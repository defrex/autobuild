import { expect, test } from 'bun:test'
import { NO_DISPATCHER_RUN_LINE } from '../cli/dashboard/configuration'
import { dispatchWarningLines } from '../cli/dashboard/header'
import { buildDashboardFromProjected } from '../cli/dashboard/model'
import { DISPATCHER, humanActor, KERNEL } from '../events/envelope'
import { readRepositoryFacts } from '../store/reduced-reads'
import { MemoryBuildStore } from '../store/memory'
import { WebReadFencedError } from './protocol'
import { readOnlyStore } from './read-only'
import { RepositoryFrameSource } from './repository-source'

const REPO = '/web-source'

/** Record every store call by name, with its scope kind when it has one. */
function recording(store: MemoryBuildStore) {
  const calls: { name: string; args: unknown[] }[] = []
  const proxy = new Proxy(store, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        calls.push({ name: String(key), args })
        return Reflect.apply(value, target, args)
      }
    },
  })
  return { proxy, calls }
}

async function startRun(store: MemoryBuildStore, warnings: string[]) {
  const config = await store.putRepoArtifact(REPO, {
    kind: 'config',
    content: JSON.stringify({ capacity: 2 }),
  })
  await store.appendRepo(REPO, {
    actor: DISPATCHER,
    type: 'dispatcher.run-started',
    payload: {
      run: 'run-1',
      pid: 1,
      roleWarnings: warnings,
      effectiveConfig: { kind: config.kind, rev: config.revision },
    },
  })
}

test('an empty repository shows the no-run notice and an empty queue', async () => {
  const store = new MemoryBuildStore()
  await store.ensureRepo(REPO)
  const source = new RepositoryFrameSource(readOnlyStore(store), REPO)
  const result = await source.read()
  expect(result.frame.notice).toBe(NO_DISPATCHER_RUN_LINE)
  expect(result.frame.repository?.queued).toBe(0)
  expect(result.frame.repository?.repo).toBe(REPO)
  expect(result.live).toBe(false)
})

test('the header carries the dispatcher warnings, in the terminal dashboard terms', async () => {
  const store = new MemoryBuildStore()
  await store.ensureRepo(REPO)
  await startRun(store, ['role implement has no model'])
  await store.appendRepo(REPO, {
    actor: humanActor('op'),
    type: 'dispatcher.intake-set',
    payload: { enabled: false },
  })
  const source = new RepositoryFrameSource(readOnlyStore(store), REPO)
  const { frame, live } = await source.read()
  const facts = (await readRepositoryFacts(store, REPO)).value
  const status = facts.status!
  expect(live).toBe(true)
  expect(frame.notice).toBeUndefined()
  expect(frame.repository?.warningLines).toEqual(dispatchWarningLines(status))
  expect(frame.repository?.warningLines).toContain('role implement has no model')
  const warningLines = dispatchWarningLines(status)
  const model = buildDashboardFromProjected(
    [],
    {
      repo: REPO,
      queued: status.queued ?? 0,
      activeCount: 0,
      capacity: 2,
      ...(warningLines.length > 0 ? { warningLines } : {}),
    },
    facts,
    facts.upgrades,
  )
  const { active: _active, builds: _builds, ...repositoryMembers } = model
  expect(frame.repository).toEqual(repositoryMembers)
  expect(frame.repository?.drained).toBe(true)
  expect(JSON.parse(JSON.stringify(frame))).toEqual(frame)
})

test('an unchanged position reads only the position', async () => {
  const store = new MemoryBuildStore()
  await store.ensureRepo(REPO)
  await startRun(store, [])
  const { proxy, calls } = recording(store)
  const source = new RepositoryFrameSource(readOnlyStore(proxy), REPO)
  const first = await source.read()
  calls.length = 0
  const second = await source.read()
  expect(calls.map((call) => call.name)).toEqual(['getRepoChangePosition'])
  expect(second).toBe(first)
})

test('build activity never adds a build-scope read', async () => {
  const store = new MemoryBuildStore()
  await store.ensureRepo(REPO)
  await startRun(store, [])
  const { proxy, calls } = recording(store)
  const source = new RepositoryFrameSource(readOnlyStore(proxy), REPO)
  await source.read()
  const baseline = calls.map((call) => call.name)
  for (let i = 0; i < 5; i++) {
    const slug = `build-${i}`
    await store.createBuild({ slug, repo: REPO })
    await store.append(slug, {
      actor: KERNEL,
      type: 'runner.attached',
      payload: { instance: `runner-${i}`, host: 'host', resumedFromSeq: 0 },
    })
    calls.length = 0
    await source.read()
    expect(calls.map((call) => call.name)).toEqual(baseline)
    for (const call of calls) {
      const scope = call.args[0] as { kind?: string } | string
      if (typeof scope === 'object') expect(scope.kind).toBe('repo')
      else expect(scope).toBe(REPO)
    }
  }
})

test('a failed read retries at the old position', async () => {
  const store = new MemoryBuildStore()
  await store.ensureRepo(REPO)
  let fail = true
  const flaky = new Proxy(store, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if (key === 'getReducerValue')
        return (...args: unknown[]) => {
          if (fail) return Promise.reject(new Error('store unavailable'))
          return Reflect.apply(value, target, args)
        }
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const source = new RepositoryFrameSource(flaky, REPO)
  await expect(source.read()).rejects.toThrow('store unavailable')
  fail = false
  expect((await source.read()).frame.notice).toBe(NO_DISPATCHER_RUN_LINE)
})

test('a read whose subscribers left stops before its next store stage', async () => {
  const store = new MemoryBuildStore()
  await store.ensureRepo(REPO)
  const { proxy, calls } = recording(store)
  const source = new RepositoryFrameSource(readOnlyStore(proxy), REPO)
  let admitted = true
  const gated = new Proxy(proxy, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if (key !== 'getRepoChangePosition') return value
      return async (...args: unknown[]) => {
        const position = await Reflect.apply(value, target, args)
        admitted = false // the last tab leaves while the position read is out
        return position
      }
    },
  })
  const fencedSource = new RepositoryFrameSource(readOnlyStore(gated), REPO)
  await expect(fencedSource.read(() => admitted)).rejects.toBeInstanceOf(WebReadFencedError)
  expect(calls.map((call) => call.name)).toEqual(['getRepoChangePosition'])
  // Not admitted at all: no store read happens.
  calls.length = 0
  await expect(source.read(() => false)).rejects.toBeInstanceOf(WebReadFencedError)
  expect(calls).toEqual([])
})
