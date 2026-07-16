import { describe, expect, test } from 'bun:test'
import type { Finding } from '../ontology'
import { persistenceChains, stalledChains } from './stall'

function finding(id: string, persists: string[] = []): Finding {
  return {
    id,
    severity: 'important',
    summary: `finding ${id}`,
    persists,
  }
}

describe('persistenceChains', () => {
  test('no rounds → no chains', () => {
    expect(persistenceChains([])).toEqual([])
    expect(persistenceChains([[], []])).toEqual([])
  })

  test('linear chain across 3 rounds spans 3 rounds', () => {
    const chains = persistenceChains([
      [finding('f_1')],
      [finding('f_2', ['f_1'])],
      [finding('f_3', ['f_2'])],
    ])
    expect(chains).toEqual([{ ids: ['f_1', 'f_2', 'f_3'], rounds: 3 }])
  })

  test('broken chain (no persists) stays fresh — each finding is its own 1-round chain', () => {
    const chains = persistenceChains([
      [finding('f_1')],
      [finding('f_2')],
      [finding('f_3')],
    ])
    expect(chains).toEqual([
      { ids: ['f_1'], rounds: 1 },
      { ids: ['f_2'], rounds: 1 },
      { ids: ['f_3'], rounds: 1 },
    ])
  })

  test('branching persists extend the same chain (max depth, no double-count)', () => {
    const chains = persistenceChains([
      [finding('f_1')],
      [finding('f_2', ['f_1']), finding('f_3', ['f_1'])],
      [finding('f_4', ['f_2'])],
    ])
    expect(chains).toEqual([{ ids: ['f_1', 'f_2', 'f_3', 'f_4'], rounds: 3 }])
  })

  test('multiple independent chains are tracked separately', () => {
    const chains = persistenceChains([
      [finding('f_1'), finding('f_2')],
      [finding('f_3', ['f_1']), finding('f_4', ['f_2']), finding('f_5')],
    ])
    expect(chains).toEqual([
      { ids: ['f_1', 'f_3'], rounds: 2 },
      { ids: ['f_2', 'f_4'], rounds: 2 },
      { ids: ['f_5'], rounds: 1 },
    ])
  })

  test('a finding with multiple persists entries joins multiple chains', () => {
    const chains = persistenceChains([
      [finding('f_1'), finding('f_2')],
      [finding('f_3', ['f_1', 'f_2'])],
    ])
    expect(chains).toEqual([
      { ids: ['f_1', 'f_3'], rounds: 2 },
      { ids: ['f_2', 'f_3'], rounds: 2 },
    ])
  })

  test('multi-hop persists resolves to the transitive root', () => {
    const chains = persistenceChains([
      [finding('f_1')],
      [finding('f_2', ['f_1'])],
      [finding('f_3', ['f_1', 'f_2'])],
    ])
    expect(chains).toEqual([{ ids: ['f_1', 'f_2', 'f_3'], rounds: 3 }])
  })

  test('a round gap breaks the streak — chosen semantics: rounds is the longest consecutive run', () => {
    // Round 2's fresh skeptic saw f_1 (reviewers get all prior rounds — §8.3)
    // and did not continue it; round 3 re-raised it. History is kept in ids,
    // but the chain has only "survived" 1 consecutive round.
    const chains = persistenceChains([
      [finding('f_1')],
      [finding('f_2')],
      [finding('f_3', ['f_1'])],
    ])
    expect(chains).toEqual([
      { ids: ['f_1', 'f_3'], rounds: 1 },
      { ids: ['f_2'], rounds: 1 },
    ])
  })

  test('a re-raised chain builds a new streak after the gap', () => {
    const chains = persistenceChains([
      [finding('f_1')],
      [finding('f_2')],
      [finding('f_3', ['f_1'])],
      [finding('f_4', ['f_3'])],
    ])
    expect(chains).toEqual([
      { ids: ['f_1', 'f_3', 'f_4'], rounds: 2 },
      { ids: ['f_2'], rounds: 1 },
    ])
  })

  test('persists to an unknown id is not a link — the finding roots its own chain', () => {
    const chains = persistenceChains([
      [finding('f_1')],
      [finding('f_2', ['f_ghost'])],
    ])
    expect(chains).toEqual([
      { ids: ['f_1'], rounds: 1 },
      { ids: ['f_2'], rounds: 1 },
    ])
  })

  test('persists to a same-round finding is not a link', () => {
    const chains = persistenceChains([[finding('f_1'), finding('f_2', ['f_1'])]])
    expect(chains).toEqual([
      { ids: ['f_1'], rounds: 1 },
      { ids: ['f_2'], rounds: 1 },
    ])
  })
})

