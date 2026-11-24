import type { BuildStore } from '../store/types'
import { expect, test } from 'bun:test'
import { RepoViewStore } from './repo-view'
import { MemoryBuildStore } from '../store/memory'
import { KERNEL, DISPATCHER, humanActor } from '../events/envelope'
import { reduceBuild } from '../kernel/reducer'

async function setup() {
  const store = new MemoryBuildStore()
  await store.ensureRepo('repo')
  await store.createBuild({ slug: 'build', repo: 'repo' })
  const view = new RepoViewStore(store, { repo: 'repo', resident: true })
  return { store, view }
}

test('current facts use persisted values without hydrating raw windows', async () => {
  const { store, view } = await setup()
  await store.append('build', {
    actor: KERNEL,
    type: 'runner.attached',
    payload: { instance: 'runner', host: 'host' },
  })
  const expected = reduceBuild(await store.getEvents('build'))
  store.getEvents = async () => {
    throw new Error('raw build read')
  }
  store.getRepoEvents = async () => {
    throw new Error('raw journal read')
  }
  store.getRepoStateEvents = async () => {
    throw new Error('raw journal subset')
  }
  await view.refresh()
  expect(await view.buildState('build')).toEqual(expected)
  expect((await view.buildFacts('build')).state).toEqual(expected)
  expect(view.repositoryFacts().settings.intake).toBe(true)
})

test('an own append and a lost conditional append never hide the next delta', async () => {
  const { store, view } = await setup()
  await view.refresh()
  await view.buildFacts('build')
  await view.append('build', { actor: KERNEL, type: 'build.paused', payload: {} })
  expect((await view.buildState('build')).status).toBe('paused')
  await store.append('build', { actor: KERNEL, type: 'build.resumed', payload: {} })
  expect(
    await view.appendIfCurrent('build', 0, { actor: KERNEL, type: 'build.paused', payload: {} }),
  ).toBeNull()
  expect(await view.buildState('build')).toEqual(reduceBuild(await store.getEvents('build')))
})

test('source chains order a concurrent fact read before an append', async () => {
  const { store, view } = await setup()
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const read = store.getReducerValue.bind(store)
  let hold = true
  store.getReducerValue = async (...args) => {
    const result = await read(...args)
    if (hold && args[0].kind === 'build') {
      hold = false
      entered()
      await gate
    }
    return result
  }
  const before = view.buildState('build')
  await started
  const write = view.append('build', { actor: KERNEL, type: 'build.paused', payload: {} })
  release()
  expect((await before).status).toBe('queued')
  await write
  expect((await view.buildState('build')).status).toBe('paused')
})

test('journal facts follow own writes, foreign writes on refresh, and absent repositories', async () => {
  const store = new MemoryBuildStore()
  const view = new RepoViewStore(store, { repo: 'repo' })
  await view.startJournal()
  expect(view.journalRecorded()).toBe(false)
  expect(await store.getRepo('repo')).toBeNull()
  await view.ensureRepo('repo')
  await view.appendRepo('repo', {
    actor: humanActor('human'),
    type: 'dispatcher.intake-set',
    payload: { enabled: false },
  })
  expect(view.repositoryFacts().settings.intake).toBe(false)
  await store.appendRepo('repo', {
    actor: humanActor('human'),
    type: 'dispatcher.intake-set',
    payload: { enabled: true },
  })
  await view.refreshJournal()
  expect(view.repositoryFacts().settings.intake).toBe(true)
})

test('metadata invalidates on writes and refresh detects foreign completion', async () => {
  const { store, view } = await setup()
  await view.refresh()
  await view.createBuild({ slug: 'new', repo: 'repo' })
  expect((await view.listBuilds()).map((record) => record.slug)).toContain('new')
  await view.append('new', { actor: KERNEL, type: 'build.aborted', payload: {} })
  expect((await view.getRepoBuildDigests('repo')).get('new')?.terminal).toBe('aborted')
  await store.append('build', {
    actor: DISPATCHER,
    type: 'build.completed',
    payload: { outcome: 'merged' },
  })
  await view.refresh()
  expect((await view.getRepoBuildDigests('repo')).get('build')?.terminal).toBe('done')
})

test('the open listing is served within an epoch and re-read after a write or refresh', async () => {
  const { store, view } = await setup()
  let reads = 0
  const listOpenBuilds = store.listOpenBuilds.bind(store)
  store.listOpenBuilds = async (repo) => {
    reads++
    return listOpenBuilds(repo)
  }
  const slugs = async () => (await view.listOpenBuilds('repo')).map(({ record }) => record.slug)
  await view.refreshOpen()
  expect(await slugs()).toEqual(['build'])
  expect(reads).toBe(1)
  await view.append('build', {
    actor: DISPATCHER,
    type: 'build.completed',
    payload: { outcome: 'merged' },
  })
  expect(await slugs()).toEqual([])
  expect(reads).toBe(2)
  await store.createBuild({ slug: 'foreign', repo: 'repo' })
  expect(await slugs()).toEqual([])
  await view.refreshOpen()
  expect(await slugs()).toEqual(['foreign'])
  expect(reads).toBe(3)
})

