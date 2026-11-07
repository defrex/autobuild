import { expect, test } from 'bun:test'
import { DISPATCHER } from '../events/envelope'
import {
  validateRepositoryEventWrite,
  type RepositoryEvent,
  type RepositoryEventWrite,
} from '../events/repository'
import { UPGRADE_HISTORY_LIMIT } from '../kernel/dispatch-upgrade'
import { projectDispatcherLiveness } from '../kernel/dispatcher-liveness'
import { repositoryReadFactsReducer } from '../kernel/read-facts'
import {
  resolutionOnlyWrites,
  upgradeGenerationRun,
  upgradeGenerationWrites,
  upgradeRuntime,
  upgradeTarget,
} from '../testing/upgrade-generations'
import {
  projectRepositoryStatus,
  renderRepositoryStatus,
  repositoryStatusFromFacts,
  type RepositoryStatus,
} from './repository-status'

const write = (type: string, payload: unknown) =>
  validateRepositoryEventWrite({ actor: DISPATCHER, type, payload })
const log = (writes: RepositoryEventWrite[]) =>
  writes.map(
    (write, i) =>
      ({
        ...write,
        repo: 'repo',
        seq: i + 1,
        ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      }) as RepositoryEvent,
  )
const identity = (run: string, key: string, correlation = `fail-${run}-${key}`) => ({
  correlation,
  run,
  lineage: 'launcher',
  from: upgradeRuntime('1.0.0'),
  target: upgradeTarget(key),
})
const failure = (run: string, key = 'broken') =>
  write('dispatcher.upgrade-failed', { ...identity(run, key), reason: 'preflight process exited' })
const churn = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    resolutionOnlyWrites(`churn-${String(i).padStart(3, '0')}`, 'running'),
  ).flat()
const upgradeLines = (status: RepositoryStatus) =>
  renderRepositoryStatus(status).filter((line) => /^(resolved target|upgrade|handoff) /.test(line))

/** Every surface: events, and the saved repository facts that `--json` and
 * the operator repository-status read serve. */
function statuses(writes: RepositoryEventWrite[]): RepositoryStatus[] {
  const events = log(writes)
  const dispatcher = projectDispatcherLiveness(null, [], new Date(Date.UTC(2026, 0, 2)))
  return [
    projectRepositoryStatus('repo', events),
    repositoryStatusFromFacts('repo', repositoryReadFactsReducer.reduce(events), dispatcher),
  ]
}

test('status renders a bounded number of upgrade lines however long the history', () => {
  for (const count of [5, 50]) {
    const writes: RepositoryEventWrite[] = []
    for (let i = 0; i < count; i++) {
      writes.push(...upgradeGenerationWrites(i))
      if (i % 5 === 0) writes.push(failure(upgradeGenerationRun(i)))
    }
    writes.push(...resolutionOnlyWrites(upgradeGenerationRun(count), 'latest'))
    for (const status of statuses(writes)) {
      expect(upgradeLines(status).length).toBeLessThanOrEqual(4)
      expect(Object.keys(status.upgrades.runs).length).toBeLessThanOrEqual(UPGRADE_HISTORY_LIMIT)
      expect(status.upgradeStatus.current?.run).toBe(upgradeGenerationRun(count))
      expect(JSON.parse(JSON.stringify(status)).upgradeStatus).toEqual(
        JSON.parse(JSON.stringify(status.upgradeStatus)),
      )
    }
  }
})

test('the latest settled outcome from an earlier generation survives resolution-only churn', () => {
  const failed = upgradeGenerationRun(1)
  for (const prefix of [upgradeGenerationWrites(0), []]) {
    for (const status of statuses([
      ...prefix,
      ...resolutionOnlyWrites(failed, 'broken'),
      failure(failed),
      ...churn(20),
    ])) {
      expect(status.upgradeStatus.current?.run).toBe('churn-019')
      expect(status.upgradeStatus.previous?.run).toBe(failed)
      expect(status.upgradeStatus.previous?.outcome?.type).toBe('dispatcher.upgrade-failed')
      expect(status.upgradeStatus.previous?.superseded).toBe(true)
      const text = upgradeLines(status).join('\n')
      expect(text).toContain(`upgrade ${failed}: upgrade-failed (superseded); `)
      expect(text).toContain('preflight process exited')
      expect(text).not.toContain(`upgrade ${upgradeGenerationRun(0)}:`)
    }
  }
})

