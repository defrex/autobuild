/**
 * Unit coverage for the shared build-digest derivation (AUT-487, extended by
 * AUT-521). The contract suite pins each adapter's `getRepoBuildDigests`
 * against the full-log ground truth; these tests pin the shared derivation
 * itself — in particular that its terminal rule is exactly `reduceBuild`'s —
 * over tricky logs the adapters then inherit for free.
 */
import { describe, expect, test } from 'bun:test'
import type { AbEvent } from '../events/catalog'
import { agentActor, DISPATCHER, KERNEL } from '../events/envelope'
import { reduceBuild } from '../kernel/reducer'
import { reduceBuildDigest } from './digest'

/** Minimal digest-relevant envelopes — the derivation reads only type/seq/ts. */
function event(
  type: AbEvent['type'],
  seq: number,
  ts?: string,
): Pick<AbEvent, 'type' | 'seq' | 'ts'> {
  return {
    type,
    seq,
    ts: ts ?? new Date(Date.parse('2026-07-15T12:00:00.000Z') + seq).toISOString(),
  }
}

/** A full valid log over the digest-relevant skeletons, so the terminal rule
 * can be pinned against `reduceBuild` itself. */
function fullLog(log: ReturnType<typeof event>[]): AbEvent[] {
  return log.map((item, index) => {
    const actor =
      item.type === 'build.completed'
        ? DISPATCHER
        : item.type === 'build.aborted'
          ? KERNEL
          : item.type === 'observation.recorded'
            ? agentActor('implement', 's_digest')
            : KERNEL
    const payload =
      item.type === 'build.completed'
        ? { outcome: 'merged' }
        : item.type === 'observation.recorded'
          ? { id: `o_${item.seq}`, kind: 'followup', summary: 's' }
          : {}
    return {
      build: 'b',
      seq: item.seq,
      ts: new Date(Date.parse('2026-07-15T12:00:00.000Z') + index).toISOString(),
      actor,
      type: item.type,
      payload,
    } as AbEvent
  })
}

describe('reduceBuildDigest', () => {
  test('an empty log derives an empty, terminal-less digest', () => {
    expect(reduceBuildDigest([])).toEqual({ observations: [] })
  })

  test('terminal is the latest terminal fact, in-order overwrite, exactly reduceBuild', () => {
    const logs: ReturnType<typeof event>[][] = [
      // completed → aborted → completed
      [event('build.completed', 1), event('build.aborted', 2), event('build.completed', 3)],
      // aborted → completed (the abort cleanup saga's shape)
      [event('build.aborted', 1), event('build.completed', 2)],
      // completed → aborted (mid-cleanup)
      [event('build.completed', 1), event('build.aborted', 2)],
      // aborted alone
      [event('build.aborted', 1)],
      // completed alone
      [event('build.completed', 1)],
      // terminal surrounded by unrelated facts and later observations
      [
        event('runner.attached', 1),
        event('observation.recorded', 2),
        event('build.completed', 3),
        event('observation.recorded', 4),
      ],
    ]
    for (const log of logs) {
      const status = reduceBuild(fullLog(log)).status
      expect(reduceBuildDigest(log).terminal).toBe(
        status === 'done' ? 'done' : status === 'aborted' ? 'aborted' : undefined,
      )
    }
    // Explicit shape pins for the nontrivial orderings.
    expect(reduceBuildDigest(logs[0]!)).toEqual({ observations: [], terminal: 'done' })
    expect(reduceBuildDigest(logs[1]!)).toEqual({ observations: [], terminal: 'done' })
    expect(reduceBuildDigest(logs[2]!)).toEqual({ observations: [], terminal: 'aborted' })
    expect(reduceBuildDigest(logs[5]!)).toEqual({
      observations: [
        { seq: 2, ts: event('observation.recorded', 2).ts },
        { seq: 4, ts: event('observation.recorded', 4).ts },
      ],
      terminal: 'done',
    })
  })

  test('observation seq/ts pairs are collected in log order, including after completion', () => {
    const first = event('observation.recorded', 3)
    const second = event('observation.recorded', 7)
    const third = event('observation.recorded', 9)
    expect(reduceBuildDigest([first, event('build.completed', 4), second, third])).toEqual({
      observations: [
        { seq: 3, ts: first.ts },
        { seq: 7, ts: second.ts },
        { seq: 9, ts: third.ts },
      ],
      terminal: 'done',
    })
  })

  test('merged is the latest pr.merged ts, in-order overwrite, absent without one', () => {
    expect(reduceBuildDigest([event('build.completed', 1)])).toEqual({
      observations: [],
      terminal: 'done',
    })
    const first = event('pr.merged', 2, '2026-07-15T12:00:01.000Z')
    const second = event('pr.merged', 5, '2026-07-15T12:00:05.000Z')
    // Multiple merges: the log's latest wins (in-order overwrite, the
    // terminal-fact pattern).
    expect(reduceBuildDigest([event('observation.recorded', 1), first, second])).toEqual({
      observations: [{ seq: 1, ts: event('observation.recorded', 1).ts }],
      merged: second.ts,
    })
    // A single merge carries its own ts.
    expect(reduceBuildDigest([first])).toEqual({ observations: [], merged: first.ts })
    // Interleaved with terminal facts, both overwrite independently.
    expect(
      reduceBuildDigest([
        event('pr.merged', 1, '2026-07-15T12:00:01.000Z'),
        event('build.aborted', 2),
        event('pr.merged', 3, '2026-07-15T12:00:03.000Z'),
        event('build.completed', 4),
      ]),
    ).toEqual({
      observations: [],
      merged: '2026-07-15T12:00:03.000Z',
      terminal: 'done',
    })
  })
})
