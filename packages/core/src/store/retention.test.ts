/**
 * The shared retention decision (`store/retention.ts`): the pure helper every
 * adapter drives its pruning from, and the family lists that bound which kinds
 * retention ever touches. The per-adapter pruning behavior itself is pinned by
 * the contract suite's retention test (store/contract.ts), which runs against
 * every adapter.
 */
import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_ARTIFACT_RETENTION_MAX_REVISIONS,
  DISPATCHER_RETENTION_BUILD_KINDS,
  DISPATCHER_RETENTION_REPO_KINDS,
  isRetentionManagedKind,
  revisionsToPrune,
} from './retention'

describe('revisionsToPrune', () => {
  test('at exactly maxRevisions nothing is pruned', () => {
    expect(revisionsToPrune([0, 1], 2)).toEqual([])
    expect(revisionsToPrune([0, 1, 2], 3)).toEqual([])
    expect(revisionsToPrune([], 2)).toEqual([])
  })

  test('one past the bound prunes exactly the oldest revision', () => {
    expect(revisionsToPrune([0, 1, 2], 2)).toEqual([0])
  })

  test('far past the bound only the newest maxRevisions survive', () => {
    expect(revisionsToPrune([0, 1, 2, 3, 4, 5], 2)).toEqual([0, 1, 2, 3])
    expect(revisionsToPrune([5, 3, 4, 0, 2, 1], 2)).toEqual([0, 1, 2, 3])
  })

  test('input order never changes the decision', () => {
    expect(revisionsToPrune([2, 0, 1], 2)).toEqual(revisionsToPrune([0, 1, 2], 2))
    expect(revisionsToPrune([2, 0, 1], 2)).toEqual([0])
  })

  test('non-integer or negative revisions are rejected', () => {
    expect(() => revisionsToPrune([0, 1.5], 2)).toThrow('nonnegative integers')
    expect(() => revisionsToPrune([0, -1], 2)).toThrow('nonnegative integers')
  })

  test('maxRevisions must be a positive integer', () => {
    expect(() => revisionsToPrune([0], 0)).toThrow('positive integer')
    expect(() => revisionsToPrune([0], -1)).toThrow('positive integer')
    expect(() => revisionsToPrune([0], 1.5)).toThrow('positive integer')
    expect(() => revisionsToPrune([0], Number.NaN)).toThrow('positive integer')
  })
})

describe('retention family', () => {
  test('the dispatcher run/config family is exactly the documented kinds', () => {
    expect([...DISPATCHER_RETENTION_REPO_KINDS]).toEqual([
      'dispatcher-effective-config',
      'dispatcher-config',
    ])
    expect([...DISPATCHER_RETENTION_BUILD_KINDS]).toEqual(['build-runner-effective-config'])
  })

  test('non-family kinds are not retention-managed', () => {
    for (const kind of ['plan', 'spec', 'transcript', 'harvest-scan', 'pr-description', '']) {
      expect(isRetentionManagedKind(kind)).toBe(false)
    }
    for (const kind of [...DISPATCHER_RETENTION_REPO_KINDS, ...DISPATCHER_RETENTION_BUILD_KINDS]) {
      expect(isRetentionManagedKind(kind)).toBe(true)
    }
  })

  test('the default bound is the documented 200 revisions', () => {
    expect(DEFAULT_ARTIFACT_RETENTION_MAX_REVISIONS).toBe(200)
  })
})
