import { describe, expect, test } from 'bun:test'
import { reduceBuild, type BuildState } from '../../kernel/reducer'
import { landPreconditions, awaitsConsent } from '../../kernel/landing-readiness'
import { projectTree } from './tree'
import type { LeafRestackState } from '../../kernel/leaf-restack-state'

function ready(): BuildState {
  return {
    ...reduceBuild([]),
    status: 'running',
    baseBranch: 'main',
    prState: 'open',
    pr: { number: 1, url: 'https://forge/1', headSha: 'head' },
    finalizeCompletedSeq: 5,
    landing: {
      decision: {
        seq: 6,
        from: 'leaf',
        into: { kind: 'root' },
        labels: [],
        mode: 'consent',
        rule: { default: true },
        candidate: { head: 'head', parent: 'base', cycle: '5' },
      },
    },
  }
}
const restack: LeafRestackState = { gates: {}, initialBase: 'base' }
describe('stored consent eligibility', () => {
  test('consent, auto, explicit land and hold use recorded decisions', () => {
    const state = ready()
    expect(awaitsConsent(state, restack)).toBe(true)
    state.landing!.decision!.mode = 'auto'
    expect(awaitsConsent(state, restack)).toBe(false)
    state.landing!.command = { kind: 'hold', seq: 7 }
    expect(awaitsConsent(state, restack)).toBe(true)
    state.landing!.command = { kind: 'land', seq: 8 }
    expect(awaitsConsent(state, restack)).toBe(false)
    delete state.landing!.decision
    expect(awaitsConsent(state, restack)).toBe(false)
  })
  test.each(['paused', 'done', 'aborted'] as const)('%s is absent', (status) => {
    expect(awaitsConsent({ ...ready(), status }, restack)).toBe(false)
  })
  test('current control acceptance stays separate from stale candidate read eligibility', () => {
    const state = ready()
    state.finalizeCompletedSeq = 9
    expect(landPreconditions(state, restack)).toBe(true)
    expect(awaitsConsent(state, restack)).toBe(false)
    expect(
      awaitsConsent(ready(), { ...restack, target: { seq: 9, branch: 'main', sha: 'new' } }),
    ).toBe(false)
  })
  test('unknown children are unknown and frozen target never comes from source metadata', () => {
    const state = {
      ...ready(),
      kind: 'node' as const,
      target: { ticket: { source: 'file', id: 'N' }, build: 'node' },
    }
    const tree = projectTree(
      { slug: 'leaf', repo: 'repo', branch: 'recorded', createdAt: '', updatedAt: '' },
      state,
      restack,
    )
    expect(tree.target.ticket?.id).toBe('N')
    expect(tree.branch).toBe('recorded')
    expect(tree.children).toBeUndefined()
    expect(tree.completeness).toBe('unknown')
    expect(tree.consent).toBe(false)
  })
})

test('node consent requires complete current-parent verification rather than historical same-head evidence', () => {
  const state: BuildState = {
    ...ready(),
    kind: 'node',
    integration: {
      observation: { openChildren: [], diagnostics: [], contributions: ['child'] },
      cycle: {
        id: 'cycle',
        head: 'head',
        parent: 'base',
        seq: 3,
        config: JSON.stringify({ verify: { steps: ['test'] } }),
      },
    },
    nodeComparison: { headSha: 'head', parentSha: 'base', ahead: 1 },
    nodeRestack: { items: [], contributionBase: 'base' },
    verify: {
      cycleSince: 3,
      maxAttemptSeen: 1,
      results: [
        {
          seq: 4,
          step: 'test',
          attempt: 1,
          outcome: 'pass',
          headSha: 'head',
          baseSha: 'base',
          restackId: 'cycle',
        },
      ],
    },
  }
  state.landing!.decision!.candidate.cycle = 'cycle'
  expect(awaitsConsent(state, restack)).toBe(true)
  state.integration!.observation!.openChildren = ['open']
  expect(awaitsConsent(state, restack)).toBe(false)
  state.integration!.observation!.openChildren = []
  state.nodeComparison!.parentSha = 'new-base'
  expect(awaitsConsent(state, restack)).toBe(false)
  state.nodeComparison!.parentSha = 'base'
  state.verify.results[0]!.outcome = 'fail'
  expect(awaitsConsent(state, restack)).toBe(false)
})
