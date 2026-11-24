/**
 * The derived-reducer engine (RFC 0007 §8.3, SPEC §7.7): answers a
 * `{kind: 'rollup', repo}` scope in every local adapter against a narrow
 * storage port, the way `readReducerValue` answers named values.
 *
 * A rollup row holds the accumulator and the repository change position it
 * reflects. A read whose saved position equals the repository head, and whose
 * accumulator holds nothing retention drops, is two constant reads: no event
 * rows and no feed query. Otherwise, under a per-key serialization that spans
 * every process sharing the store, the engine asks the changed-builds feed for
 * builds changed since the saved position, reads each changed build's saved
 * build-reducer value (a delta read), subtracts the contribution it absorbed
 * from that build last time, adds the new one, and commits the accumulator,
 * the feed's snapshot head and every changed absorbed contribution together,
 * conditional on the row it read. A first computation (no valid row) starts
 * from the empty accumulator at position 0, so the feed lists every build once.
 *
 * Rows live in the private `value.` namespace of `reducer_snapshots`: the
 * rollup row at `('rollup', repo, value.rollup.v1.<digest>)` and each absorbed
 * contribution at `('build', slug, value.absorbed.v1.<digest>)`. The public
 * snapshot API refuses both names.
 *
 * Browser-safe at import time: the digest is computed inside
 * `resolveRollupValue`, which only adapters call. The remote client uses
 * `rollupEntry`, which needs no hashing.
 */
import { READ_CATALOG_IDENTITY } from '../events/compatibility'
import { ROLLUPS } from '../kernel/reducer-registry'
import type { AnyRollupDefinition } from '../kernel/rollup'
import { type ChangedBuilds, compareChangePositions } from './build-feed'
import {
  canonical,
  type ReducerValue,
  type ReducerValueRequest,
  reducerValueRequestSchema,
} from './reducer-values'
import { REDUCER_VALUE_SNAPSHOT_PREFIX, type RollupScope } from './snapshots'

/** The registered rollup `name`, or a thrown unknown-rollup error. Pure. */
export function rollupEntry(name: string): AnyRollupDefinition {
  const def = Object.hasOwn(ROLLUPS, name) ? ROLLUPS[name] : undefined
  if (!def) throw new Error(`unknown rollup "${name}"`)
  return def
}

export interface ResolvedRollup {
  name: string
  def: AnyRollupDefinition
  args: unknown
  read: unknown
  version: number
  identity: string
  /** The rollup row's reducer name in the rollup scope. */
  key: string
  /** Each absorbed contribution's reducer name in its build's scope. */
  contributionKey: string
}

/** Validate a rollup request and derive its key. Key arguments are parsed with
 * their defaults before hashing, so `{}` and the explicit defaults share one
 * key; read-time arguments never enter it. */
export function resolveRollupValue(
  repo: string,
  input: ReducerValueRequest,
  catalogIdentity = READ_CATALOG_IDENTITY,
): ResolvedRollup {
  const request = reducerValueRequestSchema.parse(input)
  const def = rollupEntry(request.reducer)
  const args = def.args.parse(request.args ?? {})
  const read = def.read.parse(request.read ?? {})
  const identity = canonical({
    scope: { kind: 'rollup', repo },
    reducer: request.reducer,
    version: def.version,
    catalogIdentity,
    args,
  })
  const digest = new Bun.CryptoHasher('sha256').update(identity).digest('hex').slice(0, 54)
  return {
    name: request.reducer,
    def,
    args,
    read,
    version: def.version,
    identity,
    key: `${REDUCER_VALUE_SNAPSHOT_PREFIX}rollup.v1.${digest}`,
    contributionKey: `${REDUCER_VALUE_SNAPSHOT_PREFIX}absorbed.v1.${digest}`,
  }
}

/** A stored rollup row: its version column, decoded state, and a token naming
 * the exact bytes read, so a commit can be conditional on them. */
export interface RollupRow {
  version: number
  state: unknown
  token: string
}

/** The unserialized reads the fast path makes. */
export interface RollupReads {
  /** The repository's change position. */
  head(): Promise<string>
  read(key: string): Promise<RollupRow | null>
}

