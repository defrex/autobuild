/**
 * The dispatcher's in-process repository view (AUT-647): a `BuildStore`
 * decorator that builds the state a tick needs once, at the first refresh, and
 * on every later refresh reads only events newer than the cursors it already
 * holds — one journal delta, one delta per live build, and the discovery
 * listing/digest reads that find builds appearing since.
 *
 * Every tick stage talks to this object instead of the raw store, so
 *
 * - reads (`getEvents`, `getRepoEvents`, `getRepoStateEvents`,
 *   `getRepoBuildDigests`, `listBuilds`) are answered from memory;
 * - an event a stage appends is folded in immediately, so a later stage of the
 *   same tick sees it with no re-read (a foreign append interleaved with ours
 *   leaves a seq gap, which marks the log dirty so the next read deltas);
 * - a failed compare-and-set marks its log dirty, so every existing CAS loop
 *   that re-reads after a conflict observes the winner's event unchanged.
 *
 * Concurrency: every state transition of one source (a build slug, the journal,
 * the listing/discovery pair) runs on that source's single in-flight promise
 * chain — snapshot reads, delta reads, window opening and widening, the fold
 * after an own append, a lost compare-and-set's invalidation. Readers run on the
 * chain too, so a second reader joins the repair already in flight and never
 * observes half-applied state; nothing interleaves inside a transition, which
 * is why no write-generation or re-check bookkeeping is needed. Chain tasks only
 * call the backing store and the private unlocked helpers, never a public
 * method (that would deadlock behind itself).
 *
 * Safety net: every delta must begin at `cursor + 1` and stay contiguous; if
 * it does not, the log is discarded and re-read in full, so "no event is ever
 * skipped" is enforced here rather than assumed of the adapters.
 *
 * What is held:
 *
 * - the bounded repository journal (`getRepoStateEvents`' subset), pruned on
 *   arrival by the same keep rule — durable types plus the tail from the latest
 *   `dispatcher.run-started` — which is exact for seq-ordered input;
 * - for *work* builds (nonterminal, aborted, reclaim-pending, execution-open),
 *   the full event array. Settled terminal builds hold only the discovery
 *   digest and cost no log read;
 * - read windows: cursor-bearing readers (the orchestrator wake pass scans
 *   every build, settled ones included, from a per-session cursor) get a
 *   per-source window holding only events above their lowest cursor.
 *
 * Cold start (reducer snapshots, `store/snapshots.ts`): a process with no hot
 * memory loads each source's stored reducer state — the pruned journal view; the
 * build, log-index and open-execution reducers for a work build — as of a
 * cursor, reads only events newer than it, and advances. A snapshot-backed work
 * log holds just that delta plus the reduced state of everything before it, so a
 * quiet tick reads zero event rows. Every snapshot is a cache the log
 * regenerates: a missing, mismatched-version, ahead-of-log, malformed or
 * unreadable one is a miss and the source is replayed in full, with identical
 * results. `persistSnapshots` writes the advanced state back (best effort;
 * cursors only ever move forward in the store).
 */
import type { AbEvent, EventEnvelope, EventWrite } from '../events/catalog'
import { validateRepositoryEventWrite } from '../events/repository'
import type { EventType } from '../events/payloads'
import type {
  RepositoryEvent,
  RepositoryEventEnvelope,
  RepositoryEventType,
  RepositoryEventWrite,
} from '../events/repository'
import type {
  SessionEvent,
  SessionEventEnvelope,
  SessionEventType,
  SessionEventWrite,
} from '../events/sessions'
import { logIndexReducer, type LogIndex } from '../kernel/log-index'
import { buildReducer, reduceBuild, type BuildAcc, type BuildState } from '../kernel/reducer'
import { createBuildScopedStore } from '../store/build-scope'
import { buildDigestReducer, reduceBuildDigest, type DigestEventRow } from '../store/digest'
import {
  foldJournalView,
  JOURNAL_VIEW_REDUCER_VERSION,
  journalViewReducer,
  type JournalViewAcc,
} from '../store/repo-state-events'
import {
  loadReducerSnapshot,
  persistReducerSnapshot,
  type ReducerSnapshot,
  type SnapshotScope,
} from '../store/snapshots'
import { openBuildWorkspaceReducer, type OpenBuildWorkspace } from './dispatcher-selectors'
import {
  type ExecutionOutcome,
  lastExecutionOutcomeReducer,
  openExecutionReducer,
  type OpenExecution,
} from './execution-settlement'
import { type PublicationView, publicationStateReducer } from './publication-state'
import { createSessionScopedStore } from '../store/session-handle'
import type {
  StreamChunk,
  StreamOutcome,
  StreamPart,
  StreamRead,
  StreamRecord,
  StreamScope,
} from '../store/streams/types'
import type {
  TicketAsset,
  TicketAssetInput,
  TicketAssetLimits,
  TicketAssetMeta,
  TicketAssetSummary,
} from '../store/ticket-assets'
import type {
  Artifact,
  ArtifactInput,
  ArtifactMeta,
  BuildDigest,
  BuildRecord,
  BuildScopedStore,
  BuildStore,
  NewBuildInput,
  NewSessionInput,
  RepositoryArtifact,
  RepositoryArtifactMeta,
  RepositoryRecord,
  SessionArtifact,
  SessionArtifactMeta,
  SessionRecord,
  SessionScopedStore,
  SubscribeOptions,
  Unsubscribe,
} from '../store/types'

/** Registry names the snapshots are keyed by (kernel/reducer-registry.ts). */
const SNAPSHOT_JOURNAL = 'journalView'
/** A resident view persists at most this often; a cold single-tick process
 * (the hosted dispatcher) always persists once at its tick's end. */
const PERSIST_MIN_INTERVAL_MS = 30_000
/** Builds written back concurrently. */
const PERSIST_CONCURRENCY = 4

/** The reducers a work build's snapshots hold beside `build`, keyed by registry
 * name (`kernel/reducer-registry.ts`). Every quiet-path tick stage reads its
 * facts from these, so a snapshot-backed log needs no event array. */
