import { repositoryNeedsAttention } from '../cli/attention'
import type { RepositoryEvent } from '../events/repository'
import { BUILD_EVENT_PAGE_SIZE, CursorTooOldError } from '../store/event-reads'
import type { BuildStore } from '../store/types'
import { RegistryError } from './registry'

/** One `repository.events` call scans at most this many journal rows. */
export const REPOSITORY_EVENTS_PAGE = BUILD_EVENT_PAGE_SIZE

export interface RepositoryEventsPage {
  events: RepositoryEvent[]
  cursor: number
  hasMore: boolean
}

/** The connected agent's repository attention watch: one bounded page of the
 * repository journal after `cursor`, filtered by the same predicate as
 * `ab watch --operator`. The read itself is bounded to `(cursor, cursor+256]`
 * and the cursor advances past filtered events, so successive pages scan
 * disjoint ranges. An omitted cursor reads only the repository record and
 * its high-water mark. */
export async function readRepositoryAttentionPage(
  store: BuildStore,
  repo: string,
  opts: { cursor?: number; waitSeconds?: number; filter?: 'attention' | 'all' } = {},
): Promise<RepositoryEventsPage> {
  // A repository no dispatcher has recorded yet has an empty journal, as
  // `ab watch` treats it; one record read, no event rows.
  if ((await store.getRepo(repo)) === null)
    return { events: [], cursor: opts.cursor ?? 0, hasMore: false }
  if (opts.cursor === undefined)
    return { events: [], cursor: await store.getRepoHighWater(repo), hasMore: false }
  const cursor = opts.cursor
  if (store.getRepositoryTail === undefined) {
    const error = 'this store cannot serve bounded repository event reads'
    throw new RegistryError('domain', error, {
      kind: 'refusal',
      error,
      code: 'unsupported-operation',
    })
  }
  const through = cursor + REPOSITORY_EVENTS_PAGE
  let scanned: RepositoryEvent[]
  try {
    scanned = await store.getRepositoryTail(repo, cursor, {
      through,
      ...(opts.waitSeconds ? { waitSeconds: opts.waitSeconds } : {}),
    })
  } catch (error) {
    if (error instanceof CursorTooOldError)
      throw new RegistryError('domain', error.message, {
        kind: 'conflict',
        error: error.message,
        code: 'cursor-too-old',
      })
    throw error
  }
  // An older server that ignores `through` can never widen the page.
  scanned = scanned.filter((event) => event.seq > cursor && event.seq <= through)
  const next = scanned.at(-1)?.seq ?? cursor
  const hasMore = next < (await store.getRepoHighWater(repo))
  return {
    events: opts.filter === 'all' ? scanned : scanned.filter(repositoryNeedsAttention),
    cursor: next,
    hasMore,
  }
}
