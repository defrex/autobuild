import { describe, expect, test } from 'bun:test'
import type { AbEvent } from '../../events/catalog'
import { projectSessions } from './detail'

function event(seq: number, type: 'session.started' | 'session.ended', payload: unknown): AbEvent {
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
      },
      {
        id: 's_review',
        role: 'plan-review',
        phase: 'plan-review',
        round: 1,
        runtime: 'claude',
        startedSeq: 3,
        status: 'open',
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
