/**
 * The in-memory BuildStore — the reference adapter. Its behavior *is* the
 * contract: the suite in `store/contract.ts` is written against this and
 * every other adapter (SQLite, remote HTTP) must match it.
 */
import {
  validateEventWrite,
  type AbEvent,
  type EventEnvelope,
  type EventWrite,
} from '../events/catalog'
import type { EventType } from '../events/payloads'
import {
  validateRepositoryEventWrite,
  type RepositoryEvent,
  type RepositoryEventEnvelope,
  type RepositoryEventType,
  type RepositoryEventWrite,
} from '../events/repository'
import {
  validateSessionEventWrite,
  type SessionEvent,
  type SessionEventEnvelope,
  type SessionEventType,
  type SessionEventWrite,
} from '../events/sessions'
import { humanActor } from '../events/envelope'
import { createBuildScopedStore } from './build-scope'
import { createSessionScopedStore } from './session-handle'
import {
  DEFAULT_ARTIFACT_RETENTION_MAX_REVISIONS,
  isRetentionManagedKind,
  revisionsToPrune,
} from './retention'
import { pollingSubscribe } from './subscribe'
import { assembleUIMessageDocument } from './streams/assemble'
import { readEventsWithWait, readStreamWithWait } from './streams/wait'
import {
  serializedBatchSize,
  STREAM_BATCH_MAX_BYTES,
  STREAM_FORMAT,
  StreamBatchTooLargeError,
  StreamClosedError,
  streamArtifactInput,
  validateStreamParts,
  type StreamChunk,
  type StreamOutcome,
  type StreamPart,
  type StreamRead,
  type StreamRecord,
  type StreamScope,
} from './streams/types'
import {
  contentHash,
  normalizeOperator,
  systemClock,
  toBytes,
  validateExpectedSeq,
  type Artifact,
  type ArtifactInput,
  type ArtifactMeta,
  type BlobStore,
  type BuildRecord,
  type BuildScopedStore,
  type BuildStore,
  type Clock,
  type NewBuildInput,
  type RepositoryArtifact,
  type RepositoryArtifactMeta,
  type RepositoryRecord,
  type SessionArtifact,
  type SessionArtifactMeta,
  type SessionRecord,
  type SessionScopedStore,
  type SubscribeOptions,
  type Unsubscribe,
} from './types'

export class MemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>()

  async put(hash: string, bytes: Uint8Array): Promise<void> {
    this.blobs.set(hash, bytes.slice())
  }

  async get(hash: string): Promise<Uint8Array | null> {
    const bytes = this.blobs.get(hash)
    return bytes ? bytes.slice() : null
  }
}

interface Lease {
  holder: string
  expiresAt: number
  ttlMs: number
}

interface RepoState {
  record: {
    repo: string
    createdAt: string
    updatedAt: string
    heartbeatAt?: string
  }
  lease?: Lease
  events: RepositoryEvent[]
  artifacts: Map<string, RepositoryArtifactMeta[]>
}

interface BuildState {
  record: {
    slug: string
    repo: string
    repoOrigin?: NewBuildInput['repoOrigin']
    ticket?: NewBuildInput['ticket']
    branch?: string
    createdAt: string
    updatedAt: string
    heartbeatAt?: string
  }
  lease?: Lease
  events: AbEvent[]
  /** kind → deposits in revision order (index = revision; 0-based, §6.3). */
  artifacts: Map<string, ArtifactMeta[]>
}

interface StreamState {
  record: StreamRecord
  chunks: StreamChunk[]
}

interface SessionState {
  record: SessionRecord
  events: SessionEvent[]
  /** kind → deposits in revision order (index = revision; 0-based, §6.3). */
  artifacts: Map<string, SessionArtifactMeta[]>
}

export class MemoryBuildStore implements BuildStore {
  private readonly builds = new Map<string, BuildState>()
  private readonly repos = new Map<string, RepoState>()
  private readonly streams = new Map<string, StreamState>()
  private readonly sessions = new Map<string, SessionState>()
  private readonly clock: Clock
  private readonly maxRevisions: number
  readonly blobs: BlobStore

  constructor(
    opts: {
      clock?: Clock
      blobs?: BlobStore
      retention?: { maxRevisions?: number }
    } = {},
  ) {
    this.clock = opts.clock ?? systemClock
    this.blobs = opts.blobs ?? new MemoryBlobStore()
    this.maxRevisions = opts.retention?.maxRevisions ?? DEFAULT_ARTIFACT_RETENTION_MAX_REVISIONS
  }

  /** Newest surviving revision of one kind — revisions prune from the front,
   * so the array length is no longer the next revision (retention policy). */
  private static nextRevision(revs: { revision: number }[] | undefined): number {
    return (revs?.at(-1)?.revision ?? -1) + 1
  }

