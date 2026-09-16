/**
 * Local ambient phase-session wrapper for a BuildStore.
 *
 * This module's "session" is the CLI's validated ambient phase/Harvest
 * identity (agent-session attribution): it scopes a local store handle to the
 * exact build or repository resource and rejects agent-attributed event
 * writes for any other `AB_SESSION`. It is unrelated to the operator-session
 * scope handles in `session-handle.ts` (hosted-only, AUT-339), which scope a
 * store to a single operator session's record.
 */
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
  BuildRecord,
  BuildStore,
  NewBuildInput,
  NewSessionInput,
  RepositoryArtifact,
  RepositoryArtifactMeta,
  RepositoryRecord,
  SessionArtifactMeta,
  SessionRecord,
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

export type PhaseSessionScope =
  | { kind: 'build'; id: string; session: string }
  | { kind: 'repo'; id: string; session: string }

/** An in-process authority failure for a local phase-session store handle. */
export class PhaseSessionError extends Error {
  constructor(
    readonly scope: PhaseSessionScope,
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
    super(message ?? `local phase-session store scoped to ${authority} forbids ${addressed}`)
    this.name = 'PhaseSessionError'
  }
}

type BuildPhaseSessionScope = Extract<PhaseSessionScope, { kind: 'build' }>
type RepositoryPhaseSessionScope = Extract<PhaseSessionScope, { kind: 'repo' }>

/** Nested same-build scoping is idempotent while a foreign scope can never
 * widen this ambient-session handle. */
export interface BuildPhaseSessionStore extends BuildStore {
  readonly phaseSession: BuildPhaseSessionScope
  readonly buildScope: string
  scopeBuild(slug: string): BuildPhaseSessionStore
}

export interface RepositoryPhaseSessionStore extends BuildStore {
  readonly phaseSession: RepositoryPhaseSessionScope
  scopeBuild(slug: string): never
}

