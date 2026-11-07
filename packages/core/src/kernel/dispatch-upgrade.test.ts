import { expect, test } from 'bun:test'
import { DISPATCHER } from '../events/envelope'
import {
  validateRepositoryEventWrite,
  type RepositoryEventWrite,
  type RepositoryEvent,
} from '../events/repository'
import {
  dispatchUpgradeReducer,
  UPGRADE_HISTORY_LIMIT,
  type Handoff,
  type UpgradeRun,
} from './dispatch-upgrade'
import {
  resolutionOnlyWrites,
  upgradeGenerationRun,
  upgradeGenerationWrites,
  upgradeRuntime,
  upgradeTarget,
} from '../testing/upgrade-generations'
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

const generations = (from: number, to: number) => {
  const writes: RepositoryEventWrite[] = []
  for (let i = from; i < to; i++) writes.push(...upgradeGenerationWrites(i))
  return writes
}
const churn = (count: number, prefix = 'churn') => {
  const writes: RepositoryEventWrite[] = []
  for (let i = 0; i < count; i++)
    writes.push(...resolutionOnlyWrites(`${prefix}-${String(i).padStart(3, '0')}`, 'running'))
  return writes
}

test('runs, lineages and handoffs stay within the retention window across many generations', () => {
  const events = log([
    ...generations(0, 20),
    ...resolutionOnlyWrites(upgradeGenerationRun(20), 'k'),
  ])
  checkIncremental(dispatchUpgradeReducer, events)
  const state = dispatchUpgradeReducer.reduce(events)
  expect(Object.keys(state.runs).length).toBeLessThanOrEqual(UPGRADE_HISTORY_LIMIT)
  expect(Object.keys(state.lineages).length).toBeLessThanOrEqual(UPGRADE_HISTORY_LIMIT)
  expect(state.authoritativeRun).toBe(upgradeGenerationRun(20))
  expect(state.runs[upgradeGenerationRun(20)]?.resolved).toBeDefined()
  expect(state.lineages[upgradeGenerationRun(20)]).toBe('launcher')
  const predecessor = state.runs[upgradeGenerationRun(19)]!
  for (const fact of ['resolved', 'prepared', 'request', 'handoff', 'released', 'takeover'])
    expect(predecessor[fact as keyof UpgradeRun]).toBeDefined()
  expect(predecessor.completed).toBeDefined()
  expect(state.runs[upgradeGenerationRun(0)]).toBeUndefined()
})

test('an unfinished handoff outlives newer completed runs, and the authoritative run is never evicted', () => {
  const unfinished = upgradeGenerationWrites(0).slice(0, -1)
  const events = log([...unfinished, ...generations(1, 18)])
  checkIncremental(dispatchUpgradeReducer, events)
  const state = dispatchUpgradeReducer.reduce(events)
  expect(Object.keys(state.runs).length).toBe(UPGRADE_HISTORY_LIMIT)
  expect(state.runs[upgradeGenerationRun(0)]?.takeover).toBeDefined()
  expect(state.runs[upgradeGenerationRun(0)]?.completed).toBeUndefined()
  expect(state.runs[upgradeGenerationRun(1)]).toBeUndefined()

  // Only the first run ticks; later runs merely resolve, so it stays oldest.
  const resolutions = Array.from({ length: 20 }, (_, i) =>
    write('dispatcher.upgrade-target-resolved', {
      run: `other-${String(i).padStart(3, '0')}`,
      lineage: 'launcher',
      target: upgradeTarget('k'),
    }),
  )
  const authority = dispatchUpgradeReducer.reduce(
    log([...resolutionOnlyWrites('authority', 'k'), ...resolutions]),
  )
  expect(Object.keys(authority.runs).length).toBe(UPGRADE_HISTORY_LIMIT)
  expect(authority.runs.authority?.resolved).toBeDefined()
})

test('resolution-only churn evicts its own runs before accepted handoffs', () => {
  const captured = upgradeGenerationWrites(0).map((write) =>
    write.type === 'dispatcher.handoff-started'
      ? {
          ...write,
          payload: { ...write.payload, remoteBuilds: [{ slug: 'remote', instance: 'open' }] },
        }
      : write,
  ) as RepositoryEventWrite[]
  const events = log([...captured, ...churn(24)])
  checkIncremental(dispatchUpgradeReducer, events)
  const state = dispatchUpgradeReducer.reduce(events)
  expect(Object.keys(state.runs).length).toBeLessThanOrEqual(UPGRADE_HISTORY_LIMIT)
  expect(state.runs[upgradeGenerationRun(0)]?.handoff?.payload.remoteBuilds).toEqual([
    { slug: 'remote', instance: 'open' },
  ])

  const several = dispatchUpgradeReducer.reduce(log([...generations(0, 5), ...churn(24)]))
  expect(Object.keys(several.runs).length).toBe(UPGRADE_HISTORY_LIMIT)
  for (let i = 0; i < 5; i++) expect(several.runs[upgradeGenerationRun(i)]?.completed).toBeDefined()
})

test('the newest settled outcomes survive resolution-only churn', () => {
  const failure = (run: string) =>
    write('dispatcher.upgrade-failed', {
      correlation: `fail-${run}`,
      run,
      lineage: 'launcher',
      from: upgradeRuntime('1.0.0'),
      target: upgradeTarget('broken'),
      reason: 'preflight process exited',
    })
  const failed = upgradeGenerationRun(1)
  for (const prefix of [upgradeGenerationWrites(0), []]) {
    const events = log([
      ...prefix,
      ...resolutionOnlyWrites(failed, 'broken'),
      failure(failed),
      ...churn(20),
    ])
    checkIncremental(dispatchUpgradeReducer, events)
    const state = dispatchUpgradeReducer.reduce(events)
    expect(Object.keys(state.runs).length).toBeLessThanOrEqual(UPGRADE_HISTORY_LIMIT)
    expect(state.runs[failed]?.failure?.payload.reason).toBe('preflight process exited')
    if (prefix.length) expect(state.runs[upgradeGenerationRun(0)]?.completed).toBeDefined()
  }
})

test('rollback correlations and lineage holds keep a recent window and the authoritative hold', () => {
  const rollback = (correlation: string, lineage: string) =>
    write('dispatcher.runtime-rolled-back', {
      correlation,
      run: 'restored',
      lineage,
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
  const latest = rollback('rollback-019', 'lineage-019')
  const writes = [
    ...resolutionOnlyWrites('restored', 'k', 'launcher'),
    rollback('rollback-main', 'launcher'),
    ...Array.from({ length: 19 }, (_, i) =>
      rollback(`rollback-${String(i).padStart(3, '0')}`, `lineage-${String(i).padStart(3, '0')}`),
    ),
    latest,
  ]
  const events = log([...writes, latest])
  checkIncremental(dispatchUpgradeReducer, events)
  const state = dispatchUpgradeReducer.reduce(events)
  expect(state.rollbackIds.length).toBe(UPGRADE_HISTORY_LIMIT)
  expect(state.rollbackIds.at(-1)).toBe('rollback-019')
  expect(Object.keys(state.holds).length).toBe(UPGRADE_HISTORY_LIMIT)
  expect(state.holds.launcher?.payload.correlation).toBe('rollback-main')
  expect(state.holds['lineage-019']).toBeDefined()
  // The repeated latest correlation is still recognized and ignored.
  expect(state.lastRollback?.seq).toBe(events.length - 1)
})
