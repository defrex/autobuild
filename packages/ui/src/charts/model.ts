import type { SegmentCategory } from '../tokens'

/** One span of a build's wall-clock time (RFC 0007 §7.4). Times are epoch ms. */
export interface Segment {
  category: SegmentCategory
  start: number
  /** Absent while the segment is still open. */
  end?: number
  round?: number
}

export interface BuildTimeline {
  slug: string
  ticket: string
  title: string
  outcome: 'merged' | 'aborted' | 'running'
  segments: Segment[]
}

/** One step's distribution over a window (RFC 0007 §7.2). Durations in ms. */
export interface StepStats {
  step: string
  category: SegmentCategory
  count: number
  mean: number
  p50: number
  p90: number
  p99: number
  total: number
}

export const segmentLabel: Record<SegmentCategory, string> = {
  plan: 'plan',
  'plan-review': 'plan-review',
  implement: 'implement',
  'code-review': 'code-review',
  verify: 'verify',
  finalize: 'finalize',
  reconcile: 'reconcile',
  queued: 'queued',
  'ticket-wait': 'ticket wait',
  paused: 'paused',
  'awaiting-merge': 'awaiting merge',
  escalated: 'escalated',
}

/** The terminal dashboard's duration format: 38s, 4m12s, 1h04m07s. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  if (h > 0) return `${h}h${pad(m)}m${pad(s)}s`
  if (m > 0) return `${m}m${pad(s)}s`
  return `${s}s`
}

export function segmentEnd(segment: Segment, now: number): number {
  return segment.end ?? now
}

export function timelineSpan(build: BuildTimeline, now: number): [number, number] {
  let start = Number.POSITIVE_INFINITY
  let end = Number.NEGATIVE_INFINITY
  for (const s of build.segments) {
    start = Math.min(start, s.start)
    end = Math.max(end, segmentEnd(s, now))
  }
  return [start, end]
}

/** Nearest-rank percentile over raw durations, for fixtures. The served
 * rollup answers from log-scale histogram buckets instead. */
export function stepStats(step: string, category: SegmentCategory, durations: number[]): StepStats {
  const sorted = [...durations].sort((a, b) => a - b)
  const at = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0
  const total = sorted.reduce((a, b) => a + b, 0)
  return {
    step,
    category,
    count: sorted.length,
    mean: sorted.length ? total / sorted.length : 0,
    p50: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    total,
  }
}
