import { describe, expect, test } from 'bun:test'
import type { AbEvent } from '../../events/catalog'
import { KERNEL } from '../../events/envelope'
import { PanelLogBuilder, panelStarted } from '../../kernel/generators/panel-log'
import { projectSessions } from './detail'
import { dashboardFactsReducer } from './facts'

function event(seq: number, type: AbEvent['type'], payload: unknown): AbEvent {
  return {
    build: 'drilldown',
    seq,
    ts: `2026-01-01T00:00:0${seq}.000Z`,
    actor: { kind: 'kernel' },
    type,
    payload,
  } as AbEvent
}

describe('projectSessions', () => {
  test('pairs starts and ends without losing chronological order or open sessions', () => {
    const sessions = projectSessions([
      event(1, 'session.started', {
        session: 's_plan',
        role: 'plan',
        runner: 'pi',
        model: 'openai/gpt',
        phase: 'plan',
        round: 1,
      }),
      event(2, 'session.ended', {
        session: 's_plan',
        transcript: { kind: 'transcript', rev: 4 },
        usage: { inputTokens: 100, outputTokens: 20, turns: 2 },
      }),
      event(3, 'session.started', {
        session: 's_review',
        role: 'plan-review',
        runner: 'claude',
        phase: 'plan-review',
        round: 1,
      }),
      event(4, 'session.started', {
        session: 's_reclaimed',
        role: 'implement',
        runner: 'pi',
        phase: 'implement',
        round: 2,
      }),
      event(5, 'session.ended', {
        session: 's_reclaimed',
        outcome: 'reclaimed',
        reclaimedBy: { instance: 'runner-2', resumedFromSeq: 4 },
      }),
    ])

    expect(sessions).toEqual([
      {
        id: 's_plan',
        role: 'plan',
        phase: 'plan',
        round: 1,
        runtime: 'pi',
        model: 'openai/gpt',
        startedSeq: 1,
        status: 'ended',
        transcript: { kind: 'transcript', rev: 4 },
        usage: { inputTokens: 100, outputTokens: 20, turns: 2 },
        streamStatus: 'closed',
      },
      {
        id: 's_review',
        role: 'plan-review',
        phase: 'plan-review',
        round: 1,
        runtime: 'claude',
        startedSeq: 3,
        status: 'open',
        streamStatus: 'closed',
      },
      {
        id: 's_reclaimed',
        role: 'implement',
        phase: 'implement',
        round: 2,
        runtime: 'pi',
        startedSeq: 4,
        status: 'reclaimed',
        reclaimedBy: { instance: 'runner-2', resumedFromSeq: 4 },
        streamStatus: 'closed',
      },
    ])
  })

  test('ignores an unmatched historical end rather than inventing a session', () => {
    expect(
      projectSessions([
        event(1, 'session.ended', {
          session: 'missing',
          transcript: { kind: 'transcript', rev: 0 },
          usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
        }),
      ]),
    ).toEqual([])
  })
})

describe('projectSessions: stream enrichment (SPEC §9)', () => {
  const started = event(1, 'session.started', {
    session: 's_live',
    role: 'implement',
    runner: 'claude',
    phase: 'implement',
    round: 1,
    stream: 'st_payload',
  })

  test('store records are authoritative for id and status, matched by label session:<id>', () => {
    const sessions = projectSessions(
      [started],
      [
        {
          id: 'st_store',
          scope: { kind: 'build', build: 'drilldown' },
          label: 'session:s_live',
          format: 'ai-ui-message-stream/v1',
          status: 'open',
          createdAt: 't',
        },
      ],
    )
    expect(sessions[0]).toMatchObject({ stream: 'st_store', streamStatus: 'open' })
  })

  test('without records, the payload stream id degrades to pairing-derived status', () => {
    const [open] = projectSessions([started])
    expect(open).toMatchObject({ stream: 'st_payload', streamStatus: 'open' })
    const [ended] = projectSessions([
      started,
      event(2, 'session.ended', {
        session: 's_live',
        transcript: { kind: 'transcript', rev: 0 },
        usage: { inputTokens: 1, outputTokens: 1, turns: 1 },
      }),
    ])
    expect(ended).toMatchObject({ stream: 'st_payload', streamStatus: 'closed' })
  })

  test('a session that never streamed shows no stream and a closed status', () => {
    const [session] = projectSessions([
      event(1, 'session.started', {
        session: 's_plain',
        role: 'plan',
        runner: 'scripted',
        phase: 'plan',
      }),
    ])
    expect(session?.stream).toBeUndefined()
    expect(session?.streamStatus).toBe('closed')
  })
})

