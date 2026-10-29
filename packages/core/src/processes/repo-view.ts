import type { OperatorIdentity, OperatorPresence } from '../store/operator-presence'
import { readBuildDigests } from '../store/reduced-reads'
/** Repository-scoped sequencing and metadata coordination. Current reductions
 * come exclusively from persisted values; raw methods return actual event output. */
import {
  readBuildFacts,
  readPersistedBuildDigests,
  readRepositoryFacts,
  type CurrentBuildFacts,
  type RepositoryReadFacts,
} from '../store/reduced-reads'
import { repositoryReadFactsReducer } from '../kernel/read-facts'
import type { ReducerValueRequest, ReducerValue } from '../store/reducer-values'
import type { AbEvent, EventEnvelope, EventWrite } from '../events/catalog'
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
import type { BuildState } from '../kernel/reducer'
import { createBuildScopedStore } from '../store/build-scope'
import type { ReducerSnapshot, SnapshotScope } from '../store/snapshots'
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

/** The write committed; only the subsequent local projection refresh failed. */
export class CommittedRefreshError<T = unknown> extends Error {
  constructor(
    readonly result: T,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'CommittedRefreshError'
  }
}

export interface RepoViewOptions {
  repo: string
  resident?: boolean
  now?: () => number
}
export type WindowSource = { build: string } | 'journal'
export type BuildFacts = CurrentBuildFacts
export function isWorkDigest(digest: Omit<BuildDigest, 'slug'>): boolean {
  return (
    digest.terminal === undefined ||
    digest.terminal === 'aborted' ||
    digest.reclaimPending === true ||
    digest.executionOpen === true
  )
}
class Chain {
  private tail: Promise<unknown> = Promise.resolve()
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task)
    this.tail = result.catch(() => {})
    return result
  }
}
interface RawWindow<E> {
  from: number
  cursor: number
  events: E[]
  epoch: number
  dirty: boolean
}
export class RepoViewStore implements BuildStore {
  private epoch = 0
  private readonly windows = new Map<string, RawWindow<AbEvent>>()
  private journalWindow?: RawWindow<RepositoryEvent>
  private readonly repo: string
  private readonly builds = new Map<string, Chain>()
  private readonly journalChain = new Chain()
  private readonly metaChain = new Chain()
  private initialized = false
  private recorded = false
  private records: BuildRecord[] = []
  private recordsDirty = true
  private discovery = new Map<string, BuildDigest>()
  private readonly dirtyDigests = new Set<string>()
  private discoveryDirty = true
  private repoFacts = repositoryReadFactsReducer.finish(repositoryReadFactsReducer.initial())
  constructor(
    private readonly backing: BuildStore,
    opts: RepoViewOptions,
  ) {
    this.repo = opts.repo
  }
  private build<T>(slug: string, task: () => Promise<T>): Promise<T> {
    let chain = this.builds.get(slug)
    if (!chain) {
      chain = new Chain()
      this.builds.set(slug, chain)
    }
    return chain.run(task)
  }
  async refresh(): Promise<void> {
    this.epoch++
    await this.refreshJournal()
    await this.metaChain.run(async () => {
      this.recordsDirty = false
      this.discoveryDirty = false
      this.dirtyDigests.clear()
      this.records = await this.backing.listBuilds()
      this.discovery = await readBuildDigests(this.backing, this.repo)
      this.initialized = true
    })
  }
  async startJournal(): Promise<void> {
    await this.refreshJournal()
  }
  async refreshJournal(): Promise<void> {
    if (this.journalWindow) this.journalWindow.dirty = true
    await this.journalChain.run(async () => {
      const recorded = (await this.backing.getRepo(this.repo)) !== null
      const facts = (await readRepositoryFacts(this.backing, this.repo, recorded)).value
      this.recorded = recorded
      this.repoFacts = facts
    })
  }
  repositoryFacts(): RepositoryReadFacts {
    return structuredClone(this.repoFacts)
  }
  journalRecorded(): boolean {
    return this.recorded
  }
  async refreshBuild(slug: string): Promise<void> {
    await this.build(slug, async () => {})
  }
  buildState(slug: string): Promise<BuildState> {
    return this.build(slug, async () => (await readBuildFacts(this.backing, slug)).value.state)
  }
  buildFacts(slug: string): Promise<CurrentBuildFacts> {
    return this.build(slug, async () => (await readBuildFacts(this.backing, slug)).value)
  }
  getRepoChangePosition(repo: string): Promise<string> {
    return this.backing.getRepoChangePosition(repo)
  }