const EXTRA_REDUCERS = {
  // The digest reducer folds the narrow rows `digestRow` projects, so it is
  // adapted to the event-array form the rest of the bundle shares. A restored
  // log derives its own digest from this, never from discovery.
  buildDigest: {
    version: buildDigestReducer.version,
    initial: buildDigestReducer.initial,
    advance: (acc: ReturnType<typeof buildDigestReducer.initial>, events: readonly AbEvent[]) =>
      buildDigestReducer.advance(acc, events.map(digestRow)),
    finish: buildDigestReducer.finish,
  },
  logIndex: logIndexReducer,
  openExecution: openExecutionReducer,
  openBuildWorkspace: openBuildWorkspaceReducer,
  publicationState: publicationStateReducer,
  lastExecutionOutcome: lastExecutionOutcomeReducer,
} as const
type ExtraName = keyof typeof EXTRA_REDUCERS
const EXTRA_NAMES = Object.keys(EXTRA_REDUCERS) as ExtraName[]
type ExtraAccs = Record<ExtraName, unknown>

/** The facts a quiet-path stage needs about one build, without its event array. */
export interface BuildFacts {
  state: BuildState
  log: LogIndex
  open: OpenExecution | null
  /** The open workspace (the latest provisioned, not yet released). */
  workspace: OpenBuildWorkspace | null
  publication: PublicationView
  lastExecution: ExecutionOutcome
}

/** A build that still has tick duties: nonterminal, aborted (awaiting its
 * cleanup's `build.completed`), a `done` build with an unreclaimed release
 * asset, or one with an execution the provider has not been seen to end. A
 * terminal, settled build costs no event reads. */
export function isWorkDigest(digest: Omit<BuildDigest, 'slug'>): boolean {
  return (
    digest.terminal === undefined ||
    digest.terminal === 'aborted' ||
    digest.reclaimPending === true ||
    digest.executionOpen === true
  )
}

function digestRow(event: AbEvent): DigestEventRow {
  return {
    type: event.type,
    seq: event.seq,
    ts: event.ts,
    ...(event.type === 'pr-attachment.reclaimed' ? { hostedSeq: event.payload.hostedSeq } : {}),
    ...(event.type === 'execution.started' || event.type === 'execution.ended'
      ? { instance: event.payload.instance }
      : {}),
  }
}

/** One build log held in memory: events with `seq > from`, contiguous through
 * `cursor`. Work logs are held from 0. A window created for a cursor-bearing
 * reader may start higher; in a resident view it then also carries `acc`, the
 * reduced state of the history it does not retain. */
interface Log {
  from: number
  events: AbEvent[]
  cursor: number
  dirty: boolean
  /** The refresh epoch this log was last brought current in. */
  epoch: number
  acc?: BuildAcc
  /** The other work-build accumulators ride beside `acc`, so the facts a stage
   * derives never need the event array. */
  extra?: ExtraAccs
  /** The cursor last read from, or written to, the snapshot store. */
  persisted: number
  /** Created by a cursor-bearing request: survives refreshes while unneeded. */
  pinned: boolean
  digest?: { cursor: number; value: Omit<BuildDigest, 'slug'> }
}

interface JournalWindow {
  from: number
  events: RepositoryEvent[]
  /** Highest seq held (≥ from). */
  last: number
}

/** Every retained journal entry is an event envelope, in increasing seq order
 * and no newer than the snapshot's cursor. */
function retainedShape(retained: unknown[], cursor: number): boolean {
  let last = 0
  for (const event of retained) {
    if (!isObject(event)) return false
    if (typeof event.type !== 'string' || typeof event.ts !== 'string') return false
    if (typeof event.repo !== 'string' || !isObject(event.actor)) return false
    if (!Number.isInteger(event.seq) || (event.seq as number) <= last) return false
    last = event.seq as number
    // The payload must satisfy the repository event contract for its type, so a
    // reducer never meets an entry a full replay would not have produced.
    try {
      validateRepositoryEventWrite({
        actor: event.actor,
        type: event.type,
        payload: event.payload,
      } as never)
    } catch {
      return false
    }
  }
  return last <= cursor
}

function hasAccs(log: Log): boolean {
  return log.acc !== undefined && log.extra !== undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface RepoViewOptions {
  repo: string
  /** A long-running dispatcher: windows are seeded from a full read so the
   * reduced state of unretained history stays available (one pass over the log
   * at process start). One-shot invocations leave this off and read each
   * window from its cursor, exactly as the wake pass always did. */
  resident?: boolean
  /** Injectable millisecond clock for the persist throttle (tests). */
  now?: () => number
}

/** Runs tasks strictly one after another; `onIdle` fires when the queue drains. */
class Chain {
  private tail: Promise<void> = Promise.resolve()
  private pending = 0

  constructor(private readonly onIdle?: () => void) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    this.pending += 1
    const result = this.tail.then(task)
    this.tail = result
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        this.pending -= 1
        if (this.pending === 0) this.onIdle?.()
      })
    return result
  }
}

export type WindowSource = { build: string } | 'journal'

export class RepoViewStore implements BuildStore {
  private readonly repo: string
  private readonly resident: boolean
  private epoch = 0
  private initialized = false
  /** The journal alone is loaded (`startJournal`): own journal appends fold. */
  private journalReady = false
  private initializing: Promise<void> | undefined

  // Journal.
  private recorded = false
  private journal: RepositoryEvent[] = []
  private anchor: number | undefined
  private journalCursor = 0
  private journalDirty = false
  private journalEpoch = -1
  private journalWindow: JournalWindow | undefined
  private persistedJournal = 0
  private lastPersistAt: number | undefined

  // Builds.
  private records: BuildRecord[] = []
  private recordsDirty = false
  private discovery = new Map<string, BuildDigest>()
  private discoveryDirty = false
  private readonly logs = new Map<string, Log>()
  private readonly work = new Set<string>()
  private readonly buildChains = new Map<string, Chain>()
  private readonly journalChain = new Chain()
  /** Serializes the build listing and the discovery digests. */
  private readonly metaChain = new Chain()

  private readonly now: () => number

  constructor(
    private readonly backing: BuildStore,
    opts: RepoViewOptions,
  ) {
    this.repo = opts.repo
    this.resident = opts.resident === true
    this.now = opts.now ?? Date.now
  }

  // ── Refresh ────────────────────────────────────────────────────────────────

  /** One build's transitions, strictly in order. */
  private build<T>(slug: string, task: () => Promise<T>): Promise<T> {
    let chain = this.buildChains.get(slug)
    if (chain === undefined) {
      const created: Chain = new Chain(() => {
        if (this.buildChains.get(slug) === created) this.buildChains.delete(slug)
      })
      chain = created
      this.buildChains.set(slug, created)
    }
    return chain.run(task)
  }

