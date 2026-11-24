import { describe, expect, test } from 'bun:test'
import {
  HISTOGRAM_BUCKETS,
  addCell,
  bucketLow,
  bucketOf,
  mergeInto,
  percentile,
  subtractFrom,
  totals,
  type Histogram,
} from './histogram'

const DAY = 86_400_000

/** Deterministic pseudo-random numbers in [0, 1). */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state / 2 ** 32
  }
}

function histogramOf(values: number[]): Histogram {
  const hist: Histogram = {}
  for (const value of values) addCell(hist, bucketOf(value), 1, value)
  return hist
}

function exactRank(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(1, Math.ceil(q * sorted.length)) - 1]!
}

function expectWithin(values: number[]) {
  const hist = histogramOf(values)
  for (const q of [0.5, 0.9, 0.99]) {
    const exact = exactRank(values, q)
    expect(Math.abs(percentile(hist, q) - exact) / exact).toBeLessThanOrEqual(0.05)
  }
}

describe('histogram', () => {
  test('buckets are 10% wide from 1 second, clamped at both ends', () => {
    expect(bucketOf(0)).toBe(0)
    expect(bucketOf(999)).toBe(0)
    expect(bucketOf(1_000)).toBe(0)
    expect(bucketOf(1_099)).toBe(0)
    expect(bucketOf(1_101)).toBe(1)
    expect(bucketOf(7 * DAY)).toBe(HISTOGRAM_BUCKETS - 1)
    expect(bucketOf(365 * DAY)).toBe(HISTOGRAM_BUCKETS - 1)
    expect(bucketLow(HISTOGRAM_BUCKETS)).toBeGreaterThan(7 * DAY)
    for (let i = 1; i < HISTOGRAM_BUCKETS - 1; i++) {
      expect(bucketOf(bucketLow(i) * 1.0001)).toBe(i)
      expect(bucketOf(bucketLow(i + 1) * 0.9999)).toBe(i)
    }
  })

  test('add then subtract restores the original', () => {
    const base = histogramOf([1_500, 60_000, 60_500, 3_600_000])
    const before = structuredClone(base)
    const extra = histogramOf([60_100, 2 * DAY, 10])
    mergeInto(base, extra)
    expect(totals(base).count).toBe(7)
    subtractFrom(base, extra)
    expect(base).toEqual(before)
    subtractFrom(base, before)
    expect(base).toEqual({})
  })

  test('mean and total are exact', () => {
    const values = [1_234, 5_678, 91_011, 1_213_141]
    const { count, totalMs } = totals(histogramOf(values))
    expect(count).toBe(4)
    expect(totalMs).toBe(values.reduce((a, b) => a + b, 0))
  })

  test('percentiles are within 5% of exact nearest rank on a log-uniform fixture', () => {
    const rand = seeded(42)
    const lo = Math.log(1_000)
    const hi = Math.log(7 * DAY)
    expectWithin(Array.from({ length: 10_000 }, () => Math.exp(lo + rand() * (hi - lo))))
  })

  test('percentiles are within 5% on skewed and single-value fixtures', () => {
    const rand = seeded(7)
    // Mostly short durations with a long tail.
    expectWithin(
      Array.from({ length: 5_000 }, () => 2_000 + (rand() < 0.95 ? rand() * 60_000 : rand() * DAY)),
    )
    expectWithin([42_000])
    expectWithin(Array.from({ length: 100 }, () => 300_000))
    // Clamped values answer the bucket mean.
    expect(percentile(histogramOf([200, 400]), 0.5)).toBe(300)
    expect(percentile(histogramOf([30 * DAY]), 0.5)).toBe(30 * DAY)
    expect(percentile({}, 0.5)).toBe(0)
  })
})
