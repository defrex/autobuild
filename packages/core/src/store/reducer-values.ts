/** Named JSON answers over persisted incremental state. The event log remains authoritative. */
import { z } from 'zod'
import type { AbEvent } from '../events/catalog'
import type { RepositoryEvent } from '../events/repository'
import { REDUCERS } from '../kernel/reducer-registry'
import type { IncrementalReducer } from '../kernel/incremental'
import {
  REDUCER_VALUE_SNAPSHOT_PREFIX,
  type ReducerSnapshot,
  type SnapshotScope,
} from './snapshots'

export const reducerValueRequestSchema = z
  .object({
    reducer: z.string().min(1).max(64),
    args: z.record(z.string(), z.json()).optional(),
  })
  .strict()
export type ReducerValueRequest = z.infer<typeof reducerValueRequestSchema>
export type JsonValue = z.infer<ReturnType<typeof z.json>>
export interface ReducerValue {
  version: number
  cursor: number
  value: JsonValue
}
export const reducerValueSchema = z
  .object({
    version: z.number().int().positive(),
    cursor: z.number().int().nonnegative(),
    value: z.json(),
  })
  .strict()

export interface ValueCatalogEntry {
  scope: SnapshotScope['kind']
  args: z.ZodType
  validate(state: unknown): boolean
  adapt(events: readonly (AbEvent | RepositoryEvent)[]): readonly unknown[]
  value(state: unknown): JsonValue
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous executable catalog
  create(args: any): IncrementalReducer<any, any, any>
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`
  return JSON.stringify(value)
}

export function resolveReducerValue(scope: SnapshotScope, input: ReducerValueRequest) {
  const request = reducerValueRequestSchema.parse(input)
  const registration = Object.hasOwn(REDUCERS, request.reducer)
    ? REDUCERS[request.reducer]
    : undefined
  if (!registration) throw new Error(`unknown reducer "${request.reducer}"`)
  const entry = registration.valueRead
  if ('excluded' in entry)
    throw new Error(`excluded reducer "${request.reducer}": ${entry.excluded}`)
  if (entry.scope !== scope.kind) throw new Error(`wrong scope for reducer "${request.reducer}"`)
  const args = entry.args.parse(request.args ?? {})
  const reducer = entry.create(args)
  const identity = canonical({ scope, reducer: request.reducer, version: reducer.version, args })
  // v2 ignores checkpoints from the former client-writable key format.
  const key = `${REDUCER_VALUE_SNAPSHOT_PREFIX}v2.${new Bun.CryptoHasher('sha256').update(identity).digest('hex').slice(0, 54)}`
  return { name: request.reducer, reducer, identity, key, entry }
}

/** Raw cache reads and conditional repairs are private adapter operations: clients
 * cannot submit a new accumulator through the value API. `token` identifies the
 * exact row read, including malformed bytes that could not be decoded. */
export interface ValueCacheRow {
  snapshot: ReducerSnapshot
  token: string
}
export interface ReducerValueStorage {
  highWater(): Promise<number>
  read(key: string): Promise<ValueCacheRow | null>
  events(since: number, through: number): Promise<(AbEvent | RepositoryEvent)[]>
  put(key: string, snapshot: ReducerSnapshot): Promise<boolean>
  repair(key: string, observed: ValueCacheRow, snapshot: ReducerSnapshot): Promise<boolean>
}

export async function readReducerValue(
  scope: SnapshotScope,
  request: ReducerValueRequest,
  storage: ReducerValueStorage,
): Promise<ReducerValue> {
  const { reducer, identity, key, entry } = resolveReducerValue(scope, request)
  let boundary = await storage.highWater()
  let row: ValueCacheRow | null = null
  try {
    row = await storage.read(key)
  } catch {
    /* unreadable cache is a miss */
  }
  // A concurrent reader may have persisted beyond our first boundary. Only a
  // fresh authoritative boundary can establish ahead-of-log poison.
  if (row && row.snapshot.cursor > boundary) boundary = await storage.highWater()
  let acc = reducer.initial()
  let cursor = 0
  let valid = false
  if (row) {
    const { snapshot } = row
    const state = snapshot.state as { identity?: unknown; acc?: unknown } | null
    try {
      valid =
        snapshot.version === reducer.version &&
        Number.isSafeInteger(snapshot.cursor) &&
        snapshot.cursor >= 0 &&
        snapshot.cursor <= boundary &&
        state !== null &&
        typeof state === 'object' &&
        state.identity === identity &&
        entry.validate(state.acc)
    } catch {
      valid = false // malformed nested cache data must never prevent replay
    }
    if (valid) {
      acc = structuredClone(state!.acc)
      cursor = snapshot.cursor
    }
  }
  const delta = (await storage.events(cursor, boundary)).filter((event) => event.seq <= boundary)
  for (const event of delta) {
    if (event.seq !== cursor + 1) throw new Error('noncontiguous reducer log')
    cursor = event.seq
  }
  if (cursor !== boundary) throw new Error('incomplete reducer log')
  acc = reducer.advance(acc, entry.adapt(delta))
  const value = entry.value(reducer.finish(acc))
  if (!valid || delta.length > 0) {
    const next = { version: reducer.version, cursor, state: { identity, acc } }
    try {
      if (row && !valid) await storage.repair(key, row, next)
      else await storage.put(key, next)
    } catch {
      /* best-effort cache; log and reduction errors propagate */
    }
  }
  return { version: reducer.version, cursor, value }
}
