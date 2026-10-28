import { READ_CATALOG_IDENTITY } from '../events/compatibility'
/**
 * Reducer snapshots: a cache beside the event log, never an authority.
 *
 * For one scope (a build log or a repository journal) and one registered
 * reducer, the store may keep that reducer's serialized accumulator as of a
 * cursor, so a process with no hot memory loads it, reads only the events
 * newer than the cursor, and advances — instead of replaying the whole log.
 *
 * The log always regenerates a snapshot. Every consumer treats a missing,
 * version-mismatched, ahead-of-log, malformed or unreadable snapshot as a miss
 * and replays; deleting every snapshot changes no observable output.
 */
import { z } from 'zod'
import type { IncrementalReducer } from '../kernel/incremental'
import type { BuildStore } from './types'

export type SnapshotScope = { kind: 'build'; slug: string } | { kind: 'repo'; repo: string }

export interface ReducerSnapshot {
  /** The reducer version that wrote `state`; a reader on another version
   * ignores the snapshot. */
  version: number
  /** The greatest event seq folded into `state`. */
  cursor: number
  /** The reducer's JSON accumulator as of `cursor`. */
  state: unknown
}

export const reducerSnapshotWireSchema = z.object({
  version: z.number().int().min(1),
  cursor: z.number().int().min(0),
  state: z.unknown(),
})

/** The registry name a snapshot is keyed by: a short identifier, safe in a URL
 * path segment and a SQL key. */
export const SNAPSHOT_REDUCER_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/

/** Value checkpoints are written only by the adapter's private reduction path.
 * Generic snapshot clients must never supply state used for named answers. */
export const REDUCER_VALUE_SNAPSHOT_PREFIX = 'value.'

export function assertPublicSnapshotReducer(reducer: string): void {
  if (reducer.startsWith(REDUCER_VALUE_SNAPSHOT_PREFIX)) {
    throw new Error('reserved reducer value snapshot namespace')
  }
}

export function snapshotScopeKey(scope: SnapshotScope): string {
  return scope.kind === 'build' ? `build:${scope.slug}` : `repo:${scope.repo}`
}

/** Whether a put replaces the stored row. The stored cursor never decreases:
 * an advancing cursor never downgrades the stored reducer version, and an
 * upgraded reducer may replace an older shape at an unchanged cursor. */
export function snapshotSupersedes(
  next: Pick<ReducerSnapshot, 'version' | 'cursor'>,
  stored: Pick<ReducerSnapshot, 'version' | 'cursor'> | undefined,
): boolean {
  if (stored === undefined) return true
  if (next.version < stored.version) return false
  if (next.cursor !== stored.cursor) return next.cursor > stored.cursor
  return next.version > stored.version
}

type SnapshotStore = Pick<BuildStore, 'getReducerSnapshot' | 'putReducerSnapshot'>

/** Read a snapshot, degrading every failure to a miss. */
export async function loadReducerSnapshot(
  store: Partial<SnapshotStore>,
  scope: SnapshotScope,
  name: string,
  reducer: Pick<IncrementalReducer<unknown, unknown, unknown>, 'version'>,
): Promise<ReducerSnapshot | null> {
  if (store.getReducerSnapshot === undefined) return null
  try {
    const found = await store.getReducerSnapshot(scope, catalogSnapshotName(name), reducer.version)
    if (found === null || found.version !== reducer.version) return null
    if (!Number.isInteger(found.cursor) || found.cursor < 0) return null
    const state = found.state as { catalogIdentity?: unknown; acc?: unknown } | null
    if (!state || state.catalogIdentity !== READ_CATALOG_IDENTITY || !Object.hasOwn(state, 'acc'))
      return null
    return { ...found, state: state.acc }
  } catch {
    return null
  }
}

/** Write a snapshot best-effort; a failing store never reaches the caller. */
export async function persistReducerSnapshot(
  store: Partial<SnapshotStore>,
  scope: SnapshotScope,
  name: string,
  snapshot: ReducerSnapshot,
): Promise<boolean> {
  return (await persistReducerSnapshotOutcome(store, scope, name, snapshot)) === 'written'
}

export type SnapshotWriteOutcome = 'written' | 'refused' | 'unavailable' | 'unsupported'

/** Preserve refusal versus transport failure for best-effort retry scheduling. */
export async function persistReducerSnapshotOutcome(
  store: Partial<SnapshotStore>,
  scope: SnapshotScope,
  name: string,
  snapshot: ReducerSnapshot,
): Promise<SnapshotWriteOutcome> {
  if (store.putReducerSnapshot === undefined) return 'unsupported'
  try {
    const written = await store.putReducerSnapshot(scope, catalogSnapshotName(name), {
      ...snapshot,
      state: { catalogIdentity: READ_CATALOG_IDENTITY, acc: snapshot.state },
    })
    return written ? 'written' : 'refused'
  } catch {
    return 'unavailable'
  }
}

/** Fixed-size names isolate checkpoints even when reducer integers match. */
export function catalogSnapshotName(name: string, catalogIdentity = READ_CATALOG_IDENTITY): string {
  return `catalog.${new Bun.CryptoHasher('sha256')
    .update(JSON.stringify([name, catalogIdentity]))
    .digest('hex')
    .slice(0, 56)}`
}
