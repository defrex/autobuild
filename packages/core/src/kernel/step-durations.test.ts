import { describe, expect, test } from 'bun:test'
import type { BuildTimeline, TimelineSegment } from '../cli/dashboard/timeline'
import { REDUCERS, ROLLUPS } from './reducer-registry'
import {
  STEP_DURATIONS_RETENTION_DAYS,
  retentionCutoff,
  stepDurationsRollup as rollup,
  stepOrder,
  type DayHistograms,
  type StepDurationsAcc,
} from './step-durations'

const DAY = 86_400_000
const NOW = new Date('2026-11-23T12:00:00.000Z')
const leafMerged = rollup.args.parse({})

let seq = 0
function segment(
  category: string,
  end: string,
  durationMs: number,
  extra: Partial<TimelineSegment> = {},
): TimelineSegment {
  seq += 2
  return {
    category,
    start: new Date(Date.parse(end) - durationMs).toISOString(),
    end,
    durationMs,
    opened: { type: 'x.started', seq: seq - 1 },
    closed: { type: 'x.completed', seq },
    state: 'closed',
    ...extra,
  }
}

function timeline(segments: TimelineSegment[], extra: Partial<BuildTimeline> = {}): BuildTimeline {
  return { kind: 'work', outcome: 'merged', segments, ...extra }
}

function folded(...contributions: (DayHistograms | null)[]): StepDurationsAcc {
  const acc = rollup.initial()
  for (const c of contributions) if (c) rollup.add(acc, c)
  return acc
}

