import { expect, test } from 'bun:test'
import { timelineLive } from './analytics-model'
import { shouldRefetch } from './fetch'

test('only a new URL or a moved position fetches; triggers in flight coalesce', () => {
  const at = (url: string, key?: string) => ({ url, key })
  expect(shouldRefetch(at('/a', '1'), undefined, undefined)).toBe('now')
  expect(shouldRefetch(at('/b', '1'), at('/a', '1'), undefined)).toBe('now')
  expect(shouldRefetch(at('/a', '2'), at('/a', '1'), undefined)).toBe('now')
  expect(shouldRefetch(at('/a', '1'), at('/a', '1'), undefined)).toBe('no')
  expect(shouldRefetch(at('/a'), at('/a', '1'), undefined)).toBe('no')
  expect(shouldRefetch(at('/a', '2'), undefined, at('/a', '1'))).toBe('after')
  expect(shouldRefetch(at('/a', '1'), undefined, at('/a', '1'))).toBe('no')
  expect(shouldRefetch(at('/b', '1'), undefined, at('/a', '1'))).toBe('now')
})

test('a timeline is live while any segment is open', () => {
  const row = (state: 'open' | 'closed' | 'abandoned') => ({
    slug: 's',
    kind: 'work' as const,
    segments: [
      {
        category: 'plan',
        start: '2026-11-20T10:00:00.000Z',
        durationMs: 0,
        opened: { type: 'plan.started', seq: 2 },
        state,
      },
    ],
  })
  expect(timelineLive(row('open'))).toBe(true)
  expect(timelineLive(row('closed'))).toBe(false)
  expect(timelineLive(row('abandoned'))).toBe(false)
})