  /** Deposit-time pruning (store/retention.ts): drop revisions past the bound
   * for retention-managed kinds, inside the same critical section as the
   * deposit itself. Non-family kinds are never touched. */
  private pruneBuildKind(state: BuildState, kind: string): void {
    if (!isRetentionManagedKind(kind)) return
    const revs = state.artifacts.get(kind)
    if (!revs) return
    const pruned = revisionsToPrune(
      revs.map((meta) => meta.revision),
      this.maxRevisions,
    )
    if (pruned.length === 0) return
    const drop = new Set(pruned)
    state.artifacts.set(
      kind,
      revs.filter((meta) => !drop.has(meta.revision)),
    )
  }

  private pruneRepoKind(state: RepoState, kind: string): void {
    if (!isRetentionManagedKind(kind)) return
    const revisions = state.artifacts.get(kind)
    if (!revisions) return
    const pruned = revisionsToPrune(
      revisions.map((meta) => meta.revision),
      this.maxRevisions,
    )
    if (pruned.length === 0) return
    const drop = new Set(pruned)
    state.artifacts.set(
      kind,
      revisions.filter((meta) => !drop.has(meta.revision)),
    )
  }

  scopeBuild(slug: string): BuildScopedStore {
    return createBuildScopedStore(this, slug)
  }

  scopeSession(id: string): SessionScopedStore {
    return createSessionScopedStore(this, id)
  }

  private now(): string {
    return this.clock().toISOString()
  }

  private state(slug: string): BuildState {
    const state = this.builds.get(slug)
    if (!state) throw new Error(`unknown build "${slug}"`)
    return state
  }

  private snapshot(state: BuildState): BuildRecord {
    const { record, lease } = state
    return {
      slug: record.slug,
      repo: record.repo,
      ...(record.ticket ? { ticket: structuredClone(record.ticket) } : {}),
      ...(record.branch ? { branch: record.branch } : {}),
      ...(record.repoOrigin !== undefined ? { repoOrigin: record.repoOrigin } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.heartbeatAt ? { heartbeatAt: record.heartbeatAt } : {}),
      ...(lease
        ? {
            lease: {
              holder: lease.holder,
              expiresAt: new Date(lease.expiresAt).toISOString(),
            },
          }
        : {}),
    }
  }

  async createBuild(input: NewBuildInput): Promise<BuildRecord> {
    if (this.builds.has(input.slug)) {
      throw new Error(`build "${input.slug}" already exists`)
    }
    const ts = this.now()
    const state: BuildState = {
      record: {
        slug: input.slug,
        repo: input.repo,
        ...(input.repoOrigin !== undefined ? { repoOrigin: input.repoOrigin } : {}),
        ...(input.ticket ? { ticket: structuredClone(input.ticket) } : {}),
        ...(input.branch ? { branch: input.branch } : {}),
        createdAt: ts,
        updatedAt: ts,
      },
      events: [],
      artifacts: new Map(),
    }
    this.builds.set(input.slug, state)
    return this.snapshot(state)
  }

  async getBuild(slug: string): Promise<BuildRecord | null> {
    const state = this.builds.get(slug)
    return state ? this.snapshot(state) : null
  }

  async listBuilds(): Promise<BuildRecord[]> {
    return [...this.builds.values()].map((state) => this.snapshot(state))
  }

  async append<T extends EventType>(slug: string, event: EventWrite<T>): Promise<EventEnvelope<T>> {
    const state = this.state(slug)
    const validated = validateEventWrite(event)
    const envelope = {
      build: slug,
      seq: state.events.length + 1,
      ts: this.now(),
      actor: validated.actor,
      type: validated.type,
      payload: validated.payload,
    } as EventEnvelope<T>
    state.events.push(structuredClone(envelope) as AbEvent)
    state.record.updatedAt = envelope.ts
    return envelope
  }

  async appendIfCurrent<T extends EventType>(
    slug: string,
    expectedSeq: number,
    event: EventWrite<T>,
  ): Promise<EventEnvelope<T> | null> {
    const state = this.state(slug)
    validateExpectedSeq(expectedSeq)
    const validated = validateEventWrite(event)

    // No await occurs between comparison and mutation. JavaScript's run-to-
    // completion semantics make this one atomic critical section even when
    // concurrent remote requests interleave elsewhere in the adapter.
    if (state.events.length !== expectedSeq) return null
    const envelope = {
      build: slug,
      seq: expectedSeq + 1,
      ts: this.now(),
      actor: validated.actor,
      type: validated.type,
      payload: validated.payload,
    } as EventEnvelope<T>
    state.events.push(structuredClone(envelope) as AbEvent)
    state.record.updatedAt = envelope.ts
    return envelope
  }

