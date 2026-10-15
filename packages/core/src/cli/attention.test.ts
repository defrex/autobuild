import { describe, expect, test } from 'bun:test'
import type { AbEvent } from '../events/catalog'
import { DISPATCHER, KERNEL, humanActor } from '../events/envelope'
import type { RepositoryEvent } from '../events/repository'
import { autoMergeDeferralObservation } from '../kernel/auto-merge'
import { MemoryBuildStore } from '../store/memory'
import { manualClock } from '../testing/fixed'
import { mergeDecision, RepositoryAttention, repositoryNeedsAttention } from './attention'

const start = '2026-10-15T00:00:00.000Z'
const at = (ms: number) => new Date(Date.parse(start) + ms)
function repo(type: string, payload: unknown, seq: number, ms = 0): RepositoryEvent {
  return {
    repo: 'repo',
    type,
    payload,
    seq,
    ts: at(ms).toISOString(),
    actor: DISPATCHER,
  } as RepositoryEvent
}
const degraded = (seq: number, ms = 0, extra = {}) =>
  repo(
    'dispatcher.ticket-source-degraded',
    {
      source: 'linear',
      cause: 'ready-scan-failed',
      operation: 'ready-scan',
      message: 'offline',
      ...extra,
    },
    seq,
    ms,
  )
const failed = (seq: number, ms = 0, run = 'r1') =>
  repo('dispatcher.tick-failed', { run, error: 'offline' }, seq, ms)

describe('repository attention projection', () => {
  test.each([
    ['harvest.escalated', {}, true],
    ['harvest.recovery-exhausted', {}, true],
    ['dispatcher.config-rejected', {}, true],
    ['dispatcher.config-reloaded', { restartRequired: [] }, false],
    ['dispatcher.config-reloaded', { restartRequired: ['store'] }, true],
    ['dispatcher.run-stopped', { outcome: 'abnormal' }, true],
    ['dispatcher.run-stopped', { outcome: 'normal' }, false],
    ['dispatcher.run-stopped', { outcome: 'forced' }, false],
    ['harvest.failed', {}, false],
    ['dispatcher.harvest-runner-failed', {}, false],
    ['dispatcher.tick-failed', {}, false],
    ['dispatcher.ticket-source-degraded', {}, false],
    ['dispatcher.ticket-source-recovered', {}, false],
  ])('%s %j direct=%s', (type, payload, expected) => {
    expect(repositoryNeedsAttention(repo(type as string, payload, 1))).toBe(expected as boolean)
  })

  test('degradation threshold, repeated evidence, strengthening, recovery and new episode', () => {
    const projection = new RepositoryAttention()
    projection.fold(degraded(1))
    projection.fold(degraded(2, 14 * 60_000))
    projection.fold(repo('dispatcher.ticket-source-dependency-limited', { source: 'linear' }, 3))
    expect(projection.pending(at(15 * 60_000 - 1))).toEqual([])
    expect(projection.pending(at(15 * 60_000))).toMatchObject([
      {
        identity: 'source:1',
        observation: { episodeSeq: 1, dependencyLimited: true, message: 'offline' },
      },
    ])
    projection.fold(repo('dispatcher.ticket-source-recovered', { source: 'linear' }, 4))
    expect(projection.pending(at(60 * 60_000))).toEqual([])
    projection.fold(degraded(5, 60 * 60_000))
    expect(projection.pending(at(75 * 60_000))[0]?.identity).toBe('source:5')
  })

  test('reset deadline cannot be postponed; independent sources retain their clocks', () => {
    const projection = new RepositoryAttention()
    projection.fold(degraded(1, 0, { cause: 'rate-limited', resetAt: at(10_000).toISOString() }))
    projection.fold(
      degraded(2, 1_000, { cause: 'rate-limited', resetAt: at(20_000).toISOString() }),
    )
    projection.fold(degraded(3, 0, { source: 'other' }))
    expect(projection.pending(at(9_999))).toEqual([])
    expect(projection.pending(at(10_000))).toEqual([])
    projection.fold(repo('dispatcher.tick-started', { run: 'r1' }, 4, 10_001))
    projection.fold(repo('dispatcher.tick-completed', { run: 'r1' }, 5, 10_002))
    expect(projection.pending(at(10_002))).toHaveLength(1)
    expect(projection.pending(at(15 * 60_000))).toHaveLength(2)
  })

  test('normal recovery on the first post-reset tick never needs attention', () => {
    const projection = new RepositoryAttention()
    const reset = 2 * 60_000
    projection.fold(degraded(1, 0, { cause: 'rate-limited', resetAt: at(reset).toISOString() }))
    let seq = 2
    for (let ms = 1; ms < reset; ms += 10_000) {
      projection.fold(repo('dispatcher.tick-started', { run: 'r1' }, seq++, ms))
      projection.fold(failed(seq++, ms + 1))
    }
    expect(projection.pending(at(reset + 1_000))).toEqual([])
    projection.fold(repo('dispatcher.tick-started', { run: 'r1' }, seq++, reset + 10_000))
    expect(projection.pending(at(reset + 10_001))).toEqual([])
    projection.fold(
      repo('dispatcher.ticket-source-recovered', { source: 'linear' }, seq++, reset + 10_002),
    )
    projection.fold(repo('dispatcher.tick-completed', { run: 'r1' }, seq++, reset + 10_003))
    expect(projection.pending(at(reset + 20_000))).toEqual([])
  })

  test.each(['dispatcher.tick-completed', 'dispatcher.tick-failed'])(
    'persistence requires a post-reset tick outcome: %s',
    (outcome) => {
      const projection = new RepositoryAttention()
      projection.fold(degraded(1, 0, { cause: 'rate-limited', resetAt: at(10_000).toISOString() }))
      // A tick crossing reset while in flight is not evidence of a retry.
      projection.fold(repo('dispatcher.tick-started', { run: 'r1' }, 2, 9_000))
      projection.fold(repo(outcome, { run: 'r1', error: 'offline' }, 3, 11_000))
      expect(projection.pending(at(12_000))).toEqual([])
      projection.fold(repo('dispatcher.tick-started', { run: 'r1' }, 4, 13_000))
      // A foreign run outcome cannot consume this tick's evidence.
      projection.fold(repo(outcome, { run: 'other', error: 'offline' }, 5, 14_000))
      expect(projection.pending(at(15_000))).toEqual([])
      projection.fold(repo(outcome, { run: 'r1', error: 'offline' }, 6, 16_000))
      expect(projection.pending(at(16_000))).toMatchObject([{ identity: 'source:1' }])
    },
  )

  test('a long cooldown cannot become a five-minute dispatcher outage', () => {
    const projection = new RepositoryAttention()
    const reset = 40 * 60_000
    projection.fold(degraded(1, 0, { cause: 'rate-limited', resetAt: at(reset).toISOString() }))
    let seq = 2
    for (let ms = 1; ms < reset; ms += 10_000) {
      projection.fold(repo('dispatcher.tick-started', { run: 'r1' }, seq++, ms))
      projection.fold(failed(seq++, ms + 1))
      expect(projection.pending(at(ms + 1))).toEqual([])
    }
    expect(projection.pending(at(reset + 1_000))).toEqual([])
    projection.fold(repo('dispatcher.tick-started', { run: 'r1' }, seq++, reset + 10_000))
    const firstFailureSeq = seq++
    projection.fold(failed(firstFailureSeq, reset + 10_001))
    expect(projection.pending(at(reset + 10_001)).map((entry) => entry.identity)).toEqual([
      'source:1',
    ])
    expect(projection.pending(at(reset + 310_001)).map((entry) => entry.identity)).toEqual([
      'source:1',
      `tick:${firstFailureSeq}`,
    ])
  })

  test.each(['dispatcher.tick-completed', 'dispatcher.run-stopped', 'dispatcher.run-started'])(
    '%s ends a tick episode',
    (type) => {
      const projection = new RepositoryAttention()
      projection.fold(failed(1))
      projection.fold(repo('dispatcher.tick-started', { run: 'r1' }, 2, 100))
      projection.fold(failed(3, 200))
      expect(projection.pending(at(299_999))).toEqual([])
      expect(projection.pending(at(300_000))).toMatchObject([
        { identity: 'tick:1', observation: { firstFailure: start } },
      ])
      projection.fold(repo(type, { run: 'r1' }, 4, 300_001))
      expect(projection.pending(at(600_000))).toEqual([])
      projection.fold(failed(5, 600_000))
      expect(projection.pending(at(900_000))[0]?.identity).toBe('tick:5')
    },
  )

  test('foreign tick success/stop does not clear failure, a different failing run starts a new clock', () => {
    const projection = new RepositoryAttention()
    projection.fold(failed(1))
    projection.fold(repo('dispatcher.run-stopped', { run: 'old' }, 2))
    expect(projection.pending(at(300_000))).toHaveLength(1)
    projection.fold(failed(3, 300_000, 'new'))
    expect(projection.pending(at(300_001))).toEqual([])
    expect(projection.pending(at(600_000))[0]?.identity).toBe('tick:3')
  })
})

