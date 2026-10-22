import { expect, test } from 'bun:test'
import { DISPATCHER } from '../events/envelope'
import {
  validateRepositoryEventWrite,
  type RepositoryEventWrite,
  type RepositoryEvent,
} from '../events/repository'
import { dispatchUpgradeReducer, type Handoff } from './dispatch-upgrade'
import { checkIncremental } from './incremental-contract'
const runtime = {
  version: '1.0.0',
  commit: 'unknown',
  source: { kind: 'package' as const, location: '/old' },
}
const handoff: Handoff = {
  correlation: 'upgrade',
  run: 'old',
  lineage: 'launcher',
  from: runtime,
  to: { ...runtime, version: '2.0.0' },
  root: '/cache/new',
  cacheId: 'new',
  target: { mode: 'installed', key: 'new', source: '/install' },
}
const write = (type: string, payload: unknown) =>
  validateRepositoryEventWrite({ actor: DISPATCHER, type, payload })
const log = (writes: RepositoryEventWrite[]) =>
  writes.map(
    (write, i) =>
      ({
        ...write,
        repo: 'repo',
        seq: i + 1,
        ts: new Date(2026, 0, 1, 0, 0, i).toISOString(),
      }) as RepositoryEvent,
  )
function accepted() {
  return [
    write('dispatcher.target-prepared', handoff),
    write('dispatcher.yield-requested', {
      ...handoff,
      successor: 'new',
      mode: 'drain',
      evidence: 'same schema',
    }),
    write('dispatcher.handoff-started', {
      ...handoff,
      successor: 'new',
      mode: 'drain',
      startedAt: '2026-01-01T00:00:00.000Z',
      deadline: '2026-01-01T00:15:00.000Z',
      builds: [{ slug: 'build', instance: 'execution' }],
    }),
  ]
}
test('handoff folds exact execution settlement, deadline and completion idempotently across replay', () => {
  const events = log([
    ...accepted(),
    write('dispatcher.terminal-released', handoff),
    write('dispatcher.takeover', { ...handoff, successor: 'new' }),
    write('dispatcher.handoff-completed', { ...handoff, successor: 'new' }), // too early
    write('dispatcher.drain-settled', {
      ...handoff,
      slug: 'build',
      instance: 'stranger',
      outcome: 'suspended',
    }),
    write('dispatcher.drain-deadline', { ...handoff, deadline: '2026-01-01T00:01:00.000Z' }),
    write('dispatcher.drain-settled', {
      ...handoff,
      slug: 'build',
      instance: 'execution',
      outcome: 'drained',
    }),
    write('dispatcher.drain-settled', {
      ...handoff,
      slug: 'build',
      instance: 'execution',
      outcome: 'suspended',
    }),
    write('dispatcher.handoff-completed', { ...handoff, successor: 'new' }),
    write('dispatcher.handoff-completed', { ...handoff, successor: 'stranger' }),
  ])
  checkIncremental(dispatchUpgradeReducer, events)
  const state = dispatchUpgradeReducer.reduce(events).runs.old!
  expect(state.outstanding).toEqual({})
  expect(state.drained).toBe(1)
  expect(state.suspended).toBe(0)
  expect(state.deadline).toBe('2026-01-01T00:01:00.000Z')
  expect(state.completed?.seq).toBe(11)
  expect(state.takeover?.payload.successor).toBe('new')
})
test('mismatched correlation, holder and successor cannot accept or take over', () => {
  for (const changed of [
    { correlation: 'stale' },
    { run: 'stranger' },
    { lineage: 'stranger' },
    { root: '/wrong' },
  ]) {
    const state = dispatchUpgradeReducer.reduce(
      log([
        write('dispatcher.target-prepared', handoff),
        write('dispatcher.yield-requested', {
          ...handoff,
          ...changed,
          successor: 'new',
          mode: 'drain',
          evidence: 'same schema',
        }),
        ...accepted().slice(2),
      ]),
    ).runs.old!
    expect(state.handoff).toBeUndefined()
  }
  const state = dispatchUpgradeReducer.reduce(
    log([...accepted(), write('dispatcher.takeover', { ...handoff, successor: 'new' })]),
  ).runs.old!
  expect(state.takeover).toBeUndefined()
})
test('legacy cutover handoffs remain readable without drain protocol facts', () => {
  const state = dispatchUpgradeReducer.reduce(
    log([
      write('dispatcher.handoff-started', handoff),
      write('dispatcher.handoff-completed', { ...handoff, successor: 'new' }),
    ]),
  ).runs.old!
  expect(state.handoff?.payload).toEqual(handoff)
  expect(state.completed?.payload.successor).toBe('new')
})