test('raw cursor reads pass through event output, independently of facts', async () => {
  const { store, view } = await setup()
  const first = await store.append('build', { actor: KERNEL, type: 'build.paused', payload: {} })
  const second = await store.append('build', { actor: KERNEL, type: 'build.resumed', payload: {} })
  await view.buildFacts('build')
  expect(await view.getEvents('build', first.seq)).toEqual([second])
})

test('own appends refresh only the changed digest; leases do not repeat discovery', async () => {
  const store = new MemoryBuildStore()
  await store.ensureRepo('repo')
  await store.createBuild({ slug: 'a', repo: 'repo' })
  await store.createBuild({ slug: 'b', repo: 'repo' })
  let batches = 0
  const singles: string[] = []
  const counted = new Proxy(store, {
    get(target, key) {
      if (key === 'getRepoBuildDigests')
        return async (repo: string) => {
          batches++
          return target.getRepoBuildDigests(repo)
        }
      if (key === 'getReducerValue')
        return async (...args: Parameters<BuildStore['getReducerValue']>) => {
          if (args[1].reducer === 'buildDigest' && args[0].kind === 'build')
            singles.push(args[0].slug)
          return target.getReducerValue(...args)
        }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const view = new RepoViewStore(counted, { repo: 'repo' })
  await view.refresh()
  await view.append('a', { actor: KERNEL, type: 'build.aborted', payload: {} })
  expect((await view.getRepoBuildDigests('repo')).get('a')?.terminal).toBe('aborted')
  await view.claimLease('a', 'holder', 60000)
  await view.heartbeat('a', 'holder')
  await view.releaseLease('a', 'holder')
  await view.getRepoBuildDigests('repo')
  expect(batches).toBe(1)
  expect(singles).toEqual(['a'])
})

test('journal refresh samples metadata once and publishes facts atomically', async () => {
  const { store, view } = await setup()
  const calls: string[] = []
  const backing = new Proxy(store, {
    get(target, key) {
      const value = Reflect.get(target, key)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        calls.push(String(key))
        return value.apply(target, args)
      }
    },
  })
  const counted = new RepoViewStore(backing, { repo: 'repo' })
  await counted.refreshJournal()
  expect(calls).toEqual(['getRepo', 'getReducerValue'])
  await view.appendRepo('repo', {
    actor: humanActor('human'),
    type: 'dispatcher.intake-set',
    payload: { enabled: false },
  })
  expect(counted.repositoryFacts().settings.intake).toBe(true)
  const read = store.getReducerValue.bind(store)
  store.getReducerValue = async () => {
    throw new Error('unavailable')
  }
  await expect(counted.refreshJournal()).rejects.toThrow('unavailable')
  expect(counted.journalRecorded()).toBe(true)
  expect(counted.repositoryFacts().settings.intake).toBe(true)
  store.getReducerValue = read
  await counted.refreshJournal()
  expect(counted.repositoryFacts().settings.intake).toBe(false)
})

for (const operation of ['append', 'artifact', 'tick'] as const) {
  test(`committed ${operation} retains its result when facts refresh fails`, async () => {
    const { store, view } = await setup()
    await view.refresh()
    const snapshot = view.repositoryFacts()
    const original = store.getReducerValue.bind(store)
    store.getReducerValue = async () => {
      throw new Error('read unavailable')
    }
    const event = {
      actor: DISPATCHER,
      type: 'dispatcher.tick-failed' as const,
      payload: { run: 'r', error: 'failure' },
    }
    if (operation === 'tick') {
      await store.claimRepoLease('repo', 'r', 60_000)
      await store.beginRepoTick('repo', 'r')
    }
    const write = async () =>
      operation === 'append'
        ? view.appendRepo('repo', event)
        : operation === 'artifact'
          ? view.appendRepoWithArtifacts('repo', [], () => event)
          : view.finishRepoTick('repo', 'r', { outcome: 'failed', error: 'failure' }, [
              {
                actor: DISPATCHER,
                type: 'dispatcher.tick-started',
                payload: {
                  run: 'r',
                  startedAt: (await store.getRepo('repo'))!.tick!.open!.startedAt,
                },
              },
              event,
            ])
    const error = await write().catch((error) => error)
    expect(error.name).toBe('CommittedRefreshError')
    expect(error.result).toBeDefined()
    expect(view.repositoryFacts()).toEqual(snapshot)
    await expect(view.refreshJournal()).rejects.toThrow('read unavailable')
    store.getReducerValue = original
    await view.refreshJournal()
    expect(await store.getRepoHighWater('repo')).toBeGreaterThan(0)
    store.appendRepo = async () => {
      throw new Error('write unavailable')
    }
    await expect(view.appendRepo('repo', event)).rejects.toThrow('write unavailable')
  })
}

test('the retained tick sample tracks the journal refresh read and committed finishes', async () => {
  const { store, view } = await setup()
  await view.startJournal()
  expect(view.lastTickSample()).toBeUndefined()
  await store.claimRepoLease('repo', 'run', 60_000)
  await store.beginRepoTick('repo', 'run')
  const forgeRequests = { total: 0, unattributed: 0, builds: [], complete: false }
  const boundaries = (error: string) => [
    { actor: DISPATCHER, type: 'dispatcher.tick-started' as const, payload: { run: 'run' } },
    { actor: DISPATCHER, type: 'dispatcher.tick-failed' as const, payload: { run: 'run', error } },
  ]
  await store.finishRepoTick(
    'repo',
    'run',
    { outcome: 'failed', error: 'a', forgeRequests },
    boundaries('a'),
  )
  let getRepo = 0
  const read = store.getRepo.bind(store)
  store.getRepo = async (...args) => {
    getRepo++
    return read(...args)
  }
  await view.refreshJournal()
  expect(getRepo).toBe(1)
  expect(view.lastTickSample()).toMatchObject({ outcome: 'failed', error: 'a', forgeRequests })
  const sample = view.lastTickSample()!
  if (sample.outcome === 'failed') sample.error = 'mutated'
  expect(view.lastTickSample()).toMatchObject({ error: 'a' })
  await view.beginRepoTick('repo', 'run')
  await view.finishRepoTick('repo', 'run', { outcome: 'failed', error: 'b' }, boundaries('b'))
  expect(view.lastTickSample()).toMatchObject({ outcome: 'failed', error: 'b' })
})

test('served facts reuse this epoch’s retained read until a write or refresh', async () => {
  const { store, view } = await setup()
  let reads = 0
  const read = store.getReducerValue.bind(store)
  store.getReducerValue = async (...args) => {
    if (args[1].reducer === 'buildReadFacts') reads++
    return read(...args)
  }
  await view.refresh()
  // Not retained: every served read reads.
  await view.buildFacts('build')
  await view.servedBuildFacts('build')
  expect(reads).toBe(2)
  view.retainBuildFacts(true)
  const first = await view.buildFacts('build')
  expect(await view.servedBuildFacts('build')).toBe(first)
  expect(reads).toBe(3)
  // An own append ends serving; the retained read stays available.
  await view.append('build', { actor: KERNEL, type: 'build.paused', payload: {} })
  expect(view.retainedBuildFacts('build')).toBe(first)
  expect((await view.servedBuildFacts('build')).state.status).toBe('paused')
  expect(reads).toBe(4)
  await view.servedBuildFacts('build')
  expect(reads).toBe(4)
  // A foreign write surfaces on the next epoch, never through a served read.
  await store.append('build', { actor: KERNEL, type: 'build.resumed', payload: {} })
  await view.refresh()
  expect(view.retainedBuildFacts('build')).toBeUndefined()
  expect((await view.servedBuildFacts('build')).state.status).not.toBe('paused')
  expect(reads).toBe(5)
  view.retainBuildFacts(false)
  expect(view.retainedBuildFacts('build')).toBeUndefined()
})

test('onRepositoryFacts observes each successful journal read, never a failed one, and cannot fail it', async () => {
  const store = new MemoryBuildStore()
  await store.ensureRepo('repo')
  const seen: unknown[] = []
  let throwing = false
  const view = new RepoViewStore(store, {
    repo: 'repo',
    onRepositoryFacts: (facts) => {
      seen.push(facts)
      if (throwing) throw new Error('sink failed')
    },
  })
  await view.startJournal()
  expect(seen).toEqual([view.repositoryFacts()])
  await store.appendRepo('repo', {
    actor: humanActor('operator'),
    type: 'dispatcher.intake-set',
    payload: { enabled: false },
  })
  throwing = true
  await view.refreshJournal()
  expect(seen).toHaveLength(2)
  expect(seen[1]).toEqual(view.repositoryFacts())
  expect(view.repositoryFacts().settings.intake).toBe(false)
  const read = store.getRepo.bind(store)
  store.getRepo = async () => {
    throw new Error('store down')
  }
  await expect(view.refreshJournal()).rejects.toThrow('store down')
  expect(seen).toHaveLength(2)
  store.getRepo = read
})
