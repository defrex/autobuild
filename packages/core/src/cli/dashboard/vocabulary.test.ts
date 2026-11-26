import { describe, expect, test } from 'bun:test'
import type { SlotState } from '../../kernel/dispatch-capacity'
import type { EffectiveStatus, PipelineStep } from './model'
import {
  BUILD_STATUS_TONE,
  HARVEST_STATUS_TONE,
  buildStatusText,
  dispatcherModeWord,
  finishedOutcomeText,
  formatDuration,
  harvestStatusText,
  type StatusBasis,
  stepLine,
  stepMark,
  stepNote,
  stepTone,
  viewerLabel,
} from './vocabulary'

describe('status words', () => {
  test('the tone table is SPEC §14 word for word', () => {
    expect(BUILD_STATUS_TONE).toEqual({
      RUNNING: 'ok',
      STARTING: 'ok',
      PAUSING: 'ok',
      ABORTING: 'ok',
      QUEUED: 'live',
      WAITING: 'held',
      MERGING: 'held',
      PAUSED: 'held',
      COLLECTING: 'held',
      BLOCKED: 'alert',
      CLEANING: 'pending',
    })
    expect(HARVEST_STATUS_TONE).toEqual({
      HARVESTING: 'live',
      PAUSED: 'held',
      SUSPENDED: 'held',
      ESCALATED: 'alert',
      FAILED: 'alert',
    })
  })

  const held: SlotState = { state: 'held' }
  const none: SlotState = { state: 'none' }
  const text = (
    status: EffectiveStatus,
    slot: SlotState | undefined,
    basis?: Partial<StatusBasis>,
  ) => {
    const t = buildStatusText({
      status,
      ...(slot !== undefined ? { slot } : {}),
      ...(basis !== undefined ? { basis: { resting: 'running', runner: false, ...basis } } : {}),
    })
    return [t.word, t.tone, t.note]
  }

  test('a held slot is green, its word from the runner and pending commands', () => {
    expect(text('queued', held, { resting: 'queued' })).toEqual(['STARTING', 'ok', undefined])
    expect(text('running', held, { runner: true })).toEqual(['RUNNING', 'ok', undefined])
    expect(text('pausing', held, { runner: true, pause: true })).toEqual([
      'PAUSING',
      'ok',
      undefined,
    ])
    expect(text('aborting', held, { abort: true, pause: true })).toEqual([
      'ABORTING',
      'ok',
      undefined,
    ])
    // A node running verification holds its slot and reads RUNNING.
    expect(text('collecting', held, { resting: 'collecting', node: true, runner: true })).toEqual([
      'RUNNING',
      'ok',
      undefined,
    ])
  })

  test('a requested slot is teal QUEUED naming the request', () => {
    expect(
      text(
        'resuming',
        { state: 'requested', request: 'resume' },
        { resting: 'paused', resume: true },
      ),
    ).toEqual(['QUEUED', 'live', 'resume'])
    expect(
      text('running', { state: 'requested', request: 'reconcile', priority: 'urgent' }, {}),
    ).toEqual(['QUEUED', 'live', 'urgent reconcile'])
  })

  test('no slot: the word says why, and a pending pause or abort waits for its acknowledgement', () => {
    expect(text('running', none, { settled: 'decision' })).toEqual([
      'WAITING',
      'held',
      'merge decision',
    ])
    expect(text('running', none, { settled: 'hold' })).toEqual(['WAITING', 'held', 'on hold'])
    expect(text('running', none, { settled: 'merging' })).toEqual(['MERGING', 'held', undefined])
    expect(text('running', none, { reviseSpec: true })).toEqual([
      'WAITING',
      'held',
      'spec revision',
    ])
    expect(
      text('waiting', none, { resting: 'waiting', waitTickets: ['#1', '#2'], abort: true }),
    ).toEqual(['WAITING', 'held', 'on #1, #2'])
    expect(text('collecting', none, { resting: 'collecting', node: true })).toEqual([
      'COLLECTING',
      'held',
      undefined,
    ])
    expect(text('paused', none, { resting: 'paused' })).toEqual(['PAUSED', 'held', undefined])
    expect(text('blocked', none, { resting: 'blocked', pause: true })).toEqual([
      'BLOCKED',
      'alert',
      undefined,
    ])
    expect(text('aborting', none, { resting: 'blocked', abort: true })).toEqual([
      'BLOCKED',
      'alert',
      undefined,
    ])
    expect(text('cleaning', none, { resting: 'cleaning' })).toEqual([
      'CLEANING',
      'pending',
      undefined,
    ])
    expect(text('running', none, {})).toEqual(['WAITING', 'held', undefined])
  })

  test('an unknown slot is inferred, and a basis-less row implies one from its status', () => {
    expect(text('running', undefined, { runner: true })).toEqual(['RUNNING', 'ok', undefined])
    expect(text('running', undefined, { settled: 'decision' })[0]).toBe('WAITING')
    expect(text('queued', undefined)[0]).toBe('STARTING')
    expect(text('pausing', undefined)[0]).toBe('PAUSING')
    expect(text('aborting', undefined)[0]).toBe('ABORTING')
    expect(text('resuming', undefined)).toEqual(['QUEUED', 'live', 'resume'])
    expect(text('collecting', undefined)[0]).toBe('COLLECTING')
    expect(text('waiting', undefined)[0]).toBe('WAITING')
  })

  test('with a known slot, a word is green exactly when the slot is held', () => {
    const slots: SlotState[] = [held, none, { state: 'requested', request: 'verification' }]
    const statuses: EffectiveStatus[] = [
      'queued',
      'running',
      'collecting',
      'pausing',
      'paused',
      'resuming',
      'blocked',
      'waiting',
      'aborting',
    ]
    for (const slot of slots)
      for (const status of statuses)
        for (const settled of [undefined, 'decision', 'merging'] as const)
          for (const runner of [false, true]) {
            const t = buildStatusText({
              status,
              slot,
              basis: { resting: 'running', runner, ...(settled ? { settled } : {}) },
            })
            expect(t.tone === 'ok').toBe(slot.state === 'held')
            expect(BUILD_STATUS_TONE[t.word as keyof typeof BUILD_STATUS_TONE]).toBe(t.tone)
          }
  })

  test('harvest words are never green', () => {
    const statuses = ['running', 'paused', 'suspended', 'escalated', 'failed'] as const
    expect(statuses.map((s) => [harvestStatusText(s).word, harvestStatusText(s).tone])).toEqual([
      ['HARVESTING', 'live'],
      ['PAUSED', 'held'],
      ['SUSPENDED', 'held'],
      ['ESCALATED', 'alert'],
      ['FAILED', 'alert'],
    ])
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
