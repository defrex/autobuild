import { expect, test } from 'bun:test'
import { MemoryBuildStore } from '../store/memory'
import { DISPATCHER, KERNEL } from '../events/envelope'
import { readDispatchUpgrade } from '../store/reduced-reads'
import { manualClock } from '../testing/fixed'
import { authorizeRemoteHandoffs, recoverDispatchDrain } from './dispatch-drain-recovery'
import { UPGRADE_HISTORY_LIMIT } from './dispatch-upgrade'
import {
  resolutionOnlyWrites,
  upgradeGenerationRun,
  upgradeGenerationWrites,
  upgradeRuntime,
  upgradeTarget,
} from '../testing/upgrade-generations'

for (const recoveryRun of [undefined, 'restored'])
  for (const knownEnd of [false, true])
    test(`successor reconstructs crashed retirement after execution fencing (end before authorization: ${knownEnd}, recovery: ${recoveryRun})`, async () => {
      const clock = manualClock()
      const store = new MemoryBuildStore({ clock })
      const runtime = {
        version: '1.0.0',
        commit: 'unknown',
        source: { kind: 'package' as const, location: '/old' },
      }
      const handoff = {
        correlation: 'upgrade',
        run: 'old',
        lineage: 'launcher',
        from: runtime,
        to: { ...runtime, version: '2.0.0' },
        root: '/new',
        cacheId: 'new',
        target: { mode: 'installed' as const, key: 'new', source: '/install' },
      }
      await store.ensureRepo('repo')
      await store.createBuild({ slug: 'build', repo: 'repo' })
      await store.createBuild({ slug: 'guest', repo: 'repo' })
      await store.append('guest', {
        actor: DISPATCHER,
        type: 'execution.started',
        payload: { provider: 'vercel-sandbox', workspaceRef: 'sandbox', instance: 'remote' },
      })
      const attach = await store.append('guest', {
        actor: KERNEL,
        type: 'runner.attached',
        payload: { instance: 'remote', host: 'guest' },
      })
      await store.append('guest', {
        actor: KERNEL,
        type: 'runner.runtime-recorded',
        payload: { instance: 'remote', attachedSeq: attach.seq, runtime },
      })
      await store.claimLease('guest', 'remote', 60_000)
      const remoteLease = (await store.getBuild('guest'))!.lease
      if (knownEnd)
        await store.append('build', {
          actor: DISPATCHER,
          type: 'execution.ended',
          payload: { instance: 'execution', workspaceRef: 'ws', outcome: 'completed' },
        })
      await store.append('build', {
        actor: DISPATCHER,
        type: 'execution.drain-authorized',
        payload: { correlation: 'upgrade', run: 'old', runtime, instance: 'execution' },
      })
      await store.claimLease('build', 'execution', 1_000)
      await store.claimRepoLease('repo', 'new', 60_000)
      await store.appendRepo('repo', {
        actor: DISPATCHER,
        type: 'dispatcher.target-prepared',
        payload: handoff,
      })
      await store.appendRepo('repo', {
        actor: DISPATCHER,
        type: 'dispatcher.yield-requested',
        payload: { ...handoff, successor: 'new', mode: 'drain', evidence: 'same schema' },
      })
      await store.appendRepo('repo', {
        actor: DISPATCHER,
        type: 'dispatcher.handoff-started',
        payload: {
          ...handoff,
          successor: 'new',
          mode: 'drain',
          startedAt: clock().toISOString(),
          deadline: new Date(clock().getTime() + 900_000).toISOString(),
          builds: [{ slug: 'build', instance: 'execution' }],
          remoteBuilds: [{ slug: 'guest', instance: 'remote', runtime }],
        },
      })
      await store.appendRepo('repo', {
        actor: DISPATCHER,
        type: 'dispatcher.terminal-released',
        payload: handoff,
      })
      if (recoveryRun) {
        await store.releaseRepoLease('repo', 'new')
        await store.claimRepoLease('repo', recoveryRun, 60_000)
        // A foreign run cannot settle even after acquiring authority.
        expect(await recoverDispatchDrain(store, 'repo', 'old', clock(), recoveryRun)).toBe(false)
        await store.appendRepo('repo', {
          actor: DISPATCHER,
          type: 'dispatcher.run-started',
          payload: {
            run: recoveryRun,
            lineage: 'launcher',
            pid: 1,
            effectiveConfig: { kind: 'config', rev: 0 },
            roleWarnings: [],
          },
        })
      }
      expect(await recoverDispatchDrain(store, 'repo', 'old', clock(), recoveryRun)).toBe(false)
      expect((await readDispatchUpgrade(store, 'repo')).value.runs.old!.outstanding).toEqual({
        build: 'execution',
      })
      clock.advance(1_001)
      expect(await recoverDispatchDrain(store, 'repo', 'old', clock(), recoveryRun)).toBe(true)
      const count = (await store.getRepoEvents('repo')).length
      expect(await recoverDispatchDrain(store, 'repo', 'old', clock(), recoveryRun)).toBe(true)
      expect((await store.getRepoEvents('repo')).length).toBe(count)
      const state = (await readDispatchUpgrade(store, 'repo')).value.runs.old!
      expect(state.outstanding).toEqual({})
      expect(state.drained).toBe(knownEnd ? 1 : 0)
      expect(state.suspended).toBe(0)
      expect(state.completed?.payload.mode).toBe('drain')
      await authorizeRemoteHandoffs(store, 'repo')
      expect((await store.getBuild('guest'))!.lease).toEqual(remoteLease)
      await store.close()
    })

