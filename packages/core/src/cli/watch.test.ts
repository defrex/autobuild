/**
 * `ab watch` pure-layer unit tests: record rendering, cadence selection,
 * duration parsing, cursor validation and repository line summaries. The
 * command shell is tested over MemoryBuildStore in `watch.integration.test.ts`.
 */
import { describe, expect, test } from 'bun:test'
import { DISPATCHER, agentActor } from '../events/envelope'
import {
  decodeCursor,
  encodeCursor,
  parseDurationMs,
  renderWatchLine,
  summarizeEvent,
  WATCH_USAGE,
  watchSelection,
} from './watch'

const ESCALATION = {
  id: 'esc_1',
  phase: 'implement',
  round: 1,
  source: 'agent',
  question: 'Which auth store?',
} as const

test('renderWatchLine keeps multiline payload text on one line, control bytes inert', () => {
  const line = renderWatchLine(
    {
      build: 'b1',
      seq: 2,
      ts: '2026-07-15T12:00:00.000Z',
      actor: agentActor('implement', 's_1'),
      type: 'escalation.raised',
      payload: { ...ESCALATION, question: 'line one\nline two' },
    },
    null,
  )
  expect(line).toBe(
    '2026-07-15T12:00:00.000Z  b1  escalation.raised  esc_1: line one\\u{a}line two',
  )
})

test('interval selection follows the store-reference kind', () => {
  expect(watchSelection('https://stores.example.com/ab').intervalMs).toBe(5000)
  expect(watchSelection('http://localhost:8080').intervalMs).toBe(5000)
  expect(watchSelection('/repo/.autobuild/store.db').intervalMs).toBe(1000)
})

test('duration parsing: bare numbers are seconds, suffixes scale, 0 only for --timeout', () => {
  const timeout = { flag: '--timeout', usage: WATCH_USAGE, allowZero: true }
  const interval = { flag: '--interval', usage: WATCH_USAGE }
  expect(parseDurationMs('30', timeout)).toBe(30_000)
  expect(parseDurationMs('45s', timeout)).toBe(45_000)
  expect(parseDurationMs('5m', timeout)).toBe(300_000)
  expect(parseDurationMs('1h', timeout)).toBe(3_600_000)
  expect(parseDurationMs('0', timeout)).toBe(0)
  expect(parseDurationMs('5s', interval)).toBe(5_000)
  for (const text of ['0', '-5', '1.5m', '5x', 'abc', '']) {
    expect(() => parseDurationMs(text, interval)).toThrow('--interval requires a duration')
  }
})

describe('watch cursor validation', () => {
  test('malformed lost-run metadata is rejected', () => {
    expect(() =>
      decodeCursor(
        encodeCursor({
          v: 1,
          store: 's',
          repo: 'r',
          streams: {},
          lostRuns: [42] as unknown as string[],
        }),
        { store: 's', repo: 'r' },
      ),
    ).toThrow('malformed')
  })

  test('malformed attention cursor metadata is rejected', () => {
    for (const deliveredAttention of [null, ['bad'], ['source:0'], [['b1', 7]], [12]]) {
      const cursor =
        'v1.' +
        Buffer.from(
          JSON.stringify({ v: 1, store: 's', repo: 'r', streams: {}, deliveredAttention }),
        ).toString('base64url')
      expect(() => decodeCursor(cursor, { store: 's', repo: 'r' })).toThrow('malformed')
    }
  })
})

describe('repository line summaries', () => {
  test('kernel Git condition events render as repository attention lines', () => {
    const base = { repo: 'repo', seq: 1, ts: '2026-11-05T00:00:00.000Z', actor: DISPATCHER }
    expect(
      summarizeEvent(
        {
          ...base,
          type: 'dispatcher.kernel-git-unavailable',
          payload: { executable: 'git', detail: 'Executable not found in $PATH: "git"\nmore' },
        },
        null,
      ),
    ).toBe(String.raw`Kernel Git unavailable (git): Executable not found in $PATH: "git"\u{a}more`)
    expect(
      summarizeEvent(
        { ...base, type: 'dispatcher.kernel-git-recovered', payload: { executable: 'git' } },
        null,
      ),
    ).toBe('Kernel Git recovered (git)')
  })

  test('open-PR backpressure transitions render as repository lines', () => {
    const base = { repo: 'repo', seq: 1, ts: '2026-11-20T00:00:00.000Z', actor: DISPATCHER }
    expect(
      summarizeEvent(
        {
          ...base,
          type: 'dispatcher.open-pr-backpressure-engaged',
          payload: { openPrs: 12, maxOpenPrs: 12, resumeOpenPrs: 9, excludeHeld: true },
        },
        null,
      ),
    ).toBe(
      'Open-PR backpressure engaged: 12 open root PRs ≥ 12; normal claims paused until ≤ 9 (held PRs excluded)',
    )
    expect(
      summarizeEvent(
        {
          ...base,
          type: 'dispatcher.open-pr-backpressure-cleared',
          payload: { openPrs: 9, reason: 'drained' },
        },
        null,
      ),
    ).toBe('Open-PR backpressure cleared (drained): 9 open root PRs')
  })
})
