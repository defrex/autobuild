import type { EventType } from '../events/payloads'
import type { EventWrite } from '../events/catalog'
import type { RepositoryEventType, RepositoryEventWrite } from '../events/repository'
import type { AbEvent, EventEnvelope } from '../events/catalog'
import type { RepositoryEvent, RepositoryEventEnvelope } from '../events/repository'
import type {
  Artifact,
  ArtifactInput,
  ArtifactMeta,
  BuildRecord,
  BuildScopedStore,
  BuildStore,
  NewBuildInput,
  RepositoryArtifact,
  RepositoryArtifactMeta,
  RepositoryRecord,
  SubscribeOptions,
  Unsubscribe,
} from './types'

/** Interface-level authority failure. It is deliberately independent of the
 * remote transport's authentication errors: tokens carry this scope over the
 * wire, while every adapter enforces it before delegation. */
export class BuildScopeError extends Error {
  constructor(
    readonly scope: string,
    readonly operation: string,
    readonly target?: string,
  ) {
    super(
      target === undefined
        ? `build-scoped store for ${JSON.stringify(scope)} forbids ${operation}`
        : `build-scoped store for ${JSON.stringify(scope)} forbids ${operation} targeting ${JSON.stringify(target)}`,
    )
    this.name = 'BuildScopeError'
  }
}

/** Wrap a full store with one-build authority. The wrapper intentionally keeps
 * the complete BuildStore shape so accidental admin, collection, repository,
 * or foreign-build calls fail loudly instead of disappearing behind a type
 * assertion. */
export function createBuildScopedStore(store: BuildStore, scope: string): BuildScopedStore {
  const own = (operation: string, slug: string): void => {
    if (slug !== scope) throw new BuildScopeError(scope, operation, slug)
  }
  return {
    buildScope: scope,
    scopeBuild(slug: string): BuildScopedStore {
      own('scopeBuild', slug)
      return this
    },
    createBuild(_input: NewBuildInput): Promise<BuildRecord> {
      return Promise.reject(new BuildScopeError(scope, 'createBuild'))
    },
    async getBuild(slug: string): Promise<BuildRecord | null> {
      own('getBuild', slug)
      return store.getBuild(slug)
    },
    listBuilds(): Promise<BuildRecord[]> {
      return Promise.reject(new BuildScopeError(scope, 'listBuilds'))
    },
    async append<T extends EventType>(
      slug: string,
      event: EventWrite<T>,
    ): Promise<EventEnvelope<T>> {
      own('append', slug)
      return store.append(slug, event)
    },
    async appendIfCurrent<T extends EventType>(
      slug: string,
      expectedSeq: number,
      event: EventWrite<T>,
    ): Promise<EventEnvelope<T> | null> {
      own('appendIfCurrent', slug)
      return store.appendIfCurrent(slug, expectedSeq, event)
    },
    async appendWithArtifacts<T extends EventType>(
      slug: string,
      artifacts: ArtifactInput[],
      makeEvent: (deposited: ArtifactMeta[]) => EventWrite<T>,
    ): Promise<{ event: EventEnvelope<T>; artifacts: ArtifactMeta[] }> {
      own('appendWithArtifacts', slug)
      return store.appendWithArtifacts(slug, artifacts, makeEvent)
    },
    async getEvents(slug: string, sinceSeq?: number): Promise<AbEvent[]> {
      own('getEvents', slug)
      return store.getEvents(slug, sinceSeq)
    },
    async putArtifact(slug: string, artifact: ArtifactInput): Promise<ArtifactMeta> {
      own('putArtifact', slug)
      return store.putArtifact(slug, artifact)
    },
    async getArtifact(slug: string, kind: string, rev?: number): Promise<Artifact | null> {
      own('getArtifact', slug)
      return store.getArtifact(slug, kind, rev)
    },
    async listArtifacts(slug: string, kind?: string): Promise<ArtifactMeta[]> {
      own('listArtifacts', slug)
      return store.listArtifacts(slug, kind)
    },
    async claimLease(slug: string, holder: string, ttlMs: number): Promise<boolean> {
      own('claimLease', slug)
      return store.claimLease(slug, holder, ttlMs)
    },
    async heartbeat(slug: string, holder: string): Promise<boolean> {
      own('heartbeat', slug)
      return store.heartbeat(slug, holder)
    },
    async releaseLease(slug: string, holder: string): Promise<void> {
      own('releaseLease', slug)
      return store.releaseLease(slug, holder)
    },
    subscribe(
      slug: string,
      opts: SubscribeOptions,
      onEvent: (event: AbEvent) => void,
    ): Unsubscribe {
      own('subscribe', slug)
      return store.subscribe(slug, opts, onEvent)
    },
    ensureRepo(repo: string): Promise<RepositoryRecord> {
      return Promise.reject(new BuildScopeError(scope, 'ensureRepo', repo))
    },
    getRepo(repo: string): Promise<RepositoryRecord | null> {
      return Promise.reject(new BuildScopeError(scope, 'getRepo', repo))
    },
    appendRepo<T extends RepositoryEventType>(
      repo: string,
      _event: RepositoryEventWrite<T>,
    ): Promise<RepositoryEventEnvelope<T>> {
      return Promise.reject(new BuildScopeError(scope, 'appendRepo', repo))
    },
    appendRepoWithArtifacts<T extends RepositoryEventType>(
      repo: string,
      _artifacts: ArtifactInput[],
      _makeEvent: (deposited: RepositoryArtifactMeta[]) => RepositoryEventWrite<T>,
    ): Promise<{ event: RepositoryEventEnvelope<T>; artifacts: RepositoryArtifactMeta[] }> {
      return Promise.reject(new BuildScopeError(scope, 'appendRepoWithArtifacts', repo))
    },
    getRepoEvents(repo: string, _sinceSeq?: number): Promise<RepositoryEvent[]> {
      return Promise.reject(new BuildScopeError(scope, 'getRepoEvents', repo))
    },
    putRepoArtifact(repo: string, _artifact: ArtifactInput): Promise<RepositoryArtifactMeta> {
      return Promise.reject(new BuildScopeError(scope, 'putRepoArtifact', repo))
    },
    getRepoArtifact(
      repo: string,
      _kind: string,
      _rev?: number,
    ): Promise<RepositoryArtifact | null> {
      return Promise.reject(new BuildScopeError(scope, 'getRepoArtifact', repo))
    },
    listRepoArtifacts(repo: string, _kind?: string): Promise<RepositoryArtifactMeta[]> {
      return Promise.reject(new BuildScopeError(scope, 'listRepoArtifacts', repo))
    },
    claimRepoLease(repo: string, _holder: string, _ttlMs: number): Promise<boolean> {
      return Promise.reject(new BuildScopeError(scope, 'claimRepoLease', repo))
    },
    heartbeatRepo(repo: string, _holder: string): Promise<boolean> {
      return Promise.reject(new BuildScopeError(scope, 'heartbeatRepo', repo))
    },
    releaseRepoLease(repo: string, _holder: string): Promise<void> {
      return Promise.reject(new BuildScopeError(scope, 'releaseRepoLease', repo))
    },
    close(): Promise<void> {
      return Promise.reject(new BuildScopeError(scope, 'close'))
    },
  }
}
