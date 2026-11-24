import { describe, expect, test } from 'bun:test'
import type { AbEvent } from '../../events/catalog'
import { randomBuildLog } from '../../kernel/generators/build-log'
import { checkIncremental } from '../../kernel/incremental-contract'
import {
  TIMELINE_SEGMENT_CAP,
  buildTimelineReducer,
  capSegments,
  type TimelineSegment,
} from './timeline'

const T0 = Date.parse('2026-11-01T00:00:00.000Z')

/** A log whose event `i` (1-based) is stamped `T0 + minutes[i]` minutes. */
function log(...writes: [minute: number, type: string, payload?: unknown][]): AbEvent[] {
  return writes.map(
    ([minute, type, payload], index) =>
      ({
        build: 'b',
        seq: index + 1,
        ts: new Date(T0 + minute * 60_000).toISOString(),
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
const exec = { provider: 'p', workspaceRef: 'w', instance: 'i' }
const raised = (id: string, round?: number) => ({
  id,
  phase: 'implement',
  ...(round !== undefined ? { round } : {}),
  source: 'agent',
  question: 'q',
})
const answered = (id: string) => ({ id, answer: 'a', resolution: 'continue' })
const pr = { pr: { number: 1, url: 'u', headSha: 'h' } }
const verdict = (round: number) => ({ round, verdict: 'approve', findings: [] })

const summary = (segments: TimelineSegment[]) =>
  segments.map((s) => [s.category, s.state, s.durationMs / 60_000, s.opened.seq, s.closed?.seq])

describe('buildTimeline', () => {
  test('pairs every phase and wait in the taxonomy', () => {
    const timeline = buildTimelineReducer.reduce(
      log(
        [0, 'build.created', created()],
        [2, 'execution.started', exec],
        [3, 'plan.started', { round: 1 }],
        [5, 'plan.completed', { round: 1, artifact: { kind: 'plan', rev: 1 } }],
        [5, 'plan-review.started', { round: 1 }],
        [6, 'plan-review.verdict', verdict(1)],
        [6, 'implement.started', { round: 1 }],
        [7, 'escalation.raised', raised('e1', 1)],
        [9, 'escalation.answered', answered('e1')],
        [10, 'implement.completed', { round: 1 }],
        [10, 'code-review.started', { round: 1 }],
        [11, 'build.paused'],
        [12, 'build.resumed'],
        [13, 'code-review.verdict', verdict(1)],
        [13, 'verify.started', { step: 'unit', attempt: 1 }],
        [13, 'verify.started', { step: 'lint', attempt: 1 }],
        [14, 'verify.completed', { step: 'lint', attempt: 1 }],
        [16, 'verify.cancelled', { step: 'unit', attempt: 1, cause: { step: 'lint' } }],
        [16, 'finalize.started'],
        [17, 'finalize.completed', pr],
        [17, 'pr.opened', pr],
        [18, 'reconcile.started', { attempt: 2, baseSha: 'x' }],
        [19, 'reconcile.completed', { mergeCommit: 'm' }],
        [20, 'wait.entered', { id: 'w1', escalation: 'e2' }],
        [22, 'wait.ended', { id: 'w1' }],
        [25, 'pr.merged', { sha: 's' }],
        [25, 'build.completed', { outcome: 'merged' }],
      ),
    )
    expect(timeline.kind).toBe('work')
    expect(timeline.outcome).toBe('merged')
    expect(timeline.createdAt).toBe(new Date(T0).toISOString())
    expect(summary(timeline.segments)).toEqual([
      ['queued', 'closed', 2, 1, 2],
      ['plan', 'closed', 2, 3, 4],
      ['plan-review', 'closed', 1, 5, 6],
      ['implement', 'closed', 4, 7, 10],
      ['escalated', 'closed', 2, 8, 9],
      ['code-review', 'closed', 3, 11, 14],
      ['paused', 'closed', 1, 12, 13],
      ['verify:unit', 'closed', 3, 15, 18],
      ['verify:lint', 'closed', 1, 16, 17],
      ['finalize', 'closed', 1, 19, 20],
      ['awaiting-merge', 'closed', 8, 20, 26],
      ['reconcile', 'closed', 1, 22, 23],
      ['ticket-wait', 'closed', 2, 24, 25],
    ])
    const implement = timeline.segments.find((s) => s.category === 'implement')!
    expect(implement.round).toBe(1)
    expect(implement.opened).toEqual({ type: 'implement.started', seq: 7 })
    expect(implement.closed).toEqual({ type: 'implement.completed', seq: 10 })
    expect(timeline.segments.find((s) => s.category === 'escalated')!.round).toBe(1)
    expect(timeline.segments.find((s) => s.category === 'reconcile')!.attempt).toBe(2)
    expect(timeline.segments.find((s) => s.category === 'verify:unit')!.attempt).toBe(1)
  })

  test('a second phase start replaces the open one; a second wait start keeps the first', () => {
    const timeline = buildTimelineReducer.reduce(
      log(
        [0, 'build.created', created('node')],
        [1, 'implement.started', { round: 1 }],
        [4, 'implement.started', { round: 1 }],
        [5, 'implement.completed', { round: 1 }],
        [6, 'build.paused'],
        [8, 'build.paused'],
        [9, 'build.resumed'],
      ),
    )
    expect(timeline.kind).toBe('node')
    expect(summary(timeline.segments)).toEqual([
      ['queued', 'open', 0, 1, undefined],
      ['implement', 'closed', 1, 3, 4],
      ['paused', 'closed', 3, 5, 7],
    ])
  })

  test('queued closes once and never reopens', () => {
    const timeline = buildTimelineReducer.reduce(
      log(
        [0, 'build.created', created()],
        [3, 'execution.started', exec],
        [5, 'execution.started', exec],
      ),
    )
    expect(summary(timeline.segments)).toEqual([['queued', 'closed', 3, 1, 2]])
  })

  test('escalated stays open until every overlapping escalation is answered', () => {
    const timeline = buildTimelineReducer.reduce(
      log(
        [0, 'escalation.raised', raised('a')],
        [1, 'escalation.raised', raised('b')],
        [2, 'escalation.answered', answered('a')],
        [3, 'escalation.answered', answered('zzz')],
        [5, 'escalation.answered', answered('b')],
      ),
    )
    expect(summary(timeline.segments)).toEqual([['escalated', 'closed', 5, 1, 5]])
  })

  test("ticket-wait closes on its own escalation's answer, not another", () => {
    const timeline = buildTimelineReducer.reduce(
      log(
        [0, 'wait.entered', { id: 'w', escalation: 'mine' }],
        [1, 'escalation.answered', answered('other')],
        [4, 'escalation.answered', answered('mine')],
      ),
    )
    expect(summary(timeline.segments)).toEqual([['ticket-wait', 'closed', 4, 1, 3]])
  })

  test('awaiting-merge opens at finalize.completed and pr.opened does not restart it', () => {
    const timeline = buildTimelineReducer.reduce(
      log(
        [0, 'finalize.started'],
        [1, 'finalize.completed', pr],
        [3, 'pr.opened', pr],
        [6, 'pr.closed', {}],
      ),
    )
    expect(summary(timeline.segments)).toEqual([
      ['finalize', 'closed', 1, 1, 2],
      ['awaiting-merge', 'closed', 5, 2, 4],
    ])
  })

  test('a terminal event abandons every other open segment', () => {
    const timeline = buildTimelineReducer.reduce(
      log(
        [0, 'build.created', created()],
        [1, 'implement.started', { round: 1 }],
        [2, 'escalation.raised', raised('e')],
        [4, 'build.aborted'],
        [5, 'escalation.answered', answered('e')],
      ),
    )
    expect(timeline.outcome).toBeUndefined()
    expect(summary(timeline.segments)).toEqual([
      ['queued', 'abandoned', 4, 1, 4],
      ['implement', 'abandoned', 3, 2, 4],
      ['escalated', 'abandoned', 2, 3, 4],
    ])
  })

  test('build.reopened clears the outcome until the next completion', () => {
    const events = log(
      [0, 'build.completed', { outcome: 'closed-unmerged' }],
      [1, 'build.reopened', {}],
    )
    expect(buildTimelineReducer.reduce(events.slice(0, 1)).outcome).toBe('closed-unmerged')
    expect(buildTimelineReducer.reduce(events).outcome).toBeUndefined()
  })

  test('the cap bounds a retry loop while keeping count and duration exact', () => {
    const writes: [number, string, unknown?][] = [[0, 'build.created', created()]]
    let minute = 1
    for (let round = 1; round <= 1_000; round++) {
      writes.push([minute, 'implement.started', { round }])
      minute += 2
      writes.push([minute, 'implement.completed', { round }])
      writes.push([minute, 'code-review.started', { round }])
      minute += 1
      writes.push([minute, 'code-review.verdict', verdict(round)])
    }
    const timeline = buildTimelineReducer.reduce(log(...writes))
    const closed = timeline.segments.filter((s) => s.state === 'closed')
    expect(closed.length).toBeLessThanOrEqual(TIMELINE_SEGMENT_CAP)
    const total = (category: string) =>
      closed
        .filter((s) => s.category === category)
        .reduce((sum, s) => [sum[0]! + (s.merged ?? 1), sum[1]! + s.durationMs], [0, 0])
    expect(total('implement')).toEqual([1_000, 1_000 * 2 * 60_000])
    expect(total('code-review')).toEqual([1_000, 1_000 * 60_000])
    // A merged segment keeps its own start and takes the later close.
    const first = closed.find((s) => s.category === 'implement')!
    expect(first.opened.seq).toBe(2)
    expect(first.merged).toBeGreaterThan(1)
  })

  test('capSegments merges only same category and state, and stops when no pair remains', () => {
    const seg = (category: string, seq: number, state: TimelineSegment['state'] = 'closed') => ({
      category,
      start: new Date(T0 + seq).toISOString(),
      end: new Date(T0 + seq + 1).toISOString(),
      durationMs: 1,
      opened: { type: 'x', seq },
      closed: { type: 'y', seq: seq + 1 },
      state,
    })
    const list: TimelineSegment[] = [
      seg('a', 1),
      seg('b', 3),
      seg('a', 5, 'abandoned'),
      seg('a', 7),
    ]
    capSegments(list, 2)
    expect(list.map((s) => [s.category, s.state, s.merged, s.opened.seq, s.closed?.seq])).toEqual([
      ['a', 'closed', 2, 1, 8],
      ['b', 'closed', undefined, 3, 4],
      ['a', 'abandoned', undefined, 5, 6],
    ])
  })

  test('advancing in any split equals reducing the whole log', () => {
    for (const seed of [1, 2, 3, 4])
      checkIncremental(buildTimelineReducer, randomBuildLog(seed, 60))
  }, 20_000)
})