/** What an advance may do while it holds the key's serialization. Every call
 * runs under that serialization (for Postgres, on its one transaction). */
export interface RollupAdvance extends RollupReads {
  changed(since: string): Promise<ChangedBuilds>
  /** The build's saved build-reducer value, advanced by delta; `null` for a
   * build the store no longer has. */
  buildValue(slug: string, request: ReducerValueRequest): Promise<ReducerValue | null>
  /** Stored absorbed-contribution states for `slugs`, by slug. Absent slugs
   * have none. */
  contributions(key: string, slugs: readonly string[]): Promise<Map<string, unknown>>
  /** Atomically write the rollup row and the absorbed contributions (`null`
   * deletes), only if the stored row is still `observed` (`null`: none) and
   * this advance still holds the serialization. */
  commit(
    key: string,
    observed: string | null,
    row: { version: number; state: unknown },
    contributionKey: string,
    writes: ReadonlyMap<string, unknown | null>,
  ): Promise<boolean>
  /** Extend the serialization; throws when it was lost. Called after every
   * batch of build-value reads. */
  renew(): Promise<void>
}

export interface RollupStorage extends RollupReads {
  now(): Date
  /** How many build values an advance reads at once. */
  buildReadConcurrency: number
  /** Hold the store-wide per-key serialization from before the re-read until
   * after the commit, across store instances and processes. */
  serialize<T>(key: string, run: (advance: RollupAdvance) => Promise<T>): Promise<T>
}

/** Build-value reads between two `renew()` calls. */
export const ROLLUP_RENEW_BATCH = 16

interface SavedRollup {
  position: string
  acc: unknown
}

interface RollupState {
  identity: string
  position: string
  acc: unknown
}

function decodeRow(resolved: ResolvedRollup, row: RollupRow | null): SavedRollup | null {
  if (row === null || row.version !== resolved.version) return null
  try {
    const state = row.state as Partial<RollupState> | null
    if (state === null || typeof state !== 'object' || state.identity !== resolved.identity)
      return null
    if (typeof state.position !== 'string') return null
    compareChangePositions(state.position, '0')
    const acc = resolved.def.accSchema.safeParse(state.acc)
    return acc.success ? { position: state.position, acc: state.acc } : null
  } catch {
    return null // malformed nested data is a miss, never a crash
  }
}

function answer(resolved: ResolvedRollup, acc: unknown, position: string, now: Date): ReducerValue {
  return {
    version: resolved.version,
    cursor: 0,
    value: resolved.def.finish(acc, resolved.read, now, position) as ReducerValue['value'],
    catalogIdentity: READ_CATALOG_IDENTITY,
  }
}

/** A malformed stored contribution during an incremental advance: recompute. */
class MalformedContribution extends Error {}