test('failure before acceptance blocks yield, while a late preflight failure cannot revoke accepted authority', () => {
  const failure = write('dispatcher.upgrade-failed', {
    correlation: handoff.correlation,
    run: handoff.run,
    lineage: handoff.lineage,
    from: handoff.from,
    target: handoff.target,
    reason: 'preflight process exited',
  })
  const early = dispatchUpgradeReducer.reduce(
    log([...accepted().slice(0, 2), failure, ...accepted().slice(2)]),
  ).runs.old!
  expect(early.handoff).toBeUndefined()
  const late = dispatchUpgradeReducer.reduce(log([...accepted(), failure])).runs.old!
  expect(late.handoff).toBeDefined()
  expect(late.failure).toBeUndefined()
})

test('a failed request stays blocked until a new preparation replaces it, including same-target retries', () => {
  for (const target of [handoff.target, { ...handoff.target, key: 'later', source: '/later' }]) {
    const replacement = { ...handoff, correlation: 'retry', target }
    const identity = ({ correlation, run, lineage, from, target }: Handoff) => ({
      correlation,
      run,
      lineage,
      from,
      target,
    })
    const failed = [
      write('dispatcher.upgrade-detected', identity(handoff)),
      ...accepted().slice(0, 2),
      write('dispatcher.upgrade-failed', { ...identity(handoff), reason: 'preflight exited' }),
      write('dispatcher.upgrade-detected', identity(replacement)),
    ]
    const blocked = dispatchUpgradeReducer.reduce(log(failed)).runs.old!
    expect(blocked.failure).toBeDefined()
    expect(blocked.request).toBeUndefined()
    const attempts = [
      ...failed,
      write('dispatcher.target-prepared', replacement),
      // Neither replaying the failed request nor accepting it may revive A.
      accepted()[1]!,
      accepted()[2]!,
    ]
    const prepared = dispatchUpgradeReducer.reduce(log(attempts)).runs.old!
    expect(prepared.prepared?.payload.correlation).toBe('retry')
    expect(prepared.failure).toBeUndefined()
    expect(prepared.request).toBeUndefined()
    expect(prepared.handoff).toBeUndefined()
    const events = log([
      ...attempts,
      write('dispatcher.yield-requested', {
        ...replacement,
        successor: 'retry-run',
        mode: 'drain',
        evidence: 'validated again',
      }),
      write('dispatcher.handoff-started', {
        ...replacement,
        successor: 'retry-run',
        mode: 'drain',
      }),
    ])
    checkIncremental(dispatchUpgradeReducer, events)
    expect(dispatchUpgradeReducer.reduce(events).runs.old?.handoff?.payload.correlation).toBe(
      'retry',
    )
  }
})

test('rollback history and lineage holds replay across a changed target and a new operator launch', () => {
  const rollback = write('dispatcher.runtime-rolled-back', {
    correlation: 'rollback',
    run: 'restored',
    lineage: 'launcher',
    predecessor: 'old',
    successor: 'new',
    handoff: 'upgrade',
    takeoverAt: '2026-01-01T00:00:00.000Z',
    failures: 3,
    failed: handoff.to,
    restored: runtime,
    failedRoot: '/cache/new',
    restoredRoot: '/cache/old',
    target: handoff.target,
    reason: 'three failed exits',
  })
  const unchanged = write('dispatcher.rollback-hold-cleared', {
    correlation: 'rollback',
    run: 'restored',
    lineage: 'launcher',
    target: handoff.target,
  })
  const changed = write('dispatcher.rollback-hold-cleared', {
    correlation: 'rollback',
    run: 'restored',
    lineage: 'launcher',
    target: { ...handoff.target, key: 'three' },
  })
  const events = log([rollback, rollback, unchanged])
  checkIncremental(dispatchUpgradeReducer, events)
  expect(dispatchUpgradeReducer.reduce(events).holds.launcher?.payload.target.key).toBe('new')
  const cleared = log([rollback, unchanged, changed])
  checkIncremental(dispatchUpgradeReducer, cleared)
  expect(dispatchUpgradeReducer.reduce(cleared).holds).toEqual({})
  expect(dispatchUpgradeReducer.reduce(cleared).lastRollback?.payload.failed.version).toBe('2.0.0')
})