  /** Cold start once, shared by every reader that arrives before it finishes. */
  private ensureInit(): Promise<void> {
    if (this.initialized) return Promise.resolve()
    this.initializing ??= this.refresh().finally(() => {
      this.initializing = undefined
    })
    return this.initializing
  }

  /** The once-per-tick entry and lazy initializer. Cold (first call): the
   * journal's high-water mark, the bounded journal read, the build listing and
   * digests, and a full read of every work build. Warm: only what is newer. */
  async refresh(): Promise<void> {
    this.epoch += 1
    await this.journalChain.run(() => this.syncOrLoadJournal())
    await this.refreshRecords()
    await this.refreshDiscovery()

    const own = this.records.filter((record) => record.repo === this.repo)
    const known = new Set(own.map((record) => record.slug))
    // Every build held at refresh start reads its tail first, regardless of
    // what discovery says; only then may a now-settled build be evicted.
    for (const slug of [...this.work]) {
      await this.build(slug, async () => {
        if (!this.work.has(slug)) return
        if (!known.has(slug)) {
          this.work.delete(slug)
          this.logs.delete(slug)
          return
        }
        const log = this.logs.get(slug)
        if (log === undefined) {
          await this.loadWork(slug)
          return
        }
        await this.ensureCurrent(slug, log)
        const current = this.logs.get(slug) ?? log
        if (!isWorkDigest(this.digestOf(slug, current))) {
          // Its last events are in hand; leave the final state behind.
          await this.persistLog(slug, current)
          this.work.delete(slug)
          if (!current.pinned) this.logs.delete(slug)
        }
      })
    }
    for (const record of own) {
      await this.build(record.slug, async () => {
        if (this.work.has(record.slug)) return
        const digest = this.discovery.get(record.slug)
        if (digest !== undefined && !isWorkDigest(digest)) return
        await this.loadWork(record.slug)
        this.work.add(record.slug)
      })
    }
    // Unpinned logs read for one request do not outlive the epoch.
    for (const slug of [...this.logs.keys()]) {
      await this.build(slug, async () => {
        const log = this.logs.get(slug)
        if (log !== undefined && !this.work.has(slug) && !log.pinned) this.logs.delete(slug)
      })
    }
    // The cold start's replay is the expensive part to lose: leave it behind
    // now rather than only at the tick's end. Later epochs persist at the end.
    if (this.epoch === 1) await this.persistSnapshots({ cold: true })
  }

  private refreshRecords(): Promise<void> {
    return this.metaChain.run(async () => {
      // Cleared before the read: an own write that lands during it re-marks.
      this.recordsDirty = false
      try {
        this.records = await this.backing.listBuilds()
      } catch (error) {
        this.recordsDirty = true
        throw error
      }
    })
  }

  private refreshDiscovery(): Promise<void> {
    return this.metaChain.run(async () => {
      this.discoveryDirty = false
      try {
        this.discovery = await this.backing.getRepoBuildDigests(this.repo)
      } catch (error) {
        this.discoveryDirty = true
        throw error
      }
    })
  }

  /** The journal-only delta, for a stage that needs foreign journal appends
   * mid-tick (the ready scan) without paying for discovery. */
  async refreshJournal(): Promise<void> {
    if (!this.initialized) return this.ensureInit()
    // The build epoch is untouched: build logs stay current for this tick.
    await this.journalChain.run(() => this.syncJournal(true))
  }

  // ── Journal ────────────────────────────────────────────────────────────────

  private resetJournalState(): void {
    this.journal = []
    this.anchor = undefined
    this.journalCursor = 0
    this.journalWindow = undefined
    this.journalDirty = false
    this.persistedJournal = 0
  }

  /** Cold journal load. The true high-water mark is read before the bounded
   * subset: an event the subset excludes is never needed (a later anchor has a
   * higher seq and cannot pull earlier events into the tail), and everything
   * committed between the two reads is either returned or irrelevant. */
  private async loadJournal(opts: { snapshot?: boolean } = {}): Promise<void> {
    this.resetJournalState()
    if ((await this.backing.getRepo(this.repo)) === null) {
      this.recorded = false
      return
    }
    this.recorded = true
    if (opts.snapshot === true && (await this.restoreJournal())) return
    const high = await this.backing.getRepoHighWater(this.repo)
    const subset = await this.backing.getRepoStateEvents(this.repo)
    this.foldJournal(subset)
    this.journalCursor = Math.max(high, this.journalCursor)
    this.journalEpoch = this.epoch
  }

  /** Install the stored journal view and read only the events newer than its
   * cursor. Any shortfall — no snapshot, a malformed one, a failed or
   * non-contiguous delta — leaves the state reset and answers `false`, and the
   * caller replays in full. */
  private async restoreJournal(): Promise<boolean> {
    const scope: SnapshotScope = { kind: 'repo', repo: this.repo }
    const snapshot = await loadReducerSnapshot(
      this.backing,
      scope,
      SNAPSHOT_JOURNAL,
      journalViewReducer,
    )
    if (snapshot === null) return false
    const state = snapshot.state
    if (
      !isObject(state) ||
      !Array.isArray(state.retained) ||
      (state.anchor !== undefined && typeof state.anchor !== 'number') ||
      !retainedShape(state.retained, snapshot.cursor)
    ) {
      return false
    }
    try {
      const delta = (await this.backing.getRepoEvents(this.repo, snapshot.cursor)).filter(
        (event) => event.seq > snapshot.cursor,
      )
      if (!contiguousFrom(delta, snapshot.cursor)) return false
      this.journal = [...(state.retained as RepositoryEvent[])]
      this.anchor = state.anchor as number | undefined
      this.journalCursor = snapshot.cursor
      this.persistedJournal = snapshot.cursor
      this.foldJournal(delta)
      this.journalEpoch = this.epoch
      return true
    } catch {
      this.resetJournalState()
      this.recorded = true
      return false
    }
  }

  /** Restore the journal alone, ahead of the first `refresh()`, so the
   * lifecycle appends a process makes before its first tick fold into the view
   * and are not read back. Costs no listing, digest, or build read. */
  startJournal(): Promise<void> {
    return this.journalChain.run(async () => {
      if (this.journalReady || this.initialized) return
      await this.loadJournal({ snapshot: true })
      this.journalReady = true
    })
  }

