import { describe, expect, test } from 'bun:test'
import { agentActor, humanActor } from '@defrex/autobuild/testing'
import type { SessionEvent, SessionEventWrite } from '@defrex/autobuild/remote-store'
import { reduceSession, type SessionState } from './session-reducer'

const OPERATOR = humanActor('operator')
const RUNNER = agentActor('orchestrator', 'os_turn')

/** A standalone catalog-valid session event with a synthetic seq/ts. */
function event(
  seq: number,
  actor: typeof OPERATOR | typeof RUNNER,
  type: SessionEvent['type'],
  payload: unknown,
): SessionEvent {
  return {
    session: 'os_1',
    seq,
    ts: '2026-09-15T12:00:00.000Z',
    actor,
    type,
    payload,
  } as unknown as SessionEvent
}

function turnStarted(
  seq: number,
  turn: string,
  trigger: SessionEventWrite<'turn.started'>['payload']['trigger'],
  stream = `st_${turn}`,
): SessionEvent {
  return event(seq, RUNNER, 'turn.started', { turn, stream, trigger })
}

function requestApproval(seq: number, turn = 't1', toolCallId = 'c1'): SessionEvent {
  return event(seq, RUNNER, 'approval.requested', {
    turn,
    toolCallId,
    toolName: 'bash',
    input: { command: 'rm -rf /' },
  })
}

