/**
 * Log-scale duration histograms for rollups (RFC 0007 §8.6, SPEC §7.7).
 *
 * Bucket `i` covers `[1000·1.1^i, 1000·1.1^(i+1))` milliseconds: 10% wide,
 * from 1 second to about 7.2 days in 140 buckets. Shorter durations clamp
 * into bucket 0 and longer ones into bucket 139. A histogram is sparse, and
 * each bucket keeps a count and an exact sum, so a mean or total is exact
 * and a percentile is within 5% of the exact nearest-rank value.
 *
 * Pure and browser-safe: plain JSON in and out, no Bun or `node:` APIs.
 */
import { z } from 'zod'

export const HISTOGRAM_MIN_MS = 1_000
export const HISTOGRAM_GROWTH = 1.1
export const HISTOGRAM_BUCKETS = 140

/** Bucket index → `[count, sumMs]`. Empty buckets are absent. */
export type Histogram = Record<string, [number, number]>

/**
 * Cast because non-`strict` consumers (plugins typechecking this source) infer
 * zod tuple elements as optional; the runtime schema is the two-element tuple.
 */
export const histogramSchema = z.record(
  z.string().regex(/^(0|[1-9][0-9]?|1[0-3][0-9])$/),
  z.tuple([z.number().int().positive(), z.number().nonnegative()]),
) as unknown as z.ZodType<Histogram>

const LOG_GROWTH = Math.log(HISTOGRAM_GROWTH)

/** The bucket a duration falls in, clamped to the histogram's range. */
export function bucketOf(ms: number): number {
  if (!(ms > HISTOGRAM_MIN_MS)) return 0
  const index = Math.floor(Math.log(ms / HISTOGRAM_MIN_MS) / LOG_GROWTH)
  return Math.min(HISTOGRAM_BUCKETS - 1, Math.max(0, index))
}

/** The lower bound of bucket `index`, in milliseconds. */
export function bucketLow(index: number): number {
  return HISTOGRAM_MIN_MS * HISTOGRAM_GROWTH ** index
}

/** Add `count` observations whose durations sum to `sumMs` to one bucket. */
export function addCell(hist: Histogram, bucket: number, count: number, sumMs: number): void {
  const key = String(bucket)
  const cell = hist[key]
  if (cell === undefined) hist[key] = [count, sumMs]
  else hist[key] = [cell[0] + count, cell[1] + sumMs]
}

/** The inverse of `addCell`. A bucket whose count reaches zero is removed. */
export function subtractCell(hist: Histogram, bucket: number, count: number, sumMs: number): void {
  const key = String(bucket)
  const cell = hist[key]
  if (cell === undefined) return
  const next: [number, number] = [cell[0] - count, cell[1] - sumMs]
  if (next[0] <= 0) delete hist[key]
  else hist[key] = [next[0], Math.max(0, next[1])]
}

/** Add every bucket of `from` into `into`. */
export function mergeInto(into: Histogram, from: Histogram): void {
  for (const [bucket, [count, sum]] of Object.entries(from))
    addCell(into, Number(bucket), count, sum)
}

/** Subtract every bucket of `from` out of `into`. */
export function subtractFrom(into: Histogram, from: Histogram): void {
  for (const [bucket, [count, sum]] of Object.entries(from))
    subtractCell(into, Number(bucket), count, sum)
}

export interface HistogramTotals {
  count: number
  totalMs: number
}

export function totals(hist: Histogram): HistogramTotals {
  let count = 0
  let totalMs = 0
  for (const [c, s] of Object.values(hist)) {
    count += c
    totalMs += s
  }
  return { count, totalMs }
}

/**
 * The nearest-rank `q` quantile (0 < q ≤ 1). Within its bucket the estimate is
 * the geometric midpoint `lo·√1.1`, at most 4.9% from any value in the bucket.
 * The clamping buckets 0 and 139 answer their mean instead, because they hold
 * values outside their nominal bounds. An empty histogram answers 0.
 */
export function percentile(hist: Histogram, q: number): number {
  const { count } = totals(hist)
  if (count === 0) return 0
  const rank = Math.max(1, Math.ceil(q * count))
  const buckets = Object.keys(hist)
    .map(Number)
    .sort((a, b) => a - b)
  let seen = 0
  for (const bucket of buckets) {
    const [c, sum] = hist[String(bucket)]!
    seen += c
    if (seen >= rank) {
      if (bucket === 0 || bucket === HISTOGRAM_BUCKETS - 1) return sum / c
      return bucketLow(bucket) * Math.sqrt(HISTOGRAM_GROWTH)
    }
  }
  // Unreachable: the ranks sum to `count`.
  return 0
}
