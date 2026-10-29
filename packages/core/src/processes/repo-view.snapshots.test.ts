/** The former work-bundle cache is replaced by adapter-owned persisted values. */
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SqliteBuildStore } from '../store/local/store'
import { MemoryBlobStore } from '../store/memory'
import {
  reducedReadBudget,
  countHistoricalRows,
  type ReducedReadCosts,
} from '../testing/reduced-read-budget'
import { readBuildFacts } from '../store/reduced-reads'
import { KERNEL, humanActor } from '../events/envelope'
import { reduceBuild } from '../kernel/reducer'

test('local SQL row budgets include adapter-internal persisted reads on fresh consumers', async () => {
  const database = new Database(':memory:')
  const blobs = new MemoryBlobStore()
  const store = new SqliteBuildStore({ database, blobs })
  const costs: ReducedReadCosts = { events: 0, metadata: 0, bytes: 0, historicalEvents: 0 }
  const wrapped = new WeakSet<object>()
  for (const name of ['query', 'prepare'] as const) {
    const original = database[name].bind(database)
    Reflect.set(database, name, (sql: string, ...params: unknown[]) => {
      const statement = Reflect.apply(original, database, [sql, ...params])
      if (wrapped.has(statement)) return statement
      const proxy = new Proxy(statement, {
        get(target, key) {
          const method = Reflect.get(target, key, target)
          if (typeof method !== 'function') return method
          return (...args: unknown[]) => {
            const result = Reflect.apply(method, target, args)
            if (key === 'all' || key === 'get' || key === 'values') {
              const rows =
                key === 'get' ? (result == null ? 0 : 1) : Array.isArray(result) ? result.length : 0
              const events =
                /\bFROM\s+["`]?(?:repo_)?events\b/i.test(sql) && !/\b(?:max|count)\s*\(/i.test(sql)
              costs[events ? 'events' : 'metadata'] += rows
              if (events)
                costs.historicalEvents += countHistoricalRows(
                  costs,
                  key === 'get' ? [result] : result,
                )
              costs.bytes += Buffer.byteLength(JSON.stringify(result) ?? '')
            }
            return result
          }
        },
      })
      wrapped.add(proxy)
      return proxy
    })
  }
  try {
    // A deliberate full-log read through Drizzle must trip the same budget.
    await store.ensureRepo('probe')
    await store.createBuild({ slug: 'probe', repo: 'probe' })
    for (let i = 0; i < 50; i++) {
      await store.append('probe', { actor: KERNEL, type: 'build.paused', payload: {} })
      await store.appendRepo('probe', {
        actor: humanActor('probe'),
        type: 'dispatcher.intake-set',
        payload: { enabled: true },
      })
    }
    costs.events = 0
    await store.getEvents('probe')
    expect(costs.events).toBe(50)
    await store.getRepoEvents('probe')
    expect(costs.events).toBe(100)
    expect(() => expect(costs.events).toBeLessThanOrEqual(6)).toThrow()
    await reducedReadBudget({
      store,
      costs,
      fresh: async () => new SqliteBuildStore({ database, blobs }),
    })
  } finally {
    database.close()
  }
})

test('cache loss and corrupt private cache rows recover output parity', async () => {
  const database = new Database(':memory:')
  const store = new SqliteBuildStore({ database, blobs: new MemoryBlobStore() })
  try {
    await store.createBuild({ slug: 'build', repo: 'repo' })
    await store.append('build', { actor: KERNEL, type: 'build.paused', payload: {} })
    const expected = reduceBuild(await store.getEvents('build'))
    expect((await readBuildFacts(store, 'build')).value.state).toEqual(expected)
    database.run("UPDATE reducer_snapshots SET state='{}'")
    expect((await readBuildFacts(store, 'build')).value.state).toEqual(expected)
    database.run('DELETE FROM reducer_snapshots')
    expect((await readBuildFacts(store, 'build')).value.state).toEqual(expected)
  } finally {
    database.close()
  }
})

test('cold presence reads consume canonical witnessed values with zero idle event rows', async () => {
  const { MemoryBuildStore } = await import('../store/memory')
  const { memoryRepositoryReadCounter } = await import('../testing/reduced-read-budget')
  const { DISPATCHER } = await import('../events/envelope')
  const { RepoViewStore } = await import('./repo-view')
  const { readRepositoryFacts } = await import('../store/reduced-reads')
  for (const count of [10, 1000]) {
    const store = new MemoryBuildStore()
    await store.ensureRepo('repo')
    for (let i = 0; i < count; i++) {
      await store.createBuild({ slug: `historical-${i}`, repo: 'repo' })
      await store.append(`historical-${i}`, {
        actor: DISPATCHER,
        type: 'pr.merged',
        payload: { sha: (i + 100).toString(16).padStart(40, '0') },
      })
    }
    const payload = {
      destination: 'root:main',
      branch: 'main',
      head: 'a'.repeat(40),
      evidence: 'presence-v3:fixed',
      identities: ['build:blocker'],
      witness: { version: 1 as const, commits: ['a'.repeat(40)], identities: [] },
    }
    await store.appendRepo('repo', { actor: DISPATCHER, type: 'change-presence.observed', payload })
    await readRepositoryFacts(store, 'repo')
    const { readBuildDigests } = await import('../store/reduced-reads')
    await readBuildDigests(store, 'repo')
    const counter = memoryRepositoryReadCounter(store, 'repo')
    for (let i = 0; i < 3; i++) {
      const cold = new RepoViewStore(store, { repo: 'repo' })
      await cold.startJournal()
      expect(cold.repositoryFacts().presence['root:main']).toEqual(payload)
    }
    expect(counter.rows).toBe(0)
    expect(counter.buildRows).toBe(0)
    expect(counter.buildFactsCalls).toBe(0)
    expect(counter.reducedCalls).toBe(3)
  }
})