  async appendWithArtifacts<T extends EventType>(
    slug: string,
    artifacts: ArtifactInput[],
    makeEvent: (deposited: ArtifactMeta[]) => EventWrite<T>,
  ): Promise<{ event: EventEnvelope<T>; artifacts: ArtifactMeta[] }> {
    const state = this.state(slug)
    // Prepare phase — validate every input and store the blobs *before*
    // touching build state, mirroring the SQLite adapter: an invalid input
    // mid-bundle persists nothing, and orphaned blobs are harmless because
    // they are content-addressed (D6, §8.5).
    const prepared: { kind: string; blobRef: string; metadata: Record<string, unknown> }[] = []
    for (const artifact of artifacts) {
      if (!artifact.kind) throw new Error('artifact kind is required')
      const bytes = toBytes(artifact.content)
      const blobRef = contentHash(bytes)
      await this.blobs.put(blobRef, bytes)
      prepared.push({
        kind: artifact.kind,
        blobRef,
        metadata: structuredClone(artifact.metadata ?? {}),
      })
    }
    // Commit phase — fully synchronous (no await), so no interleaved writer
    // can slip between revision assignment, event validation, and the
    // deposits landing: "there is no state where an artifact exists without
    // its event or vice versa" (D6, §8.5). Everything is validated before
    // the first mutation, so no rollback path exists to get wrong.
    //
    // Ordering invariant (AUT-322): event validation precedes any retention
    // prune — validation runs before the deposit loop below, and the per-kind
    // prune happens inside that loop after the deposit, so a same-kind batch
    // whose prune scope covers a sibling never deletes that sibling before
    // the batch's event is validated.
    const ts = this.now()
    const nextRev = new Map<string, number>()
    const deposited: ArtifactMeta[] = prepared.map((p) => {
      const revision =
        nextRev.get(p.kind) ?? MemoryBuildStore.nextRevision(state.artifacts.get(p.kind))
      nextRev.set(p.kind, revision + 1)
      return {
        build: slug,
        kind: p.kind,
        revision,
        blobRef: p.blobRef,
        metadata: p.metadata,
        createdAt: ts,
      }
    })
    const validated = validateEventWrite(makeEvent(structuredClone(deposited)))
    for (const meta of deposited) {
      const revs = state.artifacts.get(meta.kind) ?? []
      revs.push(meta)
      state.artifacts.set(meta.kind, revs)
      this.pruneBuildKind(state, meta.kind)
    }
    const envelope = {
      build: slug,
      seq: state.events.length + 1,
      ts,
      actor: validated.actor,
      type: validated.type,
      payload: validated.payload,
    } as EventEnvelope<T>
    state.events.push(structuredClone(envelope) as AbEvent)
    state.record.updatedAt = ts
    return { event: envelope, artifacts: structuredClone(deposited) }
  }

  async getEvents(slug: string, sinceSeq = 0): Promise<AbEvent[]> {
    const state = this.state(slug)
    return structuredClone(state.events.filter((e) => e.seq > sinceSeq))
  }

  async putArtifact(slug: string, artifact: ArtifactInput): Promise<ArtifactMeta> {
    const state = this.state(slug)
    if (!artifact.kind) throw new Error('artifact kind is required')
    const bytes = toBytes(artifact.content)
    const blobRef = contentHash(bytes)
    await this.blobs.put(blobRef, bytes)
    const revs = state.artifacts.get(artifact.kind) ?? []
    const meta: ArtifactMeta = {
      build: slug,
      kind: artifact.kind,
      revision: MemoryBuildStore.nextRevision(revs),
      blobRef,
      metadata: structuredClone(artifact.metadata ?? {}),
      createdAt: this.now(),
    }
    revs.push(meta)
    state.artifacts.set(artifact.kind, revs)
    this.pruneBuildKind(state, artifact.kind)
    state.record.updatedAt = meta.createdAt
    return structuredClone(meta)
  }

  async getArtifact(slug: string, kind: string, rev?: number): Promise<Artifact | null> {
    const state = this.state(slug)
    const revs = state.artifacts.get(kind)
    if (!revs || revs.length === 0) return null
    const meta =
      rev === undefined ? revs.at(-1) : revs.find((candidate) => candidate.revision === rev)
    if (!meta) return null
    const content = await this.blobs.get(meta.blobRef)
    if (!content) return null
    return { meta: structuredClone(meta), content }
  }

