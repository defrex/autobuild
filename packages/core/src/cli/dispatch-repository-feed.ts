import { DISPATCH_HANDOFF_EVENT_TYPES } from '../store/repo-state-events'
import { type RepositoryEvent, validateRepositoryEventWrite } from '../events/repository'
import { defineReducer } from '../kernel/incremental'
import { loadReducerSnapshot, persistReducerSnapshot } from '../store/snapshots'
import type { BuildStore, Clock } from '../store/types'

const handoffTypes = new Set<string>(DISPATCH_HANDOFF_EVENT_TYPES)

export function isDashboardRepositoryEvent(event: RepositoryEvent): boolean {
  return (
    handoffTypes.has(event.type) ||
    event.type.startsWith('harvest.') ||
    event.type === 'dispatcher.intake-set' ||
    event.type === 'dispatcher.pause-set' ||
    event.type === 'dispatcher.auto-merge-default-set'
  )
}

export const dispatchFrontendReducer = defineReducer({
  version: 3,
  initial: (): { retained: RepositoryEvent[]; incompleteIdentities: boolean } => ({
    retained: [],
    incompleteIdentities: true,
  }),
  fold(acc, events: readonly RepositoryEvent[]) {
    const facts = new Map(acc.retained.map((event) => [event.seq, event]))
    for (const event of events) {
      if (isDashboardRepositoryEvent(event) || event.type === 'dispatcher.run-started')
        facts.set(event.seq, event)
    }
    acc.retained = [...facts.values()].sort((a, b) => a.seq - b.seq)
  },
  finish: (acc) => acc.retained,
})

/** One serialized, frontend-only repository projection. The consumed cursor is
 * independent of retained facts: quiet ticks must never survive in the cache. */
export class DispatchRepositoryFeed {
  private cursor = 0
  private ready = false
  private retained: RepositoryEvent[] = []
  private tail: Promise<void> = Promise.resolve()
  private savedAt = -Infinity
  private boundary: number | undefined
  private recovery = false
  incompleteIdentities = true

  constructor(
    private readonly store: BuildStore,
    private readonly repo: string,
    private readonly clock: Clock,
  ) {}

  get events(): RepositoryEvent[] {
    return this.retained.filter(isDashboardRepositoryEvent)
  }
  get identities(): RepositoryEvent[] {
    return this.retained.filter((e) => e.type === 'dispatcher.run-started')
  }

  private validate(events: RepositoryEvent[], cursor: number, contiguous: boolean): void {
    let previous = cursor
    for (const event of events) {
      if (
        event.repo !== this.repo ||
        !Number.isInteger(event.seq) ||
        event.seq <= previous ||
        (contiguous && event.seq !== previous + 1) ||
        typeof event.ts !== 'string' ||
        !Number.isFinite(Date.parse(event.ts))
      ) {
        throw new Error('invalid dashboard repository delta')
      }
      validateRepositoryEventWrite(event)
      previous = event.seq
    }
  }

  async warm(): Promise<RepositoryEvent[]> {
    this.recovery = true
    this.boundary = await this.store.getRepoHighWater(this.repo)
    this.recovery = false
    try {
      return await this.refresh()
    } catch (error) {
      this.recovery = true
      throw error
    }
  }

  refresh(persist = true): Promise<RepositoryEvent[]> {
    let result: RepositoryEvent[] = []
    const next = this.tail.then(async () => {
      let cursor = this.cursor
      let retained = this.retained
      let incompleteIdentities = this.incompleteIdentities
      let delta: RepositoryEvent[]
      if (!this.ready) {
        if ((await this.store.getRepo(this.repo)) === null) {
          this.ready = true
          this.recovery = false
          return
        }
        const high = await this.store.getRepoHighWater(this.repo)
        const snapshot = await loadReducerSnapshot(
          this.store,
          { kind: 'repo', repo: this.repo },
          'dispatchFrontend',
          dispatchFrontendReducer,
        )
        let restored = false
        if (snapshot && snapshot.cursor <= high) {
          try {
            const state = snapshot.state as {
              retained: RepositoryEvent[]
              incompleteIdentities: boolean
            }
            if (!Array.isArray(state.retained) || typeof state.incompleteIdentities !== 'boolean')
              throw new Error('invalid projection')
            this.validate(state.retained, 0, false)
            if (
              state.retained.some(
                (e) =>
                  e.seq > snapshot.cursor ||
                  !(isDashboardRepositoryEvent(e) || e.type === 'dispatcher.run-started'),
              )
            )
              throw new Error('invalid retained fact')
            incompleteIdentities = state.incompleteIdentities
            retained = state.retained
            cursor = snapshot.cursor
            restored = true
          } catch {
            /* A malformed cache uses the bounded seed. */
          }
        }
        if (!restored) {
          const seed = await this.store.getRepoStateEvents(this.repo)
          this.validate(seed, 0, false)
          incompleteIdentities = true
          retained = dispatchFrontendReducer.reduce(seed)
          cursor = Math.max(high, seed.at(-1)?.seq ?? 0)
        }
        delta = await this.store.getRepoEvents(this.repo, cursor)
        this.validate(delta, cursor, true)
        // A failed prelaunch seed must not skip this invocation's config/start
        // even if a competing run advanced the bounded seed's anchor.
        if (this.recovery) {
          const recovery = await this.store.getRepoEvents(this.repo, this.boundary ?? 0)
          this.validate(recovery, this.boundary ?? 0, true)
          delta = [...new Map([...delta, ...recovery].map((e) => [e.seq, e])).values()].sort(
            (a, b) => a.seq - b.seq,
          )
        }
      } else {
        delta = await this.store.getRepoEvents(this.repo, cursor)
        this.validate(delta, cursor, true)
        // A standby correlation may have supplied an older identity while the
        // delta read was pending. Keep those memoized facts in this commit.
        retained = this.retained
        incompleteIdentities = this.incompleteIdentities
      }
      retained = dispatchFrontendReducer.advance({ retained, incompleteIdentities }, delta).retained
      this.cursor = Math.max(cursor, delta.at(-1)?.seq ?? 0)
      this.incompleteIdentities = incompleteIdentities
      this.retained = retained
      this.ready = true
      this.recovery = false
      result = delta
      if (persist) await this.save()
    })
    this.tail = next.catch(() => {})
    return next.then(() => result)
  }

  remember(events: readonly RepositoryEvent[], complete = false): void {
    this.retained = dispatchFrontendReducer.advance(
      { retained: this.retained, incompleteIdentities: this.incompleteIdentities },
      events.filter((e) => e.seq <= this.cursor),
    ).retained
    if (complete) this.incompleteIdentities = false
  }

  async save(force = false): Promise<void> {
    if (!this.ready || (!force && this.clock().getTime() - this.savedAt < 5000)) return
    // A rejected equal-cursor put and an unavailable store still cost a
    // request. Bound attempts, not just successful writes, on quiet polls.
    this.savedAt = this.clock().getTime()
    await persistReducerSnapshot(
      this.store,
      { kind: 'repo', repo: this.repo },
      'dispatchFrontend',
      {
        version: dispatchFrontendReducer.version,
        cursor: this.cursor,
        state: { retained: this.retained, incompleteIdentities: this.incompleteIdentities },
      },
    )
  }
}
