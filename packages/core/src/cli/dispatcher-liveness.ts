import type { RepositoryEvent } from '../events/repository'
import type { BuildStore, RepositoryRecord } from '../store/types'
import { formatDispatcherIdentity, projectDispatcherLiveness } from '../kernel/dispatcher-liveness'

/** Bounded first; a later yielding invocation can hide the owner's identity or
 * an earlier stop. Only this correlation query falls back to full history. */
export async function readDispatcherLiveness(
  store: BuildStore,
  repo: string,
  now = new Date(),
  subset?: RepositoryEvent[],
) {
  const record = await store.getRepo(repo)
  let events = record === null ? [] : (subset ?? (await store.getRepoStateEvents(repo)))
  const bounded = projectDispatcherLiveness(record, events, now)
  if (
    record &&
    ((record.lease &&
      !events.some(
        (e) => e.type === 'dispatcher.run-started' && e.payload.run === record.lease!.holder,
      )) ||
      (bounded.state !== 'held' &&
        events.some((e) => e.type === 'dispatcher.run-started') &&
        !events.some((e) => e.type === 'dispatcher.run-stopped')))
  ) {
    events = await store.getRepoEvents(repo)
  }
  return { record, events, dispatcher: projectDispatcherLiveness(record, events, now) }
}

/** Invocation-local identity cache. Only start facts survive refreshes; ages
 * always come from the current lease record and clock. Failed correlations are
 * negatively cached so a standby cannot repeatedly replay a large journal. */
export class StandbyIdentityResolver {
  private readonly starts = new Map<string, RepositoryEvent>()
  private readonly attempted = new Set<string>()
  private readonly pending = new Map<string, Promise<void>>()

  constructor(
    private readonly store: BuildStore,
    private readonly repo: string,
  ) {}

  ingest(events: readonly RepositoryEvent[]): void {
    for (const event of events) {
      if (event.type === 'dispatcher.run-started') this.starts.set(event.payload.run, event)
    }
  }

  private async correlate(holder: string): Promise<void> {
    const pending = this.pending.get(holder)
    if (pending !== undefined) return pending
    if (this.starts.has(holder) || this.attempted.has(holder)) return
    this.attempted.add(holder)
    const lookup = (async () => {
      try {
        this.ingest(await this.store.getRepoStateEvents(this.repo))
        if (!this.starts.has(holder)) this.ingest(await this.store.getRepoEvents(this.repo, 0))
      } catch {
        // Identity is best effort; the sampled holder id remains sufficient.
      }
    })()
    this.pending.set(holder, lookup)
    try {
      await lookup
    } finally {
      this.pending.delete(holder)
    }
  }

  async refresh(
    run: string,
    yieldedHolder: string | undefined,
    now: Date,
  ): Promise<string | undefined> {
    let record: RepositoryRecord | null
    try {
      record = await this.store.getRepo(this.repo)
    } catch {
      return yieldedHolder
    }
    const holder = record?.lease?.holder
    if (holder === run) return undefined
    if (holder === undefined) return yieldedHolder
    await this.correlate(holder)
    if (!this.starts.has(holder)) return holder
    const projection = projectDispatcherLiveness(record, [...this.starts.values()], now)
    const identity = projection.holder ?? projection.expiredHolder
    return identity?.run === holder ? formatDispatcherIdentity(identity) : holder
  }
}
