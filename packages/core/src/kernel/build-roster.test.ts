import { describe, expect, test } from 'bun:test'
import type { AbEvent } from '../events/catalog'
import {
  BUILD_ROSTER_FINISHED,
  BUILD_ROSTER_HISTORY,
  buildRosterEntryReducer as entryReducer,
  buildRosterRollup as rollup,
  type BuildRosterAcc,
  type BuildRosterContribution,
} from './build-roster'
import { randomBuildLog } from './generators/build-log'
import { buildReducer } from './reducer'
import { REDUCERS, ROLLUPS } from './reducer-registry'

const T0 = Date.parse('2026-11-01T00:00:00.000Z')
const NOW = new Date('2026-11-24T00:00:00.000Z')
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString()

function log(...writes: [minute: number, type: string, payload?: unknown][]): AbEvent[] {
  return writes.map(
    ([minute, type, payload], index) =>
      ({
        build: 'b',
        seq: index + 1,
        ts: at(minute),
        actor: { kind: 'kernel' },
        type,
        payload: payload ?? {},
      }) as AbEvent,
  )
}

const created = (kind?: 'work' | 'node') => ({
  ticket: { source: 'file', id: 'T-1', title: 't' },
  repo: 'o/r',
  baseBranch: 'main',
  ...(kind ? { kind } : {}),
})
const completed = (outcome: string) => ['build.completed', { outcome }] as const
const aborted = ['build.aborted', {}] as const

const finished = (slug: string, minute: number): BuildRosterContribution => ({
  state: 'finished',
  slug,
  kind: 'work',
  outcome: 'merged',
  completedAt: at(minute),
})
const live = (slug: string, minute?: number): BuildRosterContribution => ({
  state: 'live',
  slug,
  kind: 'work',
  ...(minute === undefined ? {} : { createdAt: at(minute) }),
})

function folded(contributions: BuildRosterContribution[]): BuildRosterAcc {
  const acc = rollup.initial()
  for (const c of contributions) rollup.add(acc, c)
  return acc
}

describe('buildRosterEntry', () => {
  test('kind, creation time, and every outcome', () => {
    expect(entryReducer.reduce(log([3, 'build.created', created('node')]))).toEqual({
      kind: 'node',
      createdAt: at(3),
    })
    expect(entryReducer.reduce(log([3, 'build.created', created()])).kind).toBe('work')
    for (const [outcome, expected] of [
      ['merged', 'merged'],
      ['closed-unmerged', 'closed'],
      ['abandoned', 'closed'],
      ['discarded', 'closed'],
    ] as const)
      expect(
        entryReducer.reduce(log([0, 'build.created', created()], [5, ...completed(outcome)]))
          .finished,
      ).toEqual({ outcome: expected, completedAt: at(5) })
    expect(
      entryReducer.reduce(log([0, 'build.created', created()], [7, ...aborted])).finished,
    ).toEqual({ outcome: 'aborted', completedAt: at(7) })
  })

  test('finished exactly when the build reducer is terminal, latest wins', () => {
    const base: [number, string, unknown][] = [[0, 'build.created', created()]]
    const sequences: [number, string, unknown?][][] = [
      [],
      [[1, ...completed('merged')]],
      [[1, ...aborted]],
      [
        [1, ...completed('merged')],
        [2, ...aborted],
      ],
      [
        [1, ...aborted],
        [2, ...completed('closed-unmerged')],
      ],
      [
        [1, ...completed('closed-unmerged')],
        [2, 'build.reopened', { feedback: 'again' }],
      ],
    ]
    const parity = (events: AbEvent[]) => {
      const status = buildReducer.reduce(events).status
      const entry = entryReducer.reduce(events)
      expect(entry.finished !== undefined).toBe(status === 'done' || status === 'aborted')
      if (entry.finished) expect(entry.finished.outcome === 'aborted').toBe(status === 'aborted')
    }
    for (const tail of sequences) parity(log(...base, ...tail))
    expect(
      entryReducer.reduce(log(...base, [1, ...completed('merged')], [2, ...aborted])).finished,
    ).toEqual({ outcome: 'aborted', completedAt: at(2) })
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) parity(randomBuildLog(seed, 60))
  })
})

