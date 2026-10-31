import { CursorTooOldError } from '../store/event-reads'
import { DISPATCH_HANDOFF_EVENT_TYPES } from '../store/repo-state-events'
import { type RepositoryEvent, validateRepositoryEventWrite } from '../events/repository'
import { defineReducer } from '../kernel/incremental'
import { loadReducerSnapshot, persistReducerSnapshotOutcome } from '../store/snapshots'
import type { BuildStore, Clock } from '../store/types'

const handoffTypes = new Set<string>(DISPATCH_HANDOFF_EVENT_TYPES)

export function isDashboardRepositoryEvent(event: RepositoryEvent): boolean {
  return (
    handoffTypes.has(event.type) ||
    event.type.startsWith('harvest.') ||
    event.type === 'tickets.migration-recorded' ||
    event.type === 'dispatcher.intake-set' ||
    event.type === 'dispatcher.pause-set' ||
    event.type === 'dispatcher.auto-merge-default-set'
  )
}

export const dispatchFrontendReducer = defineReducer({
  version: 4,
  initial: (): { retained: RepositoryEvent[]; incompleteIdentities: boolean; holder?: string } => ({
    retained: [],
    incompleteIdentities: true,
  }),
  fold(acc, events: readonly RepositoryEvent[]) {
    const facts = new Map(acc.retained.map((event) => [event.seq, event]))
    for (const event of events) {
      if (isDashboardRepositoryEvent(event) || event.type === 'dispatcher.run-started')
        facts.set(event.seq, event)
    }
    const sorted = [...facts.values()].sort((a, b) => a.seq - b.seq)
    const latest = sorted.findLast((event) => event.type === 'dispatcher.run-started')
    const holder = sorted.findLast(
      (event) => event.type === 'dispatcher.run-started' && event.payload.run === acc.holder,
    )
    acc.retained = sorted.filter(
      (event) => event.type !== 'dispatcher.run-started' || event === latest || event === holder,
    )
    acc.incompleteIdentities = true
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
  private generation = 0
  private settled: string | undefined
  private nextSaveAt = -Infinity
  private failures = 0
  private saving: Promise<void> | undefined
  private holder: string | undefined
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
      let restoredKey: string | undefined
      let restoredRetained: RepositoryEvent[] | undefined
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
              holder?: string
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
            if (state.holder !== undefined && typeof state.holder !== 'string')
              throw new Error('invalid holder')
            this.holder = state.holder
            retained = dispatchFrontendReducer.advance({ ...state }, []).retained
            incompleteIdentities = true
            if (state.incompleteIdentities && retained.length === state.retained.length) {
              restoredKey = `${snapshot.cursor}:${this.generation}`
              restoredRetained = retained
            }
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
        if (this.recovery && this.boundary !== undefined) {
          const recovery = await this.store.getRepoEvents(this.repo, this.boundary)
          this.validate(recovery, this.boundary, true)
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
      if (delta.length > 0)
        retained = dispatchFrontendReducer.advance(
          { retained, incompleteIdentities, holder: this.holder },
          delta,
        ).retained
      this.cursor = Math.max(cursor, delta.at(-1)?.seq ?? 0)
      this.incompleteIdentities = true
      if (restoredKey !== undefined) {
        this.settled = restoredKey
        this.retained = restoredRetained!
      }
      this.replaceRetained(retained)

      this.ready = true
      this.recovery = false
      result = delta
      if (persist) await this.save()
    })
    const recovered = next.catch(async (error) => {
      if (!(error instanceof CursorTooOldError)) throw error
      const high = await this.store.getRepoHighWater(this.repo)
      const seed = await this.store.getRepoStateEvents(this.repo)
      this.validate(seed, 0, false)
      this.replaceRetained(dispatchFrontendReducer.reduce(seed))
      this.cursor = Math.max(high, seed.at(-1)?.seq ?? 0)
      this.incompleteIdentities = true
      this.ready = true
      this.recovery = false
      this.boundary = undefined
      result = []
      if (persist) await this.save()
    })
    this.tail = recovered.catch(() => {})
    return recovered.then(() => result)
  }

  private replaceRetained(events: RepositoryEvent[]): void {
    // Sequence numbers identify immutable journal facts; no deep serialization on polls.
    const changed =
      events !== this.retained &&
      (events.length !== this.retained.length ||
        events.some((event, i) => event.seq !== this.retained[i]?.seq))
    this.retained = events
    if (changed) this.generation++
  }

  selectHolder(holder: string | undefined): void {
    if (this.holder === holder) return
    this.generation++
    this.holder = holder
    this.replaceRetained(
      dispatchFrontendReducer.advance(
        {
          retained: this.retained,
          incompleteIdentities: true,
          holder,
        },
        [],
      ).retained,
    )
  }

  remember(events: readonly RepositoryEvent[], _complete = false): void {
    const eligible = events.filter((e) => e.seq <= this.cursor)
    this.validate(
      [...eligible].sort((a, b) => a.seq - b.seq),
      0,
      false,
    )
    this.replaceRetained(
      dispatchFrontendReducer.advance(
        { retained: this.retained, incompleteIdentities: true, holder: this.holder },
        eligible,
      ).retained,
    )
  }

  save(force = false): Promise<void> {
    if (this.saving) return force ? this.saving.then(() => this.save(true)) : this.saving
    const key = `${this.cursor}:${this.generation}`
    const now = this.clock().getTime()
    if (!this.ready || key === this.settled || (!force && now < this.nextSaveAt))
      return Promise.resolve()
    const snapshot = {
      version: dispatchFrontendReducer.version,
      cursor: this.cursor,
      state: { retained: this.retained, incompleteIdentities: true, holder: this.holder },
    }
    this.nextSaveAt = now + 30_000
    this.saving = persistReducerSnapshotOutcome(
      this.store,
      { kind: 'repo', repo: this.repo },
      'dispatchFrontend',
      snapshot,
    )
      .then((outcome) => {
        if (outcome === 'unavailable') {
          this.nextSaveAt = this.clock().getTime() + Math.min(30_000 * 2 ** this.failures, 300_000)
          this.failures = Math.min(this.failures + 1, 4)
        } else {
          this.settled = key
          this.failures = 0
        }
      })
      .finally(() => {
        this.saving = undefined
      })
    return this.saving
  }
}
