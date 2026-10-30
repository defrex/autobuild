import type { AbEvent } from '../events/catalog'
import type { RepositoryEvent } from '../events/repository'
import type { SnapshotScope } from './snapshots'
import type { ReducerValue } from './reducer-values'

export const REPOSITORY_TAIL_WINDOW = 1_000
export const BUILD_EVENT_PAGE_SIZE = 256
export interface EventPage<E> {
  events: E[]
  cursor: number
  hasMore: boolean
}
export interface EventReadOptions {
  through?: number
  waitSeconds?: number
  signal?: AbortSignal
}
export interface BoundedEventReads {
  getBuildEventPage?(
    slug: string,
    since?: number,
    opts?: EventReadOptions,
  ): Promise<EventPage<AbEvent>>
  getRepositoryTail?(
    repo: string,
    since?: number,
    opts?: EventReadOptions,
  ): Promise<RepositoryEvent[]>
  getStreamSeed?(scope: SnapshotScope, cursor: number): Promise<ReducerValue>
  getHarvestHistoryPage?(repo: string, before?: number): Promise<EventPage<RepositoryEvent>>
}
export function validateEventCursor(cursor: number): void {
  if (!Number.isSafeInteger(cursor) || cursor < 0)
    throw new Error('event cursor must be a safe nonnegative integer')
}
export class CursorTooOldError extends Error {
  override readonly name = 'CursorTooOldError'
  readonly oldestCursor: number
  constructor(
    readonly scope: SnapshotScope,
    readonly requestedCursor: number,
    readonly head: number,
  ) {
    const oldest = Math.max(0, head - REPOSITORY_TAIL_WINDOW)
    super(
      `cursor ${requestedCursor} is too old; oldest servable cursor is ${oldest}. Re-arm without --since and reconcile repository/build status; the historical gap is unavailable.`,
    )
    this.oldestCursor = oldest
  }
}
export class IncompleteEventReadError extends Error {
  override readonly name = 'IncompleteEventReadError'
  constructor(
    readonly requestedCursor: number,
    readonly continuationCursor: number,
    readonly pageLimit = BUILD_EVENT_PAGE_SIZE,
  ) {
    super(
      `event suffix exceeds ${pageLimit} events; use getBuildEventPage and continue from ${continuationCursor}`,
    )
  }
}
export class CheckpointIntegrityError extends Error {
  override readonly name = 'CheckpointIntegrityError'
}
export class RetiredSeedGenerationError extends Error {
  override readonly name = 'RetiredSeedGenerationError'
  constructor() {
    super(
      'retired stream-seed generation; upgrade or restart, re-arm without --since and reconcile status',
    )
  }
}
export function assertResumeWindow(scope: SnapshotScope, cursor: number, head: number): void {
  validateEventCursor(cursor)
  if (cursor < Math.max(0, head - REPOSITORY_TAIL_WINDOW))
    throw new CursorTooOldError(scope, cursor, head)
}
export function isTerminalEventReadError(error: unknown): boolean {
  return (
    error instanceof CursorTooOldError ||
    error instanceof CheckpointIntegrityError ||
    error instanceof IncompleteEventReadError ||
    error instanceof RetiredSeedGenerationError
  )
}

/** One page for history UIs; local adapters keep their complete array method. */
export async function readBuildPage(
  store: import('./types').BuildStore,
  slug: string,
  since = 0,
  opts?: EventReadOptions,
): Promise<EventPage<AbEvent>> {
  if (store.getBuildEventPage) return store.getBuildEventPage(slug, since, opts)
  const events = (await store.getEvents(slug, since, opts)).filter(
    (event) => event.seq <= (opts?.through ?? Number.MAX_SAFE_INTEGER),
  )
  const page = events.slice(0, BUILD_EVENT_PAGE_SIZE)
  return {
    events: page,
    cursor: page.at(-1)?.seq ?? since,
    hasMore: events.length > BUILD_EVENT_PAGE_SIZE,
  }
}
/** An explicitly required interval freezes its upper boundary before traversal. */
export async function readBuildRange(
  store: import('./types').BuildStore,
  slug: string,
  since: number,
  opts?: EventReadOptions,
): Promise<AbEvent[]> {
  if (!store.getBuildEventPage) return store.getEvents(slug, since, opts)
  const through =
    opts?.through ??
    (await store.getReducerValue({ kind: 'build', slug }, { reducer: 'buildStreamSeed' })).cursor
  if (since >= through && opts?.waitSeconds) {
    const first = await store.getBuildEventPage(slug, since, opts)
    if (!first.hasMore) return first.events
    return [
      ...first.events,
      ...(await readBuildRange(store, slug, first.cursor, { ...opts, waitSeconds: 0 })),
    ]
  }
  const events: AbEvent[] = []
  let cursor = since
  do {
    const page = await store.getBuildEventPage(slug, cursor, { ...opts, through })
    events.push(...page.events)
    if (!page.hasMore) return events
    if (page.cursor <= cursor) throw new CheckpointIntegrityError('nonadvancing event page')
    cursor = page.cursor
  } while (cursor < through)
  return events
}
export async function readHarvestTail(
  store: import('./types').BuildStore,
  repo: string,
  count: number,
): Promise<RepositoryEvent[]> {
  if (count <= 0) return []
  if (!store.getHarvestHistoryPage)
    return (await store.getRepoEvents(repo))
      .filter((e) => e.type.startsWith('harvest.'))
      .slice(-count)
  const events: RepositoryEvent[] = []
  let cursor = Number.MAX_SAFE_INTEGER
  while (events.length < count) {
    const page = await store.getHarvestHistoryPage(repo, cursor)
    events.push(...page.events.slice(0, count - events.length))
    if (!page.hasMore) break
    if (page.cursor >= cursor) throw new CheckpointIntegrityError('nonadvancing harvest page')
    cursor = page.cursor
  }
  return events.reverse()
}
