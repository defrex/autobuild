import { describe, expect, test } from 'bun:test'
import type { PipelineStep } from './model'
import {
  dispatcherModeWord,
  finishedOutcomeText,
  formatDuration,
  statusText,
  stepLine,
  stepMark,
  stepNote,
  stepTone,
  viewerLabel,
} from './vocabulary'

describe('statusText', () => {
  test('every status is its uppercase word with a fixed tone', () => {
    const tones = {
      queued: 'live',
      running: 'ok',
      collecting: 'live',
      pausing: 'held',
      paused: 'held',
      suspended: 'held',
      resuming: 'live',
      blocked: 'alert',
      waiting: 'held',
      aborting: 'alert',
      cleaning: 'held',
      escalated: 'held',
      failed: 'alert',
    } as const
    for (const [status, tone] of Object.entries(tones)) {
      expect(statusText(status as keyof typeof tones)).toEqual({
        status: status as keyof typeof tones,
        word: status.toUpperCase(),
        tone,
      })
    }
  })
})

test('step marks and tones cover every state', () => {
  expect(
    (['done', 'current', 'provisional', 'pending'] as const).map((s) => [stepMark(s), stepTone(s)]),
  ).toEqual([
    ['[x]', 'ok'],
    ['[>]', 'live'],
    ['[~]', 'held'],
    ['[ ]', 'pending'],
  ])
})

test('formatDuration floors and pads across unit boundaries', () => {
  expect([59_999, 60_000, 3_599_000, 3_600_000, 3_847_000].map(formatDuration)).toEqual([
    '59s',
    '1m00s',
    '59m59s',
    '1h00m00s',
    '1h04m07s',
  ])
})

describe('step text', () => {
  const step = (extra: Partial<PipelineStep>): PipelineStep => ({
    label: 'plan',
    state: 'current',
    ...extra,
  })
  const closed = { accumulatedMs: 252_000 }

  test('row form', () => {
    expect(stepNote(step({}), 0, 'row')).toBe('')
    expect(stepNote(step({ qualifier: 'waiting' }), 0, 'row')).toBe('(waiting)')
    expect(stepNote(step({ timing: closed }), 0, 'row')).toBe('(4m12s)')
    const running = step({ timing: { accumulatedMs: 1_000, runningSince: 10_000 } })
    expect(stepNote(running, 10_000, 'row')).toBe('(1s)')
    expect(stepNote(running, 70_000, 'row')).toBe('(1m01s)')
    expect(stepNote(step({ timing: closed, count: 1 }), 0, 'row')).toBe('(4m12s)')
    expect(stepNote(step({ timing: closed, count: 2, qualifier: 'failed' }), 0, 'row')).toBe(
      '(failed, 4m12s/2)',
    )
    expect(stepNote(step({ count: 2 }), 0, 'row')).toBe('')
    expect(stepLine(step({ timing: closed, reason: 'policy' }), 0, 'row')).toBe(
      '[>] plan(4m12s) — policy',
    )
  })

  test('detail form', () => {
    expect(stepNote(step({ count: 1 }), 0, 'detail')).toBe(' (round 1)')
    expect(
      stepLine(
        step({ label: 'verify:unit', qualifier: 'failed', count: 2, timing: closed }),
        0,
        'detail',
      ),
    ).toBe('[>] verify:unit (failed, attempt 2, 4m12s)')
    expect(stepNote(step({ label: 'reconcile', count: 3 }), 0, 'detail')).toBe(' (attempt 3)')
    expect(stepNote(step({}), 0, 'detail')).toBe('')
  })
})

test('finished outcome words', () => {
  expect((['merged', 'closed', 'aborted'] as const).map(finishedOutcomeText)).toEqual([
    { outcome: 'merged', word: 'MERGED', tone: 'ok' },
    { outcome: 'closed', word: 'CLOSED', tone: 'pending' },
    { outcome: 'aborted', word: 'ABORTED', tone: 'alert' },
  ])
})

test('dispatcher mode words and the viewer label', () => {
  expect((['running', 'viewer', 'stopped', 'handoff'] as const).map(dispatcherModeWord)).toEqual([
    { word: 'running', tone: 'ok' },
    { word: 'viewer', tone: 'live' },
    { word: 'stopped', tone: 'alert' },
    { word: 'handoff', tone: 'held' },
  ])
  expect(viewerLabel({})).toBe('viewer')
  expect(viewerLabel({ dispatchedBy: 'host-a' })).toBe('viewer · dispatched by host-a')
})
