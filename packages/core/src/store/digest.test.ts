/**
 * Unit coverage for the shared build-digest derivation (AUT-487). The
 * contract suite pins each adapter's `getRepoBuildDigests` against the
 * full-log ground truth; these tests pin the shared derivation itself —
 * in particular that its terminal rule is exactly `reduceBuild`'s — over
 * tricky logs the adapters then inherit for free.
 */
import { describe, expect, test } from 'bun:test'
import type { AbEvent } from '../events/catalog'
import { agentActor, DISPATCHER, KERNEL } from '../events/envelope'
import { reduceBuild } from '../kernel/reducer'
import { reduceBuildDigest } from './digest'

/** Minimal digest-relevant envelopes — the derivation reads only type/seq. */
function event(type: AbEvent['type'], seq: number): Pick<AbEvent, 'type' | 'seq'> {
  return { type, seq }
}

/** A full valid log over the digest-relevant skeletons, so the terminal rule
 * can be pinned against `reduceBuild` itself. */
function fullLog(log: Pick<AbEvent, 'type' | 'seq'>[]): AbEvent[] {
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
    const logs: Pick<AbEvent, 'type' | 'seq'>[][] = [
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
    expect(reduceBuildDigest(logs[5]!)).toEqual({ observations: [2, 4], terminal: 'done' })
  })

  test('observation seqs are collected in log order, including after completion', () => {
    expect(
      reduceBuildDigest([
        event('observation.recorded', 3),
        event('build.completed', 4),
        event('observation.recorded', 7),
        event('observation.recorded', 9),
      ]),
    ).toEqual({ observations: [3, 7, 9], terminal: 'done' })
  })
})