test('merge attention respects consent, current deferral, changed heads, and terminal PRs', async () => {
  const clock = manualClock()
  const store = new MemoryBuildStore({ clock })
  await store.createBuild({ slug: 'b', repo: 'repo' })
  const events: AbEvent[] = []
  const read = async () => {
    events.splice(0, events.length, ...(await store.getEvents('b')))
    return mergeDecision(events, clock())
  }
  expect(await read()).toBeNull()
  await store.append('b', {
    actor: humanActor('op'),
    type: 'build.auto-merge-requested',
    payload: {},
  })
  const commandSeq = (await store.getEvents('b')).at(-1)!.seq
  await store.append('b', {
    actor: KERNEL,
    type: 'finalize.completed',
    payload: { pr: { number: 1, url: 'https://example.com/pr/1', headSha: 'aaa' } },
  })
  expect(await read()).toBeNull() // pending consent is armed
  await store.append(
    'b',
    autoMergeDeferralObservation(
      { code: 'repository-auto-merge-disabled', detail: 'disabled' },
      1,
      commandSeq,
      'obs',
    ),
  )
  expect(await read()).toMatchObject({ type: 'build.merge-decision', pr: { number: 1 } })
  await store.append('b', {
    actor: KERNEL,
    type: 'finalize.completed',
    payload: { pr: { number: 1, url: 'https://example.com/pr/1', headSha: 'bbb' } },
  })
  expect(await read()).toBeNull() // old head's deferral is stale
  await store.append('b', {
    actor: humanActor('op'),
    type: 'build.auto-merge-cancelled',
    payload: {},
  })
  expect(await read()).toMatchObject({ reason: 'Auto-merge is not armed' })
  await store.append('b', {
    actor: DISPATCHER,
    type: 'pr.conflicted',
    payload: { baseSha: 'base' },
  })
  expect(await read()).toBeNull()
  await store.append('b', { actor: DISPATCHER, type: 'pr.closed', payload: {} })
  expect(await read()).toBeNull()
})
