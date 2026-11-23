import { describe, expect, test } from 'bun:test'
import { DISPATCHER } from '../events/envelope'
import type { AbEvent } from '../events/catalog'
import { reduceBuildDigest } from '../store/digest'
import { executionIntervalsReducer, type ExecutionIntervalsValue } from './execution-intervals'
import { commandObjective, OptimizationLogBuilder } from './generators/optimization-log'
import {
  ACTIVITY_FACTS_PER_EVENT,
  activeHours,
  chunkActivityBatch,
  clockView,
  ExecutionFactsMissingError,
  optimizationActivityBatch,
  optimizationElapsedHours,
  optimizationReducer,
  unionLength,
  unionSpans,
  type OptimizationClock,
  type OptimizationState,
} from './optimization'
import { reduceBuild } from './reducer'
import { REDUCERS } from './reducer-registry'

const START = Date.parse('2026-11-17T00:00:00Z')
const iso = (minutes: number) => new Date(START + minutes * 60_000).toISOString()
const at = (minutes: number) => new Date(START + minutes * 60_000)
const hours = (state: OptimizationState, minutes: number) =>
  optimizationElapsedHours(state, at(minutes))

function digest(builder: OptimizationLogBuilder): OptimizationState {
  const state = optimizationReducer.reduce(builder.events)
  if (state === null) throw new Error('no objective accepted')
  return state
}

/** An opened, measured node at minute 0 whose clock has not run. */
const measured = () => new OptimizationLogBuilder().accept(commandObjective(), 1).baseline(1, 50, 1)

/** A batch of `[build, n, kind, instance, minute]` facts written at `when`. */
function batch(
  builder: OptimizationLogBuilder,
  when: number,
  facts: [string, number, 'started' | 'ended', string, number][],
  extra: { released?: string[]; settles?: true; watermark?: string } = {},
) {
  const now = (builder.events.at(-1) ? Date.parse(builder.events.at(-1)!.ts) : START) - START
  builder.wait(when - now / 60_000)
  return builder.activity(
    facts.map(([build, n, kind, instance, minute]) => [build, n, kind, instance, when - minute]),
    extra,
  )
}

describe('span arithmetic', () => {
  test('unions merge overlap, nesting, adjacency and duplicates, and drop empty spans', () => {
    expect(
      unionSpans([
        [iso(30), iso(60)],
        [iso(0), iso(10)],
        [iso(10), iso(20)],
        [iso(40), iso(50)],
        [iso(55), iso(70)],
        [iso(0), iso(10)],
        [iso(80), iso(80)],
      ]),
    ).toEqual([
      [iso(0), iso(20)],
      [iso(30), iso(70)],
    ])
    expect(unionLength([])).toBe(0)
    expect(
      unionLength([
        [iso(0), iso(60)],
        [iso(30), iso(90)],
      ]),
    ).toBe(90 * 60_000)
  })

  test('active hours run open intervals to now and stop at the stop', () => {
    const view = {
      activeMs: 3_600_000,
      spans: [[iso(60), iso(90)]] as [string, string][],
      open: [iso(120)],
    }
    expect(activeHours(view, at(150))).toBe(2)
    expect(activeHours({ ...view, stoppedAt: iso(150) }, at(150))).toBe(2)
    expect(activeHours({ ...view, stoppedAt: iso(150) }, at(10_000))).toBe(2)
    expect(activeHours({ activeMs: 0, spans: [], open: [] }, at(10_000))).toBe(0)
  })
})

