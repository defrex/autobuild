import { describe, expect, test } from 'bun:test'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Masked } from '../components/motion'
import { type AnalyticsView, analyticsBlocks, GANTT_ROWS } from './analytics'
import { FIRST_PAGE, olderPage, timelineLive, type WebAnalytics } from './analytics-model'
import { BuildPage, buildPageBlocks, buildPageFetch, type TimelineState } from './build-page'
import { fallbackFrame } from './fallback'
import {
  attentionArrivedFrame,
  BLOCKED_SLUG,
  movedFrame,
  NOW,
  overviewFrame,
  RUNNING_SLUG,
  WAITING_SLUG,
} from './fixtures'
import { parseFrameHint } from './hint'
import { overviewBlocks, OverviewPage } from './overview'
import { MAX_ELAPSED_MS, noteSizer, stepModel } from './rows'
import { buildHref, route } from './routes'
import { navCurrent } from './shell'

const html = (element: ReactElement) => renderToStaticMarkup(element)
const overview = (frame = overviewFrame()) => html(<OverviewPage frame={frame} now={NOW} seq={1} />)
const buildPage = (slug: string, frame = overviewFrame()) =>
  html(<BuildPage frame={frame} slug={slug} now={NOW} seq={1} />)
const titles = (markup: string) =>
  [...markup.matchAll(/data-ansi="row-title"[^>]*><span>([^<]*)<\/span>/g)].map((m) => m[1])

describe('overview', () => {
  test('rows land in their sections in projection order, title first, each linked', () => {
    const frame = overviewFrame()
    const o = frame.overview!
    const markup = overview(frame)
    const order = titles(markup)
    expect(order).toEqual([
      'Harvest',
      ...o.active.map((row) => row.title ?? row.slug),
      ...o.queued.map((row) => row.title ?? row.slug),
      ...o.finished.map((row) => row.slug),
    ])
    expect(markup.indexOf('Needs attention')).toBeLessThan(markup.indexOf('>Active<'))
    expect(markup.indexOf('>Queued<')).toBeLessThan(markup.indexOf('>Recently finished<'))
    expect(markup).toContain(`href="${buildHref(RUNNING_SLUG)}"`)
    expect(markup).toContain(`<a data-ansi="ticket-id" href="${buildHref(BLOCKED_SLUG)}">#1051</a>`)
    expect(markup).toContain('(2/3, 4m12s/2)')
    expect(markup).toContain('data-kind="escalation"')
  })

  test('a row without a ticket title falls back to its slug; empty sections say so', () => {
    const frame = overviewFrame()
    const o = frame.overview!
    delete o.active[0]!.title
    o.attention = []
    o.active = [o.active[0]!]
    delete o.harvest
    o.queued = []
    o.finished = []
    const markup = overview(frame)
    expect(titles(markup)).toEqual([RUNNING_SLUG])
    for (const sentence of [
      'Nothing needs a person right now.',
      'No builds are queued.',
      'No build has finished yet.',
    ])
      expect(markup).toContain(sentence)
    o.active = []
    expect(overview(frame)).toContain('No builds are running.')
  })

  test('a moved row keeps its block key in its new position; keys are unique', () => {
    const keys = (frame = overviewFrame()) => overviewBlocks({ frame, now: NOW }).map((b) => b.key)
    const before = keys()
    const after = keys(movedFrame())
    expect(before).toContain(`row:${RUNNING_SLUG}`)
    expect(after).not.toContain(`row:${RUNNING_SLUG}`)
    expect(after.indexOf(`fin:${RUNNING_SLUG}`)).toBe(after.indexOf('h:finished') + 1)
    for (const list of [before, after, keys(attentionArrivedFrame())])
      expect(new Set(list).size).toBe(list.length)
  })
})

describe('build page', () => {
  test('a live build shows its header, ticket, phase and attention', () => {
    const markup = buildPage(RUNNING_SLUG)
    expect(markup).toContain('Resume suspended sessions')
    expect(markup).toContain('href="https://github.com/acme/app/issues/1084">#1084</a>')
    expect(markup).toContain('verify:unit')
    expect(markup).not.toContain(`href="${buildHref(RUNNING_SLUG)}"`)
    const blocked = buildPage(BLOCKED_SLUG)
    expect(blocked).toContain('data-kind="escalation"')
    expect(blocked).toContain(`ab answer ${BLOCKED_SLUG}`)
    expect(buildPage(WAITING_SLUG)).toContain('data-kind="wait"')
  })

  test('a finished build shows its outcome; an unknown one says it is not here', () => {
    expect(buildPage('github-cooldown-exhausted')).toContain('MERGED')
    const missing = 'This build is not active, queued or among the recently finished builds.'
    expect(buildPage('nope')).toContain(missing)
    expect(buildPage(RUNNING_SLUG, { notice: 'later' })).toContain(missing)
  })
})

