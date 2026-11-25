/**
 * The web UI's analytics reads (RFC 0007 §7, §9.3): the Gantt of builds and
 * the step-duration chart for one query, and one build's timeline. Both are
 * explicit reads a person asks for; nothing here runs on a timer.
 *
 * Reads, per request (SPEC §14):
 *
 * - Sync step, every request: `getRepoChangePosition`. Only when it moved,
 *   one `listBuildsChangedSince` from the saved watermark; the builds it names
 *   leave the timeline cache, and the response cache is cleared.
 * - Analytics, response cache hit (same query, same UTC day, nothing changed):
 *   the sync step only; zero event rows.
 * - Analytics, miss: one `stepDurations` rollup value and one filtered
 *   `listBuildsPage` (at most 26 index entries), plus one saved
 *   `buildTimeline` value per listed build not already cached (at most 25,
 *   eight at a time). Zero event rows beyond the saved values' own deltas.
 * - Timeline, cache hit: the sync step only. Miss: `getBuild` and one saved
 *   `buildTimeline` value.
 *
 * Settled builds are read once and then served from memory (LRU-capped), so
 * a live refresh re-reads only the builds the feed names. It never lists
 * builds except one page and never reads events. A remote store too old to
 * filter the listing, or on another reducer version, fails the request with
 * its typed error; there is no fallback.
 */
import { z } from 'zod'
import type { BuildTimeline } from '../cli/dashboard/timeline'
import {
  STEP_DURATION_WINDOWS,
  retentionCutoff,
  utcDay,
  type StepDurationWindow,
  type StepDurationsValue,
} from '../kernel/step-durations'
import type { TicketRef } from '../ontology'
import type { BuildRecord, BuildStore } from '../store/types'
import { mapBounded } from './bounded'
import type { WebAnalytics, WebAnalyticsQuery, WebTimelineRow } from './protocol'

/** The only store reads analytics may make. Listing builds beyond one page
 * and reading events are deliberately absent, so a history scan cannot
 * type-check. */
export type AnalyticsReader = Pick<
  BuildStore,
  | 'getRepoChangePosition'
  | 'listBuildsChangedSince'
  | 'listBuildsPage'
  | 'getReducerValue'
  | 'getBuild'
>

export const GANTT_PAGE_SIZE = 25
export const TIMELINE_CACHE_LIMIT = 1000
export const RESPONSE_CACHE_LIMIT = 32

const DAY_MS = 86_400_000
const WINDOW_MS: Record<Exclude<StepDurationWindow, 'all'>, number> = {
  '24h': DAY_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
}

const querySchema = z.object({
  window: z.enum(STEP_DURATION_WINDOWS).default('7d'),
  outcome: z.enum(['merged', 'all']).default('merged'),
  kind: z.enum(['leaf', 'node', 'all']).default('leaf'),
  page: z.string().min(1).max(1024).optional(),
})

/** A query parameter the analytics route refuses. */
export class AnalyticsQueryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AnalyticsQueryError'
  }
}

/** The normalised query for `params`: defaults filled, empty values absent,
 * unknown names ignored, unknown values refused. */
export function parseAnalyticsQuery(params: URLSearchParams): WebAnalyticsQuery {
  const raw: Record<string, string> = {}
  for (const name of ['window', 'outcome', 'kind', 'page'] as const) {
    const value = params.get(name)
    if (value !== null && value !== '') raw[name] = value
  }
  const parsed = querySchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new AnalyticsQueryError(
      `invalid analytics ${issue?.path.join('.') || 'query'}: ${issue?.message ?? 'unparseable'}`,
    )
  }
  const { page, ...rest } = parsed.data
  return { ...rest, ...(page !== undefined ? { page } : {}) }
}

/**
 * The window's first instant, the same day the rollup's read starts from:
 * UTC midnight of the first day the window overlaps, never before the
 * retention cutoff, and the retention cutoff itself for `all`.
 */
export function analyticsWindowStart(window: StepDurationWindow, now: Date): string {
  const retained = retentionCutoff(now)
  const since = window === 'all' ? retained : utcDay(now.getTime() - WINDOW_MS[window])
  return `${since > retained ? since : retained}T00:00:00.000Z`
}

/** One Gantt row from a build's ticket and its saved timeline. */
export function timelineRow(
  slug: string,
  ticket: TicketRef | undefined,
  timeline: BuildTimeline,
): WebTimelineRow {
  return {
    slug,
    ...(ticket !== undefined ? { ticketId: ticket.id } : {}),
    ...(ticket?.url !== undefined ? { ticketUrl: ticket.url } : {}),
    ...(ticket?.title !== undefined ? { title: ticket.title } : {}),
    kind: timeline.kind,
    ...(timeline.outcome !== undefined ? { outcome: timeline.outcome } : {}),
    ...(timeline.createdAt !== undefined ? { createdAt: timeline.createdAt } : {}),
    segments: timeline.segments,
  }
}

interface CachedTimeline {
  timeline: BuildTimeline
  ticket?: TicketRef
}