test('suspended and resumed segments retain separate usage and transcript navigation', () => {
  const native = {
    version: 1,
    runner: 'pi',
    nativeId: 'native',
    host: 'host',
    workspacePath: '/repo',
  }
  const sessions = projectSessions([
    event(1, 'session.started', {
      session: 'old',
      role: 'plan',
      runner: 'pi',
      phase: 'plan',
      round: 1,
    }),
    event(2, 'session.suspended', {
      session: 'old',
      phase: 'plan',
      round: 1,
      handle: native,
      cause: 'shutdown',
      activeMs: 10,
      transcript: { kind: 'transcript', rev: 1 },
      usage: { inputTokens: 3, outputTokens: 2, turns: 1 },
    }),
    event(3, 'session.started', {
      session: 'new',
      role: 'plan',
      runner: 'pi',
      phase: 'plan',
      round: 1,
      continuation: {
        predecessor: 'old',
        root: 'old',
        handle: native,
        cause: 'shutdown',
        activeMs: 10,
        budgetMs: 1000,
      },
    }),
    event(4, 'session.resumed', {
      session: 'new',
      predecessor: 'old',
      root: 'old',
      handle: native,
      stale: false,
    }),
    event(5, 'session.resumed', {
      session: 'old',
      predecessor: 'older',
      root: 'old',
      handle: native,
      stale: true,
    }),
  ])
  expect(sessions[0]).toMatchObject({
    status: 'suspended',
    cause: 'shutdown',
    transcript: { rev: 1 },
    usage: { inputTokens: 3 },
  })
  expect(sessions[1]).toMatchObject({ status: 'resumed', predecessor: 'old', root: 'old' })
})

test('pause cause and remote fallback remain visible on the suspended session', () => {
  const [session] = projectSessions([
    event(1, 'session.started', {
      session: 'remote',
      role: 'plan',
      runner: 'pi',
      phase: 'plan',
      round: 1,
    }),
    event(2, 'session.suspended', {
      session: 'remote',
      phase: 'plan',
      round: 1,
      cause: 'pause',
      activeMs: 20,
      transcript: { kind: 'transcript', rev: 0 },
    }),
    event(3, 'session.resume-fallback', {
      session: 'remote',
      reason: 'workspace-not-local-git-worktree',
    }),
  ])
  expect(session).toMatchObject({
    status: 'suspended',
    cause: 'pause',
    fallbackReason: 'workspace-not-local-git-worktree',
    transcript: { kind: 'transcript', rev: 0 },
  })
})

describe('projectSessions: judge sessions (SPEC §13.1.1)', () => {
  const log = new PanelLogBuilder('drilldown')
    .push({
      actor: KERNEL,
      type: 'session.started',
      payload: { session: 's_plan', role: 'plan', runner: 'claude', phase: 'plan', round: 1 },
    })
    .started(panelStarted({ judges: 3 }))
    .judgeStarted(1, 's_j1', 'candidate-first', 'panel-1', { runner: 'codex', stream: 'st_j1' })
    .ended(1, 's_j1', 'failed')
    .substituted(
      1,
      's_j1b',
      'candidate-first',
      { session: 's_j1', index: 0, runner: 'codex' },
      { runner: 'claude', stream: 'st_j1b' },
    )
    .preferred(1, 's_j1b', 'A')
    .judged(1, 's_j1b', 'candidate-first', 'A')
    .push({
      actor: KERNEL,
      type: 'panel.judge-ended',
      payload: {
        panel: 'panel-1',
        judge: 1,
        session: 's_j1b',
        outcome: 'completed',
        transcript: { kind: 'transcript', rev: 3 },
      },
    })
    .judgeStarted(2, 's_j2', 'baseline-first', 'panel-1', { model: 'gpt-x' })
    .ended(2, 's_j2', 'reclaimed')
    .judgeStarted(3, 's_j3', 'baseline-first', 'panel-1', { stream: 'st_j3' })
  const facts = dashboardFactsReducer.reduce(log.events)

  test('judge facts carry the target and stream but never the order', () => {
    expect(facts.judgeSessions.map((judge) => [judge.session, judge.status])).toEqual([
      ['s_j1', 'ended'],
      ['s_j1b', 'ended'],
      ['s_j2', 'reclaimed'],
      ['s_j3', 'open'],
    ])
    expect(JSON.stringify(facts.judgeSessions)).not.toContain('first')
  })

  test('judge rows merge in log order with phase sessions', () => {
    const sessions = projectSessions(facts.sessionEvents, undefined, facts.judgeSessions)
    expect(
      sessions.map((session) => [
        session.id,
        session.role,
        session.phase,
        session.runtime,
        session.status,
        session.stream,
        session.streamStatus,
      ]),
    ).toEqual([
      ['s_plan', 'plan', 'plan', 'claude', 'open', undefined, 'closed'],
      ['s_j1', 'judge', 'judge:panel-1:1', 'codex', 'ended', 'st_j1', 'closed'],
      ['s_j1b', 'judge', 'judge:panel-1:1', 'claude', 'ended', 'st_j1b', 'closed'],
      ['s_j2', 'judge', 'judge:panel-1:2', 'scripted', 'reclaimed', undefined, 'closed'],
      ['s_j3', 'judge', 'judge:panel-1:3', 'scripted', 'open', 'st_j3', 'open'],
    ])
    expect(sessions[2]?.transcript).toEqual({ kind: 'transcript', rev: 3 })
    expect(sessions[3]?.model).toBe('gpt-x')
    const serialized = JSON.stringify(sessions)
    expect(serialized).not.toContain('first')
    expect(serialized).not.toContain('order')
  })

  test('a stream record is authoritative for a judge row', () => {
    const sessions = projectSessions(
      [],
      [
        {
          id: 'st_store',
          scope: { kind: 'build', build: 'drilldown' },
          label: 'session:s_j3',
          format: 'ai-ui-message-stream/v1',
          status: 'closed',
          createdAt: 't',
        },
      ],
      facts.judgeSessions,
    )
    expect(sessions.find((session) => session.id === 's_j3')).toMatchObject({
      stream: 'st_store',
      streamStatus: 'closed',
    })
  })
})
