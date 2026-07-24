import { describe, expect, test } from 'bun:test'
import type { AbEvent } from '../events/catalog'
import {
  autoMergeDeferralObservation,
  autoMergeDeferralRef,
  classifyAutoMergeEnable,
  hasAutoMergeDeferralObservation,
  mergeStateStatuses,
  type MergeGatePresence,
} from './auto-merge'

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

describe('auto-merge deferral observations', () => {
  test('uses an auto-merge-gate-specific summary and stable PR/command marker', () => {
    const write = autoMergeDeferralObservation(
      { code: 'repository-auto-merge-disabled', detail: 'allow_auto_merge=false' },
      42,
      17,
      'obs_1',
    )
    expect(write.payload.summary).toContain('Auto-merge gate')
    expect(write.payload.summary).toContain('repository-level auto-merge is disabled')
    expect(write.payload.refs).toEqual([autoMergeDeferralRef(42, 17)])

    const event = {
      build: 'build-1',
      seq: 18,
      ts: '2026-01-01T00:00:00.000Z',
      ...write,
    } as AbEvent
    expect(hasAutoMergeDeferralObservation([event], 42, 17)).toBe(true)
    expect(hasAutoMergeDeferralObservation([event], 42, 19)).toBe(false)
  })
})
