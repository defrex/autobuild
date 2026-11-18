import { expect, test } from 'bun:test'
import { nodeLandingPolicyDisplay, nodeLandingRuleDisplay } from './landing-display'
import { reduceBuild } from '../../kernel/reducer'
import type { LandingRule } from '../../config/schema'

const state = { ...reduceBuild([]), kind: 'node' as const }
const nested = {
  ...state,
  target: { ticket: { source: 'fake', id: 'N-1' }, build: 'release' },
}
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
      {
        ...decided,
        landing: { ...decided.landing, command: { kind: 'hold', seq: 2 } },
      },
      rules,
    ),
  ).toBe('held')
})
test("path rules predict from the cycle head's recorded paths, pending while unrecorded", () => {
  const cycled = {
    ...state,
    integration: {
      ...state.integration,
      cycle: { id: 'c1', head: 'h1', parent: 'p1', config: 'cfg', seq: 3 },
    },
  }
  const recorded = (paths: string[]) => ({
    ...cycled,
    headPaths: [
      {
        source: 'integration' as const,
        head: 'h1',
        destination: 'p1',
        mergeBase: 'b1',
        total: paths.length,
        preview: paths,
        artifact: { kind: 'head-paths' as const, rev: 0 },
        seq: 4,
      },
    ],
  })
  const rules: LandingRule[] = [{ within: ['docs/**'], mode: 'auto' }]
  expect(nodeLandingPolicyDisplay(cycled, rules)).toBe('policy pending')
  expect(nodeLandingRuleDisplay(cycled, rules)).toBe('rule pending changed paths')
  expect(nodeLandingPolicyDisplay(recorded(['docs/a.md']), rules)).toBe('auto')
  expect(nodeLandingRuleDisplay(recorded(['docs/a.md']), rules)).toBe(
    'rule 1: {"within":["docs/**"],"mode":"auto"}',
  )
  expect(nodeLandingPolicyDisplay(recorded(['src/a.ts']), rules)).toBe('consent')
  expect(nodeLandingRuleDisplay(recorded(['src/a.ts']), rules)).toBe(
    'default rule for integration builds: consent',
  )
  const mixed: LandingRule[] = [
    { within: ['docs/**'], mode: 'auto' },
    { label: 'fast', mode: 'auto' },
    { mode: 'consent' },
  ]
  expect(nodeLandingPolicyDisplay(recorded(['src/a.ts']), mixed)).toBe('policy pending')
  expect(nodeLandingRuleDisplay(recorded(['src/a.ts']), mixed)).toBe('rule pending ticket labels')
  expect(nodeLandingPolicyDisplay(recorded(['docs/a.md']), mixed)).toBe('auto')
  expect(nodeLandingRuleDisplay(recorded(['docs/a.md']), mixed)).toBe(
    'rule 1: {"within":["docs/**"],"mode":"auto"}',
  )
  expect(nodeLandingPolicyDisplay(cycled, mixed)).toBe('policy pending')
  expect(nodeLandingRuleDisplay(cycled, mixed)).toBe('rule pending changed paths')
  const catchAll: LandingRule[] = [{ within: ['docs/**'], mode: 'auto' }, { mode: 'consent' }]
  expect(nodeLandingPolicyDisplay(recorded(['src/a.ts']), catchAll)).toBe('consent')
  expect(nodeLandingRuleDisplay(recorded(['src/a.ts']), catchAll)).toBe(
    'rule 2: {"mode":"consent"}',
  )
  const sameMode: LandingRule[] = [
    { within: ['docs/**'], mode: 'auto' },
    { label: 'safe', mode: 'consent' },
    { mode: 'consent' },
  ]
  expect(nodeLandingPolicyDisplay(recorded(['src/a.ts']), sameMode)).toBe('consent')
  expect(nodeLandingRuleDisplay(recorded(['src/a.ts']), sameMode)).toBe(
    'rule pending ticket labels',
  )
  const anyPath: LandingRule[] = [
    { paths: ['docs/**'], mode: 'auto' },
    { label: 'fast', mode: 'auto' },
  ]
  expect(nodeLandingPolicyDisplay(recorded(['src/a.ts']), anyPath)).toBe('policy pending')
  expect(nodeLandingPolicyDisplay(recorded(['docs/a.md', 'src/a.ts']), anyPath)).toBe('auto')
})