test('remote authorization survives completed retirement, late attach and successive targets', async () => {
  const { authorizeRemoteHandoffs } = await import('./dispatch-drain-recovery')
  const { KERNEL } = await import('../events/envelope')
  const clock = manualClock()
  const store = new MemoryBuildStore({ clock })
  const runtime = {
    version: '1.0.0',
    commit: 'unknown',
    source: { kind: 'package' as const, location: '/opt/autobuild' },
  }
  await store.ensureRepo('repo')
  await store.createBuild({ slug: 'guest', repo: 'repo' })
  await store.append('guest', {
    actor: DISPATCHER,
    type: 'execution.started',
    payload: {
      provider: 'vercel-sandbox',
      workspaceRef: 'sandbox',
      instance: 'guest-1',
      environmentId: 'env',
      sessionId: 'session',
      commandId: 'command',
    },
  })
  await store.claimLease('guest', 'guest-1', 60_000)
  const lease = (await store.getBuild('guest'))!.lease
  async function handoff(run: string, version: string) {
    const identity = {
      correlation: run,
      run,
      lineage: 'launcher',
      from: { ...runtime, source: { ...runtime.source, location: '/host/cache' } },
      to: { ...runtime, version, source: { ...runtime.source, location: `/host/${version}` } },
      root: '/new',
      cacheId: version,
      target: { mode: 'installed' as const, key: version, source: '/install' },
    }
    await store.appendRepo('repo', {
      actor: DISPATCHER,
      type: 'dispatcher.target-prepared',
      payload: identity,
    })
    await store.appendRepo('repo', {
      actor: DISPATCHER,
      type: 'dispatcher.yield-requested',
      payload: { ...identity, successor: `${run}-next`, mode: 'drain', evidence: 'compatible' },
    })
    await store.appendRepo('repo', {
      actor: DISPATCHER,
      type: 'dispatcher.handoff-started',
      payload: {
        ...identity,
        successor: `${run}-next`,
        mode: 'drain',
        startedAt: clock().toISOString(),
        deadline: clock().toISOString(),
        builds: [],
        remoteBuilds: [{ slug: 'guest', instance: 'guest-1' }],
      },
    })
    await store.appendRepo('repo', {
      actor: DISPATCHER,
      type: 'dispatcher.handoff-completed',
      payload: { ...identity, successor: `${run}-next` },
    })
  }
  await handoff('old', '1.1.0')
  await authorizeRemoteHandoffs(store, 'repo')
  expect(
    (await store.getEvents('guest')).filter((e) => e.type === 'execution.drain-authorized'),
  ).toHaveLength(0)
  // More resolution-only generations than the retention window cannot evict
  // the newest accepted handoff before the guest attaches.
  for (let i = 0; i < 20; i++)
    for (const write of resolutionOnlyWrites(`restart-${String(i).padStart(3, '0')}`, '1.1.0'))
      await store.appendRepo('repo', write)
  const retained = (await readDispatchUpgrade(store, 'repo')).value
  expect(retained.runs.old?.handoff).toBeDefined()
  expect(Object.keys(retained.runs).length).toBeLessThanOrEqual(UPGRADE_HISTORY_LIMIT)
  const attach = await store.append('guest', {
    actor: KERNEL,
    type: 'runner.attached',
    payload: { instance: 'guest-1', host: 'sandbox' },
  })
  await store.append('guest', {
    actor: KERNEL,
    type: 'runner.runtime-recorded',
    payload: { instance: 'guest-1', attachedSeq: attach.seq, runtime },
  })
  await authorizeRemoteHandoffs(store, 'repo')
  await authorizeRemoteHandoffs(store, 'repo')
  let events = await store.getEvents('guest')
  expect(events.filter((e) => e.type === 'execution.drain-authorized')).toHaveLength(1)
  expect(events.find((e) => e.type === 'execution.drain-authorized')!.payload).toMatchObject({
    runtime,
    targetRuntime: { version: '1.1.0' },
  })
  expect((await store.getBuild('guest'))!.lease).toEqual(lease)
  expect((await readDispatchUpgrade(store, 'repo')).value.runs.old!.outstanding).toEqual({})
  expect((await readDispatchUpgrade(store, 'repo')).value.runs.old!.completed).toBeDefined()
  await handoff('new', '1.2.0')
  await authorizeRemoteHandoffs(store, 'repo')
  await authorizeRemoteHandoffs(store, 'repo')
  events = await store.getEvents('guest')
  expect(events.filter((e) => e.type === 'execution.drain-authorized')).toHaveLength(2)
  expect(
    events.filter((e) => e.type === 'execution.drain-authorized').at(-1)!.payload,
  ).toMatchObject({ correlation: 'new', targetRuntime: { version: '1.2.0' } })
  await store.append('guest', {
    actor: DISPATCHER,
    type: 'execution.ended',
    payload: { instance: 'guest-1', workspaceRef: 'sandbox', outcome: 'relaunch', exitCode: 0 },
  })
  await authorizeRemoteHandoffs(store, 'repo')
  expect(
    (await store.getEvents('guest')).filter((e) => e.type === 'execution.drain-authorized'),
  ).toHaveLength(2)
  await store.close()
})