describe('stepDurations', () => {
  test('is registered over a registered build-scope reducer', () => {
    expect(ROLLUPS.stepDurations).toBe(rollup)
    const entry = REDUCERS[rollup.buildReducer]!.valueRead
    expect('scope' in entry && entry.scope).toBe('build')
    // The rollup's version carries its build reducer's.
    expect(rollup.version).toBeGreaterThan(REDUCERS.buildTimeline!.reducer.version)
  })

  test('outcome and kind filters', () => {
    const segs = [segment('plan', '2026-11-20T10:00:00.000Z', 60_000)]
    const all = rollup.args.parse({ outcome: 'all', kind: 'all' })
    const unmerged = timeline(segs, { outcome: 'closed-unmerged' })
    const live = timeline(segs, { outcome: undefined })
    const node = timeline(segs, { kind: 'node' })
    expect(rollup.contribute(unmerged, leafMerged, NOW)).toBeNull()
    expect(rollup.contribute(live, leafMerged, NOW)).toBeNull()
    expect(rollup.contribute(node, leafMerged, NOW)).toBeNull()
    expect(rollup.contribute(unmerged, all, NOW)).not.toBeNull()
    expect(rollup.contribute(node, rollup.args.parse({ kind: 'node' }), NOW)).not.toBeNull()
    expect(rollup.contribute(timeline(segs), rollup.args.parse({ kind: 'node' }), NOW)).toBeNull()
  })

  test('open and abandoned segments contribute nothing', () => {
    const value = timeline([
      segment('plan', '2026-11-20T10:00:00.000Z', 60_000, { state: 'abandoned' }),
      { ...segment('implement', '2026-11-20T10:00:00.000Z', 0), state: 'open', end: undefined },
    ])
    expect(rollup.contribute(value, leafMerged, NOW)).toBeNull()
  })

  test('assigns each segment to the UTC day it ended', () => {
    const c = rollup.contribute(
      timeline([
        segment('plan', '2026-11-20T23:59:59.999Z', 120_000),
        segment('plan', '2026-11-21T00:00:00.000Z', 120_000),
      ]),
      leafMerged,
      NOW,
    )!
    expect(Object.keys(c).sort()).toEqual(['2026-11-20', '2026-11-21'])
  })

  test('merged segments keep count and total', () => {
    const c = rollup.contribute(
      timeline([segment('implement', '2026-11-22T00:00:00.000Z', 600_000, { merged: 5 })]),
      leafMerged,
      NOW,
    )!
    const value = rollup.finish(folded(c), { window: '7d' }, NOW, '9')
    expect(value.steps).toEqual([
      expect.objectContaining({ step: 'implement', count: 5, totalMs: 600_000, meanMs: 120_000 }),
    ])
  })

  test('subtract inverts add', () => {
    const a = rollup.contribute(
      timeline([
        segment('plan', '2026-11-20T10:00:00.000Z', 61_000),
        segment('verify:unit', '2026-11-21T10:00:00.000Z', 5_000),
      ]),
      leafMerged,
      NOW,
    )!
    const b = rollup.contribute(
      timeline([
        segment('plan', '2026-11-20T11:00:00.000Z', 62_000),
        segment('queued', '2026-11-22T10:00:00.000Z', 3_000_000),
      ]),
      leafMerged,
      NOW,
    )!
    const acc = folded(a)
    const before = structuredClone(acc)
    rollup.add(acc, b)
    rollup.subtract(acc, b)
    expect(acc).toEqual(before)
    rollup.subtract(acc, a)
    expect(acc).toEqual(rollup.initial())
  })

  test('retention drops days at contribution and in prune; a reopen subtracts nothing for them', () => {
    const cutoff = retentionCutoff(NOW)
    expect(cutoff).toBe(
      new Date(NOW.getTime() - STEP_DURATIONS_RETENTION_DAYS * DAY).toISOString().slice(0, 10),
    )
    const oldEnd = new Date(NOW.getTime() - (STEP_DURATIONS_RETENTION_DAYS + 2) * DAY).toISOString()
    const value = timeline([
      segment('plan', oldEnd, 60_000),
      segment('plan', '2026-11-20T10:00:00.000Z', 60_000),
    ])
    expect(Object.keys(rollup.contribute(value, leafMerged, NOW)!)).toEqual(['2026-11-20'])

    // Absorbed earlier, when the old day was still retained.
    const earlier = new Date(NOW.getTime() - 10 * DAY)
    const absorbed = rollup.contribute(value, leafMerged, earlier)!
    expect(Object.keys(absorbed)).toHaveLength(2)
    const acc = folded(absorbed)
    expect(rollup.expired(acc, earlier)).toBe(false)
    expect(rollup.expired(acc, NOW)).toBe(true)
    // `finish` never reports the expired day, pruned or not.
    expect(rollup.finish(acc, { window: 'all' }, NOW, '1').steps[0]!.count).toBe(1)
    expect(rollup.prune(acc, NOW)).toBe(true)
    expect(rollup.prune(acc, NOW)).toBe(false)
    expect(Object.keys(acc.days)).toEqual(['2026-11-20'])
    // The reopen subtracts the old contribution; the dropped day is skipped.
    rollup.subtract(acc, absorbed)
    expect(acc).toEqual(rollup.initial())
  })

  test('each window selects the UTC days it overlaps', () => {
    const at = (daysAgo: number) =>
      segment('plan', new Date(NOW.getTime() - daysAgo * DAY).toISOString(), 10_000)
    const acc = folded(
      rollup.contribute(timeline([at(0), at(1), at(5), at(20), at(100)]), leafMerged, NOW),
    )
    const count = (window: '24h' | '7d' | '30d' | 'all') =>
      rollup.finish(acc, { window }, NOW, '1').steps[0]?.count ?? 0
    expect(count('24h')).toBe(2)
    expect(count('7d')).toBe(3)
    expect(count('30d')).toBe(4)
    expect(count('all')).toBe(5)
    expect(rollup.read.parse({})).toEqual({ window: '7d' })
  })

  test('steps run in pipeline order and zero-count steps are omitted', () => {
    expect(
      stepOrder([
        'awaiting-merge',
        'queued',
        'verify:unit',
        'finalize',
        'plan',
        'verify:lint',
        'reconcile',
        'code-review',
        'mystery',
      ]),
    ).toEqual([
      'plan',
      'code-review',
      'verify:lint',
      'verify:unit',
      'finalize',
      'reconcile',
      'queued',
      'awaiting-merge',
      'mystery',
    ])
    const c = rollup.contribute(
      timeline([segment('plan', '2026-11-20T10:00:00.000Z', 60_000)]),
      leafMerged,
      NOW,
    )!
    const acc = folded(c)
    acc.days['2026-11-20']!.implement = {}
    const value = rollup.finish(acc, { window: '7d' }, NOW, '3')
    expect(value).toEqual({
      position: '3',
      window: '7d',
      steps: [expect.objectContaining({ step: 'plan', count: 1, totalMs: 60_000 })],
    })
    expect(rollup.valueSchema.safeParse(value).success).toBe(true)
  })

  test('key arguments parse with defaults', () => {
    expect(rollup.args.parse({})).toEqual({ outcome: 'merged', kind: 'leaf' })
    expect(() => rollup.args.parse({ window: '7d' })).toThrow()
  })
})