test('masked pages are the same markup as the pages, wrapped', () => {
  const unwrap = (markup: string) => markup.slice(markup.indexOf('>') + 1, -'</div>'.length)
  const cases: ReactElement[] = [
    <OverviewPage key="o" frame={overviewFrame()} now={NOW} seq={1} />,
    <BuildPage key="b" frame={overviewFrame()} slug={BLOCKED_SLUG} now={NOW} seq={1} />,
    <OverviewPage key="f" frame={fallbackFrame({ page: 'overview' })} now={NOW} seq={1} />,
    <BuildPage
      key="fb"
      frame={fallbackFrame({ page: 'build', slug: 'x' })}
      slug="x"
      now={NOW}
      seq={1}
    />,
  ]
  for (const page of cases) expect(unwrap(html(<Masked>{page}</Masked>))).toBe(html(page))
  expect(buildPage('x', fallbackFrame({ page: 'build', slug: 'x' }))).toContain('Loading build')
})

test('every step note has a reserved slot wide enough for any elapsed time', () => {
  const steps = overviewFrame().overview!.active[0]!.steps
  const ticking = steps.find((step) => step.state === 'current')!
  const sizer = noteSizer(ticking)
  for (const seconds of [9, 10, 59, 60, 3599, 3600, MAX_ELAPSED_MS / 1000]) {
    const at = { ...ticking, timing: { accumulatedMs: seconds * 1000 } }
    expect(sizer.length).toBeGreaterThanOrEqual(stepModel(at, NOW).note!.length)
  }
  expect(noteSizer(steps.find((step) => step.state === 'pending')!)).toBe('(99h59m59s)')
  const markup = overview()
  expect(markup.split('data-ansi="note-slot"').length).toBe(
    markup.split('data-ansi="note-sizer"').length,
  )
})

test('both pages are read-only', () => {
  for (const markup of [overview(), buildPage(BLOCKED_SLUG), buildPage(WAITING_SLUG)])
    expect(markup).not.toMatch(/<(form|input|textarea|button)\b/)
})

test('routes and hints parse', () => {
  expect(route('/')).toEqual({ page: 'overview' })
  expect(route('/builds/a%2Fb')).toEqual({ page: 'build', slug: 'a/b' })
  expect(route('/builds/%E0%A4%A')).toEqual({ page: 'unknown' })
  expect(route('/builds/')).toEqual({ page: 'unknown' })
  expect(route('/elsewhere')).toEqual({ page: 'unknown' })
  expect(parseFrameHint('{"notice":"x"}')).toEqual({ notice: 'x' })
  expect(parseFrameHint('{')).toBeUndefined()
  expect(parseFrameHint('[1]')).toBeUndefined()
  expect(parseFrameHint('3')).toBeUndefined()
  expect(parseFrameHint(null)).toBeUndefined()
})

