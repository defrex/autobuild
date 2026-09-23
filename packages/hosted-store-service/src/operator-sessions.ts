/**
 * Operator-session operations behind the operator API (SPEC §7.1.1): the
 * signed-in operator's orchestrator conversations. Every write is attributed
 * to the signed-in operator — the token's user, never a client-supplied
 * identity — and `via` is never set on session events: session events are the
 * delegate's own log, and here the operator IS the actor.
 *
 * Ownership lives here, in the server seam, because the store has no
 * principal concept: a session belongs to its creating operator; other
 * operators of the same repository can read it and cannot write to it. The
 * store stays neutral; the API is the gatekeeper — writes of any kind to an
 * archived session are refusals here, not store errors.
 */
import { humanActor } from '@defrex/autobuild/operator'
import type { SessionEventWrite } from '@defrex/autobuild/remote-store'
import { reduceSession, type SessionState, type SessionTurn } from './session-reducer'
import type { StreamRead, BuildStore, SessionRecord } from '@defrex/autobuild/plugin-sdk'
import type { OperatorSandboxService } from '@defrex/autobuild/operator'

export class OperatorSessionError extends Error {
  constructor(
    readonly code: 'not-found' | 'refusal' | 'forbidden',
    message: string,
  ) {
    super(message)
    this.name = 'OperatorSessionError'
  }
}

async function requireSession(
  store: BuildStore,
  repo: string,
  sid: string,
): Promise<SessionRecord> {
  const record = await store.getSession(sid)
  if (record === null || record.repo !== repo) {
    throw new OperatorSessionError('not-found', `unknown session "${sid}"`)
  }
  return record
}

function requireOwner(record: SessionRecord, user: string, operation: string): void {
  if (record.operator !== user) {
    throw new OperatorSessionError(
      'forbidden',
      `session "${record.id}" belongs to operator ${JSON.stringify(record.operator)}; ${JSON.stringify(user)} may not ${operation}`,
    )
  }
}

/** Every append funnels through here: one attribution point, one archived
 * gate. The store has no principal concept, so this is where a token's user
 * meets a session's operator. */
async function appendAs(
  store: BuildStore,
  record: SessionRecord,
  user: string,
  event: SessionEventWrite,
): Promise<void> {
  requireOwner(record, user, `write ${event.type}`)
  const state = reduceSession(await store.getSessionEvents(record.id))
  if (state.status === 'archived') {
    throw new OperatorSessionError('refusal', `session "${record.id}" is archived and read-only`)
  }
  await store.appendSessionEvent(record.id, event)
}

export async function listOperatorSessions(
  store: BuildStore,
  repo: string,
): Promise<SessionRecord[]> {
  const sessions = await store.listSessions(repo)
  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function createOperatorSession(
  store: BuildStore,
  repo: string,
  user: string,
  title?: string,
): Promise<SessionRecord> {
  return store.createSession({
    repo,
    operator: user,
    ...(title !== undefined ? { title } : {}),
  })
}

export interface OperatorSessionView {
  session: SessionRecord
  state: SessionState
  turns: SessionTurn[]
}

export async function getOperatorSession(
  store: BuildStore,
  repo: string,
  sid: string,
): Promise<OperatorSessionView> {
  const record = await requireSession(store, repo, sid)
  const state = reduceSession(await store.getSessionEvents(record.id))
  return { session: record, state, turns: state.turns }
}

export async function postOperatorMessage(
  store: BuildStore,
  repo: string,
  sid: string,
  user: string,
  text: string,
): Promise<void> {
  const record = await requireSession(store, repo, sid)
  await appendAs(store, record, user, {
    actor: humanActor(user),
    type: 'message.posted',
    payload: { text },
  })
}

export async function setOperatorWake(
  store: BuildStore,
  repo: string,
  sid: string,
  user: string,
  globs: string[],
): Promise<void> {
  const record = await requireSession(store, repo, sid)
  await appendAs(store, record, user, {
    actor: humanActor(user),
    type: 'session.wake-set',
    payload: { globs },
  })
}

export async function answerOperatorApproval(
  store: BuildStore,
  repo: string,
  sid: string,
  user: string,
  turn: string,
  toolCallId: string,
  decision: 'approve' | 'deny',
): Promise<void> {
  const record = await requireSession(store, repo, sid)
  requireOwner(record, user, 'answer an approval')
  const state = reduceSession(await store.getSessionEvents(record.id))
  const pending = state.pendingApproval
  if (
    state.status === 'archived' ||
    pending === undefined ||
    pending.turn !== turn ||
    pending.toolCallId !== toolCallId
  ) {
    throw new OperatorSessionError(
      'refusal',
      `session "${record.id}" has no pending approval for turn ${JSON.stringify(turn)} tool call ${JSON.stringify(toolCallId)}`,
    )
  }
  await appendAs(store, record, user, {
    actor: humanActor(user),
    type: 'approval.answered',
    payload: { turn, toolCallId, decision },
  })
}

export async function archiveOperatorSession(
  store: BuildStore,
  repo: string,
  sid: string,
  user: string,
  sandbox?: OperatorSandboxService,
): Promise<void> {
  const record = await requireSession(store, repo, sid)
  requireOwner(record, user, 'archive')
  const state = reduceSession(await store.getSessionEvents(record.id))
  if (state.status === 'archived') {
    throw new OperatorSessionError('refusal', `session "${record.id}" is already archived`)
  }
  await store.appendSessionEvent(record.id, {
    actor: humanActor(user),
    type: 'session.archived',
    payload: {},
  })
  // When the archive leaves the operator with no open session for this
  // repository, their sandbox environment is released (snapshot purge,
  // journal fact). The service derives the environment via its pure
  // describe — never provisioning — and a never-provisioned operator is a
  // no-op. Contained: a release failure must not fail an accepted archive.
  if (sandbox !== undefined) {
    const sessions = await store.listSessions(repo)
    const open: SessionRecord[] = []
    for (const session of sessions) {
      if (session.operator !== user) continue
      const sessionState = reduceSession(await store.getSessionEvents(session.id))
      if (sessionState.status !== 'archived') open.push(session)
    }
    if (open.length === 0) {
      try {
        await sandbox.release(user, { repo })
      } catch {
        // The archive already succeeded; the environment stays journaled and
        // the dispatcher's idle settlement stops it later.
      }
    }
  }
}

export async function readOperatorTurnStream(
  store: BuildStore,
  repo: string,
  sid: string,
  turn: string,
  opts?: { since?: number; waitSeconds?: number },
): Promise<StreamRead> {
  const record = await requireSession(store, repo, sid)
  const state = reduceSession(await store.getSessionEvents(record.id))
  const target = state.turns.find((candidate) => candidate.turn === turn)
  if (target === undefined) {
    throw new OperatorSessionError('not-found', `unknown turn "${turn}" in session "${record.id}"`)
  }
  return store.readStream(target.stream, opts)
}
