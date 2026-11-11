import { CursorTooOldError, REPOSITORY_TAIL_WINDOW } from '../store/event-reads'
import { DISPATCH_HANDOFF_EVENT_TYPES } from '../store/repo-state-events'
import { type RepositoryEvent, validateRepositoryEventWrite } from '../events/repository'
import { defineReducer } from '../kernel/incremental'
import { readRepositoryFacts } from '../store/reduced-reads'
import { loadReducerSnapshot, persistReducerSnapshotOutcome } from '../store/snapshots'
import type { BuildStore, Clock } from '../store/types'

const handoffTypes = new Set<string>(DISPATCH_HANDOFF_EVENT_TYPES)

/** Dashboard-class facts a version-4 checkpoint cached; only legacy restore
 * validation still recognizes them. */
function isLegacyDashboardEvent(event: RepositoryEvent): boolean {
  return (
    handoffTypes.has(event.type) ||
    event.type.startsWith('harvest.') ||
    event.type === 'tickets.migration-recorded' ||
    event.type === 'dispatcher.intake-set' ||
    event.type === 'dispatcher.pause-set' ||
    event.type === 'dispatcher.auto-merge-default-set'
  )
}

/** The version-4 checkpoint shape, normalized once on restore. */
const LEGACY_VERSION = 4

export const dispatchFrontendReducer = defineReducer({
  version: 5,
  initial: (): { identities: RepositoryEvent[]; holder?: string } => ({ identities: [] }),
  fold(acc, events: readonly RepositoryEvent[]) {
    const starts = new Map(acc.identities.map((event) => [event.seq, event]))
    for (const event of events) {
      if (event.type === 'dispatcher.run-started') starts.set(event.seq, event)
    }
    const sorted = [...starts.values()].sort((a, b) => a.seq - b.seq)
    const latest = sorted.at(-1)
    const holder = sorted.findLast(
      (event) => event.type === 'dispatcher.run-started' && event.payload.run === acc.holder,
    )
    acc.identities = sorted.filter((event) => event === latest || event === holder)
  },
  finish: (acc) => acc.identities,
})

type FrontendState = { identities: RepositoryEvent[]; holder?: string }