describe('session reducer', () => {
  test('an empty log reduces to idle with no turns and default wake settings', () => {
    expect(reduceSession([])).toEqual({ status: 'idle', wakeGlobs: [], wakeCursors: {}, turns: [] })
  })

  test('creation, messages, and wake-set facts accumulate without touching status', () => {
    const state = reduceSession([
      event(1, OPERATOR, 'session.created', { title: 'Fix the login flow' }),
      event(2, OPERATOR, 'message.posted', { text: 'please look at the flaky test' }),
      event(3, OPERATOR, 'session.wake-set', { globs: ['build.*', 'escalation.raised'] }),
      event(4, OPERATOR, 'session.wake-set', { globs: [] }),
    ])
    expect(state.status).toBe('idle')
    expect(state.wakeGlobs).toEqual([])
    expect(state.turns).toEqual([])
    expect(state.openTurn).toBeUndefined()
  })

  test('turn.started opens a turn and sets status running', () => {
    const state = reduceSession([
      event(1, OPERATOR, 'session.created', {}),
      event(2, OPERATOR, 'message.posted', { text: 'go' }),
      turnStarted(3, 't1', { kind: 'message', messageSeq: 2 }),
    ])
    expect(state.status).toBe('running')
    expect(state.openTurn).toEqual({
      turn: 't1',
      stream: 'st_t1',
      startedSeq: 3,
      trigger: { kind: 'message', messageSeq: 2 },
    })
    expect(state.turns).toEqual([
      {
        turn: 't1',
        stream: 'st_t1',
        startedSeq: 3,
        trigger: { kind: 'message', messageSeq: 2 },
        state: 'open',
      },
    ])
  })

  test('suspension, resume, completion, and failure follow their turn', () => {
    const base = [event(1, OPERATOR, 'session.created', {})]
    const started = turnStarted(2, 't1', { kind: 'message', messageSeq: 1 })

    const suspended = reduceSession([
      ...base,
      started,
      event(3, RUNNER, 'turn.suspended', { turn: 't1', cause: 'budget' }),
    ])
    expect(suspended.status).toBe('suspended')
    expect(suspended.suspendedCause).toBe('budget')
    expect(suspended.turns[0]?.state).toBe('suspended')

    const resumed = reduceSession([
      ...base,
      started,
      event(3, RUNNER, 'turn.suspended', { turn: 't1', cause: 'budget' }),
      event(4, RUNNER, 'turn.resumed', { turn: 't1' }),
    ])
    expect(resumed.status).toBe('running')
    expect(resumed.suspendedCause).toBeUndefined()
    expect(resumed.turns[0]?.state).toBe('open')

    const completed = reduceSession([
      ...base,
      started,
      event(3, RUNNER, 'turn.completed', {
        turn: 't1',
        usage: { inputTokens: 10, outputTokens: 5, steps: 2, turns: 1 },
      }),
    ])
    expect(completed.status).toBe('idle')
    expect(completed.openTurn).toBeUndefined()
    expect(completed.turns[0]).toEqual({
      turn: 't1',
      stream: 'st_t1',
      startedSeq: 2,
      trigger: { kind: 'message', messageSeq: 1 },
      state: 'completed',
      usage: { inputTokens: 10, outputTokens: 5, steps: 2, turns: 1 },
    })

    const failed = reduceSession([
      ...base,
      started,
      event(3, RUNNER, 'turn.failed', {
        turn: 't1',
        kind: 'provider-unavailable',
        error: 'provider 500',
      }),
    ])
    expect(failed.status).toBe('idle')
    expect(failed.turns[0]).toMatchObject({
      state: 'failed',
      error: 'provider 500',
      kind: 'provider-unavailable',
    })

    // An old-format turn.completed without steps still reduces (the reducer
    // never re-validates; the store validated at append time).
    const legacy = reduceSession([
      ...base,
      started,
      {
        session: 's1',
        seq: 3,
        ts: '2026-01-01T00:00:00Z',
        actor: RUNNER,
        type: 'turn.completed',
        payload: { turn: 't1', usage: { inputTokens: 3, outputTokens: 2 } },
      } as never,
    ])
    expect(legacy.turns[0]).toMatchObject({
      state: 'completed',
      usage: { inputTokens: 3, outputTokens: 2 },
    })
  })

  test('a requested approval raises awaiting-approval above running and suspended', () => {
    const base = [
      event(1, OPERATOR, 'session.created', {}),
      turnStarted(2, 't1', { kind: 'message', messageSeq: 1 }),
    ]

    const running = reduceSession([...base, requestApproval(3)])
    expect(running.status).toBe('awaiting-approval')
    expect(running.pendingApproval).toEqual({
      turn: 't1',
      toolCallId: 'c1',
      toolName: 'bash',
      input: { command: 'rm -rf /' },
      requestedSeq: 3,
    })

    const suspended = reduceSession([
      ...base,
      event(3, RUNNER, 'turn.suspended', { turn: 't1', cause: 'approval' }),
      requestApproval(4),
    ])
    expect(suspended.status).toBe('awaiting-approval')
    expect(suspended.suspendedCause).toBeUndefined()
  })

  test('an answered approval clears the pending approval; only turn.resumed resumes the turn', () => {
    const events = [
      event(1, OPERATOR, 'session.created', {}),
      turnStarted(2, 't1', { kind: 'message', messageSeq: 1 }),
      event(3, RUNNER, 'turn.suspended', { turn: 't1', cause: 'approval' }),
      requestApproval(4),
      event(5, OPERATOR, 'approval.answered', {
        turn: 't1',
        toolCallId: 'c1',
        decision: 'approve',
      }),
    ]
    // The answer clears the pending approval but the turn stays suspended:
    // `turn.resumed` — recorded by the runner when it actually picks the turn
    // up — is the sole resume fact, so an answered approval whose resuming
    // invocation dies remains recoverable by the dispatcher tick.
    const answered = reduceSession(events)
    expect(answered.status).toBe('suspended')
    expect(answered.suspendedCause).toBe('approval')
    expect(answered.pendingApproval).toBeUndefined()
    expect(answered.turns[0]?.state).toBe('suspended')

    // The runner's turn.resumed moves the turn back to open.
    const resumed = reduceSession([...events, event(6, RUNNER, 'turn.resumed', { turn: 't1' })])
    expect(resumed.status).toBe('running')
    expect(resumed.turns[0]?.state).toBe('open')
  })

  test('a deny answers the same way; a non-matching answer leaves the approval pending', () => {
    const base = [
      event(1, OPERATOR, 'session.created', {}),
      turnStarted(2, 't1', { kind: 'message', messageSeq: 1 }),
      requestApproval(3),
    ]
    expect(
      reduceSession([
        ...base,
        event(4, OPERATOR, 'approval.answered', { turn: 't1', toolCallId: 'c9', decision: 'deny' }),
      ]).pendingApproval,
    ).toBeDefined()
    expect(
      reduceSession([
        ...base,
        event(4, OPERATOR, 'approval.answered', { turn: 't1', toolCallId: 'c1', decision: 'deny' }),
      ]).pendingApproval,
    ).toBeUndefined()
  })

  test('wake triggers accumulate per-build wake cursors with the highest seq', () => {
    const state = reduceSession([
      event(1, OPERATOR, 'session.created', {}),
      event(2, OPERATOR, 'session.wake-set', { globs: ['build.*'] }),
      turnStarted(3, 't1', { kind: 'wake', build: 'b1', seq: 7, type: 'escalation.raised' }),
      turnStarted(4, 't2', { kind: 'wake', build: 'b2', seq: 2, type: 'build.paused' }),
      turnStarted(5, 't3', { kind: 'wake', build: 'b1', seq: 4, type: 'build.resumed' }),
      turnStarted(6, 't4', { kind: 'wake', build: 'b1', seq: 9, type: 'observation.recorded' }),
    ])
    expect(state.wakeCursors).toEqual({ b1: 9, b2: 2 })
    expect(state.status).toBe('running')
    expect(state.openTurn?.turn).toBe('t4')
    expect(state.turns.map((turn) => turn.turn)).toEqual(['t1', 't2', 't3', 't4'])
  })

  test('archived is terminal: status freezes and later facts are ignored', () => {
    const state = reduceSession([
      event(1, OPERATOR, 'session.created', {}),
      turnStarted(2, 't1', { kind: 'message', messageSeq: 1 }),
      event(3, OPERATOR, 'session.archived', {}),
      event(4, RUNNER, 'turn.completed', {
        turn: 't1',
        usage: { inputTokens: 1, outputTokens: 1, steps: 1 },
      }),
      requestApproval(5),
    ])
    expect(state.status).toBe('archived')
    expect(state.openTurn?.turn).toBe('t1')
    expect(state.pendingApproval).toBeUndefined()
    expect(state.turns[0]?.state).toBe('open')
    expect(state.wakeCursors).toEqual({})
  })

  test('full precedence matrix', () => {
    const created = event(1, OPERATOR, 'session.created', {})
    const started = turnStarted(2, 't1', { kind: 'message', messageSeq: 1 })
    const suspend = (seq: number, cause: 'budget' | 'approval') =>
      event(seq, RUNNER, 'turn.suspended', { turn: 't1', cause })
    const answer = (seq: number) =>
      event(seq, OPERATOR, 'approval.answered', {
        turn: 't1',
        toolCallId: 'c1',
        decision: 'approve',
      })
    const complete = (seq: number) =>
      event(seq, RUNNER, 'turn.completed', {
        turn: 't1',
        usage: { inputTokens: 0, outputTokens: 0, steps: 1 },
      })

    // idle (created only)
    expect(reduceSession([created]).status).toBe('idle')
    // running
    expect(reduceSession([created, started]).status).toBe('running')
    // suspended
    expect(reduceSession([created, started, suspend(3, 'budget')]).status).toBe('suspended')
    // awaiting-approval while running
    expect(reduceSession([created, started, requestApproval(3)]).status).toBe('awaiting-approval')
    // awaiting-approval above suspended
    expect(
      reduceSession([created, started, suspend(3, 'approval'), requestApproval(4)]).status,
    ).toBe('awaiting-approval')
    // the answer clears the approval; the turn stays suspended and the
    // dispatcher tick's resume pass (or the next runner) records `turn.resumed`
    // — even when the suspension was for budget.
    const answeredBudget = reduceSession([
      created,
      started,
      suspend(3, 'budget'),
      requestApproval(4),
      answer(5),
    ])
    expect(answeredBudget.status).toBe('suspended')
    expect(answeredBudget.suspendedCause).toBe('budget')
    // answer then resume → running
    expect(
      reduceSession([
        created,
        started,
        suspend(3, 'budget'),
        requestApproval(4),
        answer(5),
        event(6, RUNNER, 'turn.resumed', { turn: 't1' }),
      ]).status,
    ).toBe('running')
    // completed after an approval cycle → idle
    expect(
      reduceSession([created, started, requestApproval(3), answer(4), complete(5)]).status,
    ).toBe('idle')
    // archived wins over everything
    expect(
      reduceSession([
        created,
        started,
        requestApproval(3),
        event(4, OPERATOR, 'session.archived', {}),
      ]).status,
    ).toBe('archived')
  })

  test('a second turn opens after the first completes; turns stay in start order', () => {
    const state: SessionState = reduceSession([
      event(1, OPERATOR, 'session.created', {}),
      turnStarted(2, 't1', { kind: 'message', messageSeq: 1 }),
      event(3, RUNNER, 'turn.completed', {
        turn: 't1',
        usage: { inputTokens: 2, outputTokens: 3 },
      }),
      event(4, OPERATOR, 'message.posted', { text: 'again' }),
      turnStarted(5, 't2', { kind: 'message', messageSeq: 4 }),
    ])
    expect(state.status).toBe('running')
    expect(state.openTurn?.turn).toBe('t2')
    expect(state.turns.map((turn) => [turn.turn, turn.state])).toEqual([
      ['t1', 'completed'],
      ['t2', 'open'],
    ])
  })
})