  listBuildsForRepo(repo: string): Promise<BuildRecord[]> {
    return this.backing.listBuildsForRepo(repo)
  }

  async listBuilds(): Promise<BuildRecord[]> {
    if (!this.initialized) await this.refresh()
    return this.metaChain.run(async () => {
      if (this.recordsDirty) {
        this.recordsDirty = false
        this.records = await this.backing.listBuilds()
      }
      return structuredClone(this.records)
    })
  }
  async getRepoBuildDigests(repo: string): Promise<Map<string, BuildDigest>> {
    if (repo !== this.repo) return this.backing.getRepoBuildDigests(repo)
    await this.listBuilds()
    return this.metaChain.run(async () => {
      if (this.discoveryDirty) {
        this.discoveryDirty = false
        this.discovery = await readBuildDigests(this.backing, repo)
      }
      if (this.dirtyDigests.size) {
        const records = this.records.filter((record) => this.dirtyDigests.has(record.slug))
        this.dirtyDigests.clear()
        try {
          for (const [slug, digest] of await readPersistedBuildDigests(this.backing, repo, records))
            this.discovery.set(slug, digest)
        } catch (error) {
          for (const record of records) this.dirtyDigests.add(record.slug)
          throw error
        }
      }
      const missing = this.records.filter(
        (record) => record.repo === repo && !this.discovery.has(record.slug),
      )
      if (missing.length)
        for (const [slug, digest] of await readPersistedBuildDigests(this.backing, repo, missing))
          this.discovery.set(slug, digest)
      return structuredClone(this.discovery)
    })
  }
  async getEvents(
    slug: string,
    sinceSeq = 0,
    opts?: { waitSeconds?: number; signal?: AbortSignal },
  ): Promise<AbEvent[]> {
    if (opts?.waitSeconds !== undefined || opts?.signal !== undefined)
      return this.backing.getEvents(slug, sinceSeq, opts)
    return this.build(slug, async () => {
      let window = this.windows.get(slug)
      if (!window || sinceSeq < window.from) {
        const events = await this.backing.getEvents(slug, sinceSeq)
        window = {
          from: sinceSeq,
          cursor: Math.max(sinceSeq, events.at(-1)?.seq ?? 0),
          events,
          epoch: this.epoch,
          dirty: false,
        }
        this.windows.set(slug, window)
      } else if (window.dirty || window.epoch !== this.epoch) {
        let delta = await this.backing.getEvents(slug, window.cursor)
        if (delta.some((event, index) => event.seq !== window!.cursor + index + 1)) {
          delta = await this.backing.getEvents(slug, window.from)
          window.events = []
        }
        window.events.push(...delta)
        window.cursor = delta.at(-1)?.seq ?? window.cursor
        window.epoch = this.epoch
        window.dirty = false
      }
      return structuredClone(window.events.filter((event) => event.seq > sinceSeq))
    })
  }
  async getRepoEvents(
    repo: string,
    sinceSeq = 0,
    opts?: { waitSeconds?: number; signal?: AbortSignal },
  ): Promise<RepositoryEvent[]> {
    if (repo !== this.repo || opts?.waitSeconds !== undefined || opts?.signal !== undefined)
      return this.backing.getRepoEvents(repo, sinceSeq, opts)
    return this.journalChain.run(async () => {
      let window = this.journalWindow
      if (!window || sinceSeq < window.from) {
        const events = await this.backing.getRepoEvents(repo, sinceSeq)
        window = {
          from: sinceSeq,
          cursor: Math.max(sinceSeq, events.at(-1)?.seq ?? 0),
          events,
          epoch: this.epoch,
          dirty: false,
        }
        this.journalWindow = window
      } else if (window.dirty || window.epoch !== this.epoch) {
        let delta = await this.backing.getRepoEvents(repo, window.cursor)
        if (delta.some((event, index) => event.seq !== window!.cursor + index + 1)) {
          delta = await this.backing.getRepoEvents(repo, window.from)
          window.events = []
        }
        window.events.push(...delta)
        window.cursor = delta.at(-1)?.seq ?? window.cursor
        window.epoch = this.epoch
        window.dirty = false
      }
      return structuredClone(window.events.filter((event) => event.seq > sinceSeq))
    })
  }
  getRepoStateEvents(repo: string): Promise<RepositoryEvent[]> {
    return this.backing.getRepoStateEvents(repo)
  }
  getReducerValue(scope: SnapshotScope, request: ReducerValueRequest): Promise<ReducerValue> {
    return this.backing.getReducerValue(scope, request)
  }
  getReducerSnapshot(
    scope: SnapshotScope,
    name: string,
    version: number,
  ): Promise<ReducerSnapshot | null> {
    return this.backing.getReducerSnapshot(scope, name, version)
  }
  putReducerSnapshot(
    scope: SnapshotScope,
    name: string,
    snapshot: ReducerSnapshot,
  ): Promise<boolean> {
    return this.backing.putReducerSnapshot(scope, name, snapshot)
  }
  getRepoHighWater(repo: string): Promise<number> {
    return this.backing.getRepoHighWater(repo)
  }
  // Raw windows are owned by their cursor consumers, and values persist at the adapter boundary.
  releaseWindowsBelow(source: WindowSource, minCursor: number): void {
    const trim = <E extends { seq: number }>(window: RawWindow<E> | undefined): void => {
      if (!window || minCursor <= window.from) return
      window.events = window.events.filter((event) => event.seq > minCursor)
      window.from = minCursor
      window.cursor = Math.max(window.cursor, minCursor)
    }
    if (source === 'journal') trim(this.journalWindow)
    else trim(this.windows.get(source.build))
  }

