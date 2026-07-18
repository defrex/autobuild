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
  validateHarvestEventWrite,
  type HarvestEvent,
  type HarvestEventEnvelope,
  type HarvestEventType,
  type HarvestEventWrite,
} from '../events/harvest'
import { pollingSubscribe } from './subscribe'
import {
  contentHash,
  systemClock,
  toBytes,
  type Artifact,
  type ArtifactInput,
  type ArtifactMeta,
  type BlobStore,
  type BuildRecord,
  type BuildStore,
  type Clock,
  type NewBuildInput,
  type RepositoryArtifact,
  type RepositoryArtifactMeta,
  type RepositoryRecord,
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
  events: HarvestEvent[]
  artifacts: Map<string, RepositoryArtifactMeta[]>
}

interface BuildState {
  record: {
    slug: string
    repo: string
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

export class MemoryBuildStore implements BuildStore {
  private readonly builds = new Map<string, BuildState>()
  private readonly repos = new Map<string, RepoState>()
  private readonly clock: Clock
  readonly blobs: BlobStore

  constructor(opts: { clock?: Clock; blobs?: BlobStore } = {}) {
    this.clock = opts.clock ?? systemClock
    this.blobs = opts.blobs ?? new MemoryBlobStore()
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

  async append<T extends EventType>(
    slug: string,
    event: EventWrite<T>,
  ): Promise<EventEnvelope<T>> {
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
    const ts = this.now()
    const nextRev = new Map<string, number>()
    const deposited: ArtifactMeta[] = prepared.map((p) => {
      const revision = nextRev.get(p.kind) ?? state.artifacts.get(p.kind)?.length ?? 0
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
      revision: revs.length,
      blobRef,
      metadata: structuredClone(artifact.metadata ?? {}),
      createdAt: this.now(),
    }
    revs.push(meta)
    state.artifacts.set(artifact.kind, revs)
    state.record.updatedAt = meta.createdAt
    return structuredClone(meta)
  }

  async getArtifact(
    slug: string,
    kind: string,
    rev?: number,
  ): Promise<Artifact | null> {
    const state = this.state(slug)
    const revs = state.artifacts.get(kind)
    if (!revs || revs.length === 0) return null
    const meta = rev === undefined ? revs[revs.length - 1] : revs[rev]
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
      filtered.sort(
        (a, b) => a.kind.localeCompare(b.kind) || a.revision - b.revision,
      ),
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

  subscribe(
    slug: string,
    opts: SubscribeOptions,
    onEvent: (event: AbEvent) => void,
  ): Unsubscribe {
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
      ...(state.record.heartbeatAt
        ? { heartbeatAt: state.record.heartbeatAt }
        : {}),
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

  async appendRepo<T extends HarvestEventType>(
    repo: string,
    event: HarvestEventWrite<T>,
  ): Promise<HarvestEventEnvelope<T>> {
    const state = this.repoState(repo)
    const validated = validateHarvestEventWrite(event)
    const envelope = {
      repo,
      seq: state.events.length + 1,
      ts: this.now(),
      actor: validated.actor,
      type: validated.type,
      payload: validated.payload,
    } as HarvestEventEnvelope<T>
    state.events.push(structuredClone(envelope) as HarvestEvent)
    state.record.updatedAt = envelope.ts
    return envelope
  }

  async appendRepoWithArtifacts<T extends HarvestEventType>(
    repo: string,
    artifacts: ArtifactInput[],
    makeEvent: (
      deposited: RepositoryArtifactMeta[],
    ) => HarvestEventWrite<T>,
  ): Promise<{
    event: HarvestEventEnvelope<T>
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
        nextRev.get(item.kind) ?? state.artifacts.get(item.kind)?.length ?? 0
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
    const validated = validateHarvestEventWrite(
      makeEvent(structuredClone(deposited)),
    )
    for (const meta of deposited) {
      const revisions = state.artifacts.get(meta.kind) ?? []
      revisions.push(meta)
      state.artifacts.set(meta.kind, revisions)
    }
    const envelope = {
      repo,
      seq: state.events.length + 1,
      ts,
      actor: validated.actor,
      type: validated.type,
      payload: validated.payload,
    } as HarvestEventEnvelope<T>
    state.events.push(structuredClone(envelope) as HarvestEvent)
    state.record.updatedAt = ts
    return { event: envelope, artifacts: structuredClone(deposited) }
  }

  async getRepoEvents(repo: string, sinceSeq = 0): Promise<HarvestEvent[]> {
    return structuredClone(
      this.repoState(repo).events.filter((event) => event.seq > sinceSeq),
    )
  }

  async putRepoArtifact(
    repo: string,
    artifact: ArtifactInput,
  ): Promise<RepositoryArtifactMeta> {
    const state = this.repoState(repo)
    if (!artifact.kind) throw new Error('artifact kind is required')
    const bytes = toBytes(artifact.content)
    const blobRef = contentHash(bytes)
    await this.blobs.put(blobRef, bytes)
    const revisions = state.artifacts.get(artifact.kind) ?? []
    const meta: RepositoryArtifactMeta = {
      repo,
      kind: artifact.kind,
      revision: revisions.length,
      blobRef,
      metadata: structuredClone(artifact.metadata ?? {}),
      createdAt: this.now(),
    }
    revisions.push(meta)
    state.artifacts.set(artifact.kind, revisions)
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
    const meta = rev === undefined ? revisions.at(-1) : revisions[rev]
    if (!meta) return null
    const content = await this.blobs.get(meta.blobRef)
    return content ? { meta: structuredClone(meta), content } : null
  }

  async listRepoArtifacts(
    repo: string,
    kind?: string,
  ): Promise<RepositoryArtifactMeta[]> {
    const all = [...this.repoState(repo).artifacts.values()].flat()
    return structuredClone(
      (kind ? all.filter((meta) => meta.kind === kind) : all).sort(
        (a, b) => a.kind.localeCompare(b.kind) || a.revision - b.revision,
      ),
    )
  }

  async claimRepoLease(
    repo: string,
    holder: string,
    ttlMs: number,
  ): Promise<boolean> {
    const state = this.repoState(repo)
    const now = this.clock().getTime()
    if (
      state.lease &&
      state.lease.holder !== holder &&
      state.lease.expiresAt > now
    ) {
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

  async close(): Promise<void> {
    // Nothing to release.
  }
}
