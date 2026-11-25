/**
 * `ab wait` pure-layer unit tests: condition parsing and validation, and the
 * state/event match order. The command shell is tested over MemoryBuildStore
 * in `wait.integration.test.ts`.
 */
import { describe, expect, test } from 'bun:test'
import { DISPATCHER, KERNEL } from '../events/envelope'
import { currentDeferralObservationReducer } from '../kernel/auto-merge'
import { reduceBuild } from '../kernel/reducer'
import { readBuildFacts } from '../store/reduced-reads'
import { MemoryBuildStore } from '../store/memory'
import { steppingClock } from '../testing/fixed'
import { WAIT_USAGE, matchEvent, matchState, parseConditions } from './wait'

describe('wait condition parsing', () => {
  test('the whole closed vocabulary parses; phase= accepts verify:<step> and core phases', () => {
    const { conditions, globs } = parseConditions(
      [
        'blocked',
        'paused',
        'running',
        'done',
        'aborted',
        'collecting',
        'terminal',
        'pr=open',
        'pr=merged',
        'pr=closed',
        'pr=conflicted',
        'phase=finalize',
        'phase=verify:e2e',
        'attention',
      ],
      ['pr.*', 'escalation.*'],
    )
    expect(conditions.map((condition) => condition.text)).toEqual([
      'blocked',
      'paused',
      'running',
      'done',
      'aborted',
      'collecting',
      'terminal',
      'pr=open',
      'pr=merged',
      'pr=closed',
      'pr=conflicted',
      'phase=finalize',
      'phase=verify:e2e',
      'attention',
    ])
    expect(conditions[5]).toEqual({
      text: 'collecting',
      cond: { kind: 'status', status: 'collecting' },
    })
    expect(globs.map((glob) => glob.text)).toEqual(['pr.*', 'escalation.*'])
  })

  test('the deprecated node-landed alias parses as node-merged', () => {
    expect(parseConditions(['node-landed'], []).conditions).toEqual([
      { text: 'node-merged', cond: { kind: 'node-merged' } },
    ])
  })

  test('unknown --for values and an empty phase= are rejected, naming vocabulary and usage', () => {
    for (const value of ['bogus', 'pr=opened', 'phase=', 'phase=bogus', 'TERMINAL', '']) {
      expect(() => parseConditions([value], [])).toThrow(`unknown --for condition "${value}"`)
      expect(() => parseConditions([value], [])).toThrow('pr=conflicted')
      expect(() => parseConditions([value], [])).toThrow(WAIT_USAGE)
    }
  })

  test('an unknown --event glob is rejected with the wait usage line', () => {
    expect(() => parseConditions([], ['bogus.*'])).toThrow('--event "bogus.*"')
    expect(() => parseConditions([], ['bogus.*'])).toThrow(WAIT_USAGE)
  })

  test('matchState walks --for values in supply order; attention is event-only', () => {
    const state = {
      status: 'blocked',
      phase: 'verify:e2e',
      prState: 'conflicted',
    } as unknown as Parameters<typeof matchState>[1]
    expect(
      matchState(
        parseConditions(['pr=conflicted', 'phase=verify:e2e', 'blocked'], []).conditions,
        state,
      ),
    ).toBe('pr=conflicted')
    expect(
      matchState(parseConditions(['phase=verify:e2e', 'pr=conflicted'], []).conditions, state),
    ).toBe('phase=verify:e2e')
    expect(matchState(parseConditions(['terminal', 'blocked'], []).conditions, state)).toBe(
      'blocked',
    )
    expect(matchState(parseConditions(['running', 'pr=open'], []).conditions, state)).toBeNull()
    expect(matchState(parseConditions(['attention'], []).conditions, state)).toBeNull()
  })

  test('matchEvent checks attention per supply order, then globs in supply order', () => {
    const attention = { type: 'escalation.raised' } as Parameters<typeof matchEvent>[0]
    const conditions = parseConditions(['attention'], []).conditions
    expect(matchEvent(attention, conditions, [])).toBe('attention')
    expect(
      matchEvent(attention, parseConditions(['done'], []).conditions, [
        { regex: /^escalation\..*$/, text: 'escalation.*' },
        { regex: /^build\..*$/, text: 'build.*' },
      ]),
    ).toBe('escalation.*')
    expect(
      matchEvent({ type: 'plan.started' } as Parameters<typeof matchEvent>[0], conditions, [
        { regex: /^escalation\..*$/, text: 'escalation.*' },
        { regex: /^build\..*$/, text: 'build.*' },
      ]),
    ).toBeNull()
  })
})

test('attention backlog recognizes a conflicted replay and ignores a clean replay', () => {
  const facts = { state: reduceBuild([]), deferral: currentDeferralObservationReducer.initial() }
  const conditions = parseConditions(['attention'], []).conditions
  expect(
    matchEvent({ type: 'restack.replayed', payload: { conflicted: true } }, conditions, [], facts),
  ).toBe('attention')
  expect(
    matchEvent({ type: 'restack.replayed', payload: { conflicted: false } }, conditions, [], facts),
  ).toBeNull()
})

test("a node's current upstream rewrite satisfies attention after restart and clears on safe observation", async () => {
  const store = new MemoryBuildStore({ clock: steppingClock() })
  await store.createBuild({ slug: 'b1', repo: '/main/repo' })
  await store.append('b1', {
    actor: DISPATCHER,
    type: 'build.created',
    payload: {
      ticket: { source: 'file', id: 'N' },
      repo: '/main/repo',
      baseBranch: 'main',
      kind: 'node',
    },
  })
  await store.append('b1', {
    actor: KERNEL,
    type: 'runner.attached',
    payload: { instance: 'i1', host: 'h1', resumedFromSeq: 0 },
  })
  await store.append('b1', {
    actor: DISPATCHER,
    type: 'target.rewritten',
    payload: {
      branch: 'main',
      previousSha: 'a'.repeat(40),
      sha: 'b'.repeat(40),
    },
  })
  let facts = (await readBuildFacts(store, 'b1')).value
  const { conditions } = parseConditions(['attention'], [])
  expect(matchState(conditions, facts.state)).toBe('attention')
  await store.append('b1', {
    actor: DISPATCHER,
    type: 'target.rewrite-cleared',
    payload: {
      branch: 'main',
      sha: 'a'.repeat(40),
    },
  })
  facts = (await readBuildFacts(store, 'b1')).value
  expect(matchState(conditions, facts.state)).toBeNull()
})
