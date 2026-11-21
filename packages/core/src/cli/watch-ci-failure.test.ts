/** Failing forge CI on a finished leaf is default watch attention. */
import { expect, test } from 'bun:test'
import type { AbEvent } from '../events/catalog'
import { DISPATCHER } from '../events/envelope'
import { KERNEL } from '../events/envelope'
import { currentDeferralObservationReducer } from '../kernel/auto-merge'
import { reduceBuild } from '../kernel/reducer'
import { buildNeedsAttention } from './attention'
import { matchState, parseConditions } from './wait'
import { BUILD_ATTENTION_EVENTS, summarizeEvent } from './watch'

const digest = 'a'.repeat(64)
const failed = (names: string[], total = names.length) =>
  ({
    build: 'red-build',
    seq: 12,
    ts: '2026-11-20T00:00:00.000Z',
    actor: DISPATCHER,
    type: 'pr.checks-failed',
    payload: {
      pr: 41,
      head: '0123456789abcdef0123',
      buildHead: '0123456789abcdef0123',
      checks: names.map((name) => ({ name, source: 'check-run', conclusion: 'failure' })),
      total,
      digest,
    },
  }) as AbEvent

test('failing forge CI is attention; its clearing is not', () => {
  expect(BUILD_ATTENTION_EVENTS).toContain('pr.checks-failed')
  expect(BUILD_ATTENTION_EVENTS as readonly string[]).not.toContain('pr.checks-cleared')
})

test('the line names the build, PR, head and failing checks', () => {
  expect(summarizeEvent(failed(['unit']), null)).toBe(
    'Forge CI failing for red-build PR #41 at 0123456789ab: unit; inspect the PR, re-run CI, or reopen the build',
  )
  expect(summarizeEvent(failed(['a\u001b', 'b'], 7), null)).toContain(': a\\u{1b}, b, +5 more;')
})

test('a clearing has a routine line naming its cause', () => {
  expect(
    summarizeEvent(
      {
        build: 'red-build',
        seq: 13,
        ts: '2026-11-20T00:00:00.000Z',
        actor: DISPATCHER,
        type: 'pr.checks-cleared',
        payload: { pr: 41, head: '0123456789abcdef', cause: 'head-changed' },
      } as AbEvent,
      null,
    ),
  ).toBe('Forge CI failure cleared for red-build PR #41 at 0123456789ab (head-changed)')
})

const at = (seq: number, type: string, payload: unknown, actor: unknown = DISPATCHER) =>
  ({ build: 'red-build', seq, ts: '2026-11-20T00:00:00.000Z', actor, type, payload }) as AbEvent

test('a current forge CI failure is build attention until a head change or clear', () => {
  const forAttention = parseConditions(['attention'], []).conditions
  const finalized = (headSha: string, seq: number) =>
    at(seq, 'finalize.completed', { pr: { number: 41, url: 'https://forge/41', headSha } }, KERNEL)
  const red = { ...failed(['unit']), seq: 3 } as AbEvent
  ;(red.payload as { head: string; buildHead: string }).head = 'head-a'
  ;(red.payload as { head: string; buildHead: string }).buildHead = 'head-a'
  const needs = (log: AbEvent[]) => {
    const state = reduceBuild(log)
    const facts = { state, deferral: currentDeferralObservationReducer.reduce(log) }
    return {
      needs: buildNeedsAttention(log, state),
      waits: matchState(forAttention, state, facts),
    }
  }
  const base = [
    at(1, 'build.created', {
      ticket: { source: 'file', id: 'A' },
      repo: '/r',
      baseBranch: 'main',
    }),
    finalized('head-a', 2),
  ]
  expect(needs(base)).toEqual({ needs: false, waits: null })
  expect(needs([...base, red])).toEqual({ needs: true, waits: 'attention' })
  expect(needs([...base, red, finalized('head-b', 4)])).toEqual({ needs: false, waits: null })
  expect(
    needs([...base, red, at(4, 'pr.checks-cleared', { pr: 41, head: 'head-a', cause: 'passing' })]),
  ).toEqual({ needs: false, waits: null })
})
