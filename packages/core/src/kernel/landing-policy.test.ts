import { describe, expect, test } from 'bun:test'
import {
  evaluateLandingPolicy,
  landingCandidateId,
  type LandingPolicyInput,
} from './landing-policy'
import type { LandingRule } from '../config/schema'

const root = { kind: 'root' } as const
const node = { kind: 'node', ticket: 'ENG-1' } as const

describe('landing policy', () => {
  test('defaults to automatic leaves and consent for nodes, at every destination', () => {
    for (const into of [root, node]) {
      for (const from of ['leaf', 'node'] as const) {
        expect(evaluateLandingPolicy([], { into, from, labels: [] })).toEqual({
          mode: from === 'leaf' ? 'auto' : 'consent',
          rule: { default: true },
        })
      }
    }
  })

  test('matches target, source and label conjunctively and uses the first match', () => {
    const rules: LandingRule[] = [
      { into: 'ENG-1', from: 'node', label: 'release', mode: 'auto' },
      { into: 'node', mode: 'consent' },
      { mode: 'auto' },
    ]
    for (const into of [root, node, { kind: 'node', ticket: 'ENG-2' } as const]) {
      for (const from of ['leaf', 'node'] as const) {
        for (const labels of [[], ['release'], ['Release']]) {
          const input: LandingPolicyInput = { into, from, labels }
          const index =
            into.kind === 'node' &&
            into.ticket === 'ENG-1' &&
            from === 'node' &&
            labels.includes('release')
              ? 0
              : into.kind === 'node'
                ? 1
                : 2
          expect(evaluateLandingPolicy(rules, input)).toEqual({
            mode: rules[index]!.mode,
            rule: { index, snapshot: rules[index]! },
          })
        }
      }
    }
  })

  test('reserves root and node and supports exact ticket ids and wildcard predicates', () => {
    for (const [into, expected] of [
      [root, 'consent'],
      [node, 'auto'],
    ] as const) {
      expect(
        evaluateLandingPolicy(
          [
            { into: 'root', mode: 'consent' },
            { into: 'ENG-1', mode: 'auto' },
          ],
          { into, from: 'node', labels: [] },
        ).mode,
      ).toBe(expected)
    }
    expect(
      evaluateLandingPolicy([{ mode: 'consent' }, { mode: 'auto' }], {
        into: root,
        from: 'leaf',
        labels: [],
      }).rule,
    ).toEqual({ index: 0, snapshot: { mode: 'consent' } })
  })

  test('snapshots the matched rule and distinguishes replacement candidates', () => {
    const rule: LandingRule = { mode: 'consent' }
    const decision = evaluateLandingPolicy([rule], { into: root, from: 'leaf', labels: [] })
    rule.mode = 'auto'
    expect(decision).toEqual({ mode: 'consent', rule: { index: 0, snapshot: { mode: 'consent' } } })
    const candidate = { head: 'a', parent: 'b', cycle: 'c' }
    for (const key of ['head', 'parent', 'cycle'] as const) {
      expect(landingCandidateId(candidate)).not.toBe(
        landingCandidateId({ ...candidate, [key]: 'd' }),
      )
    }
  })
})