describe('analytics', () => {
  const closedSegment = (category: string, minutes: number) => ({
    category,
    start: new Date(NOW - (minutes + 5) * 60_000).toISOString(),
    end: new Date(NOW - 5 * 60_000).toISOString(),
    durationMs: minutes * 60_000,
    opened: { type: 'x', seq: 1 },
    state: 'closed' as const,
  })
  const answer = (rows = 2, next: string | null = 'c2'): WebAnalytics => ({
    query: { window: '7d', outcome: 'merged', kind: 'leaf' },
    position: '9',
    windowStart: '2026-11-17T00:00:00.000Z',
    durations: [
      {
        step: 'plan',
        count: 3,
        meanMs: 60_000,
        p50Ms: 50_000,
        p90Ms: 90_000,
        p99Ms: 99_000,
        totalMs: 180_000,
      },
      {
        step: 'verify:unit',
        count: 3,
        meanMs: 30_000,
        p50Ms: 20_000,
        p90Ms: 40_000,
        p99Ms: 50_000,
        totalMs: 90_000,
      },
    ],
    gantt: {
      rows: Array.from({ length: rows }, (_, i) => ({
        slug: `build-${i}`,
        ticketId: `#${100 + i}`,
        title: `Build ${i}`,
        kind: 'work' as const,
        outcome: 'merged',
        segments: [closedSegment('plan', 4), closedSegment('verify:unit', 2)],
      })),
      next,
    },
  })
  const on = { filters() {}, page() {}, axis() {}, mode() {}, expanded() {} }
  const view = (overrides: Partial<AnalyticsView> = {}): AnalyticsView => ({
    data: answer(),
    current: true,
    error: undefined,
    filters: { window: '7d', outcome: 'merged', kind: 'leaf' },
    cursor: FIRST_PAGE,
    axis: 'clock',
    mode: 'per-run',
    now: NOW,
    expanded: [],
    on,
    ...overrides,
  })
  const render = (v: AnalyticsView) =>
    html(
      <div>
        {analyticsBlocks(v).map((block) => (
          <div key={block.key}>{block.node}</div>
        ))}
      </div>,
    )
  const keys = (v: AnalyticsView) => analyticsBlocks(v).map((block) => block.key)

  test('skeletons hold a full page before the first answer; the charts replace them', () => {
    const loading = render(view({ data: undefined, current: false }))
    expect(loading).toContain('--gantt-reserve-rows:25')
    expect(loading.split('data-ansi="gantt-skeleton-row"').length - 1).toBe(GANTT_ROWS)
    expect(loading).toContain('data-skeleton=""')
    const loaded = render(view())
    expect(loaded).toContain('--gantt-reserve-rows:25')
    expect(loaded).toContain('Build 1')
    expect(loaded).toContain('data-ansi="step-durations"')
    expect(loaded).toContain('Time per run, last 7 days, merged leaf builds')
    for (const label of ['plan', 'verify', 'finalize', 'queued', 'ticket wait', 'awaiting merge'])
      expect(loaded).toContain(`</span>${label}</li>`)
  })

  test('chart keys change with the answered query and the axis, never with the measure', () => {
    const base = keys(view())
    expect(keys(view({ mode: 'total' }))).toEqual(base)
    const switched = keys(view({ axis: 'relative' }))
    expect(switched.filter((key) => !base.includes(key))).toEqual([
      expect.stringMatching(/^gantt:.*:relative$/),
    ])
    const wider = answer()
    wider.query = { ...wider.query, window: '30d' }
    expect(keys(view({ data: wider }))).not.toEqual(base)
    const cells = (markup: string) => markup.match(/<th scope="col"/g)?.length
    expect(cells(render(view({ mode: 'total' })))).toBe(cells(render(view())))
  })

  test('an empty page says so; paging actions hold their place when they cannot act', () => {
    const empty = render(view({ data: answer(0, null) }))
    expect(empty).toContain('No build matching these filters was active in this window.')
    expect(empty).toContain('<a data-ansi="word-action" aria-disabled="true">Newer</a>')
    expect(empty).toContain('<a data-ansi="word-action" aria-disabled="true">Older</a>')
    const second = render(view({ cursor: olderPage(FIRST_PAGE, 'c2') }))
    expect(second).toContain('href="#newer"')
    expect(second).toContain('href="#older"')
    expect(second).toContain('page 2')
    const failed = render(view({ data: undefined, current: false, error: 'Store read failed: x' }))
    expect(failed).toContain('Store read failed: x')
  })

  test('a refresh that fails after an answer shows its message, not the stale charts', () => {
    const stale = view({ error: 'incompatible reducer stepDurations' })
    const markup = render(stale)
    expect(markup.split('incompatible reducer stepDurations').length - 1).toBe(2)
    expect(markup).not.toContain('Build 1')
    expect(markup).not.toContain('data-ansi="step-durations"')
    expect(markup).toContain('<a data-ansi="word-action" aria-disabled="true">Older</a>')
    expect(keys(stale)).toContain('gantt:error')
  })
})

describe('build page timeline', () => {
  const open = {
    category: 'implement',
    start: new Date(NOW - 60_000).toISOString(),
    durationMs: 0,
    opened: { type: 'implement.started', seq: 3 },
    state: 'open' as const,
  }
  const row = { slug: 'older-build', kind: 'work' as const, segments: [open] }

  test('the timeline comes last, skeleton first, and shows for a build the frame omits', () => {
    const blocks = (timeline?: TimelineState) =>
      buildPageBlocks({
        frame: { position: '7' },
        slug: 'older-build',
        now: NOW,
        ...(timeline !== undefined ? { timeline } : {}),
      })
    const loading = blocks({ data: undefined, error: undefined })
    expect(loading.map((b) => b.key)).toEqual(['missing', 'h:timeline', 'timeline'])
    expect(html(<div>{loading.at(-1)!.node}</div>)).toContain('data-skeleton=""')
    const loaded = html(<div>{blocks({ data: { row }, error: undefined }).at(-1)!.node}</div>)
    expect(loaded).toContain('data-open=""')
    expect(loaded).toContain('data-expanded')
    expect(timelineLive(row)).toBe(true)
    // A later refresh failing replaces the chart with its message.
    const refreshFailed = html(
      <div>{blocks({ data: { row }, error: 'Store read failed: down' }).at(-1)!.node}</div>,
    )
    expect(refreshFailed).toContain('Store read failed: down')
    expect(refreshFailed).not.toContain('data-open=""')
    expect(buildPageFetch({ position: '7' }, 'a/b')).toEqual({
      url: '/api/builds/a%2Fb/timeline',
      key: '7',
    })
    expect(buildPage(RUNNING_SLUG).indexOf('Timeline')).toBeGreaterThan(
      buildPage(RUNNING_SLUG).indexOf('>Ticket<'),
    )
  })

  test('the analytics route has its own nav entry', () => {
    expect(route('/analytics')).toEqual({ page: 'analytics' })
    expect(navCurrent({ page: 'analytics' }, '/analytics')).toBe('/analytics')
    expect(navCurrent({ page: 'build', slug: 'x' }, '/builds/x')).toBe('/')
  })
})
