import { describe, expect, test } from 'bun:test'
import { reduceBuild, type BuildState } from './reducer'
import {
  ciChecksObservable,
  ciFailureKey,
  ciFailureText,
  classifyHeadChecks,
  currentCiFailure,
  failingSetDigest,
} from './forge-checks'
import type { HeadCheck } from '../ports/types'

const run = (name: string, status: string, conclusion: string | null) => ({
  name,
  status,
  conclusion,
})

describe('classifyHeadChecks', () => {
  test('failing check runs and error statuses are red, sorted by source then name', () => {
    expect(
      classifyHeadChecks(
        [
          run('unit', 'completed', 'failure'),
          run('lint', 'completed', 'timed_out'),
          run('docs', 'completed', 'success'),
        ],
        [{ context: 'ci/deploy', state: 'error', url: 'https://ci/1' }],
      ),
    ).toEqual({
      kind: 'known',
      pending: false,
      failing: [
        { name: 'lint', source: 'check-run', conclusion: 'timed_out' },
        { name: 'unit', source: 'check-run', conclusion: 'failure' },
        { name: 'ci/deploy', source: 'status', conclusion: 'error', url: 'https://ci/1' },
      ],
    })
  })

  test('cancelled, neutral, skipped and action-required runs are not failures', () => {
    expect(
      classifyHeadChecks(
        ['cancelled', 'neutral', 'skipped', 'action_required', 'stale'].map((c) =>
          run(c, 'completed', c),
        ),
        [{ context: 'ok', state: 'success' }],
      ),
    ).toEqual({ kind: 'known', failing: [], pending: false })
  })

  test('incomplete runs and pending statuses report pending', () => {
    expect(classifyHeadChecks([run('unit', 'in_progress', null)], [])).toEqual({
      kind: 'known',
      failing: [],
      pending: true,
    })
    expect(classifyHeadChecks([], [{ context: 'ci', state: 'pending' }])).toMatchObject({
      pending: true,
    })
  })

  test('a truncated listing with no visible failure is unknown, never passing', () => {
    expect(classifyHeadChecks([run('unit', 'completed', 'success')], [], true)).toEqual({
      kind: 'unknown',
      reason: 'truncated',
    })
    expect(classifyHeadChecks([run('unit', 'completed', 'failure')], [], true)).toMatchObject({
      kind: 'known',
      failing: [{ name: 'unit' }],
    })
  })

  test('names dedupe within a source and truncate to the payload limit', () => {
    const long = 'x'.repeat(300)
    const result = classifyHeadChecks(
      [run('unit', 'completed', 'failure'), run('unit', 'completed', 'failure')],
      [
        { context: 'unit', state: 'failure' },
        { context: long, state: 'failure' },
      ],
    )
    expect(result.kind === 'known' && result.failing.map((c) => [c.source, c.name.length])).toEqual(
      [
        ['check-run', 4],
        ['status', 4],
        ['status', 200],
      ],
    )
  })
})

describe('failing set identity', () => {
  const checks = (names: string[]): HeadCheck[] =>
    names.map((name) => ({ name, source: 'check-run', conclusion: 'failure' }))

  test('the digest is order-independent and ignores conclusions and urls', () => {
    expect(failingSetDigest(checks(['b', 'a']))).toBe(failingSetDigest(checks(['a', 'b'])))
    expect(failingSetDigest(checks(['a']))).toBe(
      failingSetDigest([{ name: 'a', source: 'check-run', conclusion: 'timed_out', url: 'u' }]),
    )
    expect(failingSetDigest(checks(['a']))).toMatch(/^[0-9a-f]{64}$/)
  })

  test('swapping a check outside the 20-entry preview changes the digest and key', () => {
    const names = Array.from({ length: 21 }, (_, i) => `check-${String(i).padStart(2, '0')}`)
    const swapped = [...names.slice(0, 20), 'check-zz']
    expect(checks(names).slice(0, 20)).toEqual(checks(swapped).slice(0, 20))
    const before = failingSetDigest(checks(names))
    const after = failingSetDigest(checks(swapped))
    expect(after).not.toBe(before)
    expect(ciFailureKey({ head: 'h', buildHead: 'h', digest: before })).not.toBe(
      ciFailureKey({ head: 'h', buildHead: 'h', digest: after }),
    )
  })

  test('the key binds both heads', () => {
    const digest = failingSetDigest(checks(['a']))
    expect(ciFailureKey({ head: 'a', buildHead: 'b', digest })).not.toBe(
      ciFailureKey({ head: 'a', buildHead: 'a', digest }),
    )
  })
})

function finishedLeaf(): BuildState {
  const state = reduceBuild([])
  state.pr = { number: 7, url: 'https://forge/pr/7', headSha: 'build-head' }
  state.prState = 'open'
  state.pipelineSettled = 5
  state.restartSince = 0
  state.status = 'running'
  state.ciFailure = {
    pr: 7,
    head: 'build-head',
    buildHead: 'build-head',
    checks: [{ name: 'unit', source: 'check-run', conclusion: 'failure' }],
    total: 1,
    digest: failingSetDigest([{ name: 'unit', source: 'check-run', conclusion: 'failure' }]),
    seq: 9,
  }
  return state
}

describe('currentCiFailure', () => {
  test('reports a failure recorded at the build head of the open PR', () => {
    expect(currentCiFailure(finishedLeaf())?.seq).toBe(9)
    expect(ciChecksObservable(finishedLeaf())).toBe(true)
  })

  test('hides on a head change, merge, close or conflict', () => {
    const moved = finishedLeaf()
    moved.pr!.headSha = 'reconciled'
    expect(currentCiFailure(moved)).toBeUndefined()
    for (const lifecycle of ['merged', 'closed', 'conflicted'] as const) {
      const state = finishedLeaf()
      state.prState = lifecycle
      expect(currentCiFailure(state)).toBeUndefined()
      expect(ciChecksObservable(state)).toBe(false)
    }
    const other = finishedLeaf()
    other.pr!.number = 8
    expect(currentCiFailure(other)).toBeUndefined()
  })

  test('an unfinished or running leaf and a node are not observed', () => {
    const unsettled = finishedLeaf()
    unsettled.pipelineSettled = undefined
    expect(ciChecksObservable(unsettled)).toBe(false)
    const node = finishedLeaf()
    node.kind = 'node'
    expect(ciChecksObservable(node)).toBe(false)
    const session = finishedLeaf()
    session.sessions.open = [{} as never]
    expect(ciChecksObservable(session)).toBe(false)
  })
})

describe('ciFailureText', () => {
  test('names the head, the preview and the remainder', () => {
    expect(
      ciFailureText({
        head: '0123456789abcdef',
        buildHead: '0123456789abcdef',
        checks: [{ name: 'unit' }, { name: 'lint' }],
        total: 5,
      }),
    ).toBe('forge CI failing at 0123456789ab: unit, lint (+3 more)')
  })

  test('notes a live PR head that differs from the build head', () => {
    expect(
      ciFailureText({
        head: 'aaaaaaaaaaaaaaaa',
        buildHead: 'bbbbbbbbbbbbbbbb',
        checks: [{ name: 'unit' }],
        total: 1,
      }),
    ).toBe(
      'forge CI failing at aaaaaaaaaaaa: unit (live PR head differs from build head bbbbbbbbbbbb)',
    )
  })
})
