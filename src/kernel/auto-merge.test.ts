import { describe, expect, test } from 'bun:test'
import { classifyAutoMergeEnable, mergeStateStatuses, type MergeGatePresence } from './auto-merge'

describe('classifyAutoMergeEnable', () => {
  const expected = {
    BEHIND: { present: 'native', absent: 'direct' },
    BLOCKED: { present: 'native', absent: 'error' },
    CLEAN: { present: 'native', absent: 'direct' },
    DIRTY: { present: 'deferred', absent: 'deferred' },
    DRAFT: { present: 'error', absent: 'error' },
    HAS_HOOKS: { present: 'native', absent: 'native' },
    UNKNOWN: { present: 'native', absent: 'deferred' },
    UNSTABLE: { present: 'native', absent: 'direct' },
  } as const

  for (const state of mergeStateStatuses) {
    for (const gate of ['present', 'absent'] as const satisfies readonly MergeGatePresence[]) {
      test(`${state} + gate ${gate} -> ${expected[state][gate]}`, () => {
        expect(classifyAutoMergeEnable(state, gate).kind).toBe(expected[state][gate])
      })
    }
  }

  test('CLEAN never chooses direct ownership from current satisfaction alone', () => {
    expect(classifyAutoMergeEnable('CLEAN', 'present')).toEqual({ kind: 'native' })
    expect(classifyAutoMergeEnable('CLEAN', 'absent')).toEqual({ kind: 'direct' })
  })
})