test('historical remote captures add no build reads; repeated instances cost one read per open build', async () => {
  const store = new MemoryBuildStore()
  await store.ensureRepo('repo')
  await store.createBuild({ slug: 'live', repo: 'repo' })
  await store.append('live', {
    actor: DISPATCHER,
    type: 'execution.started',
    payload: { provider: 'vercel-sandbox', workspaceRef: 'ws', instance: 'current' },
  })
  const runtime = {
    version: '1.0.0',
    commit: 'unknown',
    source: { kind: 'package' as const, location: '/old' },
  }
  const upgrades: import('./dispatch-upgrade').DispatchUpgradeState = {
    runs: {},
    holds: {},
    lineages: {},
    rollbackIds: [],
  }
  for (let i = 0; i < 100; i++) {
    const run = `old-${i}`
    upgrades.runs[run] = {
      outstanding: {},
      drained: 0,
      suspended: 0,
      handoff: {
        repo: 'repo',
        seq: i + 1,
        ts: '2026-10-22T00:00:00Z',
        actor: DISPATCHER,
        type: 'dispatcher.handoff-started',
        payload: {
          correlation: run,
          run,
          lineage: 'launcher',
          from: runtime,
          to: { ...runtime, version: '2.0.0' },
          root: '/new',
          cacheId: 'new',
          target: { mode: 'installed', key: 'new', source: '/install' },
          remoteBuilds: [
            { slug: `finished-${i}`, instance: run },
            { slug: 'live', instance: run },
          ],
        },
      },
    }
  }
  let reads = 0
  const read = store.getReducerValue.bind(store)
  store.getReducerValue = async (...args) => {
    if (args[0].kind === 'build' && args[1].reducer === 'buildReadFacts') reads++
    return read(...args)
  }
  await authorizeRemoteHandoffs(store, 'repo', upgrades)
  expect(reads).toBe(1)
  await store.append('live', {
    actor: DISPATCHER,
    type: 'execution.ended',
    payload: { instance: 'current', workspaceRef: 'ws', outcome: 'completed' },
  })
  reads = 0
  await authorizeRemoteHandoffs(store, 'repo', upgrades)
  expect(reads).toBe(0)
  await store.close()
})

