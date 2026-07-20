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
import { pollingSubscribe } from '../subscribe'
import {
  toBytes,
  type Artifact,
  type ArtifactInput,
  type ArtifactMeta,
  type BuildRecord,
  type BuildStore,
  type NewBuildInput,
  type RepositoryArtifact,
  type RepositoryArtifactMeta,
  type RepositoryRecord,
  type SubscribeOptions,
  type Unsubscribe,
} from '../types'
import {
  artifactGetResponseSchema,
  artifactMetaListSchema,
  artifactMetaWireSchema,
  buildRecordListSchema,
  buildRecordWireSchema,
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
} from './protocol'

/** A scoped-token rejection (D8): 401 (missing/expired) or 403 (wrong build). */
export class AuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

export interface RemoteBuildStoreOptions {
  /** Base URL of a store server (e.g. `http://127.0.0.1:4711`); fixed for life. */
  url: string
  /** Scoped bearer token (D8); omit against an open (no-secret) server. */
  token?: string
  /** Injectable network seam; defaults to global fetch. */
  fetchFn?: typeof fetch
}

export class RemoteBuildStore implements BuildStore {
  private readonly base: string
  private readonly token: string | undefined
  private readonly fetchFn: typeof fetch

  constructor(opts: RemoteBuildStoreOptions) {
    this.base = opts.url.replace(/\/+$/, '')
    this.token = opts.token
    this.fetchFn = opts.fetchFn ?? fetch
  }

  private buildPath(slug: string): string {
    return `/builds/${encodeURIComponent(slug)}`
  }

  private repoPath(repo: string): string {
    return `/repos/${encodeURIComponent(repo)}`
  }

  private async raw(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = {}
    if (this.token !== undefined) headers['authorization'] = `Bearer ${this.token}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    return this.fetchFn(`${this.base}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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
    // 404 carries the local adapters' message shape: `unknown build "slug"`.
    return new Error(message)
  }

  private async requestJson<T>(
    method: 'GET' | 'POST',
    path: string,
    schema: { parse: (data: unknown) => T },
    body?: unknown,
  ): Promise<T> {
    const response = await this.raw(method, path, body)
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

  async append<T extends EventType>(
    slug: string,
    event: EventWrite<T>,
  ): Promise<EventEnvelope<T>> {
    const envelope = await this.requestJson(
      'POST',
      `${this.buildPath(slug)}/events`,
      eventEnvelopeWireSchema,
      { actor: event.actor, type: event.type, payload: event.payload },
    )
    return envelope as unknown as EventEnvelope<T>
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
          ...(artifact.metadata !== undefined
            ? { metadata: artifact.metadata }
            : {}),
        })),
        event: { actor: write.actor, type: write.type, payload: write.payload },
      },
    )
    return {
      event: result.event as unknown as EventEnvelope<T>,
      artifacts: result.artifacts,
    }
  }

  async getEvents(slug: string, sinceSeq = 0): Promise<AbEvent[]> {
    const events = await this.requestJson(
      'GET',
      `${this.buildPath(slug)}/events?since=${sinceSeq}`,
      eventListSchema,
    )
    return events as unknown as AbEvent[]
  }

  async putArtifact(slug: string, artifact: ArtifactInput): Promise<ArtifactMeta> {
    return this.requestJson(
      'POST',
      `${this.buildPath(slug)}/artifacts`,
      artifactMetaWireSchema,
      {
        kind: artifact.kind,
        contentBase64: encodeBase64(toBytes(artifact.content)),
        ...(artifact.metadata !== undefined
          ? { metadata: artifact.metadata }
          : {}),
      },
    )
  }

  async getArtifact(
    slug: string,
    kind: string,
    rev?: number,
  ): Promise<Artifact | null> {
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
    await this.requestJson(
      'POST',
      `${this.buildPath(slug)}/lease/release`,
      okResponseSchema,
      { holder },
    )
  }

  async ensureRepo(repo: string): Promise<RepositoryRecord> {
    return this.requestJson(
      'POST',
      '/repos',
      repositoryRecordWireSchema,
      { repo },
    )
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
    makeEvent: (
      deposited: RepositoryArtifactMeta[],
    ) => RepositoryEventWrite<T>,
  ): Promise<{
    event: RepositoryEventEnvelope<T>
    artifacts: RepositoryArtifactMeta[]
  }> {
    const sentinels: RepositoryArtifactMeta[] = artifacts.map(
      (artifact, index) => ({
        repo,
        kind: artifact.kind,
        revision: placeholderRev(index),
        blobRef: '',
        metadata: structuredClone(artifact.metadata ?? {}),
        createdAt: '',
      }),
    )
    const write = makeEvent(sentinels)
    const result = await this.requestJson(
      'POST',
      `${this.repoPath(repo)}/deposits`,
      repoDepositsResponseSchema,
      {
        artifacts: artifacts.map((artifact) => ({
          kind: artifact.kind,
          contentBase64: encodeBase64(toBytes(artifact.content)),
          ...(artifact.metadata !== undefined
            ? { metadata: artifact.metadata }
            : {}),
        })),
        event: { actor: write.actor, type: write.type, payload: write.payload },
      },
    )
    return {
      event: result.event as unknown as RepositoryEventEnvelope<T>,
      artifacts: result.artifacts,
    }
  }

  async getRepoEvents(repo: string, sinceSeq = 0): Promise<RepositoryEvent[]> {
    const events = await this.requestJson(
      'GET',
      `${this.repoPath(repo)}/events?since=${sinceSeq}`,
      repositoryEventListSchema,
    )
    return events as unknown as RepositoryEvent[]
  }

  async putRepoArtifact(
    repo: string,
    artifact: ArtifactInput,
  ): Promise<RepositoryArtifactMeta> {
    return this.requestJson(
      'POST',
      `${this.repoPath(repo)}/artifacts`,
      repositoryArtifactMetaWireSchema,
      {
        kind: artifact.kind,
        contentBase64: encodeBase64(toBytes(artifact.content)),
        ...(artifact.metadata !== undefined
          ? { metadata: artifact.metadata }
          : {}),
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

  async listRepoArtifacts(
    repo: string,
    kind?: string,
  ): Promise<RepositoryArtifactMeta[]> {
    const query = kind !== undefined ? `?kind=${encodeURIComponent(kind)}` : ''
    return this.requestJson(
      'GET',
      `${this.repoPath(repo)}/artifact-list${query}`,
      repositoryArtifactMetaListSchema,
    )
  }

  async claimRepoLease(
    repo: string,
    holder: string,
    ttlMs: number,
  ): Promise<boolean> {
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
    await this.requestJson(
      'POST',
      `${this.repoPath(repo)}/lease/release`,
      okResponseSchema,
      { holder },
    )
  }

  subscribe(
    slug: string,
    opts: SubscribeOptions,
    onEvent: (event: AbEvent) => void,
  ): Unsubscribe {
    return pollingSubscribe((since) => this.getEvents(slug, since), opts, onEvent)
  }

  async close(): Promise<void> {
    // No-op: the server owns the backing store's lifecycle.
  }
}
