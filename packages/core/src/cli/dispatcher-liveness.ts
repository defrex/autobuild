import { readRepositoryFacts, readDispatcherRunFacts } from '../store/reduced-reads'
import type { RepositoryEvent } from '../events/repository'
import type { BuildStore, RepositoryRecord } from '../store/types'
import { formatDispatcherIdentity, projectDispatcherLiveness } from '../kernel/dispatcher-liveness'

/** Correlate only the latest, stopped and lease-holder runs through persisted values. */
export async function readDispatcherLiveness(
  store: BuildStore,
  repo: string,
  now = new Date(),
  _subset?: RepositoryEvent[],
) {
  const record = await store.getRepo(repo)
  const facts = record === null ? undefined : (await readRepositoryFacts(store, repo)).value
  const runs = new Set(
    [facts?.latestRun, facts?.latestStoppedRun, record?.lease?.holder].filter(
      (run): run is string => run !== undefined,
    ),
  )
  const correlations = await Promise.all(
    [...runs].map(async (run) => (await readDispatcherRunFacts(store, repo, run)).value),
  )
  const events = correlations.flatMap((run) =>
    [run.start, run.latestStart, run.stop, run.tick].filter(
      (event): event is RepositoryEvent => event !== undefined,
    ),
  )
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
    private readonly history?: {
      allowLookup: () => boolean
      remember: (events: RepositoryEvent[], complete: boolean) => void
    },
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
    if (this.history && !this.history.allowLookup()) return
    this.attempted.add(holder)
    const lookup = (async () => {
      try {
        const facts = (await readDispatcherRunFacts(this.store, this.repo, holder)).value
        this.ingest(facts.start ? [facts.start] : [])
        const complete = false // This lookup correlates one holder, not the complete journal.
        this.history?.remember([...this.starts.values()], complete)
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
