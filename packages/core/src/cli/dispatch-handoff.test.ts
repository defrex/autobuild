import { temporaryDirectories as ownTempDirectories } from '../testing/temp-directories'
import { afterEach, expect, test } from 'bun:test'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { openLocalStore } from '../store/local/store'
import { DISPATCHER } from '../events/envelope'
import { readHandoff } from './dispatch-handoff'
import { repositoryNeedsAttention } from './attention'
import { projectRepositoryStatus, renderRepositoryStatus } from './repository-status'

const mkdtemp = ownTempDirectories(afterEach)

test('handoff reader follows only its stopped run and rejects operator stop; status exposes failure', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ab-handoff-'))
  const storePath = join(repo, '.autobuild/store'),
    store = openLocalStore(storePath)
  const cacheId = `2.0.0-${'a'.repeat(64)}`,
    root = join(repo, '.autobuild/runtime', cacheId, 'distribution')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'tsconfig.json'), '{}\n')
  await writeFile(
    join(dirname(root), 'runtime.json'),
    JSON.stringify({ version: 1, id: cacheId, root, digest: 'a'.repeat(64) }),
  )
  const identity = {
    correlation: 'u',
    run: 'old',
    lineage: 'launcher',
    from: {
      version: '1.0.0',
      commit: 'unknown',
      source: { kind: 'package' as const, location: '/old' },
    },
    target: { mode: 'installed' as const, key: 'two', version: '2.0.0', source: '/original' },
  }
  const handoff = { ...identity, to: { ...identity.from, version: '2.0.0' }, root, cacheId }
  const launch = {
    version: 1 as const,
    runtimeRoot: '/old',
    checkout: repo,
    originalInstall: '/original',
    run: 'old',
    lineage: 'launcher',
  }
  const argv = ['dispatch', '--store', storePath]
  try {
    await store.ensureRepo(repo)
    await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'dispatcher.handoff-started',
      payload: handoff,
    })
    expect(await readHandoff(launch, argv, {})).toBeUndefined()
    await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'dispatcher.run-stopped',
      payload: { run: 'old', outcome: 'normal', exitCode: 0 },
    })
    expect(await readHandoff(launch, argv, {})).toEqual(handoff)
    expect(await readHandoff({ ...launch, run: 'foreign' }, argv, {})).toBeUndefined()
    expect(await readHandoff({ ...launch, lineage: 'foreign' }, argv, {})).toBeUndefined()
    await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'dispatcher.stop-requested',
      payload: { run: 'old', signal: 'SIGINT' },
    })
    expect(await readHandoff(launch, argv, {})).toBeUndefined()
    await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'dispatcher.upgrade-failed',
      payload: { ...identity, run: 'foreign', reason: 'registry unavailable' },
    })
    await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'dispatcher.upgrade-target-resolved',
      payload: {
        run: 'foreign',
        lineage: 'launcher',
        target: {
          mode: 'source',
          key: 'content',
          source: '/repo/.git',
          base: 'main',
          sha: 'b'.repeat(40),
        },
      },
    })
    const events = await store.getRepoEvents(repo)
    expect(repositoryNeedsAttention(events.at(-1)!)).toBe(false)
    expect(
      repositoryNeedsAttention(events.findLast((e) => e.type === 'dispatcher.upgrade-failed')!),
    ).toBe(true)
    const status = projectRepositoryStatus(repo, events)
    expect(renderRepositoryStatus(status).join('\n')).toContain(
      `source; base main; source /repo/.git at ${'b'.repeat(40)}`,
    )
    expect(
      JSON.parse(JSON.stringify(status)).upgrades.runs.foreign.resolved.payload.target.sha,
    ).toBe('b'.repeat(40))
    expect(
      projectRepositoryStatus(repo, events).upgrades.runs.foreign?.failure?.payload.reason,
    ).toBe('registry unavailable')
  } finally {
    await store.close()
    await rm(repo, { recursive: true, force: true })
  }
})