  private async syncOrLoadJournal(): Promise<void> {
    if (!this.initialized) {
      if (this.journalReady) await this.syncJournal(true)
      else await this.loadJournal({ snapshot: true })
      this.initialized = true
    } else {
      await this.syncJournal(true)
    }
  }

  /** Bring the journal current: one delta read from the cursor (a repository
   * no tick has recorded yet is re-probed instead). Runs on the journal chain. */
  private async syncJournal(force = false): Promise<void> {
    if (!this.recorded) {
      if ((await this.backing.getRepo(this.repo)) === null) return
      await this.loadJournal({ snapshot: true })
      return
    }
    if (!force && !this.journalDirty && this.journalEpoch === this.epoch) return
    const read = await this.backing.getRepoEvents(this.repo, this.journalCursor)
    this.journalDirty = false
    this.journalEpoch = this.epoch
    const delta = read.filter((event) => event.seq > this.journalCursor)
    if (delta.length === 0) return
    if (!contiguousFrom(delta, this.journalCursor)) {
      // A hole: discard and re-read from scratch rather than skip an event.
      await this.loadJournal()
      return
    }
    this.foldJournal(delta)
  }

  /** Fold events newer than the cursor into the bounded subset and the window. */
  private foldJournal(events: readonly RepositoryEvent[]): void {
    for (const event of events) {
      if (event.seq <= this.journalCursor) continue
      this.journalCursor = event.seq
      // The same prune-on-arrival fold the registered `journalView` reducer
      // runs, so a snapshot of this state resumes identically.
      const acc: JournalViewAcc = { retained: this.journal }
      if (this.anchor !== undefined) acc.anchor = this.anchor
      foldJournalView(acc, [event])
      this.journal = acc.retained
      this.anchor = acc.anchor
      const window = this.journalWindow
      if (window !== undefined && event.seq > window.last) {
        window.events.push(event)
        window.last = event.seq
      }
    }
  }

  /** The bounded journal subset, `[]` for a repository no one has recorded. */
  recordedJournal(): RepositoryEvent[] {
    return [...this.journal]
  }

  /** Whether the repository's journal record exists. */
  journalRecorded(): boolean {
    return this.recorded
  }

  // ── Builds ─────────────────────────────────────────────────────────────────

  private digestOf(slug: string, log: Log): Omit<BuildDigest, 'slug'> {
    if (log.digest === undefined || log.digest.cursor !== log.cursor) {
      if (log.extra !== undefined) {
        const value = buildDigestReducer.finish(log.extra.buildDigest as never)
        log.digest = { cursor: log.cursor, value }
        return value
      }
      if (log.from > 0) {
        // A trimmed window cannot derive a digest; discovery owns that slug.
        const found = this.discovery.get(slug)
        if (found !== undefined) return found
      }
      log.digest = { cursor: log.cursor, value: reduceBuildDigest(log.events.map(digestRow)) }
    }
    return log.digest.value
  }

  /** Full read, installed as the slug's log. Runs on the build's chain. */
  private async loadFull(slug: string): Promise<Log> {
    const events = await this.backing.getEvents(slug)
    const previous = this.logs.get(slug)
    const log: Log = {
      from: 0,
      events,
      cursor: events.at(-1)?.seq ?? 0,
      dirty: false,
      epoch: this.epoch,
      persisted: previous?.persisted ?? 0,
      pinned: previous?.pinned ?? false,
    }
    this.logs.set(slug, log)
    return log
  }

  /** Install a work build's log, from its stored reducer state when there is
   * one. Runs on the build's chain. The snapshot-backed log holds only the
   * events newer than the snapshot, plus the accumulators for everything
   * before; any shortfall is a full read. */
  private async loadWork(slug: string): Promise<Log> {
    const restored = await this.restoreLog(slug)
    return restored ?? (await this.loadFull(slug))
  }

  private async restoreLog(slug: string): Promise<Log | null> {
    const scope: SnapshotScope = { kind: 'build', slug }
    const [build, ...rest] = await Promise.all([
      loadReducerSnapshot(this.backing, scope, 'build', buildReducer),
      ...EXTRA_NAMES.map((name) =>
        loadReducerSnapshot(this.backing, scope, name, EXTRA_REDUCERS[name]),
      ),
    ])
    // Every one must be present and describe the same prefix, else one is stale
    // (a write that did not finish) or missing: replay rather than mix prefixes.
    if (build === null || !buildAccShape(build)) return null
    const extra = {} as ExtraAccs
    for (const [at, name] of EXTRA_NAMES.entries()) {
      const found = rest[at]
      if (found === null || found === undefined || found.cursor !== build.cursor) return null
      if (!isObject(found.state)) return null
      extra[name] = found.state
    }
    if (!indexAccShape(extra.logIndex)) return null
    const cursor = build.cursor
    try {
      const delta = (await this.backing.getEvents(slug, cursor)).filter(
        (event) => event.seq > cursor,
      )
      if (!contiguousFrom(delta, cursor)) return null
      const log: Log = {
        from: cursor,
        events: [],
        cursor,
        dirty: false,
        epoch: this.epoch,
        acc: build.state as BuildAcc,
        extra,
        persisted: cursor,
        pinned: this.logs.get(slug)?.pinned ?? false,
      }
      // Exercise every projection a stage will derive, before the state is
      // installed: a structurally incomplete accumulator that passed the cheap
      // shape checks throws here and the build is replayed instead.
      this.probe(log)
      if (delta.length > 0) this.fold(log, delta)
      this.probe(log)
      this.logs.set(slug, log)
      return log
    } catch {
      return null
    }
  }

  /** Bring one log current: a single delta read from its cursor, skipped when
   * it was already brought current in this epoch and nothing marked it dirty.
   * Runs on the build's chain, so nothing marks the log while the read is in
   * flight. */
  private async ensureCurrent(slug: string, log: Log): Promise<void> {
    if (!log.dirty && log.epoch === this.epoch) return
    const read = await this.backing.getEvents(slug, log.cursor)
    log.dirty = false
    log.epoch = this.epoch
    const delta = read.filter((event) => event.seq > log.cursor)
    if (delta.length === 0) return
    if (!contiguousFrom(delta, log.cursor)) {
      await this.loadFull(slug)
      return
    }
    this.fold(log, delta)
  }