test('every upgrade decision answers the same after more history than the retention window', async () => {
  const { projectHandoffs } = await import('../cli/dashboard/handoff')
  const { projectRollback } = await import('../cli/dashboard/rollback')
  const { repositoryStatusFromFacts } = await import('../cli/repository-status')
  const { readDispatcherLiveness } = await import('../cli/dispatcher-liveness')
  const { readRepositoryFacts } = await import('../store/reduced-reads')
  const clock = manualClock()
  const store = new MemoryBuildStore({ clock })
  const repo = 'repo'
  const runtime = upgradeRuntime('1.000040.0')
  await store.ensureRepo(repo)
  for (let i = 0; i < 40; i++)
    for (const write of upgradeGenerationWrites(i)) await store.appendRepo(repo, write)
  await store.createBuild({ slug: 'build', repo })
  await store.claimLease('build', 'execution', 1_000)
  await store.createBuild({ slug: 'guest', repo })
  await store.append('guest', {
    actor: DISPATCHER,
    type: 'execution.started',
    payload: { provider: 'vercel-sandbox', workspaceRef: 'sandbox', instance: 'remote' },
  })
  const attach = await store.append('guest', {
    actor: KERNEL,
    type: 'runner.attached',
    payload: { instance: 'remote', host: 'guest' },
  })
  await store.append('guest', {
    actor: KERNEL,
    type: 'runner.runtime-recorded',
    payload: { instance: 'remote', attachedSeq: attach.seq, runtime },
  })
  await store.claimLease('guest', 'remote', 60_000)

  const [predecessor, current] = [upgradeGenerationRun(40), upgradeGenerationRun(41)]
  const start = (run: string) =>
    store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'dispatcher.run-started',
      payload: {
        run,
        lineage: 'launcher',
        pid: 1,
        effectiveConfig: { kind: 'config', rev: 0 },
        roleWarnings: [],
      },
    })
  const handoff = (run: string, successor: string, version: string) => ({
    correlation: `c-${run}`,
    run,
    lineage: 'launcher',
    from: runtime,
    to: upgradeRuntime(version),
    root: `/cache/${version}`,
    cacheId: version,
    target: upgradeTarget(version),
    successor,
  })
  const accept = async (run: string, successor: string, version: string, remote: boolean) => {
    const { successor: _, ...identity } = handoff(run, successor, version)
    await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'dispatcher.target-prepared',
      payload: identity,
    })
    await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'dispatcher.yield-requested',
      payload: { ...identity, successor, mode: 'drain', evidence: 'same schema' },
    })
    await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'dispatcher.handoff-started',
      payload: {
        ...identity,
        successor,
        mode: 'drain',
        startedAt: clock().toISOString(),
        deadline: new Date(clock().getTime() + 900_000).toISOString(),
        builds: remote ? [{ slug: 'build', instance: 'execution' }] : [],
        ...(remote && { remoteBuilds: [{ slug: 'guest', instance: 'remote', runtime }] }),
      },
    })
    await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'dispatcher.terminal-released',
      payload: identity,
    })
    await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'dispatcher.takeover',
      payload: { ...identity, successor },
    })
  }
  await start(predecessor)
  await store.appendRepo(repo, {
    actor: DISPATCHER,
    type: 'dispatcher.tick-started',
    payload: { run: predecessor },
  })
  await store.claimRepoLease(repo, current, 60_000)
  await start(current)
  await accept(predecessor, current, '1.000041.0', true)
  await store.appendRepo(repo, {
    actor: DISPATCHER,
    type: 'dispatcher.runtime-rolled-back',
    payload: {
      correlation: 'rollback',
      run: current,
      lineage: 'launcher',
      predecessor,
      successor: current,
      handoff: `c-${predecessor}`,
      takeoverAt: clock().toISOString(),
      failures: 3,
      failed: upgradeRuntime('1.000041.0'),
      restored: runtime,
      failedRoot: '/cache/1.000041.0',
      restoredRoot: '/cache/1.000040.0',
      target: upgradeTarget('1.000041.0'),
      reason: 'three failed exits',
    },
  })

  let state = (await readDispatchUpgrade(store, repo)).value
  expect(Object.keys(state.runs).length).toBeLessThanOrEqual(UPGRADE_HISTORY_LIMIT)
  expect(state.runs[upgradeGenerationRun(0)]).toBeUndefined()
  // Watch takeover detection and dashboard draining rows.
  expect(state.runs[predecessor]?.takeover?.payload.successor).toBe(current)
  expect([...projectHandoffs(state).draining]).toEqual(['build'])
  // The effective rollback hold for the current lineage.
  expect(projectRollback(state)?.correlation).toBe('rollback')
  const { dispatcher } = await readDispatcherLiveness(store, repo, clock())
  const facts = (await readRepositoryFacts(store, repo)).value
  expect(repositoryStatusFromFacts(repo, facts, dispatcher).rollbackHold?.payload.correlation).toBe(
    'rollback',
  )
  // Remote authorization for an execution that is still open.
  await authorizeRemoteHandoffs(store, repo)
  const authorized = (await store.getEvents('guest')).filter(
    (e) => e.type === 'execution.drain-authorized',
  )
  expect(authorized.map((e) => e.payload)).toMatchObject([
    { correlation: `c-${predecessor}`, targetRuntime: { version: '1.000041.0' } },
  ])
  // Drain recovery of a predecessor whose handoff has not completed.
  expect(await recoverDispatchDrain(store, repo, predecessor, clock(), current)).toBe(false)
  clock.advance(1_001)
  expect(await recoverDispatchDrain(store, repo, predecessor, clock(), current)).toBe(true)
  state = (await readDispatchUpgrade(store, repo)).value
  expect(state.runs[predecessor]?.completed?.payload.successor).toBe(current)
  // Release and takeover of the current generation.
  await accept(current, upgradeGenerationRun(42), '1.000042.0', false)
  state = (await readDispatchUpgrade(store, repo)).value
  expect(state.runs[current]?.released).toBeDefined()
  expect(state.runs[current]?.takeover?.payload.successor).toBe(upgradeGenerationRun(42))
  expect(state.authoritativeRun).toBe(upgradeGenerationRun(42))
  await store.close()
})
