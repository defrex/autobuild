/**
 * RemoteBuildStore (SPEC §7.2 adapter 2): the client half of the remote
 * store — a full BuildStore over the wire protocol in protocol.ts. The
 * contract suite runs against it unchanged; in particular:
 *
 * - D6: a 422 from the server rehydrates as `EventValidationError` with the
 *   server's message — validation feedback survives the wire.
 * - D8: 401/403 surface as `AuthError`; 404 as an `Error` matching the
 *   local adapters' `unknown build "…"` message shape.
 *
 * The client takes a *fixed* base URL for its lifetime; continuity across
 * server restarts lives in the backing store (§7.4), not in the client.
 * `subscribe` is the shared polling implementation over `getEvents(since)`
 * (§7.2); `close()` is a no-op — the server owns the backing store.
 */
import {
  EventValidationError,
  type AbEvent,
  type EventEnvelope,
  type EventWrite,
} from '../../events/catalog'
import type { EventType } from '../../events/payloads'
import type {
  RepositoryEvent,
  RepositoryEventEnvelope,
  RepositoryEventType,
  RepositoryEventWrite,
} from '../../events/repository'
import type {
  SessionEvent,
  SessionEventEnvelope,
  SessionEventType,
  SessionEventWrite,
} from '../../events/sessions'
import { createBuildScopedStore } from '../build-scope'
import { createSessionScopedStore } from '../session-handle'
import { pollingSubscribe } from '../subscribe'
import type { BuildDigest } from '../types'
import type {
  StreamChunk,
  StreamOutcome,
  StreamPart,
  StreamRead,
  StreamRecord,
  StreamScope,
} from '../streams/types'
import { StreamBatchTooLargeError, StreamClosedError } from '../streams/types'
import {
  toBytes,
  type Artifact,
  type ArtifactInput,
  type ArtifactMeta,
  type BuildRecord,
  type BuildScopedStore,
  type BuildStore,
  type NewBuildInput,
  type NewSessionInput,
  type RepositoryArtifact,
  type RepositoryArtifactMeta,
  type RepositoryRecord,
  type SessionArtifact,
  type SessionArtifactMeta,
  type SessionRecord,
  type SessionScopedStore,
  type SubscribeOptions,
  type Unsubscribe,
} from '../types'
import {
  artifactGetResponseSchema,
  artifactMetaListSchema,
  artifactMetaWireSchema,
  buildDigestListSchema,
  buildRecordListSchema,
  buildRecordWireSchema,
  conditionalEventResponseSchema,
  conditionalSessionEventResponseSchema,
  decodeBase64,
  depositsResponseSchema,
  encodeBase64,
  errorBodySchema,
  eventEnvelopeWireSchema,
  eventListSchema,
  repositoryEventEnvelopeWireSchema,
  repositoryEventListSchema,
  okResponseSchema,
  placeholderRev,
  repoDepositsResponseSchema,
  repositoryArtifactGetResponseSchema,
  repositoryArtifactMetaListSchema,
  repositoryArtifactMetaWireSchema,
  repositoryRecordWireSchema,
  sessionArtifactGetResponseSchema,
  sessionArtifactMetaListSchema,
  sessionArtifactMetaWireSchema,
  sessionDepositsResponseSchema,
  sessionEventEnvelopeWireSchema,
  sessionEventListSchema,
  sessionRecordListSchema,
  sessionRecordWireSchema,
  streamChunkWireSchema,
  streamReadWireSchema,
  streamRecordListSchema,
  streamRecordWireSchema,
} from './protocol'
import {
  AUTOBUILD_VERSION,
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
} from './version'

/** A scoped-token rejection (D8): 401 (missing/expired) or 403 (wrong build). */
export class AuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

export interface RemoteStoreIdentity {
  autobuildVersion: string
  protocolVersion: string
}

/** The bounded-wait window the client requests on event reads and watch
 * polls (AUT-334): matches the hosted service's documented ceiling. A server
 * with a smaller ceiling clamps server-side; one that ignores the parameter
 * answers immediately, which only raises the request rate. */
export const REMOTE_EVENT_WAIT_SECONDS = 25

