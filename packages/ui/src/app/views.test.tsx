import { describe, expect, test } from 'bun:test'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Masked } from '../components/motion'
import { BuildPage } from './build-page'
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
