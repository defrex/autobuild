import { expect, test } from 'bun:test'
import { distanceSuffix, workTargetDistance } from './target-distance'
import { reduceBuild } from '../../kernel/reducer'
import type { LeafRestackState } from '../../kernel/leaf-restack-state'

test('shared suffix validates numbers and suppresses terminal distance', () => {
  for (const invalid of [null, undefined, -1, 1.5, NaN, Infinity])
    expect(distanceSuffix(invalid)).toBe('+?')
  expect(distanceSuffix(0)).toBe('')
  expect(distanceSuffix(7)).toBe('+7')
  for (const terminal of ['merged', 'closed']) {
    expect(distanceSuffix(7, terminal)).toBe('')
    expect(distanceSuffix(null, terminal)).toBe('')
  }
})
test('work samples require the current destination and remain unknown for legacy logs', () => {
  const state = reduceBuild([])
  state.baseBranch = 'main'
  const restack: LeafRestackState = { gates: {}, target: { seq: 1, branch: 'main', sha: 'a' } }
  expect(workTargetDistance(state, restack)).toBe('+?')
  restack.distance = { branch: 'main', sha: 'a', head: 'b', count: 7 }
  expect(workTargetDistance(state, restack)).toBe('+7')
  restack.distance.sha = 'old'
  expect(workTargetDistance(state, restack)).toBe('+?')
  restack.distance.sha = 'a'
  state.baseBranch = 'ab/node'
  expect(workTargetDistance(state, restack)).toBe('+?')
})
