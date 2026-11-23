import { expect, test } from 'bun:test'
import { formatDuration, stepStats } from './model'

test('durations use the terminal dashboard format', () => {
  expect(formatDuration(38_000)).toBe('38s')
  expect(formatDuration(252_000)).toBe('4m12s')
  expect(formatDuration(3_847_000)).toBe('1h04m07s')
})

test('step stats take nearest-rank percentiles and sum the total', () => {
  const s = stepStats('plan', 'plan', [10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
  expect([s.p50, s.p90, s.p99, s.total, s.count, s.mean]).toEqual([50, 90, 100, 550, 10, 55])
})
