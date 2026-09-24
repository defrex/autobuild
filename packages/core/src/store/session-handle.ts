import type { EventType } from '../events/payloads'
import type { EventWrite } from '../events/catalog'
import type { RepositoryEventType, RepositoryEventWrite } from '../events/repository'
import type { AbEvent, EventEnvelope } from '../events/catalog'
import type { RepositoryEvent, RepositoryEventEnvelope } from '../events/repository'
import type {
  SessionEvent,
  SessionEventEnvelope,
  SessionEventType,
  SessionEventWrite,
} from '../events/sessions'
import type {
  Artifact,
  ArtifactInput,
  ArtifactMeta,
  BuildDigest,
  BuildRecord,
  BuildStore,
  NewBuildInput,
  RepositoryArtifact,
  RepositoryArtifactMeta,
  RepositoryRecord,
  SessionArtifact,
  SessionArtifactMeta,
  SessionRecord,
  SessionScopedStore,
  SubscribeOptions,
  Unsubscribe,
} from './types'
import type {
  StreamChunk,
  StreamOutcome,
  StreamPart,
  StreamRead,
  StreamRecord,
  StreamScope,
} from './streams/types'

/** Interface-level authority failure for a session-scoped handle — the
 * session counterpart of `BuildScopeError`. */
export class SessionScopeError extends Error {
  constructor(
    readonly scope: string,
    readonly operation: string,
    readonly target?: string,
  ) {
    super(
      target === undefined
        ? `session-scoped store for ${JSON.stringify(scope)} forbids ${operation}`
        : `session-scoped store for ${JSON.stringify(scope)} forbids ${operation} targeting ${JSON.stringify(target)}`,
    )
    this.name = 'SessionScopeError'
  }
}

/** Wrap a full store with one-session authority. The wrapper keeps the
 * complete BuildStore shape so accidental session create/list, collection,
 * build, or repository calls fail loudly instead of disappearing behind a
 * type assertion. A session-scoped handle may touch only its own session's
 * record, events, artifacts, and session-scoped streams. */