/** A Map that forgets its least recently used entry past `limit`. */
class Lru<K, V> {
  private readonly entries = new Map<K, V>()
  constructor(private readonly limit: number) {}
  get size(): number {
    return this.entries.size
  }
  get(key: K): V | undefined {
    const value = this.entries.get(key)
    if (value === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }
  set(key: K, value: V): void {
    this.entries.delete(key)
    this.entries.set(key, value)
    if (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!)
  }
  delete(key: K): void {
    this.entries.delete(key)
  }
  clear(): void {
    this.entries.clear()
  }
}

export interface WebAnalyticsSourceOptions {
  /** Read time, epoch ms; defaults to the wall clock. */
  clock?: () => number
}

/**
 * One per server process. Requests are serialized, so a timeline read that
 * began before an eviction can never cache its value after it.
 */
export class WebAnalyticsSource {
  /** The change position the caches reflect. */
  private gate: string | undefined
  /** The changed-builds feed watermark. */
  private watermark: string | undefined
  private readonly timelines = new Lru<string, CachedTimeline>(TIMELINE_CACHE_LIMIT)
  private readonly responses = new Lru<string, WebAnalytics>(RESPONSE_CACHE_LIMIT)
  /** The UTC day every cached response was computed on. */
  private responseDay: string | undefined
  private tail: Promise<unknown> = Promise.resolve()
  private readonly clock: () => number

  constructor(
    private readonly reader: AnalyticsReader,
    private readonly repo: string,
    opts: WebAnalyticsSourceOptions = {},
  ) {
    this.clock = opts.clock ?? Date.now
  }

  /** Both charts for `query`. */
  analytics(query: WebAnalyticsQuery): Promise<WebAnalytics> {
    return this.serialize(async () => {
      const now = new Date(this.clock())
      const position = await this.sync()
      const windowStart = analyticsWindowStart(query.window, now)
      // A later UTC day moves the window and retention, so earlier days'
      // answers go at once rather than ageing out.
      const day = utcDay(now)
      if (day !== this.responseDay) {
        this.responses.clear()
        this.responseDay = day
      }
      const key = JSON.stringify([
        query.window,
        query.outcome,
        query.kind,
        query.page ?? null,
        windowStart,
      ])
      const cached = this.responses.get(key)
      if (cached !== undefined) return cached
      const [durations, page] = await Promise.all([
        this.reader.getReducerValue(
          { kind: 'rollup', repo: this.repo },
          {
            reducer: 'stepDurations',
            args: { outcome: query.outcome, kind: query.kind },
            read: { window: query.window },
          },
        ),
        this.reader.listBuildsPage(this.repo, {
          limit: GANTT_PAGE_SIZE,
          activeSince: windowStart,
          ...(query.page !== undefined ? { cursor: query.page } : {}),
          ...(query.outcome === 'merged' ? { outcome: 'merged' as const } : {}),
          ...(query.kind === 'all' ? {} : { kind: query.kind }),
        }),
      ])
      const rows = await mapBounded(page.builds, (record) => this.listedRow(record))
      const answer: WebAnalytics = {
        query,
        position,
        windowStart,
        durations: (durations.value as unknown as StepDurationsValue).steps,
        gantt: { rows, next: page.next },
      }
      this.responses.set(key, answer)
      return answer
    })
  }

  /** One build's timeline row; null for an unknown build. */
  timeline(slug: string): Promise<WebTimelineRow | null> {
    return this.serialize(async () => {
      await this.sync()
      const cached = this.timelines.get(slug)
      if (cached !== undefined) return timelineRow(slug, cached.ticket, cached.timeline)
      const record = await this.reader.getBuild(slug)
      if (record === null) return null
      const timeline = await this.readTimeline(slug)
      this.timelines.set(slug, { timeline, ...(record.ticket ? { ticket: record.ticket } : {}) })
      return timelineRow(slug, record.ticket, timeline)
    })
  }

  private async listedRow(record: BuildRecord): Promise<WebTimelineRow> {
    let cached = this.timelines.get(record.slug)
    if (cached === undefined) {
      cached = {
        timeline: await this.readTimeline(record.slug),
        ...(record.ticket ? { ticket: record.ticket } : {}),
      }
      this.timelines.set(record.slug, cached)
    }
    return timelineRow(record.slug, record.ticket, cached.timeline)
  }

  private async readTimeline(slug: string): Promise<BuildTimeline> {
    const { value } = await this.reader.getReducerValue(
      { kind: 'build', slug },
      { reducer: 'buildTimeline' },
    )
    return value as unknown as BuildTimeline
  }

  /** Bring the caches up to the repository's current change position. */
  private async sync(): Promise<string> {
    const position = await this.reader.getRepoChangePosition(this.repo)
    if (this.watermark === undefined || this.gate === undefined) {
      // Nothing is cached yet, so nothing needs evicting.
      this.watermark = position
      this.gate = position
      return position
    }
    if (position === this.gate) return position
    const changed = await this.reader.listBuildsChangedSince(this.repo, this.watermark)
    if (BigInt(changed.position) < BigInt(this.watermark)) {
      // A head below the watermark: the repository was reset.
      this.timelines.clear()
      this.responses.clear()
    } else if (changed.builds.length > 0) {
      for (const build of changed.builds) this.timelines.delete(build.slug)
      this.responses.clear()
    }
    // A repository event with no build change leaves every answer current.
    this.watermark = changed.position
    this.gate = BigInt(changed.position) > BigInt(position) ? changed.position : position
    return this.gate
  }

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(run)
    this.tail = result.catch(() => {})
    return result
  }
}