export type PhaseSessionStore = BuildPhaseSessionStore | RepositoryPhaseSessionStore

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
export function scopeLocalStoreToPhaseSession(
  store: BuildStore,
  scope: BuildPhaseSessionScope,
): BuildPhaseSessionStore
export function scopeLocalStoreToPhaseSession(
  store: BuildStore,
  scope: RepositoryPhaseSessionScope,
): RepositoryPhaseSessionStore
export function scopeLocalStoreToPhaseSession(
  store: BuildStore,
  scope: PhaseSessionScope,
): PhaseSessionStore
export function scopeLocalStoreToPhaseSession(
  store: BuildStore,
  scope: PhaseSessionScope,
): PhaseSessionStore {
  const target = (kind: 'build' | 'repo', id: string) => ({ kind, id }) as const
  const own = (operation: string, kind: 'build' | 'repo', id: string): void => {
    if (scope.kind !== kind || scope.id !== id) {
      throw new PhaseSessionError(scope, operation, target(kind, id))
    }
  }
  const admin = (operation: string): never => {
    throw new PhaseSessionError(scope, operation, { kind: 'admin' })
  }
  /** Streams carry no actor, so the session dimension does not gate them —
   * only the exact-resource guard does. Addressed operations resolve the
   * target's scope from its record; an unknown id delegates so the backing
   * store's `unknown stream` feedback survives. */
  const ownStreamScope = (record: StreamRecord): void => {
    const matches =
      scope.kind === 'build'
        ? record.scope.kind === 'build' && record.scope.build === scope.id
        : record.scope.kind === 'repo' && record.scope.repo === scope.id
    if (!matches) {
      throw new PhaseSessionError(
        scope,
        'stream',
        record.scope.kind === 'build'
          ? ({ kind: 'build', id: record.scope.build } as const)
          : record.scope.kind === 'repo'
            ? ({ kind: 'repo', id: record.scope.repo } as const)
            : // Session-scoped streams are hosted-only; an ambient phase
              // session never owns one.
              ({ kind: 'admin' } as const),
      )
    }
  }
  const ownStream = async (streamId: string): Promise<void> => {
    const record = await store.getStream(streamId)
    if (record) ownStreamScope(record)
  }
  const streamScope = (): StreamScope =>
    scope.kind === 'build' ? { kind: 'build', build: scope.id } : { kind: 'repo', repo: scope.id }
  const ownStreamScopeArg = (operation: string, candidate: StreamScope): void => {
    const expected = streamScope()
    if (JSON.stringify(candidate) !== JSON.stringify(expected)) {
      throw new PhaseSessionError(
        scope,
        operation,
        candidate.kind === 'build'
          ? ({ kind: 'build', id: candidate.build } as const)
          : candidate.kind === 'repo'
            ? ({ kind: 'repo', id: candidate.repo } as const)
            : ({ kind: 'admin' } as const),
      )
    }
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
      throw new PhaseSessionError(
        scope,
        operation,
        undefined,
        `local phase-session store scoped to session ${JSON.stringify(scope.session)} may not write events attributed to ${
          session === null
            ? 'an agent without a valid session'
            : `session ${JSON.stringify(session)}`
        }`,
      )
    }
  }

  const scoped = {
    phaseSession: scope,
    ...(scope.kind === 'build' ? { buildScope: scope.id } : {}),

    scopeBuild(slug: string): BuildPhaseSessionStore {
      own('scopeBuild', 'build', slug)
      return scoped as BuildPhaseSessionStore
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
    async getEvents(
      slug: string,
      sinceSeq?: number,
      opts?: { waitSeconds?: number },
    ): Promise<AbEvent[]> {
      own('getEvents', 'build', slug)
      return store.getEvents(slug, sinceSeq, opts)
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
    async getRepoEvents(
      repo: string,
      sinceSeq?: number,
      opts?: { waitSeconds?: number },
    ): Promise<RepositoryEvent[]> {
      own('getRepoEvents', 'repo', repo)
      return store.getRepoEvents(repo, sinceSeq, opts)
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

    async createStream(candidate: StreamScope, label: string): Promise<StreamRecord> {
      ownStreamScopeArg('createStream', candidate)
      return store.createStream(candidate, label)
    },
    async appendStreamParts(streamId: string, parts: StreamPart[]): Promise<StreamChunk> {
      await ownStream(streamId)
      return store.appendStreamParts(streamId, parts)
    },
    async readStream(
      streamId: string,
      opts?: { since?: number; waitSeconds?: number },
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
      ownStreamScopeArg('listStreams', candidate)
      return store.listStreams(candidate)
    },

    // Operator sessions are hosted-only: an ambient phase-session handle —
    // a local construct — never creates or touches one.
    createSession(_input: NewSessionInput): Promise<SessionRecord> {
      return admin('createSession')
    },
    getSession(_id: string): Promise<SessionRecord | null> {
      return admin('getSession')
    },
    listSessions(_repo: string): Promise<SessionRecord[]> {
      return admin('listSessions')
    },
    appendSessionEvent<T extends SessionEventType>(
      _id: string,
      _event: SessionEventWrite<T>,
    ): Promise<SessionEventEnvelope<T>> {
      return admin('appendSessionEvent')
    },
    getSessionEvents(_id: string, _sinceSeq?: number): Promise<SessionEvent[]> {
      return admin('getSessionEvents')
    },
    appendSessionWithArtifacts<T extends SessionEventType>(
      _id: string,
      _artifacts: ArtifactInput[],
      _makeEvent: (deposited: SessionArtifactMeta[]) => SessionEventWrite<T>,
    ): Promise<{ event: SessionEventEnvelope<T>; artifacts: SessionArtifactMeta[] }> {
      return admin('appendSessionWithArtifacts')
    },
    putSessionArtifact(_id: string, _artifact: ArtifactInput): Promise<SessionArtifactMeta> {
      return admin('putSessionArtifact')
    },
    getSessionArtifact(_id: string, _kind: string, _rev?: number): Promise<null> {
      return admin('getSessionArtifact')
    },
    listSessionArtifacts(_id: string, _kind?: string): Promise<SessionArtifactMeta[]> {
      return admin('listSessionArtifacts')
    },
    scopeSession(_id: string): never {
      return admin('scopeSession')
    },

    close(): Promise<void> {
      return store.close()
    },
  } satisfies BuildStore & {
    readonly phaseSession: PhaseSessionScope
    readonly buildScope?: string
    scopeBuild(slug: string): BuildPhaseSessionStore
  }
  return scoped as PhaseSessionStore
}
