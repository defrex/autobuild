import { describe, expect, test } from 'bun:test'
import {
  evaluateLandingPolicy,
  landingCandidateId,
  type LandingPaths,
  type LandingPolicyInput,
} from './landing-policy'
import { landingPolicyIdentity } from './landing-policy-identity'
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
        ),
      ).toMatchObject({ mode: expected })
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
    const decision = evaluateLandingPolicy([rule], {
      into: root,
      from: 'leaf',
      labels: [],
    })
    rule.mode = 'auto'
    expect(decision).toEqual({
      mode: 'consent',
      rule: { index: 0, snapshot: { mode: 'consent' } },
    })
    const candidate = { head: 'a', parent: 'b', cycle: 'c' }
    for (const key of ['head', 'parent', 'cycle'] as const) {
      expect(landingCandidateId(candidate)).not.toBe(
        landingCandidateId({ ...candidate, [key]: 'd' }),
      )
    }
  })

  describe('changed-path predicates', () => {
    const leaf: LandingPolicyInput = { into: root, from: 'leaf', labels: [] }
    const changed = (...paths: string[]): LandingPaths => ({
      recorded: true,
      complete: true,
      paths,
    })
    const rules: LandingRule[] = [
      { paths: ['autobuild.toml', 'docs/policy/**'], mode: 'consent' },
      { within: ['docs/**', 'README.md'], mode: 'auto' },
      { mode: 'consent' },
    ]

    test('paths matches any changed path; within needs every changed path', () => {
      expect(evaluateLandingPolicy(rules, leaf, changed('docs/a.md', 'README.md'))).toEqual({
        mode: 'auto',
        rule: { index: 1, snapshot: rules[1]! },
        paths: { total: 2, preview: ['README.md', 'docs/a.md'] },
      })
      expect(evaluateLandingPolicy(rules, leaf, changed('docs/policy/x.md', 'src/a.ts'))).toEqual({
        mode: 'consent',
        rule: { index: 0, snapshot: rules[0]! },
        paths: { total: 1, preview: ['docs/policy/x.md'] },
      })
      expect(evaluateLandingPolicy(rules, leaf, changed('docs/a.md', 'src/a.ts'))).toEqual({
        mode: 'consent',
        rule: { index: 2, snapshot: rules[2]! },
      })
    })

    test('a rule with both predicates needs both, and records the union of matches', () => {
      const both: LandingRule[] = [{ paths: ['docs/api/**'], within: ['docs/**'], mode: 'auto' }]
      expect(evaluateLandingPolicy(both, leaf, changed('docs/a.md'))).toMatchObject({
        rule: { default: true },
      })
      expect(evaluateLandingPolicy(both, leaf, changed('docs/a.md', 'docs/api/b.md'))).toEqual({
        mode: 'auto',
        rule: { index: 0, snapshot: both[0]! },
        paths: { total: 2, preview: ['docs/a.md', 'docs/api/b.md'] },
      })
      expect(evaluateLandingPolicy(both, leaf, changed('docs/api/b.md', 'src/x.ts'))).toMatchObject(
        { rule: { default: true } },
      )
    })

    test('a recorded empty change matches neither predicate and never defers', () => {
      expect(evaluateLandingPolicy(rules, leaf, changed())).toEqual({
        mode: 'consent',
        rule: { index: 2, snapshot: rules[2]! },
      })
    })

    test('unrecorded paths defer only when evaluation reaches a path rule', () => {
      expect(evaluateLandingPolicy(rules, leaf)).toEqual({
        deferred: 'paths-unrecorded',
        rule: { index: 0, snapshot: rules[0]! },
      })
      expect(evaluateLandingPolicy(rules, leaf, { recorded: false })).toMatchObject({
        deferred: 'paths-unrecorded',
      })
      // An earlier non-path match wins without the fact.
      expect(
        evaluateLandingPolicy([{ label: 'hotfix', mode: 'auto' }, ...rules], {
          ...leaf,
          labels: ['hotfix'],
        }),
      ).toEqual({
        mode: 'auto',
        rule: { index: 0, snapshot: { label: 'hotfix', mode: 'auto' } },
      })
      // A path rule whose other predicates fail is skipped without deferral.
      expect(
        evaluateLandingPolicy([{ label: 'docs', within: ['docs/**'], mode: 'auto' }], leaf),
      ).toEqual({ mode: 'auto', rule: { default: true } })
    })

    test('a preview-only view asks for the complete set', () => {
      expect(
        evaluateLandingPolicy(rules, leaf, {
          recorded: true,
          complete: false,
          paths: ['a'],
        }),
      ).toEqual({
        deferred: 'paths-incomplete',
        rule: { index: 0, snapshot: rules[0]! },
      })
    })

    test('the matched preview is sorted, capped at 20, with the exact total', () => {
      const paths = Array.from({ length: 150 }, (_, i) => `docs/${String(i).padStart(3, '0')}.md`)
      const decision = evaluateLandingPolicy(rules, leaf, changed(...[...paths].reverse()))
      expect(decision).toMatchObject({ mode: 'auto', paths: { total: 150 } })
      expect('paths' in decision && decision.paths?.preview).toEqual(paths.slice(0, 20))
    })

    test('matching is case-sensitive', () => {
      expect(evaluateLandingPolicy(rules, leaf, changed('Docs/x.md'))).toMatchObject({
        rule: { index: 2 },
      })
    })

    test('policy identity ignores key order and follows the rules', () => {
      const a = landingPolicyIdentity([{ within: ['docs/**'], mode: 'auto' }])
      expect(landingPolicyIdentity([{ mode: 'auto', within: ['docs/**'] }])).toBe(a)
      expect(landingPolicyIdentity([{ mode: 'auto', within: ['doc/**'] }])).not.toBe(a)
      expect(landingPolicyIdentity([])).not.toBe(a)
    })
  })
})