  async listArtifacts(slug: string, kind?: string): Promise<ArtifactMeta[]> {
    const state = this.state(slug)
    const all = [...state.artifacts.values()].flat()
    const filtered = kind ? all.filter((meta) => meta.kind === kind) : all
    return structuredClone(
      filtered.sort((a, b) => a.kind.localeCompare(b.kind) || a.revision - b.revision),
    )
  }

  async claimLease(slug: string, holder: string, ttlMs: number): Promise<boolean> {
    const state = this.state(slug)
    const now = this.clock().getTime()
    const lease = state.lease
    if (lease && lease.holder !== holder && lease.expiresAt > now) {
      return false
    }
    state.lease = { holder, expiresAt: now + ttlMs, ttlMs }
    state.record.updatedAt = new Date(now).toISOString()
    return true
  }

  async heartbeat(slug: string, holder: string): Promise<boolean> {
    const state = this.state(slug)
    const now = this.clock().getTime()
    const lease = state.lease
    if (!lease || lease.holder !== holder || lease.expiresAt <= now) {
      return false
    }
    lease.expiresAt = now + lease.ttlMs
    state.record.heartbeatAt = new Date(now).toISOString()
    state.record.updatedAt = state.record.heartbeatAt
    return true
  }

  async releaseLease(slug: string, holder: string): Promise<void> {
    const state = this.state(slug)
    if (state.lease?.holder === holder) {
      state.lease = undefined
      state.record.updatedAt = this.now()
    }
  }

  subscribe(slug: string, opts: SubscribeOptions, onEvent: (event: AbEvent) => void): Unsubscribe {
    return pollingSubscribe((since) => this.getEvents(slug, since), opts, onEvent)
  }

  private repoState(repo: string): RepoState {
    const state = this.repos.get(repo)
    if (!state) throw new Error(`unknown repo "${repo}"`)
    return state
  }

  private repoSnapshot(state: RepoState): RepositoryRecord {
    return {
      repo: state.record.repo,
      createdAt: state.record.createdAt,
      updatedAt: state.record.updatedAt,
      ...(state.record.heartbeatAt ? { heartbeatAt: state.record.heartbeatAt } : {}),
      ...(state.lease
        ? {
            lease: {
              holder: state.lease.holder,
              expiresAt: new Date(state.lease.expiresAt).toISOString(),
            },
          }
        : {}),
    }
  }

  async ensureRepo(repo: string): Promise<RepositoryRecord> {
    if (!repo) throw new Error('repo is required')
    let state = this.repos.get(repo)
    if (!state) {
      const ts = this.now()
      state = {
        record: { repo, createdAt: ts, updatedAt: ts },
        events: [],
        artifacts: new Map(),
      }
      this.repos.set(repo, state)
    }
    return this.repoSnapshot(state)
  }

  async getRepo(repo: string): Promise<RepositoryRecord | null> {
    const state = this.repos.get(repo)
    return state ? this.repoSnapshot(state) : null
  }

  async appendRepo<T extends RepositoryEventType>(
    repo: string,
    event: RepositoryEventWrite<T>,
  ): Promise<RepositoryEventEnvelope<T>> {
    const state = this.repoState(repo)
    const validated = validateRepositoryEventWrite(event)
    const envelope = {
      repo,
      seq: state.events.length + 1,
      ts: this.now(),
      actor: validated.actor,
      type: validated.type,
      payload: validated.payload,
    } as RepositoryEventEnvelope<T>
    state.events.push(structuredClone(envelope) as RepositoryEvent)
    state.record.updatedAt = envelope.ts
    return envelope
  }

  async appendRepoWithArtifacts<T extends RepositoryEventType>(
    repo: string,
    artifacts: ArtifactInput[],
    makeEvent: (deposited: RepositoryArtifactMeta[]) => RepositoryEventWrite<T>,
  ): Promise<{
    event: RepositoryEventEnvelope<T>
    artifacts: RepositoryArtifactMeta[]
  }> {
    const state = this.repoState(repo)
    const prepared: {
      kind: string
      blobRef: string
      metadata: Record<string, unknown>
    }[] = []
    for (const artifact of artifacts) {
      if (!artifact.kind) throw new Error('artifact kind is required')
      const bytes = toBytes(artifact.content)
      const blobRef = contentHash(bytes)
      await this.blobs.put(blobRef, bytes)
      prepared.push({
        kind: artifact.kind,
        blobRef,
        metadata: structuredClone(artifact.metadata ?? {}),
      })
    }
    const ts = this.now()
    const nextRev = new Map<string, number>()
    const deposited = prepared.map((item): RepositoryArtifactMeta => {
      const revision =
        nextRev.get(item.kind) ?? MemoryBuildStore.nextRevision(state.artifacts.get(item.kind))
      nextRev.set(item.kind, revision + 1)
      return {
        repo,
        kind: item.kind,
        revision,
        blobRef: item.blobRef,
        metadata: item.metadata,
        createdAt: ts,
      }
    })
    // Ordering invariant (AUT-322): event validation precedes any retention
    // prune — validation runs before the deposit loop below, and the
    // per-kind prune happens inside that loop after the deposit (same shape
    // as `appendWithArtifacts` on the build side).
    const validated = validateRepositoryEventWrite(makeEvent(structuredClone(deposited)))
    for (const meta of deposited) {
      const revisions = state.artifacts.get(meta.kind) ?? []
      revisions.push(meta)
      state.artifacts.set(meta.kind, revisions)
      this.pruneRepoKind(state, meta.kind)
    }
    const envelope = {
      repo,
      seq: state.events.length + 1,
      ts,
      actor: validated.actor,
      type: validated.type,
      payload: validated.payload,
    } as RepositoryEventEnvelope<T>
    state.events.push(structuredClone(envelope) as RepositoryEvent)
    state.record.updatedAt = ts
    return { event: envelope, artifacts: structuredClone(deposited) }
  }