describe('the node clock fold', () => {
  test('a node run counts only while it serves the objective', () => {
    // Baseline due: the opening measurement run counts.
    const builder = new OptimizationLogBuilder().accept(commandObjective(), 1)
    builder.execution('started', 'n1').wait(30).baseline(1, 50, 1).execution('ended', 'n1')
    expect(hours(digest(builder), 30)).toBe(0.5)
    // Measured and no proposal: a reconcile run does not count.
    builder.wait(30).execution('started', 'n2').wait(60).execution('ended', 'n2')
    expect(hours(digest(builder), 120)).toBe(0.5)
    // An undeposited proposal: the proposer run counts.
    builder.request('r1', 2).execution('started', 'n3').wait(30).execution('ended', 'n3')
    expect(hours(digest(builder), 150)).toBe(1)
    // While running, it counts to now.
    builder.wait(10).execution('started', 'n4')
    expect(hours(digest(builder), 190)).toBe(1.5)
  })

  test('attempt runs count from batches, overlapping runs once', () => {
    const builder = measured().propose('r1', ['a', 'b'])
    batch(builder, 60, [
      ['attempt-a', 1, 'started', 'i', 0],
      ['attempt-b', 1, 'started', 'j', 30],
    ])
    batch(builder, 120, [
      ['attempt-a', 2, 'ended', 'i', 60],
      ['attempt-b', 2, 'ended', 'j', 90],
    ])
    expect(hours(digest(builder), 120)).toBe(1.5)
    expect(hours(digest(builder), 10_000)).toBe(1.5)
  })

  test('attempt and node intervals union, never sum', () => {
    const builder = new OptimizationLogBuilder().accept(commandObjective(), 1)
    builder.execution('started', 'n').wait(60).baseline(1, 50, 1).execution('ended', 'n')
    builder.propose('r1', ['a'])
    batch(builder, 90, [
      ['attempt-a', 1, 'started', 'i', 30],
      ['attempt-a', 2, 'ended', 'i', 90],
    ])
    expect(hours(digest(builder), 90)).toBe(1.5)
  })

  test('the same facts in any batching give the same hours', () => {
    const facts: [string, number, 'started' | 'ended', string, number][] = [
      ['attempt-a', 1, 'started', 'i', 0],
      ['attempt-b', 1, 'started', 'j', 10],
      ['attempt-a', 2, 'ended', 'i', 40],
      ['attempt-a', 3, 'started', 'k', 50],
      ['attempt-b', 2, 'ended', 'j', 55],
      ['attempt-a', 4, 'ended', 'k', 70],
    ]
    const whole = batch(measured().propose('r1', ['a', 'b']), 80, facts)
    const split = measured().propose('r1', ['a', 'b'])
    batch(split, 20, facts.slice(0, 2))
    batch(split, 52, facts.slice(2, 4))
    batch(split, 80, facts.slice(4))
    const single = measured().propose('r1', ['a', 'b'])
    for (const fact of facts) batch(single, fact[4], [fact])
    for (const builder of [whole, split, single]) expect(hours(digest(builder), 80)).toBe(70 / 60)
  })

  test('compaction keeps the clock bounded', () => {
    const builder = measured().propose('r1', ['a'])
    for (let run = 0; run < 50; run += 1)
      batch(builder, run * 60 + 30, [
        ['attempt-a', run * 2 + 1, 'started', `i${run}`, run * 60],
        ['attempt-a', run * 2 + 2, 'ended', `i${run}`, run * 60 + 30],
      ])
    const state = digest(builder)
    expect(state.clock.spans).toEqual([])
    expect(state.clock.open).toEqual({})
    expect(state.clock.builds).toEqual({ 'attempt-a': 100 })
    expect(hours(state, 50 * 60)).toBe(25)
  })

  test('facts the clock already accounted are skipped by number', () => {
    const builder = measured().propose('r1', ['a'])
    batch(builder, 60, [
      ['attempt-a', 1, 'started', 'i', 0],
      ['attempt-a', 2, 'ended', 'i', 30],
    ])
    // A retry after a crash between the node record and the acknowledgment.
    batch(builder, 61, [
      ['attempt-a', 1, 'started', 'i', 0],
      ['attempt-a', 2, 'ended', 'i', 30],
    ])
    expect(hours(digest(builder), 61)).toBe(0.5)
  })

  test('a start before the watermark is clamped to it', () => {
    const builder = measured().propose('r1', ['a', 'b'])
    batch(builder, 60, [['attempt-a', 1, 'started', 'i', 50]])
    // A late-tracked build's facts from before the watermark.
    batch(builder, 70, [
      ['attempt-b', 1, 'started', 'j', 10],
      ['attempt-b', 2, 'ended', 'j', 20],
    ])
    expect(digest(builder).clock.watermark).toBe(iso(50))
    expect(hours(digest(builder), 70)).toBe(20 / 60)
  })

  test('a live clock tracks a settled build it never saw; a legacy log does not', () => {
    const live = measured().propose('r1', ['a', 'b'])
    batch(live, 10, [['attempt-a', 1, 'started', 'i', 0]])
    live.settle('b', 'declined')
    expect(digest(live).clock.builds).toEqual({ 'attempt-a': 1, 'attempt-b': 0 })
    const legacy = measured().propose('r1', ['a']).settle('a', 'declined')
    expect(digest(legacy).clock.builds).toEqual({})
  })

  test('a release drops a fully accounted build, but never an open one', () => {
    const builder = measured().propose('r1', ['a', 'b'])
    batch(builder, 30, [
      ['attempt-a', 1, 'started', 'i', 0],
      ['attempt-a', 2, 'ended', 'i', 20],
      ['attempt-b', 1, 'started', 'j', 25],
    ])
    builder.wait(1).activity([], { released: ['attempt-a', 'attempt-b'] })
    expect(digest(builder).clock.builds).toEqual({ 'attempt-b': 1 })
  })

  test('a stop freezes the value; the settlement accounts pre-stop runs once', () => {
    const builder = measured().propose('r1', ['a'])
    batch(builder, 5, [['attempt-a', 1, 'started', 'i', 0]])
    // A proposer run, open at the stop: closed there.
    builder.wait(55).request('r2', 1).execution('started', 'n')
    builder.wait(60).stop('operator', 'abort')
    let state = digest(builder)
    expect(state.clock.stoppedAt).toBe(iso(120))
    // Frozen, though still settling: an open run ends at the stop.
    expect(hours(state, 120)).toBe(2)
    expect(hours(state, 5_000)).toBe(2)
    // Node facts after the stop are ignored.
    builder.wait(5).execution('ended', 'n').execution('started', 'late')
    // The settlement: the attempt ended at 100, before the stop; a run
    // straddling the stop is clipped; a fact after it is ignored.
    batch(
      builder,
      200,
      [
        ['attempt-a', 2, 'ended', 'i', 100],
        ['attempt-a', 3, 'started', 'k', 110],
        ['attempt-a', 4, 'ended', 'k', 150],
        ['attempt-a', 5, 'started', 'z', 160],
      ],
      { settles: true, watermark: iso(160) },
    )
    state = digest(builder)
    expect(state.clock).toEqual({
      activeMs: 120 * 60_000,
      watermark: iso(120),
      spans: [],
      open: {},
      builds: {},
      stoppedAt: iso(120),
      settled: true,
    })
    // Every later batch is ignored.
    batch(builder, 300, [['attempt-a', 6, 'started', 'y', 290]], { settles: true })
    expect(hours(digest(builder), 10_000)).toBe(2)
  })

  test('a stopped clock ignores a batch that does not settle', () => {
    const builder = measured().propose('r1', ['a'])
    builder.wait(60).stop('operator', 'drain')
    batch(builder, 70, [
      ['attempt-a', 1, 'started', 'i', 0],
      ['attempt-a', 2, 'ended', 'i', 30],
    ])
    expect(hours(digest(builder), 70)).toBe(0)
  })

  test('a legacy log reports its own node runs, clipped at its stop', () => {
    const builder = new OptimizationLogBuilder().accept(commandObjective(), 1)
    builder.execution('started', 'n').wait(30).baseline(1, 50, 1).execution('ended', 'n')
    builder.propose('r1', ['a']).wait(600).settle('a', 'declined').stop('budget', 'drain')
    const state = digest(builder)
    expect(hours(state, 60 * 24 * 3)).toBe(0.5)
  })

  test('the build digest folds the same clock as BuildState', () => {
    const builder = measured().propose('r1', ['a'])
    builder.execution('started', 'n')
    batch(builder, 30, [['attempt-a', 1, 'started', 'i', 0]])
    builder.wait(10).execution('ended', 'n')
    const read = REDUCERS.buildDigest!.valueRead
    if ('excluded' in read) throw new Error('buildDigest has no value read')
    const log = [
      {
        actor: DISPATCHER,
        type: 'build.created',
        payload: { repo: 'r', ticket: { source: 'file', id: 'n' }, baseBranch: 'm', kind: 'node' },
        build: 'opt-node',
        seq: 0,
        ts: iso(0),
      } as AbEvent,
      ...builder.events,
    ]
    const signal = reduceBuildDigest(read.adapt(log as never) as never).optimization
    const state = reduceBuild(log).optimization!
    expect((signal || undefined)?.clock).toEqual(clockView(state.clock))
  })
})