  /** Derive every projection of a log's accumulators (throws on malformed state). */
  private probe(log: Log): void {
    const extra = log.extra!
    buildReducer.finish(log.acc!)
    logIndexReducer.finish(extra.logIndex as never)
    openExecutionReducer.finish(extra.openExecution as never)
    openBuildWorkspaceReducer.finish(extra.openBuildWorkspace as never)
    const publication = publicationStateReducer.finish(extra.publicationState as never)
    publication.pending()
    publication.abandonedPending()
    publication.latestUncompletedRequest()
    lastExecutionOutcomeReducer.finish(extra.lastExecutionOutcome as never)
    buildDigestReducer.finish(extra.buildDigest as never)
  }

  private fold(log: Log, events: AbEvent[]): void {
    log.events.push(...events)
    log.cursor = events[events.length - 1]!.seq
    if (log.acc !== undefined) log.acc = buildReducer.advance(log.acc, events)
    if (log.extra !== undefined) {
      for (const name of EXTRA_NAMES) {
        // biome-ignore lint/suspicious/noExplicitAny: the table is heterogeneous
        const reducer = EXTRA_REDUCERS[name] as any
        log.extra[name] = reducer.advance(log.extra[name], events)
      }
    }
  }

  /** Make the three accumulators exist. Needs the full history unless they are
   * already held; the caller guarantees `from === 0` or all three present. */
  private ensureAccs(log: Log): void {
    log.acc ??= buildReducer.advance(buildReducer.initial(), log.events)
    if (log.extra === undefined) {
      const extra = {} as ExtraAccs
      for (const name of EXTRA_NAMES) {
        // biome-ignore lint/suspicious/noExplicitAny: the table is heterogeneous
        const reducer = EXTRA_REDUCERS[name] as any
        extra[name] = reducer.advance(reducer.initial(), log.events)
      }
      log.extra = extra
    }
  }

  private async openWindow(slug: string, since: number): Promise<Log> {
    if (this.work.has(slug)) return this.loadFull(slug)
    let log: Log
    if (this.resident) {
      // One pass over the log: reduce all of it, retain only what the reader
      // has not consumed.
      const all = await this.backing.getEvents(slug)
      log = {
        from: since,
        events: all.filter((event) => event.seq > since),
        cursor: all.at(-1)?.seq ?? 0,
        dirty: false,
        epoch: this.epoch,
        acc: buildReducer.advance(buildReducer.initial(), all),
        persisted: 0,
        pinned: true,
      }
    } else {
      const events = await this.backing.getEvents(slug, since)
      log = {
        from: since,
        events,
        cursor: Math.max(since, events.at(-1)?.seq ?? 0),
        dirty: false,
        epoch: this.epoch,
        persisted: 0,
        pinned: true,
      }
    }
    this.logs.set(slug, log)
    return log
  }

  async getEvents(
    slug: string,
    cursor?: number,
    opts?: { waitSeconds?: number; signal?: AbortSignal },
  ): Promise<AbEvent[]> {
    const sinceSeq = cursor ?? 0
    if (opts?.waitSeconds !== undefined || opts?.signal !== undefined) {
      return this.backing.getEvents(slug, sinceSeq, opts)
    }
    return this.build(slug, async () => {
      let log = this.logs.get(slug)
      if (log === undefined || sinceSeq < log.from) {
        log = await this.openWindow(slug, sinceSeq)
      } else if (cursor !== undefined) {
        // An explicit cursor, zero included, marks a cursor-bearing consumer
        // (the wake pass); an omitted one is a plain read.
        log.pinned = true
      }
      await this.ensureCurrent(slug, log)
      // `ensureCurrent` may have replaced the log after a gap.
      log = this.logs.get(slug) ?? log
      return log.events.filter((event) => event.seq > sinceSeq)
    })
  }

  /** Take one build's delta now, even if it was already read this epoch — for
   * the decisions that deliberately re-read at the last possible moment so a
   * concurrent writer's cancellation or request is honored. */
  async refreshBuild(slug: string): Promise<void> {
    await this.build(slug, async () => {
      const log = this.logs.get(slug)
      if (log === undefined) return
      log.dirty = true
      await this.ensureCurrent(slug, log)
    })
  }

  /** The reduced state of one build without replaying history the view already
   * folded: a held log is reduced in place; a resident window brings itself
   * current and finishes its accumulator; anything else is one full read,
   * then held. */
  buildState(slug: string): Promise<BuildState> {
    return this.build(slug, async () => {
      let log = this.logs.get(slug)
      if (log === undefined || (log.from > 0 && log.acc === undefined)) {
        log = await this.loadFull(slug)
      }
      await this.ensureCurrent(slug, log)
      log = this.logs.get(slug) ?? log
      return log.acc !== undefined ? buildReducer.finish(log.acc) : reduceBuild(log.events)
    })
  }

  /** The reduced facts of one build — state, log index, open execution —
   * brought current with one delta read, without its event array: a work
   * build restored from snapshots answers from the accumulators. A log that is
   * not snapshot-backed is reduced from its events (a full read the first
   * time), and keeps the accumulators from then on. */
  buildFacts(slug: string): Promise<BuildFacts> {
    return this.build(slug, async () => {
      let log = this.logs.get(slug)
      if (log === undefined) {
        log = this.work.has(slug) ? await this.loadWork(slug) : await this.loadFull(slug)
      } else if (log.from > 0 && !hasAccs(log)) {
        log = await this.loadFull(slug)
      }
      await this.ensureCurrent(slug, log)
      log = this.logs.get(slug) ?? log
      this.ensureAccs(log)
      const extra = log.extra!
      return {
        state: buildReducer.finish(log.acc!),
        log: logIndexReducer.finish(extra.logIndex as never),
        open: openExecutionReducer.finish(extra.openExecution as never),
        workspace: openBuildWorkspaceReducer.finish(extra.openBuildWorkspace as never),
        publication: publicationStateReducer.finish(extra.publicationState as never),
        lastExecution: lastExecutionOutcomeReducer.finish(extra.lastExecutionOutcome as never),
      }
    })
  }

  // ── Snapshots ──────────────────────────────────────────────────────────────