/** One serialized, frontend-only repository projection. The consumed cursor is
 * independent of retained facts: quiet ticks must never survive in the cache.
 * The checkpoint holds standby identities only (the latest run start and the
 * selected holder's start); presentation reads canonical repository facts.
 * Without a usable checkpoint, startup and cursor-expiry recovery seed
 * identities from the canonical `repositoryReadFacts` value, never from the
 * journal. */
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

  get identities(): RepositoryEvent[] {
    return this.retained
  }

  /** A consumed nonzero cursor proves the repository journal exists. */
  get present(): boolean {
    return this.cursor > 0
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

  /** Validate a version-5 checkpoint; a re-fold that changes nothing is clean. */
  private restoreCurrent(state: unknown, cursor: number): FrontendState & { clean: boolean } {
    const current = state as FrontendState
    if (!current || !Array.isArray(current.identities) || current.identities.length > 2)
      throw new Error('invalid projection')
    this.validate(current.identities, 0, false)
    if (current.identities.some((e) => e.seq > cursor || e.type !== 'dispatcher.run-started'))
      throw new Error('invalid identity')
    if (current.holder !== undefined && typeof current.holder !== 'string')
      throw new Error('invalid holder')
    const identities = dispatchFrontendReducer.advance(
      { identities: current.identities, holder: current.holder },
      [],
    ).identities
    return {
      identities,
      holder: current.holder,
      clean: identities.length === current.identities.length,
    }
  }

  /** Normalize a version-4 checkpoint: its dashboard-event cache is discarded
   * and only the identities survive. Never clean, so the next save replaces it. */
  private restoreLegacy(state: unknown, cursor: number): FrontendState {
    const legacy = state as {
      retained: RepositoryEvent[]
      incompleteIdentities: boolean
      holder?: string
    }
    if (
      !legacy ||
      !Array.isArray(legacy.retained) ||
      typeof legacy.incompleteIdentities !== 'boolean'
    )
      throw new Error('invalid projection')
    this.validate(legacy.retained, 0, false)
    if (
      legacy.retained.some(
        (e) =>
          e.seq > cursor || !(isLegacyDashboardEvent(e) || e.type === 'dispatcher.run-started'),
      )
    )
      throw new Error('invalid retained fact')
    if (legacy.holder !== undefined && typeof legacy.holder !== 'string')
      throw new Error('invalid holder')
    return {
      identities: dispatchFrontendReducer.advance(
        { identities: [], holder: legacy.holder },
        legacy.retained,
      ).identities,
      holder: legacy.holder,
    }
  }

  /** The current checkpoint, or else one read of a legacy version-4 row. */
  private async restore(
    high: number,
  ): Promise<(FrontendState & { cursor: number; clean: boolean }) | undefined> {
    const scope = { kind: 'repo', repo: this.repo } as const
    const usable = (cursor: number) => cursor <= high && high - cursor <= REPOSITORY_TAIL_WINDOW
    const snapshot = await loadReducerSnapshot(
      this.store,
      scope,
      'dispatchFrontend',
      dispatchFrontendReducer,
    )
    if (snapshot) {
      if (!usable(snapshot.cursor)) return undefined
      try {
        return { ...this.restoreCurrent(snapshot.state, snapshot.cursor), cursor: snapshot.cursor }
      } catch {
        return undefined
      }
    }
    const legacy = await loadReducerSnapshot(this.store, scope, 'dispatchFrontend', {
      version: LEGACY_VERSION,
    })
    if (!legacy || !usable(legacy.cursor)) return undefined
    try {
      return {
        ...this.restoreLegacy(legacy.state, legacy.cursor),
        cursor: legacy.cursor,
        clean: false,
      }
    } catch {
      return undefined
    }
  }

  refresh(persist = true): Promise<RepositoryEvent[]> {
    let result: RepositoryEvent[] = []
    const next = this.tail.then(async () => {
      let holder = this.holder
      let cursor = this.cursor
      let identities = this.retained
      let restoredKey: string | undefined
      let restoredIdentities: RepositoryEvent[] | undefined
      let delta: RepositoryEvent[]
      if (!this.ready) {
        if ((await this.store.getRepo(this.repo)) === null) {
          this.ready = true
          this.recovery = false
          return
        }
        const high = await this.store.getRepoHighWater(this.repo)
        // A malformed, stale or missing cache uses the canonical seed.
        const restored = await this.restore(high)
        if (restored) {
          holder = restored.holder
          identities = restored.identities
          cursor = restored.cursor
          if (restored.clean) {
            restoredKey = `${restored.cursor}:${this.generation}`
            restoredIdentities = identities
          }
        } else {
          const seed = await this.canonicalSeed(holder)
          identities = seed.identities
          cursor = seed.cursor
        }
        delta = await this.readStartupTail(cursor)
        this.validate(delta, cursor, true)
        // A failed prelaunch seed must not skip this invocation's config/start
        // even if a competing run advanced the bounded seed's anchor.
        if (this.recovery && this.boundary !== undefined) {
          const recovery = await this.readStartupTail(this.boundary)
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
        holder = this.holder
        identities = this.retained
      }
      if (delta.length > 0)
        identities = dispatchFrontendReducer.advance({ identities, holder }, delta).identities
      this.holder = holder
      this.cursor = Math.max(cursor, delta.at(-1)?.seq ?? 0)
      if (restoredKey !== undefined) {
        this.settled = restoredKey
        this.retained = restoredIdentities!
      }
      this.replaceIdentities(identities)

      this.ready = true
      this.recovery = false
      result = delta
      if (persist) await this.save()
    })
    const recovered = next.catch(async (error) => {
      if (!(error instanceof CursorTooOldError)) throw error
      const seed = await this.canonicalSeed(this.holder)
      const cursor = seed.cursor
      const delta = await this.readStartupTail(cursor)
      this.validate(delta, cursor, true)
      this.replaceIdentities(
        dispatchFrontendReducer.advance({ identities: seed.identities, holder: this.holder }, delta)
          .identities,
      )
      this.cursor = Math.max(cursor, delta.at(-1)?.seq ?? 0)
      this.ready = true
      this.recovery = false
      this.boundary = undefined
      result = delta
      if (persist) await this.save()
    })
    this.tail = recovered.catch(() => {})
    return recovered.then(() => result)
  }

  /** Missing or unusable presentation state restarts from the canonical reduced
   * repository value: cost is independent of journal and current-run length. */
  private async canonicalSeed(
    holder: string | undefined,
  ): Promise<{ cursor: number; identities: RepositoryEvent[] }> {
    const { cursor, value } = await readRepositoryFacts(this.store, this.repo, true)
    const runs = new Map(value.recentRuns)
    const starts = new Map<number, RepositoryEvent>()
    for (const run of [value.latestRun, holder]) {
      const start = run === undefined ? undefined : runs.get(run)?.latestStart
      if (start) starts.set(start.seq, start)
    }
    const sorted = [...starts.values()].sort((a, b) => a.seq - b.seq)
    this.validate(sorted, 0, false)
    if (!Number.isInteger(cursor) || cursor < 0)
      throw new Error('invalid canonical repository cursor')
    if (sorted.some((e) => e.type !== 'dispatcher.run-started' || e.seq > cursor))
      throw new Error('invalid canonical identity')
    return {
      cursor,
      identities: dispatchFrontendReducer.advance({ identities: [], holder }, sorted).identities,
    }
  }

  private readStartupTail(cursor: number): Promise<RepositoryEvent[]> {
    if (!this.store.getRepositoryTail)
      throw new Error('dashboard restoration requires getRepositoryTail')
    return this.store.getRepositoryTail(this.repo, cursor)
  }

  private replaceIdentities(events: RepositoryEvent[]): void {
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
    this.replaceIdentities(
      dispatchFrontendReducer.advance({ identities: this.retained, holder }, []).identities,
    )
  }

  remember(events: readonly RepositoryEvent[], _complete = false): void {
    const eligible = events.filter((e) => e.seq <= this.cursor)
    this.validate(
      [...eligible].sort((a, b) => a.seq - b.seq),
      0,
      false,
    )
    this.replaceIdentities(
      dispatchFrontendReducer.advance({ identities: this.retained, holder: this.holder }, eligible)
        .identities,
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
      state: { identities: this.retained, holder: this.holder },
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