const value = (
  facts: [number, 'started' | 'ended', string, number][],
  acknowledged = 0,
): ExecutionIntervalsValue => ({
  count: facts.at(-1)?.[0] ?? acknowledged,
  acknowledged,
  facts: facts.map(([n, kind, instance, minute]) => ({ n, kind, instance, at: iso(minute) })),
})

const clock = (overrides: Partial<OptimizationClock> = {}): OptimizationClock => ({
  activeMs: 0,
  spans: [],
  open: {},
  builds: {},
  ...overrides,
})

describe('the activity batch decision', () => {
  test('nothing changed: nothing to record', () => {
    expect(
      optimizationActivityBatch(
        clock({ builds: { a: 2 } }),
        [{ build: 'a', inFlightNewest: true, digestCount: 2 }],
        iso(0),
      ),
    ).toBeUndefined()
  })

  test('takes facts above the accounted count up to the digest count', () => {
    const batch = optimizationActivityBatch(
      clock({ builds: { a: 1 }, open: { a: { instance: 'i', start: iso(0) } } }),
      [
        {
          build: 'a',
          inFlightNewest: true,
          digestCount: 3,
          value: value([
            [2, 'ended', 'i', 10],
            [3, 'started', 'k', 20],
            [4, 'ended', 'k', 30],
          ]),
        },
      ],
      iso(0),
    )
    expect(batch).toEqual({
      facts: [
        { build: 'a', n: 2, instance: 'i', kind: 'ended', at: iso(10) },
        { build: 'a', n: 3, instance: 'k', kind: 'started', at: iso(20) },
      ],
      accounted: { a: 3 },
      watermark: iso(20),
    })
  })

  test('releases a fully accounted build no attempt runs on', () => {
    const batch = optimizationActivityBatch(
      clock({ builds: { a: 1, gone: 0 }, open: { a: { instance: 'i', start: iso(0) } } }),
      [
        {
          build: 'a',
          inFlightNewest: false,
          digestCount: 2,
          value: value([[2, 'ended', 'i', 10]]),
        },
        { build: 'gone', inFlightNewest: false, missing: true },
      ],
      iso(0),
    )
    expect(batch).toMatchObject({ accounted: { a: 2 }, released: ['a', 'gone'] })
    // Still open, or still an in-flight attempt's newest build: kept.
    expect(
      optimizationActivityBatch(
        clock({ builds: { a: 1 } }),
        [{ build: 'a', inFlightNewest: false, digestCount: 1, digestOpen: true }],
        iso(0),
      ),
    ).toBeUndefined()
  })

  test('starts after a prior acknowledgment, and refuses a value missing a needed fact', () => {
    const resumed = optimizationActivityBatch(
      clock(),
      [
        {
          build: 'a',
          inFlightNewest: true,
          digestCount: 3,
          value: value([[3, 'started', 'k', 5]], 2),
        },
      ],
      iso(0),
    )
    expect(resumed?.facts.map((fact) => fact.n)).toEqual([3])
    expect(() =>
      optimizationActivityBatch(
        clock({ builds: { a: 1 } }),
        [
          {
            build: 'a',
            inFlightNewest: true,
            digestCount: 3,
            value: value([[3, 'started', 'k', 5]], 0),
          },
        ],
        iso(0),
      ),
    ).toThrow(ExecutionFactsMissingError)
  })

  test('a stopped clock settles with every unaccounted fact up to the stop', () => {
    const batch = optimizationActivityBatch(
      clock({ stoppedAt: iso(60), builds: { a: 0 } }),
      [
        {
          build: 'a',
          inFlightNewest: false,
          digestCount: 0,
          value: value([
            [1, 'started', 'i', 10],
            [2, 'ended', 'i', 50],
            [3, 'started', 'k', 70],
          ]),
        },
      ],
      iso(0),
    )
    expect(batch).toEqual({
      facts: [
        { build: 'a', n: 1, instance: 'i', kind: 'started', at: iso(10) },
        { build: 'a', n: 2, instance: 'i', kind: 'ended', at: iso(50) },
      ],
      accounted: { a: 3 },
      watermark: iso(60),
      settles: true,
    })
    expect(optimizationActivityBatch(clock({ stoppedAt: iso(60) }), [], iso(0))).toEqual({
      facts: [],
      accounted: {},
      watermark: iso(60),
      settles: true,
    })
    expect(
      optimizationActivityBatch(clock({ stoppedAt: iso(60), settled: true }), [], iso(0)),
    ).toBeUndefined()
  })

  test('chunks keep each event within the limit and account only what they carry', () => {
    const count = ACTIVITY_FACTS_PER_EVENT + 50
    const facts = Array.from({ length: count }, (_, index) => ({
      build: 'a',
      n: index + 1,
      instance: `i${Math.floor(index / 2)}`,
      kind: index % 2 === 0 ? ('started' as const) : ('ended' as const),
      at: iso(index),
    }))
    const chunks = chunkActivityBatch({ facts, accounted: { a: count }, watermark: iso(count) })
    expect(chunks.map((chunk) => chunk.facts.length)).toEqual([ACTIVITY_FACTS_PER_EVENT, 50])
    expect(chunks[0]).toMatchObject({
      accounted: { a: ACTIVITY_FACTS_PER_EVENT },
      watermark: iso(ACTIVITY_FACTS_PER_EVENT - 1),
    })
    expect(chunks[1]).toMatchObject({ accounted: { a: count }, watermark: iso(count) })
  })
})