test('a held generation journal remains readable after invalid configuration edits', async () => {
  const { readUpgradeProjection } = await import('./dispatch-handoff')
  const repo = await mkdtemp(join(tmpdir(), 'ab-journal-binding-'))
  const storePath = join(repo, '.autobuild/store')
  const store = openLocalStore(storePath)
  const launch = {
    version: 1 as const,
    runtimeRoot: '/old',
    checkout: repo,
    originalInstall: '/install',
    run: 'old',
    lineage: 'launcher',
  }
  try {
    await store.ensureRepo(repo)
    await store.claimRepoLease(repo, 'old', 60_000)
    const projection = await readUpgradeProjection(launch, ['dispatch', '--store', storePath], {})
    expect(projection.journal).toEqual({ storeRef: storePath, repo })
    await writeFile(join(repo, 'autobuild.toml'), 'store = [invalid TOML')
    const bound = await readUpgradeProjection(
      { ...launch, journal: projection.journal },
      ['dispatch'],
      {},
    )
    expect(bound.journal).toEqual(projection.journal)
    expect((await store.getRepo(repo))!.lease!.holder).toBe('old')
  } finally {
    await store.close()
    await rm(repo, { recursive: true, force: true })
  }
})

test('operator stop wins over preflight failure publication', async () => {
  const { recordPreflightFailure } = await import('./dispatch-handoff')
  const repo = await mkdtemp(join(tmpdir(), 'ab-preflight-stop-'))
  const storePath = join(repo, '.autobuild/store')
  const store = openLocalStore(storePath)
  const runtime = {
    version: '1.0.0',
    commit: 'unknown',
    source: { kind: 'package' as const, location: '/old' },
  }
  const prepared = {
    run: 'old',
    correlation: 'upgrade',
    lineage: 'launcher',
    from: runtime,
    to: { ...runtime, version: '2.0.0' },
    root: '/new',
    cacheId: 'new',
    target: { mode: 'installed' as const, key: 'new', source: '/install' },
  }
  try {
    await store.ensureRepo(repo)
    await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'dispatcher.target-prepared',
      payload: prepared,
    })
    await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'dispatcher.stop-requested',
      payload: { run: 'old', signal: 'SIGINT' },
    })
    await recordPreflightFailure(
      {
        version: 1,
        runtimeRoot: '/old',
        checkout: repo,
        run: 'old',
        lineage: 'launcher',
        journal: { repo, storeRef: storePath },
      },
      ['dispatch'],
      {},
      'upgrade',
      'preflight process exited',
    )
    expect(
      (await store.getRepoEvents(repo)).some((event) => event.type === 'dispatcher.upgrade-failed'),
    ).toBe(false)
  } finally {
    await store.close()
    await rm(repo, { recursive: true, force: true })
  }
})