describe('buildRoster', () => {
  test('is registered over a registered build-scope reducer', () => {
    expect(ROLLUPS.buildRoster).toBe(rollup)
    const entry = REDUCERS[rollup.buildReducer]!.valueRead
    expect('scope' in entry && entry.scope).toBe('build')
    expect(rollup.version).toBeGreaterThan(REDUCERS.buildRosterEntry!.reducer.version)
  })

  test('contributions name their build', () => {
    expect(rollup.contribute({ kind: 'node', createdAt: at(1) }, {}, NOW, 's')).toEqual({
      state: 'live',
      slug: 's',
      kind: 'node',
      createdAt: at(1),
    })
    expect(
      rollup.contribute(
        { kind: 'work', finished: { outcome: 'closed', completedAt: at(4) } },
        {},
        NOW,
        's',
      ),
    ).toEqual({ state: 'finished', slug: 's', kind: 'work', outcome: 'closed', completedAt: at(4) })
  })

  test('live and finished entries add, subtract, and order', () => {
    const acc = folded([live('z', 5), live('y'), live('a', 5), finished('f', 1), finished('e', 3)])
    rollup.add(acc, finished('d', 3))
    const value = rollup.finish(acc, {}, NOW, '9')
    expect(value.live.map((e) => e.slug)).toEqual(['y', 'a', 'z'])
    expect(value.finished.map((e) => e.slug)).toEqual(['d', 'e', 'f'])
    expect(rollup.valueSchema.safeParse(value).success).toBe(true)
    // A build that finishes moves from live to finished.
    rollup.subtract(acc, live('a', 5))
    rollup.add(acc, finished('a', 9))
    const after = rollup.finish(acc, {}, NOW, '10')
    expect(after.live.map((e) => e.slug)).toEqual(['y', 'z'])
    expect(after.finished[0]).toMatchObject({ slug: 'a', completedAt: at(9) })
  })

  test('the history caps at 50, prunes the oldest, and never back-fills', () => {
    const acc = folded(Array.from({ length: 51 }, (_, i) => finished(`b${i}`, i)))
    expect(acc.finished).toHaveLength(BUILD_ROSTER_HISTORY)
    expect(acc.finished.at(-1)!.slug).toBe('b1') // b0, the oldest, was pruned
    rollup.subtract(acc, finished('b0', 0)) // already pruned: a no-op
    expect(acc.finished).toHaveLength(BUILD_ROSTER_HISTORY)
    // Reopens move the newest out; nothing older replaces them.
    for (let i = 50; i > 5; i--) {
      rollup.subtract(acc, finished(`b${i}`, i))
      rollup.add(acc, live(`b${i}`, i))
    }
    const value = rollup.finish(acc, {}, NOW, '1')
    expect(value.finished.map((e) => e.slug)).toEqual(['b5', 'b4', 'b3', 'b2', 'b1'])
    expect(value.live).toHaveLength(45)
    // Over-full rows from elsewhere are expired and pruned in constant work.
    const over = folded([])
    over.finished = Array.from({ length: 52 }, (_, i) => finished(`o${i}`, 100 - i)).map(
      ({ state: _, ...entry }) => entry as BuildRosterAcc['finished'][number],
    )
    expect(rollup.expired(over, NOW)).toBe(true)
    expect(rollup.prune(over, NOW)).toBe(true)
    expect(over.finished).toHaveLength(BUILD_ROSTER_HISTORY)
    expect(rollup.expired(over, NOW)).toBe(false)
    expect(rollup.prune(over, NOW)).toBe(false)
  })

  test('the first computation does not depend on feed order', () => {
    const all = Array.from({ length: 200 }, (_, i) =>
      finished(`s${String(i).padStart(3, '0')}`, i % 70),
    )
    let state = 7
    const shuffled = [...all].sort(() => {
      state = (state * 48271) % 2147483647
      return (state % 3) - 1
    })
    const sorted = folded(all)
    expect(folded(shuffled)).toEqual(sorted)
    const value = rollup.finish(sorted, {}, NOW, '200')
    expect(value.finished).toHaveLength(BUILD_ROSTER_FINISHED)
    expect(value.finished[0]!.completedAt).toBe(at(69))
    expect(rollup.valueSchema.safeParse(value).success).toBe(true)
  })
})
