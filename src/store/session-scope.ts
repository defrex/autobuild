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
  BuildStore,
  NewBuildInput,
  RepositoryArtifact,
  RepositoryArtifactMeta,
  RepositoryRecord,
  SubscribeOptions,
  Unsubscribe,
} from './types'

export type LocalSessionScope =
  | { kind: 'build'; id: string; session: string }
  | { kind: 'repo'; id: string; session: string }

/** An in-process authority failure for a local phase-session store handle. */
export class SessionScopeError extends Error {
  constructor(
    readonly scope: LocalSessionScope,
    readonly operation: string,
    readonly target?: { kind: 'build' | 'repo' | 'admin'; id?: string },
    message?: string,
  ) {
    const authority = `${scope.kind} ${JSON.stringify(scope.id)} and session ${JSON.stringify(scope.session)}`
    const addressed =
      target === undefined
        ? operation
        : target.kind === 'admin'
          ? `${operation} (admin)`
          : `${operation} targeting ${target.kind} ${JSON.stringify(target.id)}`
    super(message ?? `local session store scoped to ${authority} forbids ${addressed}`)
    this.name = 'SessionScopeError'
  }
}

type BuildSessionScope = Extract<LocalSessionScope, { kind: 'build' }>
type RepositorySessionScope = Extract<LocalSessionScope, { kind: 'repo' }>

/** The AUT-201 seam is included now so nested same-build scoping is idempotent
 * while a foreign scope can never widen this handle. The return shapes also
 * remain structurally compatible once BuildStore itself requires scopeBuild. */
export interface BuildLocalSessionStore extends BuildStore {
  readonly sessionScope: BuildSessionScope
  readonly buildScope: string
  scopeBuild(slug: string): BuildLocalSessionStore
}

export interface RepositoryLocalSessionStore extends BuildStore {
  readonly sessionScope: RepositorySessionScope
  scopeBuild(slug: string): never
}

export type LocalSessionStore = BuildLocalSessionStore | RepositoryLocalSessionStore

function actorSession(actor: unknown): string | null {
  if (typeof actor !== 'object' || actor === null) return null
  const { kind, session } = actor as { kind?: unknown; session?: unknown }
  return kind === 'agent' && typeof session === 'string' ? session : null
}

/**
 * Restrict a local Store handle to the exact resource and session supplied by
 * a validated ambient agent identity. Resource checks apply to every method;
 * the session dimension applies only to agent-attributed event writes so the
 * CLI's trusted KERNEL plumbing remains usable.
 */