export interface RemoteBuildStoreOptions {
  /** Base URL of a store server (e.g. `http://127.0.0.1:4711`); fixed for life. */
  url: string
  /** Scoped bearer token (D8); omit against an open (no-secret) server. */
  token?: string
  /** Injectable network seam; defaults to global fetch. */
  fetchFn?: typeof fetch
  /** Test seam for exercising package/protocol skew diagnostics. */
  identity?: Partial<RemoteStoreIdentity>
}

export class RemoteBuildStore implements BuildStore {
  private readonly base: string
  private readonly token: string | undefined
  private readonly fetchFn: typeof fetch
  private readonly identity: RemoteStoreIdentity

  constructor(opts: RemoteBuildStoreOptions) {
    this.base = opts.url.replace(/\/+$/, '')
    this.token = opts.token
    this.fetchFn = opts.fetchFn ?? fetch
    this.identity = {
      autobuildVersion: opts.identity?.autobuildVersion ?? AUTOBUILD_VERSION,
      protocolVersion: opts.identity?.protocolVersion ?? REMOTE_STORE_PROTOCOL_VERSION,
    }
  }

  scopeBuild(slug: string): BuildScopedStore {
    return createBuildScopedStore(this, slug)
  }

  scopeSession(id: string): SessionScopedStore {
    return createSessionScopedStore(this, id)
  }

  private buildPath(slug: string): string {
    return `/builds/${encodeURIComponent(slug)}`
  }

  private repoPath(repo: string): string {
    return `/repos/${encodeURIComponent(repo)}`
  }

  private sessionPath(id: string): string {
    return `/sessions/${encodeURIComponent(id)}`
  }