  /** Write one work log's reducer state back to the snapshot store, if it has
   * advanced past what was last read or written. Runs on the build's chain.
   * Best effort: a failure leaves the cursor so the next call retries. A log
   * that is dirty (a foreign append not yet read) or trimmed without its
   * accumulators is skipped — only a cursor read from the log is persisted. */
  private async persistLog(slug: string, log: Log): Promise<void> {
    if (log.dirty || log.cursor <= log.persisted) return
    if (log.from > 0 && !hasAccs(log)) return
    this.ensureAccs(log)
    const scope: SnapshotScope = { kind: 'build', slug }
    const cursor = log.cursor
    const version = (reducer: { version: number }, state: unknown): ReducerSnapshot => ({
      version: reducer.version,
      cursor,
      state,
    })
    const extra = log.extra!
    const writes = [
      persistReducerSnapshot(this.backing, scope, 'build', version(buildReducer, log.acc)),
      ...EXTRA_NAMES.map((name) =>
        persistReducerSnapshot(
          this.backing,
          scope,
          name,
          version(EXTRA_REDUCERS[name], extra[name]),
        ),
      ),
    ]
    await Promise.all(writes)
    log.persisted = Math.max(log.persisted, cursor)
  }

  /** Write the journal view back when it has advanced. Runs on the journal chain. */
  private async persistJournal(): Promise<void> {
    if (!this.recorded || this.journalDirty || this.journalCursor <= this.persistedJournal) return
    const cursor = this.journalCursor
    const state: JournalViewAcc = {
      ...(this.anchor !== undefined ? { anchor: this.anchor } : {}),
      retained: [...this.journal],
    }
    await persistReducerSnapshot(
      this.backing,
      { kind: 'repo', repo: this.repo },
      SNAPSHOT_JOURNAL,
      { version: JOURNAL_VIEW_REDUCER_VERSION, cursor, state },
    )
    this.persistedJournal = Math.max(this.persistedJournal, cursor)
  }