describe('stalledChains', () => {
  test('applies the threshold: chain at exactly stallRounds is stalled', () => {
    const rounds = [
      [finding('f_1')],
      [finding('f_2', ['f_1'])],
      [finding('f_3', ['f_2'])],
    ]
    expect(stalledChains(rounds, 3)).toEqual([
      { ids: ['f_1', 'f_2', 'f_3'], rounds: 3 },
    ])
    expect(stalledChains(rounds, 4)).toEqual([])
  })

  test('fresh findings never stall', () => {
    const rounds = [[finding('f_1')], [finding('f_2')], [finding('f_3')]]
    expect(stalledChains(rounds, 2)).toEqual([])
  })

  test('only chains at threshold are reported when chains have different depths', () => {
    const rounds = [
      [finding('f_1'), finding('f_2')],
      [finding('f_3', ['f_1'])],
      [finding('f_4', ['f_3']), finding('f_5', ['f_2'])],
    ]
    // f_1→f_3→f_4 spans rounds 1-3; f_2→f_5 spans rounds {1,3}: streak 1.
    expect(stalledChains(rounds, 3)).toEqual([
      { ids: ['f_1', 'f_3', 'f_4'], rounds: 3 },
    ])
  })

  test('dismissed chain is suppressed when its tip is dismissed (§15.6-B)', () => {
    const rounds = [
      [finding('f_1')],
      [finding('f_2', ['f_1'])],
      [finding('f_3', ['f_2'])],
    ]
    expect(stalledChains(rounds, 3, new Set(['f_3']))).toEqual([])
    expect(stalledChains(rounds, 3, new Set(['f_1', 'f_2', 'f_3']))).toEqual([])
  })

  test('dismissing only historical members does not suppress the chain', () => {
    const rounds = [
      [finding('f_1')],
      [finding('f_2', ['f_1'])],
      [finding('f_3', ['f_2'])],
    ]
    expect(stalledChains(rounds, 3, new Set(['f_1', 'f_2']))).toEqual([
      { ids: ['f_1', 'f_2', 'f_3'], rounds: 3 },
    ])
  })

  test('a branched tip needs every continuation dismissed', () => {
    const rounds = [
      [finding('f_1')],
      [finding('f_2', ['f_1'])],
      [finding('f_3', ['f_2']), finding('f_4', ['f_2'])],
    ]
    expect(stalledChains(rounds, 3, new Set(['f_3']))).toEqual([
      { ids: ['f_1', 'f_2', 'f_3', 'f_4'], rounds: 3 },
    ])
    expect(stalledChains(rounds, 3, new Set(['f_3', 'f_4']))).toEqual([])
  })

  test('chain resurrected by a later persists after dismissal — chosen semantics: a non-dismissed continuation moves the tip and revives the full streak', () => {
    const dismissed = new Set(['f_1', 'f_2', 'f_3'])
    const throughDismissal = [
      [finding('f_1')],
      [finding('f_2', ['f_1'])],
      [finding('f_3', ['f_2'])],
    ]
    expect(stalledChains(throughDismissal, 3, dismissed)).toEqual([])

    // The round-4 reviewer was told the chain was dismissed and insisted
    // anyway: that is maximal disagreement — it re-stalls immediately.
    const afterResurrection = [...throughDismissal, [finding('f_4', ['f_3'])]]
    expect(stalledChains(afterResurrection, 3, dismissed)).toEqual([
      { ids: ['f_1', 'f_2', 'f_3', 'f_4'], rounds: 4 },
    ])
  })

  test('no dismissedIds set means nothing is suppressed', () => {
    const rounds = [[finding('f_1')], [finding('f_2', ['f_1'])]]
    expect(stalledChains(rounds, 2)).toEqual([{ ids: ['f_1', 'f_2'], rounds: 2 }])
    expect(stalledChains(rounds, 2, new Set())).toEqual([
      { ids: ['f_1', 'f_2'], rounds: 2 },
    ])
  })

  test('inputs are never mutated', () => {
    const rounds = [
      [finding('f_1')],
      [finding('f_2', ['f_1'])],
      [finding('f_3', ['f_2'])],
    ]
    const snapshot = structuredClone(rounds)
    persistenceChains(rounds)
    stalledChains(rounds, 2, new Set(['f_3']))
    expect(rounds).toEqual(snapshot)
  })
})
