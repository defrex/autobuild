import { describe, expect, test } from 'bun:test'
import { buildFeedReadBudget, filteredBuildPageReadBudget } from '../testing/reduced-read-budget'
import {
  BUILD_PAGE_DEFAULT_LIMIT,
  BUILD_PAGE_MAX_LIMIT,
  BuildFeedValidationError,
  compareChangePositions,
  decodeBuildPageCursor,
  encodeBuildPageCursor,
  MAX_CHANGE_POSITION,
  parseBuildPageLimitParam,
  parseChangePosition,
  resolveBuildPageLimit,
} from './build-feed'

describe('change positions', () => {
  test('parse canonical decimals up to the Postgres bigint ceiling', () => {
    expect(parseChangePosition('0')).toBe(0n)
    expect(parseChangePosition('9223372036854775807')).toBe(MAX_CHANGE_POSITION)
    for (const invalid of ['', '01', '-1', '1.0', '1e3', ' 1', 'x', '9223372036854775808', 1])
      expect(() => parseChangePosition(invalid)).toThrow(BuildFeedValidationError)
  })

  test('compare numerically, including 19-digit values past float precision', () => {
    expect(compareChangePositions('9', '10')).toBe(-1)
    expect(compareChangePositions('10', '9')).toBe(1)
    expect(compareChangePositions('42', '42')).toBe(0)
    expect(compareChangePositions('9007199254740993', '9007199254740992')).toBe(1)
    expect(compareChangePositions('9223372036854775806', '9223372036854775807')).toBe(-1)
    expect(() => compareChangePositions('01', '1')).toThrow(BuildFeedValidationError)
  })
})

describe('build page arguments', () => {
  test('limits are integers from 1 to the max and never clamp', () => {
    expect(resolveBuildPageLimit()).toBe(BUILD_PAGE_DEFAULT_LIMIT)
    expect(resolveBuildPageLimit(1)).toBe(1)
    expect(resolveBuildPageLimit(BUILD_PAGE_MAX_LIMIT)).toBe(BUILD_PAGE_MAX_LIMIT)
    for (const invalid of [0, -1, 1.5, BUILD_PAGE_MAX_LIMIT + 1, Number.NaN, '5'])
      expect(() => resolveBuildPageLimit(invalid)).toThrow(BuildFeedValidationError)
    expect(parseBuildPageLimitParam(null)).toBe(BUILD_PAGE_DEFAULT_LIMIT)
    expect(parseBuildPageLimitParam('100')).toBe(100)
    for (const invalid of ['', '0', '01', '101', '1.0', 'x', '1000'])
      expect(() => parseBuildPageLimitParam(invalid)).toThrow(BuildFeedValidationError)
  })

  test('cursors round-trip opaque sort keys and reject malformed input', () => {
    // A creation-order cursor keeps the exact bytes it had before filters.
    expect(
      encodeBuildPageCursor({ order: 'created', at: '2026-11-23T00:00:00.000Z', slug: 'build-a' }),
    ).toBe('eyJ2IjoxLCJhdCI6IjIwMjYtMTEtMjNUMDA6MDA6MDAuMDAwWiIsInNsdWciOiJidWlsZC1hIn0')
    for (const key of [
      { order: 'created' as const, at: '2026-11-23T00:00:00.000Z', slug: 'build-a' },
      { order: 'updated' as const, at: '2026-11-23 00:00:00.123456+00', slug: 'ünïcode/slug?&=' },
    ]) {
      const cursor = encodeBuildPageCursor(key)
      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(decodeBuildPageCursor(cursor)).toEqual(key)
    }
    const encode = (value: unknown) =>
      btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
    for (const invalid of [
      '',
      '!',
      'not a cursor',
      encode({}),
      encode([]),
      encode(null),
      encode({ v: 3, at: 'x', slug: 'y' }),
      encode({ v: 1, at: '', slug: 'y' }),
      encode({ v: 1, at: 'x', slug: 1 }),
      encode({ v: 1, at: 'x', slug: 'y', extra: true }),
      'A'.repeat(4096),
      42,
    ])
      expect(() => decodeBuildPageCursor(invalid)).toThrow(BuildFeedValidationError)
  })
})

test('feed and page reads cost the same at 100 and 10,000 builds or writes', async () => {
  await buildFeedReadBudget()
}, 60_000)

test('every filtered page costs its page size at 100 and 100,000 builds', async () => {
  await filteredBuildPageReadBudget()
}, 60_000)
