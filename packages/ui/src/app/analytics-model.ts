import type { StepDurationStat } from '../../../core/src/kernel/step-durations'
import type {
  WebAnalytics,
  WebAnalyticsQuery,
  WebTimelineRow,
} from '../../../core/src/web/protocol'

export type { WebAnalytics, WebTimelineRow }
import type { BuildTimeline, Segment, StepStats } from '../charts/model'
import { type SegmentCategory, segmentStyle } from '../tokens'

/** The chart category a served step draws in: `verify:*` as verify, every
 * other known step as itself, anything else none. */
export function stepCategory(step: string): SegmentCategory | undefined {
  if (step.startsWith('verify:')) return 'verify'
  return Object.hasOwn(segmentStyle, step) ? (step as SegmentCategory) : undefined
}

/** A served timeline row as the Gantt draws it: epoch times, the full step
 * name on each segment, and unknown categories dropped. */
export function ganttTimeline(row: WebTimelineRow): BuildTimeline {
  const segments: Segment[] = []
  for (const s of row.segments) {
    const category = stepCategory(s.category)
    if (category === undefined) continue
    segments.push({
      category,
      start: Date.parse(s.start),
      ...(s.end !== undefined ? { end: Date.parse(s.end) } : {}),
      ...(s.round !== undefined ? { round: s.round } : {}),
      step: s.category,
    })
  }
  return {
    slug: row.slug,
    ticket: row.ticketId ?? '',
    title: row.title ?? row.slug,
    outcome:
      row.outcome === 'merged'
        ? 'merged'
        : row.outcome !== undefined
          ? 'closed'
          : timelineLive(row)
            ? 'running'
            : 'aborted',
    segments,
  }
}

/** The row has a segment still growing. */
export function timelineLive(row: WebTimelineRow): boolean {
  return row.segments.some((s) => s.state === 'open')
}

/** Served step statistics as the step table draws them; steps without a
 * chart category are left out. */
export function durationStats(stats: readonly StepDurationStat[]): StepStats[] {
  const out: StepStats[] = []
  for (const s of stats) {
    const category = stepCategory(s.step)
    if (category === undefined) continue
    out.push({
      step: s.step,
      category,
      count: s.count,
      mean: s.meanMs,
      p50: s.p50Ms,
      p90: s.p90Ms,
      p99: s.p99Ms,
      total: s.totalMs,
    })
  }
  return out
}

export type AnalyticsFilters = Omit<WebAnalyticsQuery, 'page'>

export const DEFAULT_FILTERS: AnalyticsFilters = { window: '7d', outcome: 'merged', kind: 'leaf' }

const WINDOWS = ['24h', '7d', '30d', 'all'] as const
const OUTCOMES = ['merged', 'all'] as const
const KINDS = ['leaf', 'node', 'all'] as const

const pick = <T extends string>(options: readonly T[], value: string | null, fallback: T): T =>
  value !== null && (options as readonly string[]).includes(value) ? (value as T) : fallback

/** The filters a page URL's search string names; anything unknown takes its
 * default. */
export function queryFromSearch(search: string): AnalyticsFilters {
  const params = new URLSearchParams(search)
  return {
    window: pick(WINDOWS, params.get('window'), DEFAULT_FILTERS.window),
    outcome: pick(OUTCOMES, params.get('outcome'), DEFAULT_FILTERS.outcome),
    kind: pick(KINDS, params.get('kind'), DEFAULT_FILTERS.kind),
  }
}

/** The search string for `filters`, keeping unrelated parameters (such as
 * `cls`) and omitting defaults. */
export function searchFromQuery(filters: AnalyticsFilters, search = ''): string {
  const params = new URLSearchParams(search)
  for (const name of ['window', 'outcome', 'kind'] as const) {
    if (filters[name] === DEFAULT_FILTERS[name]) params.delete(name)
    else params.set(name, filters[name])
  }
  const text = params.toString()
  return text === '' ? '' : `?${text}`
}

/** The JSON route's URL for one page of `filters`. Literal of
 * `WEB_API.analytics` in packages/core/src/web/protocol.ts. */
export function analyticsUrl(filters: AnalyticsFilters, page?: string): string {
  const params = new URLSearchParams({ ...filters, ...(page !== undefined ? { page } : {}) })
  return `/api/analytics?${params.toString()}`
}

/** The timeline route for one build. Literal of `WEB_API.timeline`. */
export function timelineUrl(slug: string): string {
  return `/api/builds/${encodeURIComponent(slug)}/timeline`
}

/**
 * The Gantt's paging: `stack` holds the cursors of the pages before the
 * current one (page 1's is undefined), so Newer returns exactly to them.
 */
export interface PageCursor {
  stack: (string | undefined)[]
  page: string | undefined
}

export const FIRST_PAGE: PageCursor = { stack: [], page: undefined }

export function olderPage(cursor: PageCursor, next: string): PageCursor {
  return { stack: [...cursor.stack, cursor.page], page: next }
}

export function newerPage(cursor: PageCursor): PageCursor {
  if (cursor.stack.length === 0) return cursor
  return { stack: cursor.stack.slice(0, -1), page: cursor.stack.at(-1) }
}

/** A key per query, so a chart block remounts under a transition when its
 * question changes, and never for an axis or measure change. */
export function queryKey(filters: AnalyticsFilters, page: string | undefined): string {
  return `${filters.window}:${filters.outcome}:${filters.kind}:${page ?? ''}`
}