test('restored generation validates takeover, deposits once under authority, and exposes hold until clear/restart', async () => {
  const { recordRuntimeRollback } = await import('./dispatch-handoff')
  const { captureRuntimeIdentity } = await import('../runtime-identity')
  const { projectDispatcherLiveness } = await import('../kernel/dispatcher-liveness')
  const repo = await mkdtemp(join(tmpdir(), 'ab-rollback-record-'))
  const store = openLocalStore(join(repo, '.autobuild/store'))
  const root = async (version: string, digest: string) => {
    const id = `${version}-${digest.repeat(64)}`,
      root = join(repo, '.autobuild/runtime', id, 'distribution')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'tsconfig.json'), '{}\n')
    await writeFile(join(root, 'package.json'), JSON.stringify({ version }))
    await writeFile(
      join(dirname(root), 'runtime.json'),
      JSON.stringify({ version: 1, id, root, digest: digest.repeat(64) }),
    )
    return { root, cacheId: id }
  }
  try {
    const restored = await root('1.0.0', 'a'),
      failed = await root('2.0.0', 'b')
    await store.ensureRepo(repo)
    const handoff = {
      correlation: 'h',
      run: 'old',
      lineage: 'launcher',
      from: captureRuntimeIdentity(restored.root),
      to: captureRuntimeIdentity(failed.root),
      root: failed.root,
      cacheId: failed.cacheId,
      target: { mode: 'installed' as const, key: 'two', source: '/install', version: '2.0.0' },
    }
    await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'dispatcher.target-prepared',
      payload: handoff,
    })
    await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'dispatcher.yield-requested',
      payload: { ...handoff, successor: 'new', mode: 'drain', evidence: 'compatible' },
    })
    await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'dispatcher.handoff-started',
      payload: {
        ...handoff,
        successor: 'new',
        mode: 'drain',
        startedAt: new Date().toISOString(),
        deadline: new Date(Date.now() + 60_000).toISOString(),
        builds: [],
      },
    })
    await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'dispatcher.terminal-released',
      payload: handoff,
    })
    const takeover = await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'dispatcher.takeover',
      payload: { ...handoff, successor: 'new' },
    })
    const rollback = {
      version: 1 as const,
      correlation: 'rollback',
      lineage: 'launcher',
      predecessor: 'old',
      successor: 'new',
      handoff: 'h',
      takeoverAt: takeover.ts,
      failures: 3 as const,
      failed,
      restored,
    }
    const launch = {
      version: 1 as const,
      rollbackVersion: 1 as const,
      rollback,
      runtimeRoot: restored.root,
      checkout: repo,
      run: 'restored',
      lineage: 'launcher',
    }
    await expect(recordRuntimeRollback(store, repo, launch, 'restored')).rejects.toThrow(
      'authority',
    )
    await store.claimRepoLease(repo, 'restored', 60_000)
    await expect(
      recordRuntimeRollback(
        store,
        repo,
        { ...launch, rollback: { ...rollback, successor: 'foreign' } },
        'restored',
      ),
    ).rejects.toThrow('matching durable takeover')
    await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'dispatcher.run-started',
      payload: {
        run: 'restored',
        lineage: 'launcher',
        pid: process.pid,
        effectiveConfig: { kind: 'config', rev: 0 },
        roleWarnings: [],
      },
    })
    await recordRuntimeRollback(store, repo, launch, 'restored')
    await recordRuntimeRollback(store, repo, launch, 'restored')
    let events = await store.getRepoEvents(repo)
    const rollbacks = events.filter((e) => e.type === 'dispatcher.runtime-rolled-back')
    expect(rollbacks).toHaveLength(1)
    expect(repositoryNeedsAttention(rollbacks[0]!)).toBe(true)
    const status = async () => {
      events = await store.getRepoEvents(repo)
      return projectRepositoryStatus(
        repo,
        events,
        projectDispatcherLiveness(await store.getRepo(repo), events, new Date()),
      )
    }
    expect((await status()).rollbackHold?.payload.failed.version).toBe('2.0.0')
    expect(renderRepositoryStatus(await status()).join('\n')).toContain(
      'runtime rollback: 2.0.0 → 1.0.0',
    )
    // A new operator lineage ignores a still-active old hold without deleting history.
    await store.releaseRepoLease(repo, 'restored')
    await store.claimRepoLease(repo, 'operator-before-clear', 60_000)
    await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'dispatcher.run-started',
      payload: {
        run: 'operator-before-clear',
        lineage: 'new-launcher',
        pid: process.pid,
        effectiveConfig: { kind: 'config', rev: 0 },
        roleWarnings: [],
      },
    })
    expect((await status()).rollbackHold).toBeUndefined()
    expect((await status()).upgrades.holds.launcher).toBeDefined()
    await store.releaseRepoLease(repo, 'operator-before-clear')
    await store.claimRepoLease(repo, 'restored', 60_000)
    await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'dispatcher.rollback-hold-cleared',
      payload: {
        correlation: 'rollback',
        run: 'restored',
        lineage: 'launcher',
        target: { ...handoff.target, key: 'three' },
      },
    })
    await rm(dirname(failed.root), { recursive: true, force: true })
    await recordRuntimeRollback(store, repo, launch, 'restored')
    expect((await status()).rollbackHold).toBeUndefined()
    expect((await status()).upgrades.lastRollback).toBeDefined()
    await store.releaseRepoLease(repo, 'restored')
    await store.claimRepoLease(repo, 'operator', 60_000)
    await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'dispatcher.run-started',
      payload: {
        run: 'operator',
        lineage: 'new-launcher',
        pid: process.pid,
        effectiveConfig: { kind: 'config', rev: 0 },
        roleWarnings: [],
      },
    })
    expect((await status()).rollbackHold).toBeUndefined()
    expect((await status()).upgrades.lastRollback).toBeDefined()
  } finally {
    await store.close()
    await rm(repo, { recursive: true, force: true })
  }
})