  async getRepoEvents(repo: string, sinceSeq = 0): Promise<RepositoryEvent[]> {
    return structuredClone(this.repoState(repo).events.filter((event) => event.seq > sinceSeq))
  }

  async putRepoArtifact(repo: string, artifact: ArtifactInput): Promise<RepositoryArtifactMeta> {
    const state = this.repoState(repo)
    if (!artifact.kind) throw new Error('artifact kind is required')
    const bytes = toBytes(artifact.content)
    const blobRef = contentHash(bytes)
    await this.blobs.put(blobRef, bytes)
    const revisions = state.artifacts.get(artifact.kind) ?? []
    const meta: RepositoryArtifactMeta = {
      repo,
      kind: artifact.kind,
      revision: MemoryBuildStore.nextRevision(revisions),
      blobRef,
      metadata: structuredClone(artifact.metadata ?? {}),
      createdAt: this.now(),
    }
    revisions.push(meta)
    state.artifacts.set(artifact.kind, revisions)
    this.pruneRepoKind(state, artifact.kind)
    state.record.updatedAt = meta.createdAt
    return structuredClone(meta)
  }

  async getRepoArtifact(
    repo: string,
    kind: string,
    rev?: number,
  ): Promise<RepositoryArtifact | null> {
    const revisions = this.repoState(repo).artifacts.get(kind)
    if (!revisions || revisions.length === 0) return null
    const meta =
      rev === undefined
        ? revisions.at(-1)
        : revisions.find((candidate) => candidate.revision === rev)
    if (!meta) return null
    const content = await this.blobs.get(meta.blobRef)
    return content ? { meta: structuredClone(meta), content } : null
  }

  async listRepoArtifacts(repo: string, kind?: string): Promise<RepositoryArtifactMeta[]> {
    const all = [...this.repoState(repo).artifacts.values()].flat()
    return structuredClone(
      (kind ? all.filter((meta) => meta.kind === kind) : all).sort(
        (a, b) => a.kind.localeCompare(b.kind) || a.revision - b.revision,
      ),
    )
  }

  async claimRepoLease(repo: string, holder: string, ttlMs: number): Promise<boolean> {
    const state = this.repoState(repo)
    const now = this.clock().getTime()
    if (state.lease && state.lease.holder !== holder && state.lease.expiresAt > now) {
      return false
    }
    state.lease = { holder, expiresAt: now + ttlMs, ttlMs }
    state.record.updatedAt = new Date(now).toISOString()
    return true
  }

  async heartbeatRepo(repo: string, holder: string): Promise<boolean> {
    const state = this.repoState(repo)
    const now = this.clock().getTime()
    const lease = state.lease
    if (!lease || lease.holder !== holder || lease.expiresAt <= now) return false
    lease.expiresAt = now + lease.ttlMs
    state.record.heartbeatAt = new Date(now).toISOString()
    state.record.updatedAt = state.record.heartbeatAt
    return true
  }

  async releaseRepoLease(repo: string, holder: string): Promise<void> {
    const state = this.repoState(repo)
    if (state.lease?.holder === holder) {
      state.lease = undefined
      state.record.updatedAt = this.now()
    }
  }

  // ── Operator sessions (SPEC §7.1.1 — a third resource kind) ─────────

  private sessionState(id: string): SessionState {
    const state = this.sessions.get(id)
    if (!state) throw new Error(`unknown session "${id}"`)
    return state
  }

  private sessionSnapshot(state: SessionState): SessionRecord {
    return structuredClone(state.record)
  }

