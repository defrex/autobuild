import { expect, test } from 'bun:test'
import { nodeLandingPolicyDisplay } from './landing-display'
import { reduceBuild } from '../../kernel/reducer'
import type { LandingRule } from '../../config/schema'

const state = { ...reduceBuild([]), kind: 'node' as const }
const nested = { ...state, target: { ticket: { source: 'fake', id: 'N-1' }, build: 'release' } }
test('all nodes default to consent; compatible configured rules predict auto', () => {
  expect(nodeLandingPolicyDisplay(state, [])).toBe('consent')
  expect(nodeLandingPolicyDisplay(nested, [])).toBe('consent')
  const rules: LandingRule[] = [{ from: 'node', into: 'node', mode: 'auto' }]
  expect(nodeLandingPolicyDisplay(nested, rules)).toBe('auto')
  expect(nodeLandingPolicyDisplay(state, rules)).toBe('consent')
  expect(nodeLandingPolicyDisplay(state, [{ into: 'root', mode: 'auto' }])).toBe('auto')
  expect(nodeLandingPolicyDisplay(nested, [{ into: 'N-1', mode: 'auto' }])).toBe('auto')
  expect(nodeLandingPolicyDisplay(nested, [{ into: 'N-2', mode: 'auto' }])).toBe('consent')
})
test('unknown labels explore only reachable ordered first matches', () => {
  expect(nodeLandingPolicyDisplay(state, [{ label: 'fast', mode: 'auto' }])).toBe('policy pending')
  expect(nodeLandingPolicyDisplay(state, [{ label: 'safe', mode: 'consent' }])).toBe('consent')
  expect(nodeLandingPolicyDisplay(state, [{ label: 'fast', mode: 'auto' }, { mode: 'auto' }])).toBe(
    'auto',
  )
  expect(
    nodeLandingPolicyDisplay(state, [{ mode: 'auto' }, { label: 'slow', mode: 'consent' }]),
  ).toBe('auto')
  expect(
    nodeLandingPolicyDisplay(state, [
      { from: 'leaf', label: 'fast', mode: 'auto' },
      { into: 'node', mode: 'auto' },
    ]),
  ).toBe('consent')
  expect(
    nodeLandingPolicyDisplay(state, [
      { label: 'safe', mode: 'consent' },
      { label: 'safe', mode: 'auto' },
    ]),
  ).toBe('consent')
  expect(
    nodeLandingPolicyDisplay(state, [
      { label: 'fast', mode: 'auto' },
      { label: 'safe', mode: 'consent' },
      { mode: 'auto' },
    ]),
  ).toBe('policy pending')
})
test('persisted decisions and operator holds override config without mutating inputs', () => {
  const decided = {
    ...nested,
    landing: {
      decision: {
        seq: 1,
        mode: 'consent' as const,
        from: 'node' as const,
        into: { kind: 'node' as const, ticket: 'N-1' },
        candidate: { head: 'h', parent: 'p', cycle: 'c' },
        labels: [],
        rule: { default: true as const },
      },
    },
  }
  const rules: LandingRule[] = [{ mode: 'auto' }]
  const before = JSON.stringify({ decided, rules })
  expect(nodeLandingPolicyDisplay(decided, rules)).toBe('consent')
  expect(JSON.stringify({ decided, rules })).toBe(before)
  expect(
    nodeLandingPolicyDisplay(
      { ...decided, landing: { ...decided.landing, command: { kind: 'hold', seq: 2 } } },
      rules,
    ),
  ).toBe('held')
})