  private foldBuildAppend(slug: string, event: AbEvent): void {
    const window = this.windows.get(slug)
    if (!window || event.seq <= window.cursor) return
    if (event.seq !== window.cursor + 1) {
      window.dirty = true
      return
    }
    window.events.push(event)
    window.cursor = event.seq
  }
  private invalidate(slug?: string): void {
    this.recordsDirty = true
    if (slug) this.dirtyDigests.add(slug)
  }
  async createBuild(input: NewBuildInput): Promise<BuildRecord> {
    const record = await this.backing.createBuild(input)
    this.invalidate(input.slug)
    return record
  }
  append<T extends EventType>(slug: string, event: EventWrite<T>): Promise<EventEnvelope<T>> {
    return this.build(slug, async () => {
      const result = await this.backing.append(slug, event)
      this.foldBuildAppend(slug, result as AbEvent)
      this.invalidate(slug)
      return result
    })
  }
  appendIfCurrent<T extends EventType>(
    slug: string,
    expectedSeq: number,
    event: EventWrite<T>,
  ): Promise<EventEnvelope<T> | null> {
    return this.build(slug, async () => {
      const result = await this.backing.appendIfCurrent(slug, expectedSeq, event)
      if (result) this.foldBuildAppend(slug, result as AbEvent)
      else {
        const window = this.windows.get(slug)
        if (window) window.dirty = true
      }
      this.invalidate(slug)
      return result
    })
  }
  appendWithArtifacts<T extends EventType>(
    slug: string,
    artifacts: ArtifactInput[],
    makeEvent: (deposited: ArtifactMeta[]) => EventWrite<T>,
  ): Promise<{ event: EventEnvelope<T>; artifacts: ArtifactMeta[] }> {
    return this.build(slug, async () => {
      const result = await this.backing.appendWithArtifacts(slug, artifacts, makeEvent)
      this.foldBuildAppend(slug, result.event as AbEvent)
      this.invalidate(slug)
      return result
    })
  }
  appendWithArtifactsIfCurrent<T extends EventType>(
    slug: string,
    expectedSeq: number,
    artifacts: ArtifactInput[],
    makeEvent: (deposited: ArtifactMeta[]) => EventWrite<T>,
  ): Promise<{ event: EventEnvelope<T>; artifacts: ArtifactMeta[] } | null> {
    return this.build(slug, async () => {
      const result = await this.backing.appendWithArtifactsIfCurrent(
        slug,
        expectedSeq,
        artifacts,
        makeEvent,
      )
      if (result) this.foldBuildAppend(slug, result.event as AbEvent)
      else {
        const window = this.windows.get(slug)
        if (window) window.dirty = true
      }
      this.invalidate(slug)
      return result
    })
  }
  private foldJournalAppend(event: RepositoryEvent): void {
    const window = this.journalWindow
    if (window && event.seq > window.cursor) {
      if (event.seq === window.cursor + 1) {
        window.events.push(event)
        window.cursor = event.seq
      } else window.dirty = true
    }
  }
  private async refreshCommitted<T>(result: T): Promise<T> {
    try {
      await this.refreshJournal()
    } catch (error) {
      throw new CommittedRefreshError(result, error)
    }
    return result
  }
  async appendRepo<T extends RepositoryEventType>(
    repo: string,
    event: RepositoryEventWrite<T>,
  ): Promise<RepositoryEventEnvelope<T>> {
    const result = await this.backing.appendRepo(repo, event)
    if (repo === this.repo) {
      this.foldJournalAppend(result as RepositoryEvent)
      return this.refreshCommitted(result)
    }
    return result
  }
  async appendRepoWithArtifacts<T extends RepositoryEventType>(
    repo: string,
    artifacts: ArtifactInput[],
    makeEvent: (deposited: RepositoryArtifactMeta[]) => RepositoryEventWrite<T>,
  ): Promise<{ event: RepositoryEventEnvelope<T>; artifacts: RepositoryArtifactMeta[] }> {
    const result = await this.backing.appendRepoWithArtifacts(repo, artifacts, makeEvent)
    if (repo === this.repo) {
      this.foldJournalAppend(result.event as RepositoryEvent)
      return this.refreshCommitted(result)
    }
    return result
  }
  async claimNodeWriter(slug: string, holder: string, ttlMs: number): Promise<boolean> {
    return this.backing.claimNodeWriter(slug, holder, ttlMs)
  }
  async renewNodeWriter(slug: string, holder: string): Promise<boolean> {
    return this.backing.renewNodeWriter(slug, holder)
  }
  async releaseNodeWriter(slug: string, holder: string): Promise<void> {
    return this.backing.releaseNodeWriter(slug, holder)
  }
  async claimLease(slug: string, holder: string, ttlMs: number): Promise<boolean> {
    const result = await this.backing.claimLease(slug, holder, ttlMs)
    this.invalidate()
    return result
  }
  async heartbeat(slug: string, holder: string): Promise<boolean> {
    const result = await this.backing.heartbeat(slug, holder)
    this.invalidate()
    return result
  }
  async releaseLease(slug: string, holder: string): Promise<void> {
    await this.backing.releaseLease(slug, holder)
    this.invalidate()
  }
  upsertOperatorPresence(
    repo: string,
    identity: OperatorIdentity,
    signal?: AbortSignal,
  ): Promise<OperatorPresence> {
    return this.backing.upsertOperatorPresence(repo, identity, signal)
  }
  removeOperatorPresence(repo: string, id: string, signal?: AbortSignal): Promise<void> {
    return this.backing.removeOperatorPresence(repo, id, signal)
  }
  listOperatorPresence(repo: string): Promise<OperatorPresence[]> {
    return this.backing.listOperatorPresence(repo)
  }
  ensureRepo(repo: string): Promise<RepositoryRecord> {
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
  get getNodeRewrite(): BuildStore['getNodeRewrite'] {
    return this.backing.getNodeRewrite?.bind(this.backing)
  }

  get getLatestArtifactMeta(): BuildStore['getLatestArtifactMeta'] {
    return this.backing.getLatestArtifactMeta?.bind(this.backing)
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
  beginRepoTick(repo: string, holder: string) {
    return this.backing.beginRepoTick(repo, holder)
  }
  async finishRepoTick(...args: Parameters<BuildStore['finishRepoTick']>) {
    const result = await this.backing.finishRepoTick(...args)
    if (result && result.events.length > 0 && args[0] === this.repo) {
      for (const event of result.events) this.foldJournalAppend(event)
      return this.refreshCommitted(result)
    }
    return result
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