  private async raw(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      [AUTOBUILD_VERSION_HEADER]: this.identity.autobuildVersion,
      [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: this.identity.protocolVersion,
    }
    if (this.token !== undefined) headers.authorization = `Bearer ${this.token}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    return this.fetchFn(`${this.base}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal !== undefined ? { signal } : {}),
    })
  }

  private async toError(response: Response): Promise<Error> {
    let body: { error: string; kind: string } | undefined
    try {
      body = errorBodySchema.parse(await response.json())
    } catch {
      // Not a protocol error body — fall back to the status line.
    }
    const message = body?.error ?? `store server responded ${response.status}`
    if (response.status === 401 || response.status === 403) {
      return new AuthError(message)
    }
    // D6: validation feedback crosses the wire as the same error type with
    // the server's message intact.
    if (response.status === 422) return new EventValidationError(message)
    // Typed stream rejections rehydrate by the server's message shape: the
    // ceiling names its bytes, the closed-append names its stream (a 409 is
    // otherwise the generic already-exists conflict).
    if (response.status === 413 && message.startsWith('stream batch of ')) {
      return new StreamBatchTooLargeError(undefined, undefined, message)
    }
    if (response.status === 409 && /^stream ".+" is closed$/.test(message)) {
      return new StreamClosedError(message)
    }
    // 404 carries the local adapters' message shape: `unknown build "slug"`.
    return new Error(message)
  }

  private async requestJson<T>(
    method: 'GET' | 'POST',
    path: string,
    schema: { parse: (data: unknown) => T },
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.raw(method, path, body, signal)
    if (!response.ok) throw await this.toError(response)
    return schema.parse(await response.json())
  }

  async createBuild(input: NewBuildInput): Promise<BuildRecord> {
    return this.requestJson('POST', '/builds', buildRecordWireSchema, input)
  }

  async getBuild(slug: string): Promise<BuildRecord | null> {
    const response = await this.raw('GET', this.buildPath(slug))
    if (response.status === 404) return null
    if (!response.ok) throw await this.toError(response)
    return buildRecordWireSchema.parse(await response.json())
  }

  async listBuilds(): Promise<BuildRecord[]> {
    return this.requestJson('GET', '/builds', buildRecordListSchema)
  }

  async getRepoBuildDigests(repo: string): Promise<Map<string, BuildDigest>> {
    // A repo-scoped batch read (AUT-487): one request regardless of build
    // count. The route answers from build records, so an unknown repo or a
    // repo without a journal record answers 200 with an empty array rather
    // than 404 — the server composes it before the repository-existence gate.
    const digests = await this.requestJson(
      'GET',
      `${this.repoPath(repo)}/build-digests`,
      buildDigestListSchema,
    )
    return new Map(digests.map((digest) => [digest.slug, digest]))
  }

  async append<T extends EventType>(slug: string, event: EventWrite<T>): Promise<EventEnvelope<T>> {
    const envelope = await this.requestJson(
      'POST',
      `${this.buildPath(slug)}/events`,
      eventEnvelopeWireSchema,
      { actor: event.actor, type: event.type, payload: event.payload },
    )
    return envelope as unknown as EventEnvelope<T>
  }

  async appendIfCurrent<T extends EventType>(
    slug: string,
    expectedSeq: number,
    event: EventWrite<T>,
  ): Promise<EventEnvelope<T> | null> {
    const envelope = await this.requestJson(
      'POST',
      `${this.buildPath(slug)}/events/conditional`,
      conditionalEventResponseSchema,
      {
        expectedSeq,
        event: { actor: event.actor, type: event.type, payload: event.payload },
      },
    )
    return envelope as EventEnvelope<T> | null
  }

  /**
   * The wire form of atomic deposits (D6 — see protocol.ts): `makeEvent`
   * runs client-side against sentinel metas whose `revision` is the negative
   * placeholder `-(index+1)`; the resulting payload (carrying the sentinel
   * `{kind, rev}` refs) ships to the server, which substitutes the real
   * revisions inside the backing store's atomic `appendWithArtifacts`.
   * Payloads may embed the deposited refs as `{kind, rev}` objects — the
   * system's only usage pattern; computing over the revision values is
   * unsupported by design.
   */
  async appendWithArtifacts<T extends EventType>(
    slug: string,
    artifacts: ArtifactInput[],
    makeEvent: (deposited: ArtifactMeta[]) => EventWrite<T>,
  ): Promise<{ event: EventEnvelope<T>; artifacts: ArtifactMeta[] }> {
    const sentinels: ArtifactMeta[] = artifacts.map((artifact, index) => ({
      build: slug,
      kind: artifact.kind,
      revision: placeholderRev(index),
      blobRef: '',
      metadata: structuredClone(artifact.metadata ?? {}),
      createdAt: '',
    }))
    const write = makeEvent(sentinels)
    const result = await this.requestJson(
      'POST',
      `${this.buildPath(slug)}/deposits`,
      depositsResponseSchema,
      {
        artifacts: artifacts.map((artifact) => ({
          kind: artifact.kind,
          contentBase64: encodeBase64(toBytes(artifact.content)),
          ...(artifact.metadata !== undefined ? { metadata: artifact.metadata } : {}),
        })),
        event: { actor: write.actor, type: write.type, payload: write.payload },
      },
    )
    return {
      event: result.event as unknown as EventEnvelope<T>,
      artifacts: result.artifacts,
    }
  }

  /** The BuildStore abort contract (AUT-380): a held read whose caller's
   * signal fires resolves with the empty result — the client-side mirror of
   * the server's `withDisconnect`, which discards the aborted response
   * anyway — instead of rejecting with fetch's AbortError. Failures that are
   * not the caller's own abort (the store being unreachable, say) still
   * reject. */
  private async heldRequest<T>(
    signal: AbortSignal | undefined,
    empty: () => T,
    read: () => Promise<T>,
  ): Promise<T> {
    try {
      return await read()
    } catch (error) {
      if (signal?.aborted) return empty()
      throw error
    }
  }

  async getEvents(
    slug: string,
    sinceSeq = 0,
    opts?: { waitSeconds?: number; signal?: AbortSignal },
  ): Promise<AbEvent[]> {
    const params = new URLSearchParams({ since: String(sinceSeq) })
    if (opts?.waitSeconds !== undefined) params.set('wait', String(opts.waitSeconds))
    return this.heldRequest(
      opts?.signal,
      (): AbEvent[] => [],
      () =>
        this.requestJson(
          'GET',
          `${this.buildPath(slug)}/events?${params}`,
          eventListSchema,
          undefined,
          opts?.signal,
        ) as Promise<AbEvent[]>,
    )
  }

  async putArtifact(slug: string, artifact: ArtifactInput): Promise<ArtifactMeta> {
    return this.requestJson('POST', `${this.buildPath(slug)}/artifacts`, artifactMetaWireSchema, {
      kind: artifact.kind,
      contentBase64: encodeBase64(toBytes(artifact.content)),
      ...(artifact.metadata !== undefined ? { metadata: artifact.metadata } : {}),
    })
  }

  async getArtifact(slug: string, kind: string, rev?: number): Promise<Artifact | null> {
    const params = new URLSearchParams({ kind })
    if (rev !== undefined) params.set('rev', String(rev))
    const result = await this.requestJson(
      'GET',
      `${this.buildPath(slug)}/artifacts?${params}`,
      artifactGetResponseSchema,
    )
    if (result === null) return null
    return { meta: result.meta, content: decodeBase64(result.contentBase64) }
  }

  async listArtifacts(slug: string, kind?: string): Promise<ArtifactMeta[]> {
    const query = kind !== undefined ? `?kind=${encodeURIComponent(kind)}` : ''
    return this.requestJson(
      'GET',
      `${this.buildPath(slug)}/artifact-list${query}`,
      artifactMetaListSchema,
    )
  }

  async claimLease(slug: string, holder: string, ttlMs: number): Promise<boolean> {
    const result = await this.requestJson(
      'POST',
      `${this.buildPath(slug)}/lease/claim`,
      okResponseSchema,
      { holder, ttlMs },
    )
    return result.ok
  }

  async heartbeat(slug: string, holder: string): Promise<boolean> {
    const result = await this.requestJson(
      'POST',
      `${this.buildPath(slug)}/lease/heartbeat`,
      okResponseSchema,
      { holder },
    )
    return result.ok
  }

  async releaseLease(slug: string, holder: string): Promise<void> {
    await this.requestJson('POST', `${this.buildPath(slug)}/lease/release`, okResponseSchema, {
      holder,
    })
  }

  async ensureRepo(repo: string): Promise<RepositoryRecord> {
    return this.requestJson('POST', '/repos', repositoryRecordWireSchema, { repo })
  }

  async getRepo(repo: string): Promise<RepositoryRecord | null> {
    const response = await this.raw('GET', this.repoPath(repo))
    if (response.status === 404) return null
    if (!response.ok) throw await this.toError(response)
    return repositoryRecordWireSchema.parse(await response.json())
  }

  async appendRepo<T extends RepositoryEventType>(
    repo: string,
    event: RepositoryEventWrite<T>,
  ): Promise<RepositoryEventEnvelope<T>> {
    const envelope = await this.requestJson(
      'POST',
      `${this.repoPath(repo)}/events`,
      repositoryEventEnvelopeWireSchema,
      { actor: event.actor, type: event.type, payload: event.payload },
    )
    return envelope as unknown as RepositoryEventEnvelope<T>
  }

  async appendRepoWithArtifacts<T extends RepositoryEventType>(
    repo: string,
    artifacts: ArtifactInput[],
    makeEvent: (deposited: RepositoryArtifactMeta[]) => RepositoryEventWrite<T>,
  ): Promise<{
    event: RepositoryEventEnvelope<T>
    artifacts: RepositoryArtifactMeta[]
  }> {
    const sentinels: RepositoryArtifactMeta[] = artifacts.map((artifact, index) => ({
      repo,
      kind: artifact.kind,
      revision: placeholderRev(index),
      blobRef: '',
      metadata: structuredClone(artifact.metadata ?? {}),
      createdAt: '',
    }))
    const write = makeEvent(sentinels)
    const result = await this.requestJson(
      'POST',
      `${this.repoPath(repo)}/deposits`,
      repoDepositsResponseSchema,
      {
        artifacts: artifacts.map((artifact) => ({
          kind: artifact.kind,
          contentBase64: encodeBase64(toBytes(artifact.content)),
          ...(artifact.metadata !== undefined ? { metadata: artifact.metadata } : {}),
        })),
        event: { actor: write.actor, type: write.type, payload: write.payload },
      },
    )
    return {
      event: result.event as unknown as RepositoryEventEnvelope<T>,
      artifacts: result.artifacts,
    }
  }

  async getRepoEvents(
    repo: string,
    sinceSeq = 0,
    opts?: { waitSeconds?: number; signal?: AbortSignal },
  ): Promise<RepositoryEvent[]> {
    const params = new URLSearchParams({ since: String(sinceSeq) })
    if (opts?.waitSeconds !== undefined) params.set('wait', String(opts.waitSeconds))
    return this.heldRequest(
      opts?.signal,
      (): RepositoryEvent[] => [],
      () =>
        this.requestJson(
          'GET',
          `${this.repoPath(repo)}/events?${params}`,
          repositoryEventListSchema,
          undefined,
          opts?.signal,
        ) as Promise<RepositoryEvent[]>,
    )
  }

  async getRepoStateEvents(repo: string): Promise<RepositoryEvent[]> {
    // The bounded repository-journal read (AUT-489): one additive route next
    // to `GET events`, reusing the same wire shape. No protocol-version bump
    // and no change to existing routes — a client on the previous release
    // never calls this route, so behavioral identity of the old surface is
    // the whole cross-version contract.
    return this.requestJson(
      'GET',
      `${this.repoPath(repo)}/state-events`,
      repositoryEventListSchema,
    ) as Promise<RepositoryEvent[]>
  }

  async putRepoArtifact(repo: string, artifact: ArtifactInput): Promise<RepositoryArtifactMeta> {
    return this.requestJson(
      'POST',
      `${this.repoPath(repo)}/artifacts`,
      repositoryArtifactMetaWireSchema,
      {
        kind: artifact.kind,
        contentBase64: encodeBase64(toBytes(artifact.content)),
        ...(artifact.metadata !== undefined ? { metadata: artifact.metadata } : {}),
      },
    )
  }

  async getRepoArtifact(
    repo: string,
    kind: string,
    rev?: number,
  ): Promise<RepositoryArtifact | null> {
    const params = new URLSearchParams({ kind })
    if (rev !== undefined) params.set('rev', String(rev))
    const result = await this.requestJson(
      'GET',
      `${this.repoPath(repo)}/artifacts?${params}`,
      repositoryArtifactGetResponseSchema,
    )
    return result === null
      ? null
      : { meta: result.meta, content: decodeBase64(result.contentBase64) }
  }

  async listRepoArtifacts(repo: string, kind?: string): Promise<RepositoryArtifactMeta[]> {
    const query = kind !== undefined ? `?kind=${encodeURIComponent(kind)}` : ''
    return this.requestJson(
      'GET',
      `${this.repoPath(repo)}/artifact-list${query}`,
      repositoryArtifactMetaListSchema,
    )
  }

  async claimRepoLease(repo: string, holder: string, ttlMs: number): Promise<boolean> {
    const result = await this.requestJson(
      'POST',
      `${this.repoPath(repo)}/lease/claim`,
      okResponseSchema,
      { holder, ttlMs },
    )
    return result.ok
  }

  async heartbeatRepo(repo: string, holder: string): Promise<boolean> {
    const result = await this.requestJson(
      'POST',
      `${this.repoPath(repo)}/lease/heartbeat`,
      okResponseSchema,
      { holder },
    )
    return result.ok
  }

  async releaseRepoLease(repo: string, holder: string): Promise<void> {
    await this.requestJson('POST', `${this.repoPath(repo)}/lease/release`, okResponseSchema, {
      holder,
    })
  }

  // ── Operator sessions (SPEC §7.1.1) ──────────────────────────────────
  // Mirrors the repository-journal family: collection routes under
  // /repos/{repo}/sessions and addressed routes under /sessions/{id}.

  async createSession(input: NewSessionInput): Promise<SessionRecord> {
    return this.requestJson(
      'POST',
      `${this.repoPath(input.repo)}/sessions`,
      sessionRecordWireSchema,
      input,
    )
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const response = await this.raw('GET', this.sessionPath(id))
    if (response.status === 404) return null
    if (!response.ok) throw await this.toError(response)
    const body: unknown = await response.json()
    return body === null ? null : sessionRecordWireSchema.parse(body)
  }

  async listSessions(repo: string): Promise<SessionRecord[]> {
    return this.requestJson('GET', `${this.repoPath(repo)}/sessions`, sessionRecordListSchema)
  }

  async appendSessionEvent<T extends SessionEventType>(
    id: string,
    event: SessionEventWrite<T>,
  ): Promise<SessionEventEnvelope<T>> {
    const envelope = await this.requestJson(
      'POST',
      `${this.sessionPath(id)}/events`,
      sessionEventEnvelopeWireSchema,
      { actor: event.actor, type: event.type, payload: event.payload },
    )
    return envelope as unknown as SessionEventEnvelope<T>
  }

  async appendSessionEventIfCurrent<T extends SessionEventType>(
    id: string,
    expectedSeq: number,
    event: SessionEventWrite<T>,
  ): Promise<SessionEventEnvelope<T> | null> {
    const envelope = await this.requestJson(
      'POST',
      `${this.sessionPath(id)}/events/conditional`,
      conditionalSessionEventResponseSchema,
      {
        expectedSeq,
        event: { actor: event.actor, type: event.type, payload: event.payload },
      },
    )
    return envelope as SessionEventEnvelope<T> | null
  }

  async getSessionEvents(
    id: string,
    sinceSeq = 0,
    opts?: { waitSeconds?: number; signal?: AbortSignal },
  ): Promise<SessionEvent[]> {
    const params = new URLSearchParams({ since: String(sinceSeq) })
    if (opts?.waitSeconds !== undefined) params.set('wait', String(opts.waitSeconds))
    return this.heldRequest(
      opts?.signal,
      (): SessionEvent[] => [],
      () =>
        this.requestJson(
          'GET',
          `${this.sessionPath(id)}/events?${params}`,
          sessionEventListSchema,
          undefined,
          opts?.signal,
        ) as Promise<SessionEvent[]>,
    )
  }

  async appendSessionWithArtifacts<T extends SessionEventType>(
    id: string,
    artifacts: ArtifactInput[],
    makeEvent: (deposited: SessionArtifactMeta[]) => SessionEventWrite<T>,
  ): Promise<{ event: SessionEventEnvelope<T>; artifacts: SessionArtifactMeta[] }> {
    const sentinels: SessionArtifactMeta[] = artifacts.map((artifact, index) => ({
      session: id,
      kind: artifact.kind,
      revision: placeholderRev(index),
      blobRef: '',
      metadata: structuredClone(artifact.metadata ?? {}),
      createdAt: '',
    }))
    const write = makeEvent(sentinels)
    const result = await this.requestJson(
      'POST',
      `${this.sessionPath(id)}/deposits`,
      sessionDepositsResponseSchema,
      {
        artifacts: artifacts.map((artifact) => ({
          kind: artifact.kind,
          contentBase64: encodeBase64(toBytes(artifact.content)),
          ...(artifact.metadata !== undefined ? { metadata: artifact.metadata } : {}),
        })),
        event: { actor: write.actor, type: write.type, payload: write.payload },
      },
    )
    return {
      event: result.event as unknown as SessionEventEnvelope<T>,
      artifacts: result.artifacts,
    }
  }

  async putSessionArtifact(id: string, artifact: ArtifactInput): Promise<SessionArtifactMeta> {
    return this.requestJson(
      'POST',
      `${this.sessionPath(id)}/artifacts`,
      sessionArtifactMetaWireSchema,
      {
        kind: artifact.kind,
        contentBase64: encodeBase64(toBytes(artifact.content)),
        ...(artifact.metadata !== undefined ? { metadata: artifact.metadata } : {}),
      },
    )
  }

  async getSessionArtifact(
    id: string,
    kind: string,
    rev?: number,
  ): Promise<SessionArtifact | null> {
    const params = new URLSearchParams({ kind })
    if (rev !== undefined) params.set('rev', String(rev))
    const result = await this.requestJson(
      'GET',
      `${this.sessionPath(id)}/artifacts?${params}`,
      sessionArtifactGetResponseSchema,
    )
    return result === null
      ? null
      : { meta: result.meta, content: decodeBase64(result.contentBase64) }
  }

  async listSessionArtifacts(id: string, kind?: string): Promise<SessionArtifactMeta[]> {
    const query = kind !== undefined ? `?kind=${encodeURIComponent(kind)}` : ''
    return this.requestJson(
      'GET',
      `${this.sessionPath(id)}/artifact-list${query}`,
      sessionArtifactMetaListSchema,
    )
  }

  subscribe(slug: string, opts: SubscribeOptions, onEvent: (event: AbEvent) => void): Unsubscribe {
    // Default to the bounded-wait window (AUT-334): a plain `subscribe` on a
    // quiet stream costs one held request per wait window, not one request
    // per `pollMs`. Callers may pass their own `waitSeconds` (or 0 to force
    // the immediate interval loop); a server that ignores the parameter
    // answers immediately and the cadence degrades to the old request rate.
    const { waitSeconds = REMOTE_EVENT_WAIT_SECONDS, ...rest } = opts
    return pollingSubscribe(
      (since, pollOpts) => this.getEvents(slug, since, pollOpts),
      { ...rest, waitSeconds: waitSeconds > 0 ? waitSeconds : undefined },
      onEvent,
    )
  }

  // ── Streams (SPEC §7.6) ──────────────────────────────────────────────────
  // Create and list are scoped, so they use the family routes. The four
  // addressed operations know only the stream id — a store-assigned id is
  // globally unique — so they use the protocol's top-level `/streams/{id}`
  // routes, where the server resolves the stream's own scope and
  // authorizes against it.

  private streamFamilyPath(scope: StreamScope): string {
    return scope.kind === 'build'
      ? `${this.buildPath(scope.build)}/streams`
      : scope.kind === 'repo'
        ? `${this.repoPath(scope.repo)}/streams`
        : `${this.sessionPath(scope.session)}/streams`
  }

  private streamPath(streamId: string, suffix = ''): string {
    return `/streams/${encodeURIComponent(streamId)}${suffix}`
  }

  async createStream(scope: StreamScope, label: string): Promise<StreamRecord> {
    return this.requestJson('POST', this.streamFamilyPath(scope), streamRecordWireSchema, {
      label,
    }) as Promise<StreamRecord>
  }

  async appendStreamParts(streamId: string, parts: StreamPart[]): Promise<StreamChunk> {
    return this.requestJson('POST', this.streamPath(streamId, '/chunks'), streamChunkWireSchema, {
      parts,
    }) as Promise<StreamChunk>
  }

  async readStream(
    streamId: string,
    opts?: { since?: number; waitSeconds?: number; signal?: AbortSignal },
  ): Promise<StreamRead> {
    const params = new URLSearchParams({ since: String(opts?.since ?? 0) })
    if (opts?.waitSeconds !== undefined) params.set('wait', String(opts.waitSeconds))
    // A closed stream never waits, so an aborted hold was necessarily on an
    // open stream — the empty read is `open` with no chunks.
    return this.heldRequest(
      opts?.signal,
      (): StreamRead => ({ chunks: [], status: 'open' }),
      () =>
        this.requestJson(
          'GET',
          `${this.streamPath(streamId, '/chunks')}?${params}`,
          streamReadWireSchema,
          undefined,
          opts?.signal,
        ) as Promise<StreamRead>,
    )
  }

  async closeStream(streamId: string, outcome: StreamOutcome): Promise<StreamRecord> {
    return this.requestJson('POST', this.streamPath(streamId, '/close'), streamRecordWireSchema, {
      outcome,
    }) as Promise<StreamRecord>
  }

  async getStream(streamId: string): Promise<StreamRecord | null> {
    const response = await this.raw('GET', this.streamPath(streamId))
    if (response.status === 404) return null
    if (!response.ok) throw await this.toError(response)
    return streamRecordWireSchema.parse(await response.json()) as StreamRecord
  }

  async listStreams(scope: StreamScope): Promise<StreamRecord[]> {
    return this.requestJson('GET', this.streamFamilyPath(scope), streamRecordListSchema) as Promise<
      StreamRecord[]
    >
  }

  async close(): Promise<void> {
    // No-op: the server owns the backing store's lifecycle.
  }
}