export function createSessionScopedStore(store: BuildStore, scope: string): SessionScopedStore {
  const own = (operation: string, id: string): void => {
    if (id !== scope) throw new SessionScopeError(scope, operation, id)
  }
  const ownStreamScope = (record: StreamRecord): void => {
    if (record.scope.kind !== 'session' || record.scope.session !== scope) {
      throw new SessionScopeError(scope, 'stream', record.id)
    }
  }
  const ownStream = async (streamId: string): Promise<void> => {
    const record = await store.getStream(streamId)
    if (record) ownStreamScope(record)
  }
  const sessionScope = (operation: string, candidate: StreamScope): void => {
    if (candidate.kind !== 'session' || candidate.session !== scope) {
      throw new SessionScopeError(scope, operation, JSON.stringify(candidate))
    }
  }
  return {
    sessionScope: scope,
    scopeSession(id: string): SessionScopedStore {
      own('scopeSession', id)
      return this
    },
    scopeBuild(_slug: string): never {
      throw new SessionScopeError(scope, 'scopeBuild')
    },
    createBuild(_input: NewBuildInput): Promise<BuildRecord> {
      return Promise.reject(new SessionScopeError(scope, 'createBuild'))
    },
    getBuild(slug: string): Promise<BuildRecord | null> {
      return Promise.reject(new SessionScopeError(scope, 'getBuild', slug))
    },
    listBuilds(): Promise<BuildRecord[]> {
      return Promise.reject(new SessionScopeError(scope, 'listBuilds'))
    },
    append<T extends EventType>(slug: string, _event: EventWrite<T>): Promise<EventEnvelope<T>> {
      return Promise.reject(new SessionScopeError(scope, 'append', slug))
    },
    appendIfCurrent<T extends EventType>(
      slug: string,
      _expectedSeq: number,
      _event: EventWrite<T>,
    ): Promise<EventEnvelope<T> | null> {
      return Promise.reject(new SessionScopeError(scope, 'appendIfCurrent', slug))
    },
    appendWithArtifacts<T extends EventType>(
      slug: string,
      _artifacts: ArtifactInput[],
      _makeEvent: (deposited: ArtifactMeta[]) => EventWrite<T>,
    ): Promise<{ event: EventEnvelope<T>; artifacts: ArtifactMeta[] }> {
      return Promise.reject(new SessionScopeError(scope, 'appendWithArtifacts', slug))
    },
    getEvents(slug: string, _sinceSeq?: number): Promise<AbEvent[]> {
      return Promise.reject(new SessionScopeError(scope, 'getEvents', slug))
    },
    putArtifact(slug: string, _artifact: ArtifactInput): Promise<ArtifactMeta> {
      return Promise.reject(new SessionScopeError(scope, 'putArtifact', slug))
    },
    getArtifact(slug: string, _kind: string, _rev?: number): Promise<Artifact | null> {
      return Promise.reject(new SessionScopeError(scope, 'getArtifact', slug))
    },
    listArtifacts(slug: string, _kind?: string): Promise<ArtifactMeta[]> {
      return Promise.reject(new SessionScopeError(scope, 'listArtifacts', slug))
    },
    claimLease(slug: string, _holder: string, _ttlMs: number): Promise<boolean> {
      return Promise.reject(new SessionScopeError(scope, 'claimLease', slug))
    },
    heartbeat(slug: string, _holder: string): Promise<boolean> {
      return Promise.reject(new SessionScopeError(scope, 'heartbeat', slug))
    },
    releaseLease(slug: string, _holder: string): Promise<void> {
      return Promise.reject(new SessionScopeError(scope, 'releaseLease', slug))
    },
    subscribe(
      slug: string,
      _opts: SubscribeOptions,
      _onEvent: (event: AbEvent) => void,
    ): Unsubscribe {
      throw new SessionScopeError(scope, 'subscribe', slug)
    },
    ensureRepo(repo: string): Promise<RepositoryRecord> {
      return Promise.reject(new SessionScopeError(scope, 'ensureRepo', repo))
    },
    getRepo(repo: string): Promise<RepositoryRecord | null> {
      return Promise.reject(new SessionScopeError(scope, 'getRepo', repo))
    },
    appendRepo<T extends RepositoryEventType>(
      repo: string,
      _event: RepositoryEventWrite<T>,
    ): Promise<RepositoryEventEnvelope<T>> {
      return Promise.reject(new SessionScopeError(scope, 'appendRepo', repo))
    },
    appendRepoWithArtifacts<T extends RepositoryEventType>(
      repo: string,
      _artifacts: ArtifactInput[],
      _makeEvent: (deposited: RepositoryArtifactMeta[]) => RepositoryEventWrite<T>,
    ): Promise<{ event: RepositoryEventEnvelope<T>; artifacts: RepositoryArtifactMeta[] }> {
      return Promise.reject(new SessionScopeError(scope, 'appendRepoWithArtifacts', repo))
    },
    getRepoEvents(repo: string, _sinceSeq?: number): Promise<RepositoryEvent[]> {
      return Promise.reject(new SessionScopeError(scope, 'getRepoEvents', repo))
    },
    getRepoStateEvents(repo: string): Promise<RepositoryEvent[]> {
      return Promise.reject(new SessionScopeError(scope, 'getRepoStateEvents', repo))
    },
    getRepoBuildDigests(repo: string): Promise<Map<string, BuildDigest>> {
      return Promise.reject(new SessionScopeError(scope, 'getRepoBuildDigests', repo))
    },
    putRepoArtifact(repo: string, _artifact: ArtifactInput): Promise<RepositoryArtifactMeta> {
      return Promise.reject(new SessionScopeError(scope, 'putRepoArtifact', repo))
    },
    getRepoArtifact(
      repo: string,
      _kind: string,
      _rev?: number,
    ): Promise<RepositoryArtifact | null> {
      return Promise.reject(new SessionScopeError(scope, 'getRepoArtifact', repo))
    },
    listRepoArtifacts(repo: string, _kind?: string): Promise<RepositoryArtifactMeta[]> {
      return Promise.reject(new SessionScopeError(scope, 'listRepoArtifacts', repo))
    },
    claimRepoLease(repo: string, _holder: string, _ttlMs: number): Promise<boolean> {
      return Promise.reject(new SessionScopeError(scope, 'claimRepoLease', repo))
    },
    heartbeatRepo(repo: string, _holder: string): Promise<boolean> {
      return Promise.reject(new SessionScopeError(scope, 'heartbeatRepo', repo))
    },
    releaseRepoLease(repo: string, _holder: string): Promise<void> {
      return Promise.reject(new SessionScopeError(scope, 'releaseRepoLease', repo))
    },
    async createSession(input): Promise<SessionRecord> {
      throw new SessionScopeError(scope, 'createSession', input.repo)
    },
    async getSession(id: string): Promise<SessionRecord | null> {
      own('getSession', id)
      return store.getSession(id)
    },
    listSessions(repo: string): Promise<SessionRecord[]> {
      return Promise.reject(new SessionScopeError(scope, 'listSessions', repo))
    },
    async appendSessionEvent<T extends SessionEventType>(
      id: string,
      event: SessionEventWrite<T>,
    ): Promise<SessionEventEnvelope<T>> {
      own('appendSessionEvent', id)
      return store.appendSessionEvent(id, event)
    },
    async getSessionEvents(
      id: string,
      sinceSeq?: number,
      opts?: { waitSeconds?: number; signal?: AbortSignal },
    ): Promise<SessionEvent[]> {
      own('getSessionEvents', id)
      return store.getSessionEvents(id, sinceSeq, opts)
    },
    async appendSessionWithArtifacts<T extends SessionEventType>(
      id: string,
      artifacts: ArtifactInput[],
      makeEvent: (deposited: SessionArtifactMeta[]) => SessionEventWrite<T>,
    ): Promise<{ event: SessionEventEnvelope<T>; artifacts: SessionArtifactMeta[] }> {
      own('appendSessionWithArtifacts', id)
      return store.appendSessionWithArtifacts(id, artifacts, makeEvent)
    },
    async putSessionArtifact(id: string, artifact: ArtifactInput): Promise<SessionArtifactMeta> {
      own('putSessionArtifact', id)
      return store.putSessionArtifact(id, artifact)
    },
    async getSessionArtifact(
      id: string,
      kind: string,
      rev?: number,
    ): Promise<SessionArtifact | null> {
      own('getSessionArtifact', id)
      return store.getSessionArtifact(id, kind, rev)
    },
    async listSessionArtifacts(id: string, kind?: string): Promise<SessionArtifactMeta[]> {
      own('listSessionArtifacts', id)
      return store.listSessionArtifacts(id, kind)
    },
    async createStream(candidate: StreamScope, label: string): Promise<StreamRecord> {
      sessionScope('createStream', candidate)
      return store.createStream(candidate, label)
    },
    async appendStreamParts(streamId: string, parts: StreamPart[]): Promise<StreamChunk> {
      await ownStream(streamId)
      return store.appendStreamParts(streamId, parts)
    },
    async readStream(
      streamId: string,
      opts?: { since?: number; waitSeconds?: number; signal?: AbortSignal },
    ): Promise<StreamRead> {
      await ownStream(streamId)
      return store.readStream(streamId, opts)
    },
    async closeStream(streamId: string, outcome: StreamOutcome): Promise<StreamRecord> {
      await ownStream(streamId)
      return store.closeStream(streamId, outcome)
    },
    async getStream(streamId: string): Promise<StreamRecord | null> {
      await ownStream(streamId)
      return store.getStream(streamId)
    },
    async listStreams(candidate: StreamScope): Promise<StreamRecord[]> {
      sessionScope('listStreams', candidate)
      return store.listStreams(candidate)
    },
    close(): Promise<void> {
      return Promise.reject(new SessionScopeError(scope, 'close'))
    },
  }
}