/** Answer one rollup read. See the module comment for the algorithm. */
export async function readRollupValue(
  scope: RollupScope,
  request: ReducerValueRequest,
  storage: RollupStorage,
): Promise<ReducerValue> {
  const resolved = resolveRollupValue(scope.repo, request)
  const { def, key, contributionKey, identity } = resolved
  const head = await storage.head()
  const row = await storage.read(key)
  const saved = decodeRow(resolved, row)
  const now = storage.now()
  // Fast path: current and nothing expired. Two constant reads.
  if (saved && saved.position === head && !def.expired(saved.acc, now))
    return answer(resolved, saved.acc, saved.position, now)
  // An unknown or empty repository answers the empty value and writes nothing.
  if (head === '0') return answer(resolved, def.initial(), '0', now)

  return storage.serialize(key, async (advance) => {
    // Another reader may have advanced or pruned the row while we waited.
    const observed = await advance.read(key)
    const current = await advance.head()
    let base = decodeRow(resolved, observed)
    // A saved position above the head means the repository was reset.
    if (base && compareChangePositions(base.position, current) > 0) base = null
    const encode = (acc: unknown, position: string) => ({
      version: resolved.version,
      state: { identity, position, acc } satisfies RollupState,
    })
    const lost = async (): Promise<ReducerValue> => {
      const winner = decodeRow(resolved, await advance.read(key))
      if (!winner) throw new Error(`rollup "${resolved.name}" advance lost to an unreadable row`)
      return answer(resolved, winner.acc, winner.position, storage.now())
    }

    if (base && base.position === current) {
      // Current; only retention has work. Saved at the same position with no
      // feed query and no event read.
      const acc = structuredClone(base.acc)
      if (def.prune(acc, now)) {
        const committed = await advance.commit(
          key,
          observed!.token,
          encode(acc, base.position),
          contributionKey,
          new Map(),
        )
        if (!committed) return lost()
      }
      return answer(resolved, acc, base.position, now)
    }

    const advanceFrom = async (start: SavedRollup | null) => {
      const first = start === null
      const acc = first ? def.initial() : structuredClone(start.acc)
      def.prune(acc, now)
      const feed = await advance.changed(first ? '0' : start.position)
      const slugs = feed.builds.map((build) => build.slug)
      // A first computation ignores and overwrites any stored contribution
      // for this key, so a stale row can never be subtracted.
      const absorbed = first
        ? new Map<string, unknown>()
        : await advance.contributions(contributionKey, slugs)
      const previous = new Map<string, unknown>()
      for (const [slug, stored] of absorbed) {
        const state = stored as { identity?: unknown; contribution?: unknown } | null
        const parsed =
          state !== null && typeof state === 'object' && state.identity === identity
            ? def.contributionSchema.safeParse(state.contribution)
            : undefined
        if (!parsed?.success) throw new MalformedContribution(slug)
        previous.set(slug, state!.contribution)
      }
      const writes = new Map<string, unknown | null>()
      const request = { reducer: def.buildReducer }
      const width = Math.max(1, storage.buildReadConcurrency)
      let sinceRenew = 0
      for (let i = 0; i < slugs.length; i += width) {
        const batch = slugs.slice(i, i + width)
        const values = await Promise.all(batch.map((slug) => advance.buildValue(slug, request)))
        for (const [index, slug] of batch.entries()) {
          const value = values[index] ?? null
          const next = value === null ? null : def.contribute(value.value, resolved.args, now)
          const prior = previous.get(slug)
          if (prior !== undefined) def.subtract(acc, prior)
          if (next !== null) {
            def.add(acc, next)
            writes.set(slug, { identity, contribution: next })
          } else if (first || prior !== undefined) writes.set(slug, null)
        }
        sinceRenew += batch.length
        if (sinceRenew >= ROLLUP_RENEW_BATCH) {
          sinceRenew = 0
          await advance.renew()
        }
      }
      return { acc, position: feed.position, writes }
    }

    let result: Awaited<ReturnType<typeof advanceFrom>>
    try {
      result = await advanceFrom(base)
    } catch (error) {
      if (!(error instanceof MalformedContribution) || base === null) throw error
      result = await advanceFrom(null)
    }
    const committed = await advance.commit(
      key,
      observed?.token ?? null,
      encode(result.acc, result.position),
      contributionKey,
      result.writes,
    )
    if (!committed) return lost()
    return answer(resolved, result.acc, result.position, now)
  })
}

/** A promise chain per key: serializes same-key work inside one store
 * instance. */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>()

  async run<T>(key: string, body: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(body)
    this.tails.set(key, next)
    try {
      return await next
    } finally {
      if (this.tails.get(key) === next) this.tails.delete(key)
    }
  }
}

/** A store-wide rollup lease (the SQLite adapter's per-key serialization). */
export const ROLLUP_LEASE_MS = 120_000
/** How long a reader waits on another holder's lease before giving up. */
export const ROLLUP_LEASE_WAIT_MS = 600_000

/** A reader waited `ROLLUP_LEASE_WAIT_MS` on another holder's lease. */
export class RollupLeaseTimeoutError extends Error {
  override readonly name = 'RollupLeaseTimeoutError'
  constructor(readonly key: string) {
    super(`timed out waiting for the rollup lease on ${key}`)
  }
}

/** An advance's lease expired and another holder took it over; the advance
 * commits nothing. */
export class RollupLeaseLostError extends Error {
  override readonly name = 'RollupLeaseLostError'
  constructor(readonly key: string) {
    super(`lost the rollup lease on ${key}`)
  }
}