  /** Persist every source that advanced since it was read or last written: the
   * journal view and each work build. A resident view throttles repeated
   * persists; `force` and a process's first persist always run. The snapshots
   * are a cache — nothing here can fail the caller. */
  async persistSnapshots(opts: { force?: boolean; cold?: boolean } = {}): Promise<void> {
    if (!this.initialized && !this.journalReady) return
    const now = this.now()
    if (opts.cold !== true) {
      if (
        opts.force !== true &&
        this.lastPersistAt !== undefined &&
        now - this.lastPersistAt < PERSIST_MIN_INTERVAL_MS
      ) {
        return
      }
      this.lastPersistAt = now
    }
    try {
      await this.journalChain.run(() => this.persistJournal())
    } catch {
      // A cache: the next call retries.
    }
    const slugs = [...this.work].filter((slug) => {
      const log = this.logs.get(slug)
      return log !== undefined && log.cursor > log.persisted
    })
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < slugs.length) {
        const slug = slugs[next++]!
        try {
          await this.build(slug, async () => {
            const log = this.logs.get(slug)
            if (log !== undefined) await this.persistLog(slug, log)
          })
        } catch {
          // A cache: the next call retries.
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(PERSIST_CONCURRENCY, slugs.length) }, worker))
  }

  /** Drop retained events at or below `minCursor` for a windowed source — the
   * wake pass calls this once its sessions have consumed them. Only sources
   * that carry reduced state for what they drop can be trimmed. */
  releaseWindowsBelow(source: WindowSource, minCursor: number): void {
    if (source === 'journal') {
      const window = this.journalWindow
      if (window === undefined || minCursor <= window.from) return
      window.events = window.events.filter((event) => event.seq > minCursor)
      window.from = minCursor
      window.last = Math.max(window.last, minCursor)
      return
    }
    const log = this.logs.get(source.build)
    if (log === undefined || log.acc === undefined || this.work.has(source.build)) return
    if (minCursor <= log.from) return
    log.events = log.events.filter((event) => event.seq > minCursor)
    log.from = minCursor
  }

  async listBuilds(): Promise<BuildRecord[]> {
    await this.ensureInit()
    if (this.recordsDirty) await this.refreshRecords()
    return this.records.map((record) => structuredClone(record))
  }

  async getRepoBuildDigests(repo: string): Promise<Map<string, BuildDigest>> {
    if (repo !== this.repo) return this.backing.getRepoBuildDigests(repo)
    const records = (await this.listBuilds()).filter((record) => record.repo === repo)
    const missing = (): boolean =>
      records.some((record) => !this.work.has(record.slug) && !this.discovery.has(record.slug))
    if (this.discoveryDirty || missing()) await this.refreshDiscovery()
    const digests = new Map<string, BuildDigest>()
    for (const record of records) {
      const slug = record.slug
      const digest = await this.build(slug, async () => {
        // A log invalidated by an own write resolves before it feeds a digest.
        const held = this.logs.get(slug)
        if (held?.dirty === true) await this.ensureCurrent(slug, held)
        const log = this.logs.get(slug)
        if (
          this.work.has(slug) &&
          log !== undefined &&
          (log.from === 0 || log.extra !== undefined)
        ) {
          return { slug, ...this.digestOf(slug, log) }
        }
        return this.discovery.get(slug)
      })
      if (digest !== undefined) digests.set(slug, digest)
    }
    return digests
  }

  // ── Repository journal reads ───────────────────────────────────────────────

  async getRepoEvents(
    repo: string,
    sinceSeq = 0,
    opts?: { waitSeconds?: number; signal?: AbortSignal },
  ): Promise<RepositoryEvent[]> {
    if (repo !== this.repo || opts?.waitSeconds !== undefined || opts?.signal !== undefined) {
      return this.backing.getRepoEvents(repo, sinceSeq, opts)
    }
    await this.ensureInit()
    return this.journalChain.run(async () => {
      await this.syncJournal()
      if (!this.recorded) return this.backing.getRepoEvents(repo, sinceSeq)
      let window = this.journalWindow
      if (window === undefined || sinceSeq < window.from) {
        const events = await this.backing.getRepoEvents(repo, sinceSeq)
        window = {
          from: sinceSeq,
          events,
          last: Math.max(sinceSeq, events.at(-1)?.seq ?? 0),
        }
        this.journalWindow = window
        // Anything newer than the cursor feeds the bounded subset too.
        this.foldJournal(events)
      }
      return window.events.filter((event) => event.seq > sinceSeq)
    })
  }

  async getRepoStateEvents(repo: string): Promise<RepositoryEvent[]> {
    if (repo !== this.repo) return this.backing.getRepoStateEvents(repo)
    await this.ensureInit()
    return this.journalChain.run(async () => {
      await this.syncJournal()
      if (!this.recorded) return this.backing.getRepoStateEvents(repo)
      return [...this.journal]
    })
  }

  getReducerSnapshot(
    scope: SnapshotScope,
    reducer: string,
    version: number,
  ): Promise<ReducerSnapshot | null> {
    return this.backing.getReducerSnapshot(scope, reducer, version)
  }

  putReducerSnapshot(
    scope: SnapshotScope,
    reducer: string,
    snapshot: ReducerSnapshot,
  ): Promise<boolean> {
    return this.backing.putReducerSnapshot(scope, reducer, snapshot)
  }

  async getRepoHighWater(repo: string): Promise<number> {
    return this.backing.getRepoHighWater(repo)
  }

  // ── Writes: delegate, then fold ────────────────────────────────────────────

  /** Fold an own build append on the build's chain, after any read in flight:
   * contiguous folds in place, a gap (a foreign append interleaved) marks the
   * log dirty so the next read deltas. */
  private foldBuildAppend(slug: string, envelope: AbEvent): Promise<void> {
    return this.build(slug, async () => {
      this.recordsDirty = true
      const log = this.logs.get(slug)
      if (log === undefined) {
        // An append to a build the view holds no log for may change its digest.
        this.discoveryDirty = true
        return
      }
      if (envelope.seq <= log.cursor) return
      if (envelope.seq === log.cursor + 1) this.fold(log, [envelope])
      else log.dirty = true
    })
  }

  /** Fold an own journal append on the journal chain. A seq gap means a foreign
   * append interleaved: repair it now, because stages snapshot the journal
   * synchronously through `recordedJournal()` and must see our own write. */
  private foldJournalAppend(envelope: RepositoryEvent): Promise<void> {
    return this.journalChain.run(async () => {
      // Before the cold load there is no journal state to extend; it reads the
      // journal, this append included.
      if (!this.initialized && !this.journalReady) return
      this.recorded = true
      if (envelope.seq <= this.journalCursor) return
      if (envelope.seq === this.journalCursor + 1) {
        this.foldJournal([envelope])
        return
      }
      this.journalDirty = true
      await this.syncJournal()
    })
  }

  async createBuild(input: NewBuildInput): Promise<BuildRecord> {
    const record = await this.backing.createBuild(input)
    this.recordsDirty = true
    if (record.repo === this.repo) {
      await this.build(record.slug, async () => {
        await this.loadFull(record.slug)
        this.work.add(record.slug)
      })
    }
    return record
  }

  async append<T extends EventType>(slug: string, event: EventWrite<T>): Promise<EventEnvelope<T>> {
    const envelope = await this.backing.append(slug, event)
    await this.foldBuildAppend(slug, envelope as unknown as AbEvent)
    return envelope
  }

  async appendIfCurrent<T extends EventType>(
    slug: string,
    expectedSeq: number,
    event: EventWrite<T>,
  ): Promise<EventEnvelope<T> | null> {
    const envelope = await this.backing.appendIfCurrent(slug, expectedSeq, event)
    if (envelope === null) {
      await this.build(slug, async () => {
        const log = this.logs.get(slug)
        if (log !== undefined) log.dirty = true
      })
      return null
    }
    await this.foldBuildAppend(slug, envelope as unknown as AbEvent)
    return envelope
  }

  async appendWithArtifacts<T extends EventType>(
    slug: string,
    artifacts: ArtifactInput[],
    makeEvent: (deposited: ArtifactMeta[]) => EventWrite<T>,
  ): Promise<{ event: EventEnvelope<T>; artifacts: ArtifactMeta[] }> {
    const result = await this.backing.appendWithArtifacts(slug, artifacts, makeEvent)
    await this.foldBuildAppend(slug, result.event as unknown as AbEvent)
    return result
  }

  async appendRepo<T extends RepositoryEventType>(
    repo: string,
    event: RepositoryEventWrite<T>,
  ): Promise<RepositoryEventEnvelope<T>> {
    const envelope = await this.backing.appendRepo(repo, event)
    if (repo === this.repo) await this.foldJournalAppend(envelope as unknown as RepositoryEvent)
    return envelope
  }

  async appendRepoWithArtifacts<T extends RepositoryEventType>(
    repo: string,
    artifacts: ArtifactInput[],
    makeEvent: (deposited: RepositoryArtifactMeta[]) => RepositoryEventWrite<T>,
  ): Promise<{ event: RepositoryEventEnvelope<T>; artifacts: RepositoryArtifactMeta[] }> {
    const result = await this.backing.appendRepoWithArtifacts(repo, artifacts, makeEvent)
    if (repo === this.repo) await this.foldJournalAppend(result.event as unknown as RepositoryEvent)
    return result
  }

  async claimLease(slug: string, holder: string, ttlMs: number): Promise<boolean> {
    const claimed = await this.backing.claimLease(slug, holder, ttlMs)
    this.recordsDirty = true
    return claimed
  }

  async heartbeat(slug: string, holder: string): Promise<boolean> {
    const beat = await this.backing.heartbeat(slug, holder)
    this.recordsDirty = true
    return beat
  }

  async releaseLease(slug: string, holder: string): Promise<void> {
    await this.backing.releaseLease(slug, holder)
    this.recordsDirty = true
  }

  async ensureRepo(repo: string): Promise<RepositoryRecord> {
    return this.backing.ensureRepo(repo)
  }

  // ── Plain delegation ───────────────────────────────────────────────────────

  scopeBuild(slug: string): BuildScopedStore {
    return createBuildScopedStore(this, slug)
  }
  scopeSession(id: string): SessionScopedStore {
    return createSessionScopedStore(this, id)
  }
  getBuild(slug: string): Promise<BuildRecord | null> {
    return this.backing.getBuild(slug)
  }
  putArtifact(slug: string, artifact: ArtifactInput): Promise<ArtifactMeta> {
    return this.backing.putArtifact(slug, artifact)
  }
  getArtifact(slug: string, kind: string, rev?: number): Promise<Artifact | null> {
    return this.backing.getArtifact(slug, kind, rev)
  }
  listArtifacts(slug: string, kind?: string): Promise<ArtifactMeta[]> {
    return this.backing.listArtifacts(slug, kind)
  }
  subscribe(slug: string, opts: SubscribeOptions, onEvent: (event: AbEvent) => void): Unsubscribe {
    return this.backing.subscribe(slug, opts, onEvent)
  }
  getRepo(repo: string): Promise<RepositoryRecord | null> {
    return this.backing.getRepo(repo)
  }
  putRepoArtifact(repo: string, artifact: ArtifactInput): Promise<RepositoryArtifactMeta> {
    return this.backing.putRepoArtifact(repo, artifact)
  }
  getRepoArtifact(repo: string, kind: string, rev?: number): Promise<RepositoryArtifact | null> {
    return this.backing.getRepoArtifact(repo, kind, rev)
  }
  listRepoArtifacts(repo: string, kind?: string): Promise<RepositoryArtifactMeta[]> {
    return this.backing.listRepoArtifacts(repo, kind)
  }
  ticketAssetLimits(repo: string): Promise<TicketAssetLimits> {
    return this.backing.ticketAssetLimits(repo)
  }
  putTicketAsset(
    repo: string,
    ticketId: string,
    asset: TicketAssetInput,
  ): Promise<TicketAssetMeta> {
    return this.backing.putTicketAsset(repo, ticketId, asset)
  }
  getTicketAsset(
    repo: string,
    ticketId: string,
    kind: string,
    name: string,
    rev?: number,
  ): Promise<TicketAsset | null> {
    return this.backing.getTicketAsset(repo, ticketId, kind, name, rev)
  }
  getPinnedTicketAsset(
    slug: string,
    kind: string,
    name: string,
    rev?: number,
  ): Promise<TicketAsset | null> {
    return this.backing.getPinnedTicketAsset(slug, kind, name, rev)
  }
  listTicketAssets(
    repo: string,
    ticketId: string,
    opts?: { revisions?: boolean },
  ): Promise<TicketAssetSummary[]> {
    return this.backing.listTicketAssets(repo, ticketId, opts)
  }
  removeTicketAsset(
    repo: string,
    ticketId: string,
    kind: string,
    name: string,
  ): Promise<TicketAssetMeta | null> {
    return this.backing.removeTicketAsset(repo, ticketId, kind, name)
  }
  claimRepoLease(repo: string, holder: string, ttlMs: number): Promise<boolean> {
    return this.backing.claimRepoLease(repo, holder, ttlMs)
  }
  heartbeatRepo(repo: string, holder: string): Promise<boolean> {
    return this.backing.heartbeatRepo(repo, holder)
  }
  releaseRepoLease(repo: string, holder: string): Promise<void> {
    return this.backing.releaseRepoLease(repo, holder)
  }
  createSession(input: NewSessionInput): Promise<SessionRecord> {
    return this.backing.createSession(input)
  }
  getSession(id: string): Promise<SessionRecord | null> {
    return this.backing.getSession(id)
  }
  listSessions(repo: string): Promise<SessionRecord[]> {
    return this.backing.listSessions(repo)
  }
  appendSessionEvent<T extends SessionEventType>(
    id: string,
    event: SessionEventWrite<T>,
  ): Promise<SessionEventEnvelope<T>> {
    return this.backing.appendSessionEvent(id, event)
  }
  appendSessionEventIfCurrent<T extends SessionEventType>(
    id: string,
    expectedSeq: number,
    event: SessionEventWrite<T>,
  ): Promise<SessionEventEnvelope<T> | null> {
    return this.backing.appendSessionEventIfCurrent(id, expectedSeq, event)
  }
  getSessionEvents(
    id: string,
    sinceSeq?: number,
    opts?: { waitSeconds?: number; signal?: AbortSignal },
  ): Promise<SessionEvent[]> {
    return this.backing.getSessionEvents(id, sinceSeq, opts)
  }
  appendSessionWithArtifacts<T extends SessionEventType>(
    id: string,
    artifacts: ArtifactInput[],
    makeEvent: (deposited: SessionArtifactMeta[]) => SessionEventWrite<T>,
  ): Promise<{ event: SessionEventEnvelope<T>; artifacts: SessionArtifactMeta[] }> {
    return this.backing.appendSessionWithArtifacts(id, artifacts, makeEvent)
  }
  putSessionArtifact(id: string, artifact: ArtifactInput): Promise<SessionArtifactMeta> {
    return this.backing.putSessionArtifact(id, artifact)
  }
  getSessionArtifact(id: string, kind: string, rev?: number): Promise<SessionArtifact | null> {
    return this.backing.getSessionArtifact(id, kind, rev)
  }
  listSessionArtifacts(id: string, kind?: string): Promise<SessionArtifactMeta[]> {
    return this.backing.listSessionArtifacts(id, kind)
  }
  createStream(scope: StreamScope, label: string): Promise<StreamRecord> {
    return this.backing.createStream(scope, label)
  }
  appendStreamParts(streamId: string, parts: StreamPart[]): Promise<StreamChunk> {
    return this.backing.appendStreamParts(streamId, parts)
  }
  readStream(
    streamId: string,
    opts?: { since?: number; waitSeconds?: number; signal?: AbortSignal },
  ): Promise<StreamRead> {
    return this.backing.readStream(streamId, opts)
  }
  closeStream(streamId: string, outcome: StreamOutcome): Promise<StreamRecord> {
    return this.backing.closeStream(streamId, outcome)
  }
  getStream(streamId: string): Promise<StreamRecord | null> {
    return this.backing.getStream(streamId)
  }
  listStreams(scope: StreamScope): Promise<StreamRecord[]> {
    return this.backing.listStreams(scope)
  }
  close(): Promise<void> {
    return this.backing.close()
  }
}

/** Cheap structural checks on a stored accumulator: a snapshot that fails one
 * is a miss. They guard a hand-edited or truncated row; a well-formed row of the
 * right version is the reducer's own output. */
function buildAccShape(snapshot: ReducerSnapshot): boolean {
  const state = snapshot.state
  return (
    isObject(state) && Array.isArray(state.openEscalations) && Array.isArray(state.observations)
  )
}

function indexAccShape(state: unknown): boolean {
  return (
    isObject(state) &&
    Array.isArray(state.candidates) &&
    isObject(state.maxRoundEver) &&
    Array.isArray(state.guidanceDeliveries)
  )
}

/** Events are a contiguous run starting right after `cursor`. */
function contiguousFrom(events: readonly { seq: number }[], cursor: number): boolean {
  let expected = cursor + 1
  for (const event of events) {
    if (event.seq !== expected) return false
    expected += 1
  }
  return true
}
