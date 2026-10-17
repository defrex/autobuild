import { expect, test } from 'bun:test'
import { DISPATCHER } from '../events/envelope'
import type { RepositoryEvent } from '../events/repository'
import { emptyTickReport } from './dispatcher'
import { shouldPublishTick } from './tick-publication'

const at = '2026-10-17T12:00:00.000Z'
const report = emptyTickReport()
const {
  queued,
  janitorDiagnostics,
  blockedDiagnostics,
  ticketDiagnostics,
  creationDiagnostics,
  dependencyDiagnostics,
  ...counters
} = report
const baseline: RepositoryEvent = {
  repo: 'r',
  seq: 1,
  ts: at,
  actor: DISPATCHER,
  type: 'dispatcher.tick-completed',
  payload: {
    run: 'run',
    queued,
    counters,
    janitorDiagnostics,
    blockedDiagnostics,
    ticketDiagnostics,
    creationDiagnostics,
    dependencyDiagnostics,
  },
}
const decide = (value = report, events: RepositoryEvent[] = [baseline]) =>
  shouldPublishTick(value, events, at)

test('first sample, queue transitions and unchanged nonempty queues', () => {
  expect(decide(report, [])).toBe(true)
  expect(decide()).toBe(false)
  expect(decide({ ...report, queued: 2 })).toBe(true)
  expect(
    decide({ ...report, queued: 2 }, [
      { ...baseline, payload: { ...baseline.payload, queued: 2 } },
    ]),
  ).toBe(false)
})
for (const [key, value] of Object.entries(report)) {
  if (key === 'queued') continue
  test(`records ${key}`, () => {
    expect(decide({ ...report, [key]: typeof value === 'number' ? 1 : ['diagnostic'] })).toBe(true)
  })
}
test('records diagnostic clearing and recovery from failed ticks', () => {
  for (const key of [
    'janitorDiagnostics',
    'blockedDiagnostics',
    'ticketDiagnostics',
    'creationDiagnostics',
    'dependencyDiagnostics',
  ]) {
    expect(
      decide(report, [{ ...baseline, payload: { ...baseline.payload, [key]: ['old'] } }]),
    ).toBe(true)
  }
  expect(
    decide(report, [
      baseline,
      {
        ...baseline,
        seq: 2,
        type: 'dispatcher.tick-failed',
        payload: { run: 'run', error: 'failed' },
      },
    ]),
  ).toBe(true)
})
test('retains the first retry starting after reset, using actual buffered start times', () => {
  const degraded: RepositoryEvent = {
    ...baseline,
    seq: 2,
    type: 'dispatcher.ticket-source-degraded',
    payload: {
      source: 'file',
      operation: 'ready-scan',
      message: 'limited',
      cause: 'rate-limited',
      resetAt: at,
    },
  }
  const start: RepositoryEvent = {
    ...baseline,
    seq: 3,
    type: 'dispatcher.tick-started',
    payload: { run: 'run', startedAt: '2026-10-17T11:59:00.000Z' },
  }
  expect(decide(report, [baseline, degraded])).toBe(true)
  expect(decide(report, [baseline, degraded, start, { ...baseline, seq: 4 }])).toBe(true)
  expect(
    decide(report, [
      baseline,
      degraded,
      { ...start, payload: { run: 'run', startedAt: at } },
      { ...baseline, seq: 4 },
    ]),
  ).toBe(false)
})

test('retry publication retains the earliest degradation deadline across cause changes', () => {
  const generic: RepositoryEvent = {
    ...baseline,
    seq: 2,
    ts: '2026-10-17T11:45:00.000Z',
    type: 'dispatcher.ticket-source-degraded',
    payload: {
      source: 'file',
      operation: 'ready-scan',
      message: 'offline',
      cause: 'ready-scan-failed',
    },
  }
  const limited: RepositoryEvent = {
    ...baseline,
    seq: 3,
    type: 'dispatcher.ticket-source-degraded',
    payload: {
      source: 'file',
      operation: 'ready-scan',
      message: 'limited',
      cause: 'rate-limited',
      resetAt: '2026-10-17T12:05:00.000Z',
    },
  }
  expect(decide(report, [baseline, generic, limited])).toBe(true)
})