test('a failure is current only until later evidence supersedes it', () => {
  const run = 'run-a'
  const resolved = (key: string) =>
    write('dispatcher.upgrade-target-resolved', {
      run,
      lineage: 'launcher',
      target: upgradeTarget(key),
    })
  const base = [...resolutionOnlyWrites(run, 'broken'), failure(run)]
  // (a) a different target, and (b) the target already running.
  for (const key of ['different', 'running']) {
    for (const status of statuses([...base, resolved(key)])) {
      expect(status.upgradeStatus.current?.superseded).toBe(true)
      expect(upgradeLines(status)).toContain(
        `upgrade ${run}: upgrade-failed (superseded); source /origin; source /origin at broken; preflight process exited`,
      )
    }
  }
  // (c) a later successful preparation clears the failure.
  const prepared = write('dispatcher.target-prepared', {
    ...identity(run, 'fixed', 'retry'),
    to: upgradeRuntime('2.0.0'),
    root: '/cache/fixed',
    cacheId: 'fixed',
  })
  for (const status of statuses([...base, prepared])) {
    expect(status.upgradeStatus.current?.outcome?.type).toBe('dispatcher.target-prepared')
    expect(upgradeLines(status).join('\n')).not.toContain('upgrade-failed')
  }
  // (d) a later generation.
  for (const status of statuses([
    ...base,
    write('dispatcher.run-started', {
      run: 'run-b',
      lineage: 'launcher',
      pid: 1,
      effectiveConfig: { kind: 'config', rev: 0 },
      roleWarnings: [],
    }),
    write('dispatcher.tick-started', { run: 'run-b' }),
  ])) {
    expect(status.upgradeStatus.current).toBeUndefined()
    expect(status.upgradeStatus.previous).toMatchObject({ run, superseded: true })
    expect(upgradeLines(status)).toEqual([
      `upgrade ${run}: upgrade-failed (superseded); source /origin; source /origin at broken; preflight process exited`,
    ])
  }
  // (e) an unresolved current failure keeps its reason.
  for (const status of statuses(base)) {
    expect(status.upgradeStatus.current?.superseded).toBeUndefined()
    expect(upgradeLines(status)).toContain(
      `upgrade ${run}: upgrade-failed; source /origin; source /origin at broken; preflight process exited`,
    )
  }
})

test('previous is the latest settled outcome, not an unfinished predecessor handoff', () => {
  const [a, b, c] = [0, 1, 2].map(upgradeGenerationRun) as [string, string, string]
  const draining = upgradeGenerationWrites(1)
    .slice(0, -1)
    .map((write) =>
      write.type === 'dispatcher.handoff-started'
        ? { ...write, payload: { ...write.payload, builds: [{ slug: 'build', instance: 'e1' }] } }
        : write,
    ) as RepositoryEventWrite[]
  const preparedOnly = write('dispatcher.target-prepared', {
    ...identity('prepared-only', 'p', 'p'),
    to: upgradeRuntime('9.0.0'),
    root: '/cache/p',
    cacheId: 'p',
  })
  for (const status of statuses([
    ...upgradeGenerationWrites(0),
    ...draining,
    preparedOnly,
    write('dispatcher.upgrade-detected', identity('detected-only', 'd', 'd')),
    ...resolutionOnlyWrites(c, 'next'),
    write('dispatcher.upgrade-detected', identity(c, 'next', 'next')),
  ])) {
    expect(status.upgradeStatus.handoff).toMatchObject({ run: b, successor: c, takenOver: true })
    expect(status.upgradeStatus.current?.run).toBe(c)
    expect(status.upgradeStatus.previous?.run).toBe(a)
    expect(status.upgradeStatus.previous?.outcome?.type).toBe('dispatcher.handoff-completed')
    const lines = upgradeLines(status)
    expect(lines).toHaveLength(4)
    expect(lines[0]).toStartWith(
      `handoff ${b} (1.000001.0) → ${c} (1.000002.0): drain; taken over; draining build (e1)`,
    )
    expect(lines[1]).toStartWith(`resolved target ${c}: source; base main`)
    expect(lines[2]).toStartWith(`upgrade ${c}: upgrade-detected; `)
    expect(lines[3]).toStartWith(`upgrade ${a}: handoff-completed; `)
  }
})
