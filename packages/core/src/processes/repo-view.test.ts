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
