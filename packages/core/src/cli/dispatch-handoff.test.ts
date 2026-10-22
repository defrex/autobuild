import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { openLocalStore } from '../store/local/store'
import { DISPATCHER } from '../events/envelope'
import { readHandoff } from './dispatch-handoff'
import { repositoryNeedsAttention } from './attention'
import { projectRepositoryStatus } from './repository-status'

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
    const events = await store.getRepoEvents(repo)
    expect(repositoryNeedsAttention(events.at(-1)!)).toBe(true)
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