for (const invalid of ['version', 'value'] as const) {
  test(`upgrade helper reports ${invalid} incompatibility on stderr without projection JSON`, async () => {
    const { prepareLaunchRuntime } = await import('./dispatch-launcher')
    const { releasePreparedRuntime } = await import('./dispatch-runtime-use')
    const { distributionRoot } = await import('../distribution')
    const { resolveReducerValue } = await import('../store/reducer-values')
    const checkout = await mkdtemp(join(tmpdir(), 'ab-incompatible-reader-'))
    const version = resolveReducerValue(
      { kind: 'repo', repo: 'repo' },
      { reducer: 'dispatchUpgrade' },
    ).reducer.version
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname.endsWith('/reducer-values'))
          return Response.json({
            version: version + (invalid === 'version' ? 1 : 0),
            cursor: 0,
            value: null,
          })
        return Response.json({
          repo: 'repo',
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        })
      },
    })
    const runtime = await prepareLaunchRuntime(distributionRoot(), distributionRoot(), checkout)
    try {
      const child = Bun.spawn(
        [process.execPath, join(runtime.root, 'bin/ab-dispatch-generation.ts'), '--read-upgrade'],
        {
          env: {
            ...process.env,
            AB_DISPATCH_GENERATION: JSON.stringify({
              version: 1,
              runtimeRoot: runtime.root,
              checkout,
              originalInstall: distributionRoot(),
              run: 'run',
              lineage: 'lineage',
              journal: { storeRef: server.url.toString(), repo: 'repo' },
            }),
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(code).not.toBe(0)
      expect(stdout).toBe('')
      expect(stderr).toContain('incompatible reducer dispatchUpgrade')
      expect(stderr).toContain(`client version ${version}`)
      expect(stderr).toContain(`server version ${version + (invalid === 'version' ? 1 : 0)}`)
    } finally {
      server.stop(true)
      releasePreparedRuntime(runtime.root)
    }
  }, 30_000)
}
test('conditional helpers refresh durable facts and revalidate target files without journal reads', async () => {
  const { MemoryBuildStore } = await import('../store/memory')
  const { readUpgradeProjection } = await import('./dispatch-handoff')
  const { conditionalUpgradeClient } = await import('./dispatch-launch-contract')
  const repo = await mkdtemp(join(tmpdir(), 'ab-conditional-handoff-'))
  const store = new MemoryBuildStore()
  await store.ensureRepo(repo)
  const cacheId = `2.0.0-${'c'.repeat(64)}`
  const root = join(repo, '.autobuild/runtime', cacheId, 'distribution')
  const runtime = {
    version: '1.0.0',
    commit: 'unknown',
    source: { kind: 'package' as const, location: '/old' },
  }
  const handoff = {
    run: 'old',
    lineage: 'launcher',
    correlation: 'h',
    from: runtime,
    to: { ...runtime, version: '2.0.0' },
    root,
    cacheId,
    target: { mode: 'installed' as const, key: 'two', source: '/install' },
  }
  const launch = {
    version: 1 as const,
    runtimeRoot: '/old',
    checkout: repo,
    run: 'old',
    lineage: 'launcher',
    journal: { repo, storeRef: '/memory' },
  }
  const client = conditionalUpgradeClient()
  const calls: string[] = []
  let injectAppend = false
  let queryIdentity = 'reader'
  const check = () =>
    client(queryIdentity, (condition) =>
      readUpgradeProjection(
        launch,
        ['dispatch'],
        {},
        {
          condition,
          openStore: () =>
            new Proxy(store, {
              get(target, key) {
                if (key === 'close') return async () => {}
                const value = Reflect.get(target, key, target)
                if (typeof value !== 'function') return value
                return async (...args: unknown[]) => {
                  calls.push(String(key))
                  const result = await value.apply(target, args)
                  if (key === 'getRepoChangePosition' && injectAppend) {
                    injectAppend = false
                    await store.appendRepo(repo, {
                      actor: DISPATCHER,
                      type: 'dispatcher.target-prepared',
                      payload: handoff,
                    })
                  }
                  return result
                }
              },
            }),
        },
      ),
    )
  expect((await check()).handoff).toBeNull()
  // An append after sampling cannot be acknowledged by this older position.
  injectAppend = true
  queryIdentity = 'fresh-reader'
  expect((await check()).handoff).toBeNull()
  calls.length = 0
  expect((await check()).handoff).toBeNull()
  expect(calls).toContain('getReducerValue')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'tsconfig.json'), '{}\n')
  const writeIdentity = (id: string) =>
    writeFile(
      join(dirname(root), 'runtime.json'),
      JSON.stringify({ version: 1, id, root, digest: 'c'.repeat(64) }),
    )
  await writeIdentity(cacheId)
  calls.length = 0
  expect((await check()).handoff).toEqual(handoff)
  expect(calls).toEqual(['getRepoChangePosition'])
  await writeIdentity('wrong')
  calls.length = 0
  await expect(check()).rejects.toThrow('invalid runtime metadata')
  expect(calls).toEqual(['getRepoChangePosition'])
  await writeIdentity(cacheId)
  expect((await check()).handoff).toEqual(handoff)
  await store.appendRepo(repo, {
    actor: DISPATCHER,
    type: 'dispatcher.yield-requested',
    payload: { ...handoff, successor: 'new', mode: 'drain', evidence: 'compatible' },
  })
  await store.appendRepo(repo, {
    actor: DISPATCHER,
    type: 'dispatcher.handoff-started',
    payload: {
      ...handoff,
      successor: 'new',
      mode: 'drain',
      startedAt: new Date().toISOString(),
      deadline: new Date(Date.now() + 60_000).toISOString(),
      builds: [],
    },
  })
  expect((await check()).accepted).toBe(true)
  await store.appendRepo(repo, {
    actor: DISPATCHER,
    type: 'dispatcher.terminal-released',
    payload: handoff,
  })
  await store.appendRepo(repo, {
    actor: DISPATCHER,
    type: 'dispatcher.takeover',
    payload: { ...handoff, successor: 'new' },
  })
  expect((await check()).takeover).toBe(true)
  await store.appendRepo(repo, {
    actor: DISPATCHER,
    type: 'dispatcher.stop-requested',
    payload: { run: 'old', signal: 'SIGINT' },
  })
  expect((await check()).handoff).toBeNull()
})

