import { CheckpointIntegrityError, REPOSITORY_TAIL_WINDOW } from './event-reads'
import { projectStoredEvents } from '../events/compatibility'
import { READ_CATALOG_IDENTITY } from '../events/catalog-identity'
/** Named JSON answers over persisted incremental state. The event log remains authoritative.
 * This core never names the complete catalog: callers resolve a registration
 * (`reducer-values.ts` over the registry, the local store through the selective
 * index) and hand it to `resolveRegisteredValue`. */
import { z } from 'zod'
import type { AbEvent } from '../events/catalog'
import type { RepositoryEvent } from '../events/repository'
import type { RegisteredReducer } from '../kernel/reducer-value-entry'
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
    /** Read-time arguments: they shape a rollup's finished value without
     * creating a key (SPEC §7.7). Named reducers reject them. */
    read: z.record(z.string(), z.json()).optional(),
  })
  .strict()
export type ReducerValueRequest = z.infer<typeof reducerValueRequestSchema>
export type JsonValue = z.infer<ReturnType<typeof z.json>>
export interface ReducerValue {
  catalogIdentity?: string
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

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`
  return JSON.stringify(value)
}

/** Parse a value request; named reducers take no read-time arguments. */
export function parseValueRequest(input: ReducerValueRequest): ReducerValueRequest {
  const request = reducerValueRequestSchema.parse(input)
  if (request.read !== undefined)
    throw new Error(`reducer "${request.reducer}" takes no read-time arguments`)
  return request
}

/** Validate a parsed request against its registration and derive its key. */
export function resolveRegisteredValue(
  scope: SnapshotScope,
  request: ReducerValueRequest,
  registration: RegisteredReducer | undefined,
  catalogIdentity = READ_CATALOG_IDENTITY,
) {
  if (!registration) throw new Error(`unknown reducer "${request.reducer}"`)
  const entry = registration.valueRead
  if ('excluded' in entry)
    throw new Error(`excluded reducer "${request.reducer}": ${entry.excluded}`)
  if (entry.scope !== scope.kind) throw new Error(`wrong scope for reducer "${request.reducer}"`)
  const args = entry.args.parse(request.args ?? {})
  const reducer = entry.create(args)
  const identity = canonical({
    scope,
    reducer: request.reducer,
    version: reducer.version,
    catalogIdentity,
    args,
  })
  // v2 ignores checkpoints from the former client-writable key format.
  const key = `${REDUCER_VALUE_SNAPSHOT_PREFIX}v2.${new Bun.CryptoHasher('sha256').update(identity).digest('hex').slice(0, 54)}`
  return { name: request.reducer, reducer, identity, key, entry }
}
export type ResolvedReducerValue = ReturnType<typeof resolveRegisteredValue>

/** Raw cache reads and conditional repairs are private adapter operations: clients
 * cannot submit a new accumulator through the value API. `token` identifies the
 * exact row read, including malformed bytes that could not be decoded. */
export interface ValueCacheRow {
  snapshot: ReducerSnapshot
  token: string
}
export interface ReducerValueStorage {
  checkpoints?: {
    publish(key: string, snapshot: ReducerSnapshot, checkpoints: ReducerSnapshot[]): Promise<void>
    coverage(key: string, cursor: number): Promise<boolean>
    latest(key: string, through: number): Promise<ReducerSnapshot | null>
  }
  highWater(): Promise<number>
  read(key: string): Promise<ValueCacheRow | null>
  events(since: number, through: number): Promise<(AbEvent | RepositoryEvent)[]>
  put(key: string, snapshot: ReducerSnapshot): Promise<boolean>
  repair(key: string, observed: ValueCacheRow, snapshot: ReducerSnapshot): Promise<boolean>
}

/** Serve one resolved value: load its saved row, advance it over the delta
 * since its cursor, and save the result. */
export async function readResolvedReducerValue(
  resolved: ResolvedReducerValue,
  storage: ReducerValueStorage,
): Promise<ReducerValue> {
  const { reducer, identity, key, entry } = resolved
  let boundary = await storage.highWater()
  let row: ValueCacheRow | null = null
  try {
    row = await storage.read(key)
  } catch {
    if (storage.checkpoints) throw new CheckpointIntegrityError('unreadable canonical stream seed')
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
  if (storage.checkpoints && row && !valid)
    throw new CheckpointIntegrityError('corrupt canonical stream seed')
  let recovering = false
  if (storage.checkpoints && valid && !(await storage.checkpoints.coverage(key, cursor))) {
    // A pre-checkpoint server may advance the shared canonical row during a
    // rolling deploy or rollback. Its accumulator cannot supply the missing
    // intermediate seeds. Refold only the uncovered suffix under the seed lock.
    const checkpoint = await storage.checkpoints.latest(key, cursor)
    if (checkpoint) {
      const state = checkpoint.state as { identity?: unknown; acc?: unknown } | null
      if (
        checkpoint.version !== reducer.version ||
        !Number.isSafeInteger(checkpoint.cursor) ||
        checkpoint.cursor < 0 ||
        checkpoint.cursor > cursor ||
        state?.identity !== identity ||
        !entry.validate(state.acc)
      )
        throw new CheckpointIntegrityError('corrupt recovery stream-seed checkpoint')
      acc = structuredClone(state.acc)
      cursor = checkpoint.cursor
    } else {
      // Initial legacy adoption with no checkpoint to resume from.
      acc = reducer.initial()
      cursor = 0
    }
    recovering = true
  }
  const start = cursor
  const delta = (await storage.events(cursor, boundary)).filter((event) => event.seq <= boundary)
  for (const event of delta) {
    if (event.seq !== cursor + 1) throw new Error('noncontiguous reducer log')
    cursor = event.seq
  }
  if (cursor !== boundary) throw new Error('incomplete reducer log')
  const checkpoints: ReducerSnapshot[] = []
  if (storage.checkpoints) {
    const oldest = Math.max(0, boundary - REPOSITORY_TAIL_WINDOW)
    const prefix = delta.filter((event) => event.seq <= oldest)
    acc = reducer.advance(acc, entry.adapt(projectStoredEvents(prefix)))
    if (start <= oldest)
      checkpoints.push({
        version: reducer.version,
        cursor: oldest,
        state: { identity, acc: structuredClone(acc) },
      })
    for (const event of delta) {
      if (event.seq <= oldest) continue
      acc = reducer.advance(acc, entry.adapt(projectStoredEvents([event])))
      checkpoints.push({
        version: reducer.version,
        cursor: event.seq,
        state: { identity, acc: structuredClone(acc) },
      })
    }
  } else acc = reducer.advance(acc, entry.adapt(projectStoredEvents(delta)))
  const value = entry.value(reducer.finish(acc))
  if (!valid || recovering || delta.length > 0) {
    const next = { version: reducer.version, cursor, state: { identity, acc } }
    if (storage.checkpoints) {
      await storage.checkpoints.publish(key, next, checkpoints)
      return { version: reducer.version, cursor, value, catalogIdentity: READ_CATALOG_IDENTITY }
    }
    try {
      if (row && !valid && row.snapshot.version === reducer.version)
        await storage.repair(key, row, next)
      else if (row && !valid && row.snapshot.version !== reducer.version) {
        /* foreign cache is read-only */
      } else await storage.put(key, next)
    } catch {
      /* best-effort cache; log and reduction errors propagate */
    }
  }
  return { version: reducer.version, cursor, value, catalogIdentity: READ_CATALOG_IDENTITY }
}