export function scopeLocalStoreToSession(
  store: BuildStore,
  scope: BuildSessionScope,
): BuildLocalSessionStore
export function scopeLocalStoreToSession(
  store: BuildStore,
  scope: RepositorySessionScope,
): RepositoryLocalSessionStore
export function scopeLocalStoreToSession(
  store: BuildStore,
  scope: LocalSessionScope,
): LocalSessionStore
export function scopeLocalStoreToSession(
  store: BuildStore,
  scope: LocalSessionScope,
): LocalSessionStore {
  const target = (kind: 'build' | 'repo', id: string) => ({ kind, id }) as const
  const own = (operation: string, kind: 'build' | 'repo', id: string): void => {
    if (scope.kind !== kind || scope.id !== id) {
      throw new SessionScopeError(scope, operation, target(kind, id))
    }
  }
  const admin = (operation: string): never => {
    throw new SessionScopeError(scope, operation, { kind: 'admin' })
  }
  const authorizeActor = (operation: string, actor: unknown): void => {
    if (
      typeof actor !== 'object' ||
      actor === null ||
      (actor as { kind?: unknown }).kind !== 'agent'
    ) {
      return
    }
    const session = actorSession(actor)
    if (session !== scope.session) {
      throw new SessionScopeError(
        scope,
        operation,
        undefined,
        `local session store scoped to session ${JSON.stringify(scope.session)} may not write events attributed to ${
          session === null
            ? 'an agent without a valid session'
            : `session ${JSON.stringify(session)}`
        }`,
      )
    }
  }

  const scoped = {
    sessionScope: scope,
    ...(scope.kind === 'build' ? { buildScope: scope.id } : {}),

    scopeBuild(slug: string): BuildLocalSessionStore {
      own('scopeBuild', 'build', slug)
      return scoped as BuildLocalSessionStore
    },

    async createBuild(_input: NewBuildInput): Promise<BuildRecord> {
      return admin('createBuild')
    },
    async getBuild(slug: string): Promise<BuildRecord | null> {
      own('getBuild', 'build', slug)
      return store.getBuild(slug)
    },
    async listBuilds(): Promise<BuildRecord[]> {
      return admin('listBuilds')
    },
    async append<T extends EventType>(
      slug: string,
      event: EventWrite<T>,
    ): Promise<EventEnvelope<T>> {
      own('append', 'build', slug)
      authorizeActor('append', event.actor)
      return store.append(slug, event)
    },
    async appendIfCurrent<T extends EventType>(
      slug: string,
      expectedSeq: number,
      event: EventWrite<T>,
    ): Promise<EventEnvelope<T> | null> {
      own('appendIfCurrent', 'build', slug)
      authorizeActor('appendIfCurrent', event.actor)
      return store.appendIfCurrent(slug, expectedSeq, event)
    },
    async appendWithArtifacts<T extends EventType>(
      slug: string,
      artifacts: ArtifactInput[],
      makeEvent: (deposited: ArtifactMeta[]) => EventWrite<T>,
    ): Promise<{ event: EventEnvelope<T>; artifacts: ArtifactMeta[] }> {
      own('appendWithArtifacts', 'build', slug)
      return store.appendWithArtifacts(slug, artifacts, (deposited) => {
        const event = makeEvent(deposited)
        authorizeActor('appendWithArtifacts', event.actor)
        return event
      })
    },
    async getEvents(slug: string, sinceSeq?: number): Promise<AbEvent[]> {
      own('getEvents', 'build', slug)
      return store.getEvents(slug, sinceSeq)
    },
    async putArtifact(slug: string, artifact: ArtifactInput): Promise<ArtifactMeta> {
      own('putArtifact', 'build', slug)
      return store.putArtifact(slug, artifact)
    },
    async getArtifact(slug: string, kind: string, rev?: number): Promise<Artifact | null> {
      own('getArtifact', 'build', slug)
      return store.getArtifact(slug, kind, rev)
    },
    async listArtifacts(slug: string, kind?: string): Promise<ArtifactMeta[]> {
      own('listArtifacts', 'build', slug)
      return store.listArtifacts(slug, kind)
    },
    async claimLease(slug: string, holder: string, ttlMs: number): Promise<boolean> {
      own('claimLease', 'build', slug)
      return store.claimLease(slug, holder, ttlMs)
    },
    async heartbeat(slug: string, holder: string): Promise<boolean> {
      own('heartbeat', 'build', slug)
      return store.heartbeat(slug, holder)
    },
    async releaseLease(slug: string, holder: string): Promise<void> {
      own('releaseLease', 'build', slug)
      return store.releaseLease(slug, holder)
    },
    subscribe(
      slug: string,
      opts: SubscribeOptions,
      onEvent: (event: AbEvent) => void,
    ): Unsubscribe {
      own('subscribe', 'build', slug)
      return store.subscribe(slug, opts, onEvent)
    },

    async ensureRepo(_repo: string): Promise<RepositoryRecord> {
      return admin('ensureRepo')
    },
    async getRepo(repo: string): Promise<RepositoryRecord | null> {
      own('getRepo', 'repo', repo)
      return store.getRepo(repo)
    },
    async appendRepo<T extends RepositoryEventType>(
      repo: string,
      event: RepositoryEventWrite<T>,
    ): Promise<RepositoryEventEnvelope<T>> {
      own('appendRepo', 'repo', repo)
      authorizeActor('appendRepo', event.actor)
      return store.appendRepo(repo, event)
    },
    async appendRepoWithArtifacts<T extends RepositoryEventType>(
      repo: string,
      artifacts: ArtifactInput[],
      makeEvent: (deposited: RepositoryArtifactMeta[]) => RepositoryEventWrite<T>,
    ): Promise<{
      event: RepositoryEventEnvelope<T>
      artifacts: RepositoryArtifactMeta[]
    }> {
      own('appendRepoWithArtifacts', 'repo', repo)
      return store.appendRepoWithArtifacts(repo, artifacts, (deposited) => {
        const event = makeEvent(deposited)
        authorizeActor('appendRepoWithArtifacts', event.actor)
        return event
      })
    },
    async getRepoEvents(repo: string, sinceSeq?: number): Promise<RepositoryEvent[]> {
      own('getRepoEvents', 'repo', repo)
      return store.getRepoEvents(repo, sinceSeq)
    },
    async putRepoArtifact(repo: string, artifact: ArtifactInput): Promise<RepositoryArtifactMeta> {
      own('putRepoArtifact', 'repo', repo)
      return store.putRepoArtifact(repo, artifact)
    },
    async getRepoArtifact(
      repo: string,
      kind: string,
      rev?: number,
    ): Promise<RepositoryArtifact | null> {
      own('getRepoArtifact', 'repo', repo)
      return store.getRepoArtifact(repo, kind, rev)
    },
    async listRepoArtifacts(repo: string, kind?: string): Promise<RepositoryArtifactMeta[]> {
      own('listRepoArtifacts', 'repo', repo)
      return store.listRepoArtifacts(repo, kind)
    },
    async claimRepoLease(repo: string, holder: string, ttlMs: number): Promise<boolean> {
      own('claimRepoLease', 'repo', repo)
      return store.claimRepoLease(repo, holder, ttlMs)
    },
    async heartbeatRepo(repo: string, holder: string): Promise<boolean> {
      own('heartbeatRepo', 'repo', repo)
      return store.heartbeatRepo(repo, holder)
    },
    async releaseRepoLease(repo: string, holder: string): Promise<void> {
      own('releaseRepoLease', 'repo', repo)
      return store.releaseRepoLease(repo, holder)
    },

    close(): Promise<void> {
      return store.close()
    },
  } satisfies BuildStore & {
    readonly sessionScope: LocalSessionScope
    readonly buildScope?: string
    scopeBuild(slug: string): BuildLocalSessionStore
  }
  return scoped as LocalSessionStore
}
