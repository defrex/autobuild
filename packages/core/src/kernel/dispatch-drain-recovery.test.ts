import { expect, test } from 'bun:test'
import { MemoryBuildStore } from '../store/memory'
import { DISPATCHER, KERNEL } from '../events/envelope'
import { readDispatchUpgrade } from '../store/reduced-reads'
import { manualClock } from '../testing/fixed'
import { authorizeRemoteHandoffs, recoverDispatchDrain } from './dispatch-drain-recovery'

for (const knownEnd of [false, true])
  test(`successor reconstructs crashed retirement after execution fencing (end before authorization: ${knownEnd})`, async () => {
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
    expect(await recoverDispatchDrain(store, 'repo', 'old', clock())).toBe(false)
    expect((await readDispatchUpgrade(store, 'repo')).value.runs.old!.outstanding).toEqual({
      build: 'execution',
    })
    clock.advance(1_001)
    expect(await recoverDispatchDrain(store, 'repo', 'old', clock())).toBe(true)
    const count = (await store.getRepoEvents('repo')).length
    expect(await recoverDispatchDrain(store, 'repo', 'old', clock())).toBe(true)
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