describe('executionIntervals', () => {
  const log = (events: [string, unknown][]) =>
    events.map(
      ([type, payload], index) =>
        ({
          build: 'b',
          seq: index + 1,
          ts: iso(index),
          actor: DISPATCHER,
          type,
          payload,
        }) as AbEvent,
    )
  const started = (instance: string): [string, unknown] => [
    'execution.started',
    { provider: 'p', workspaceRef: 'w', instance },
  ]
  const ended = (instance: string): [string, unknown] => [
    'execution.ended',
    { instance, workspaceRef: 'w', outcome: 'completed' },
  ]

  test('numbers every execution fact and keeps those above the acknowledgment', () => {
    const value = executionIntervalsReducer.reduce(
      log([
        started('a'),
        ['observation.recorded', { id: 'o', kind: 'refactor', summary: 's', files: [] }],
        ended('a'),
        started('b'),
        ['execution.accounted', { count: 2 }],
        ['execution.accounted', { count: 1 }],
        ended('b'),
      ]),
    )
    expect(value).toEqual({
      count: 4,
      acknowledged: 2,
      facts: [
        { n: 3, kind: 'started', instance: 'b', at: iso(3) },
        { n: 4, kind: 'ended', instance: 'b', at: iso(6) },
      ],
    })
  })

  test('an acknowledgment never exceeds the facts the build has', () => {
    const value = executionIntervalsReducer.reduce(
      log([started('a'), ['execution.accounted', { count: 9 }], ended('a')]),
    )
    expect(value).toEqual({
      count: 2,
      acknowledged: 1,
      facts: [{ n: 2, kind: 'ended', instance: 'a', at: iso(2) }],
    })
  })
})