  async createSession(input: NewSessionInput): Promise<SessionRecord> {
    const operator = normalizeOperator(input.operator)
    if (!input.repo) throw new Error('repo is required')
    const ts = this.now()
    const id = `os_${crypto.randomUUID()}`
    const state: SessionState = {
      record: {
        id,
        repo: input.repo,
        operator,
        ...(input.title !== undefined ? { title: input.title } : {}),
        createdAt: ts,
        updatedAt: ts,
      },
      events: [],
      artifacts: new Map(),
    }
    // The record and its first fact land together: `session.created` (seq 1,
    // actor the operator) is validated and appended in the same synchronous
    // commit as the insert — there is no state where a session exists without
    // its creation fact (D6).
    const validated = validateSessionEventWrite({
      actor: humanActor(operator),
      type: 'session.created',
      payload: input.title !== undefined ? { title: input.title } : {},
    })
    state.events.push({
      session: id,
      seq: 1,
      ts,
      actor: validated.actor,
      type: validated.type,
      payload: validated.payload,
    } as SessionEvent)
    this.sessions.set(id, state)
    return this.sessionSnapshot(state)
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const state = this.sessions.get(id)
    return state ? this.sessionSnapshot(state) : null
  }

  async listSessions(repo: string): Promise<SessionRecord[]> {
    return [...this.sessions.values()]
      .filter((state) => state.record.repo === repo)
      .map((state) => this.sessionSnapshot(state))
  }

  async appendSessionEvent<T extends SessionEventType>(
    id: string,
    event: SessionEventWrite<T>,
  ): Promise<SessionEventEnvelope<T>> {
    const state = this.sessionState(id)
    const validated = validateSessionEventWrite(event)
    const envelope = {
      session: id,
      seq: state.events.length + 1,
      ts: this.now(),
      actor: validated.actor,
      type: validated.type,
      payload: validated.payload,
    } as SessionEventEnvelope<T>
    state.events.push(structuredClone(envelope) as SessionEvent)
    state.record.updatedAt = envelope.ts
    return envelope
  }

  async getSessionEvents(
    id: string,
    sinceSeq = 0,
    opts?: { waitSeconds?: number },
  ): Promise<SessionEvent[]> {
    const read = async (): Promise<SessionEvent[]> =>
      structuredClone(this.sessionState(id).events.filter((event) => event.seq > sinceSeq))
    return readEventsWithWait({ read, waitSeconds: opts?.waitSeconds })
  }

  async appendSessionWithArtifacts<T extends SessionEventType>(
    id: string,
    artifacts: ArtifactInput[],
    makeEvent: (deposited: SessionArtifactMeta[]) => SessionEventWrite<T>,
  ): Promise<{ event: SessionEventEnvelope<T>; artifacts: SessionArtifactMeta[] }> {
    const state = this.sessionState(id)
    const prepared: {
      kind: string
      blobRef: string
      metadata: Record<string, unknown>
    }[] = []
    for (const artifact of artifacts) {
      if (!artifact.kind) throw new Error('artifact kind is required')
      const bytes = toBytes(artifact.content)
      const blobRef = contentHash(bytes)
      await this.blobs.put(blobRef, bytes)
      prepared.push({
        kind: artifact.kind,
        blobRef,
        metadata: structuredClone(artifact.metadata ?? {}),
      })
    }
    // Same shape as `appendRepoWithArtifacts`: everything is validated before
    // the first mutation, so the synchronous commit has no rollback path to
    // get wrong (D6) and the validation-before-prune invariant (AUT-322)
    // holds trivially — session artifacts are not retention-managed.
    const ts = this.now()
    const nextRev = new Map<string, number>()
    const deposited = prepared.map((item): SessionArtifactMeta => {
      const revision =
        nextRev.get(item.kind) ?? MemoryBuildStore.nextRevision(state.artifacts.get(item.kind))
      nextRev.set(item.kind, revision + 1)
      return {
        session: id,
        kind: item.kind,
        revision,
        blobRef: item.blobRef,
        metadata: item.metadata,
        createdAt: ts,
      }
    })
    const validated = validateSessionEventWrite(makeEvent(structuredClone(deposited)))
    for (const meta of deposited) {
      const revisions = state.artifacts.get(meta.kind) ?? []
      revisions.push(meta)
      state.artifacts.set(meta.kind, revisions)
    }
    const envelope = {
      session: id,
      seq: state.events.length + 1,
      ts,
      actor: validated.actor,
      type: validated.type,
      payload: validated.payload,
    } as SessionEventEnvelope<T>
    state.events.push(structuredClone(envelope) as SessionEvent)
    state.record.updatedAt = ts
    return { event: envelope, artifacts: structuredClone(deposited) }
  }

