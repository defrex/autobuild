import { expect, test } from 'bun:test'
import { stepOrder } from '../../../core/src/kernel/step-durations'
import type { WebTimelineRow } from '../../../core/src/web/protocol'
import { orderSteps } from '../charts/step-durations'
import {
  durationStats,
  FIRST_PAGE,
  ganttTimeline,
  newerPage,
  olderPage,
  queryFromSearch,
  searchFromQuery,
  stepCategory,
} from './analytics-model'

const segment = (category: string, state: 'open' | 'closed' | 'abandoned', round?: number) => ({
  category,
  start: '2026-11-20T10:00:00.000Z',
  ...(state !== 'open' ? { end: '2026-11-20T10:05:00.000Z' } : {}),
  durationMs: state === 'open' ? 0 : 300_000,
  opened: { type: 'x', seq: 1 },
  state,
  ...(round !== undefined ? { round } : {}),
})

test('steps map to chart categories; unknown ones to none', () => {
  expect(stepCategory('verify:unit')).toBe('verify')
  expect(stepCategory('plan-review')).toBe('plan-review')
  expect(stepCategory('awaiting-merge')).toBe('awaiting-merge')
  expect(stepCategory('toString')).toBeUndefined()
  expect(stepCategory('later-phase')).toBeUndefined()
})

test('a served row becomes a Gantt timeline', () => {
  const row: WebTimelineRow = {
    slug: 'b',
    kind: 'work',
    segments: [
      segment('plan', 'closed', 1),
      segment('verify:unit', 'abandoned'),
      segment('mystery', 'closed'),
      segment('implement', 'open', 2),
    ],
  }
  const timeline = ganttTimeline(row)
  expect(timeline).toMatchObject({ slug: 'b', ticket: '', title: 'b', outcome: 'running' })
  expect(timeline.segments.map((s) => [s.step, s.round, s.end === undefined])).toEqual([
    ['plan', 1, false],
    ['verify:unit', undefined, false],
    ['implement', 2, true],
  ])
  const done = { ...row, segments: [segment('plan', 'closed')] }
  expect(ganttTimeline({ ...done, outcome: 'merged' }).outcome).toBe('merged')
  expect(ganttTimeline({ ...done, outcome: 'discarded', ticketId: '#9' })).toMatchObject({
    outcome: 'closed',
    ticket: '#9',
  })
  expect(ganttTimeline(done).outcome).toBe('aborted')
  expect(
    durationStats([
      { step: 'verify:unit', count: 2, meanMs: 5, p50Ms: 4, p90Ms: 6, p99Ms: 7, totalMs: 10 },
      { step: 'later-phase', count: 1, meanMs: 1, p50Ms: 1, p90Ms: 1, p99Ms: 1, totalMs: 1 },
    ]),
  ).toEqual([
    {
      step: 'verify:unit',
      category: 'verify',
      count: 2,
      mean: 5,
      p50: 4,
      p90: 6,
      p99: 7,
      total: 10,
    },
  ])
})

test('the URL keeps the filters, omitting defaults and keeping other parameters', () => {
  expect(queryFromSearch('')).toEqual({ window: '7d', outcome: 'merged', kind: 'leaf' })
  expect(queryFromSearch('?window=bogus&kind=node')).toEqual({
    window: '7d',
    outcome: 'merged',
    kind: 'node',
  })
  const search = searchFromQuery({ window: '30d', outcome: 'merged', kind: 'all' }, '?cls=1')
  expect(search).toBe('?cls=1&window=30d&kind=all')
  expect(queryFromSearch(search)).toEqual({ window: '30d', outcome: 'merged', kind: 'all' })
  expect(searchFromQuery(queryFromSearch(''))).toBe('')
})

test('Older then Newer returns to the first page', () => {
  const second = olderPage(FIRST_PAGE, 'c2')
  const third = olderPage(second, 'c3')
  expect(third.page).toBe('c3')
  expect(newerPage(newerPage(third))).toEqual(FIRST_PAGE)
  expect(newerPage(FIRST_PAGE)).toBe(FIRST_PAGE)
})

test('the step table orders steps exactly as the served rollup does', () => {
  const steps = [
    'awaiting-merge',
    'queued',
    'verify:unit',
    'zeta',
    'reconcile',
    'plan',
    'escalated',
    'finalize',
    'verify:build',
    'code-review',
    'ticket-wait',
    'implement',
    'paused',
    'plan-review',
  ]
  const stat = (step: string) => ({
    step,
    category: 'plan' as const,
    count: 1,
    mean: 0,
    p50: 0,
    p90: 0,
    p99: 0,
    total: 0,
  })
  expect(orderSteps(steps.map(stat)).map((s) => s.step)).toEqual(stepOrder(steps))
})