test('conditional rollback acknowledgement follows local retention on an unchanged position', async () => {
  const { MemoryBuildStore } = await import('../store/memory')
  const { readUpgradeProjection } = await import('./dispatch-handoff')
  const { conditionalUpgradeClient } = await import('./dispatch-launch-contract')
  const { syncRollbackRetention } = await import('./dispatch-runtime-use')
  const repo = await mkdtemp(join(tmpdir(), 'ab-conditional-rollback-'))
  const cache = join(repo, '.autobuild/runtime')
  const cacheId = `2.0.0-${'d'.repeat(64)}`
  const root = join(cache, cacheId, 'distribution')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'tsconfig.json'), '{}\n')
  await writeFile(
    join(dirname(root), 'runtime.json'),
    JSON.stringify({ version: 1, id: cacheId, root, digest: 'd'.repeat(64) }),
  )
  const store = new MemoryBuildStore()
  await store.ensureRepo(repo)
  const runtime = {
    version: '1.0.0',
    commit: 'unknown',
    source: { kind: 'package' as const, location: '/old' },
  }
  await store.appendRepo(repo, {
    actor: DISPATCHER,
    type: 'dispatcher.runtime-rolled-back',
    payload: {
      correlation: 'rollback',
      run: 'restored',
      lineage: 'launcher',
      predecessor: 'old',
      successor: 'new',
      handoff: 'h',
      takeoverAt: new Date().toISOString(),
      failures: 3,
      failed: { ...runtime, version: '2.0.0' },
      restored: runtime,
      failedRoot: root,
      restoredRoot: '/old',
      target: { mode: 'installed', key: 'two', source: '/install' },
      reason: 'fixture',
    },
  })
  const launch = {
    version: 1 as const,
    runtimeRoot: '/old',
    checkout: repo,
    run: 'restored',
    lineage: 'launcher',
    journal: { repo, storeRef: '/memory' },
    rollback: {
      version: 1 as const,
      correlation: 'rollback',
      lineage: 'launcher',
      predecessor: 'old',
      successor: 'new',
      handoff: 'h',
      takeoverAt: new Date().toISOString(),
      failures: 3 as const,
      failed: { root, cacheId },
      restored: { root: '/old', cacheId: 'old' },
    },
  }
  const client = conditionalUpgradeClient()
  let reads = 0
  const check = () =>
    client('rollback', (condition) =>
      readUpgradeProjection(
        launch,
        ['dispatch'],
        {},
        {
          condition,
          openStore: () =>
            new Proxy(store, {
              get(target, key) {
                if (key === 'close') return async () => {}
                const value = Reflect.get(target, key, target)
                if (typeof value !== 'function') return value
                return (...args: unknown[]) => {
                  reads++
                  return value.apply(target, args)
                }
              },
            }),
        },
      ),
    )
  expect((await check()).rollbackRetained).toBe(false)
  syncRollbackRetention(cache, 'launcher', root)
  reads = 0
  expect((await check()).rollbackRetained).toBe(true)
  expect(reads).toBe(1)
  syncRollbackRetention(cache, 'launcher')
  reads = 0
  expect((await check()).rollbackRetained).toBe(false)
  expect(reads).toBe(1)
})