  async putSessionArtifact(id: string, artifact: ArtifactInput): Promise<SessionArtifactMeta> {
    const state = this.sessionState(id)
    if (!artifact.kind) throw new Error('artifact kind is required')
    const bytes = toBytes(artifact.content)
    const blobRef = contentHash(bytes)
    await this.blobs.put(blobRef, bytes)
    const revisions = state.artifacts.get(artifact.kind) ?? []
    const meta: SessionArtifactMeta = {
      session: id,
      kind: artifact.kind,
      revision: MemoryBuildStore.nextRevision(revisions),
      blobRef,
      metadata: structuredClone(artifact.metadata ?? {}),
      createdAt: this.now(),
    }
    revisions.push(meta)
    state.artifacts.set(artifact.kind, revisions)
    state.record.updatedAt = meta.createdAt
    return structuredClone(meta)
  }

  async getSessionArtifact(
    id: string,
    kind: string,
    rev?: number,
  ): Promise<SessionArtifact | null> {
    const revisions = this.sessionState(id).artifacts.get(kind)
    if (!revisions || revisions.length === 0) return null
    const meta =
      rev === undefined
        ? revisions.at(-1)
        : revisions.find((candidate) => candidate.revision === rev)
    if (!meta) return null
    const content = await this.blobs.get(meta.blobRef)
    return content ? { meta: structuredClone(meta), content } : null
  }

  async listSessionArtifacts(id: string, kind?: string): Promise<SessionArtifactMeta[]> {
    const all = [...this.sessionState(id).artifacts.values()].flat()
    return structuredClone(
      (kind ? all.filter((meta) => meta.kind === kind) : all).sort(
        (a, b) => a.kind.localeCompare(b.kind) || a.revision - b.revision,
      ),
    )
  }

  // ── Streams (SPEC §7.6 — the third primitive) ───────────────────────────

  private streamState(streamId: string): StreamState {
    const state = this.streams.get(streamId)
    if (!state) throw new Error(`unknown stream "${streamId}"`)
    return state
  }

  private snapshotStream(state: StreamState): StreamRecord {
    return structuredClone(state.record)
  }

  /** Stream-chunk retention (SPEC §7.6, deposit-path and count-based like
   * artifact retention): at create, drop the chunks of every previously
   * closed stream in the same scope except the most recently closed one.
   * Records and finalized artifacts are never touched; open streams are
   * never pruned. Runs in the same synchronous commit as the create. */
  private pruneStreamChunksInCommit(scope: StreamScope): void {
    const inScope = [...this.streams.values()].filter(
      (state) =>
        state.record.status === 'closed' &&
        state.record.scope.kind === scope.kind &&
        (scope.kind === 'build'
          ? state.record.scope.kind === 'build' && state.record.scope.build === scope.build
          : scope.kind === 'repo'
            ? state.record.scope.kind === 'repo' && state.record.scope.repo === scope.repo
            : state.record.scope.kind === 'session' &&
              state.record.scope.session === scope.session),
    )
    if (inScope.length <= 1) return
    // Most recently closed survives (order by closedAt, tie-break by id).
    const keep = inScope
      .map((state) => state.record)
      .sort(
        (a, b) => (a.closedAt ?? '').localeCompare(b.closedAt ?? '') || a.id.localeCompare(b.id),
      )
      .at(-1)!
    for (const state of inScope) {
      if (state.record.id !== keep.id) state.chunks = []
    }
  }

  async createStream(scope: StreamScope, label: string): Promise<StreamRecord> {
    if (!label) throw new Error('stream label is required')
    if (scope.kind === 'build') this.state(scope.build)
    else if (scope.kind === 'repo') this.repoState(scope.repo)
    else this.sessionState(scope.session)
    const id = `st_${crypto.randomUUID()}`
    const record: StreamRecord = {
      id,
      scope: structuredClone(scope),
      label,
      format: STREAM_FORMAT,
      status: 'open',
      createdAt: this.now(),
    }
    // Synchronous commit: the retention prune and the insert are one step.
    this.pruneStreamChunksInCommit(record.scope)
    this.streams.set(id, { record, chunks: [] })
    return this.snapshotStream(this.streamState(id))
  }

  async appendStreamParts(streamId: string, parts: StreamPart[]): Promise<StreamChunk> {
    const state = this.streamState(streamId)
    if (state.record.status === 'closed') throw new StreamClosedError(streamId)
    // Validate and size-check before any mutation.
    validateStreamParts(parts)
    const bytes = serializedBatchSize(parts)
    if (bytes > STREAM_BATCH_MAX_BYTES) throw new StreamBatchTooLargeError(bytes)
    const chunk: StreamChunk = {
      stream: streamId,
      seq: state.chunks.length + 1,
      ts: this.now(),
      parts: structuredClone(parts),
    }
    state.chunks.push(chunk)
    return structuredClone(chunk)
  }

