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