  async readStream(
    streamId: string,
    opts?: { since?: number; waitSeconds?: number },
  ): Promise<StreamRead> {
    const read = async (): Promise<StreamRead> => {
      const state = this.streamState(streamId)
      const record = state.record
      return {
        chunks: structuredClone(state.chunks.filter((chunk) => chunk.seq > (opts?.since ?? 0))),
        status: record.status,
        ...(record.outcome !== undefined ? { outcome: record.outcome } : {}),
        ...(record.artifact !== undefined ? { artifact: structuredClone(record.artifact) } : {}),
      }
    }
    return readStreamWithWait({ read, waitSeconds: opts?.waitSeconds })
  }

  async closeStream(streamId: string, outcome: StreamOutcome): Promise<StreamRecord> {
    const state = this.streamState(streamId)
    if (state.record.status === 'closed') return this.snapshotStream(state)
    // Prepare phase — assemble and store the blob before touching stream
    // state (mirrors appendWithArtifacts: content-addressed orphans are
    // harmless; a deposit failure leaves the stream open and unwritten).
    const { document, droppedPartCount } = await assembleUIMessageDocument(
      structuredClone(state.chunks.flatMap((chunk) => chunk.parts)),
    )
    const ts = this.now()
    const record = structuredClone(state.record)
    const input = streamArtifactInput(
      record.id,
      record.scope,
      record.label,
      outcome,
      document,
      state.chunks.length,
      droppedPartCount,
    )
    const bytes = toBytes(input.content)
    const blobRef = contentHash(bytes)
    await this.blobs.put(blobRef, bytes)
    // Commit phase — fully synchronous (no await), so no interleaved writer
    // can slip between the artifact deposit and the close landing. A close
    // that raced us through the prepare phase wins; ours is the no-op.
    const closed: StreamRecord = {
      ...record,
      status: 'closed',
      closedAt: ts,
      outcome,
      artifact: { kind: input.kind, revision: 0, blobRef },
    }
    // A close that raced us through the prepare phase wins; ours is the no-op.
    const fresh = this.streams.get(streamId)
    if (fresh && fresh.record.status === 'closed') return this.snapshotStream(fresh)
    state.record = closed
    if (record.scope.kind === 'build') {
      const meta: ArtifactMeta = {
        build: record.scope.build,
        kind: input.kind,
        revision: 0,
        blobRef,
        metadata: structuredClone(input.metadata),
        createdAt: ts,
      }
      const buildState = this.state(record.scope.build)
      const revs = buildState.artifacts.get(input.kind) ?? []
      revs.push(meta)
      buildState.artifacts.set(input.kind, revs)
    } else if (record.scope.kind === 'repo') {
      const repoMeta: RepositoryArtifactMeta = {
        repo: record.scope.repo,
        kind: input.kind,
        revision: 0,
        blobRef,
        metadata: structuredClone(input.metadata),
        createdAt: ts,
      }
      const repoState = this.repoState(record.scope.repo)
      const revs = repoState.artifacts.get(input.kind) ?? []
      revs.push(repoMeta)
      repoState.artifacts.set(input.kind, revs)
    } else {
      const sessionMeta: SessionArtifactMeta = {
        session: record.scope.session,
        kind: input.kind,
        revision: 0,
        blobRef,
        metadata: structuredClone(input.metadata),
        createdAt: ts,
      }
      const sessionState = this.sessionState(record.scope.session)
      const revs = sessionState.artifacts.get(input.kind) ?? []
      revs.push(sessionMeta)
      sessionState.artifacts.set(input.kind, revs)
    }
    return this.snapshotStream(state)
  }

  async getStream(streamId: string): Promise<StreamRecord | null> {
    const state = this.streams.get(streamId)
    return state ? this.snapshotStream(state) : null
  }

  async listStreams(scope: StreamScope): Promise<StreamRecord[]> {
    // A list of nothing is nothing: an unknown scope lists empty (only
    // createStream requires the scope's resource to exist).
    const records = [...this.streams.values()]
      .filter(
        (state) =>
          state.record.scope.kind === scope.kind &&
          (scope.kind === 'build'
            ? state.record.scope.kind === 'build' && state.record.scope.build === scope.build
            : scope.kind === 'repo'
              ? state.record.scope.kind === 'repo' && state.record.scope.repo === scope.repo
              : state.record.scope.kind === 'session' &&
                state.record.scope.session === scope.session),
      )
      .map((state) => this.snapshotStream(state))
    return records.sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    )
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}
