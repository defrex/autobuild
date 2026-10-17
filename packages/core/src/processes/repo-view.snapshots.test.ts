/** The former work-bundle cache is replaced by adapter-owned persisted values. */
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SqliteBuildStore } from '../store/local/store'
import { MemoryBlobStore } from '../store/memory'
import { reducedReadBudget } from '../testing/reduced-read-budget'
import { readBuildFacts } from '../store/reduced-reads'
import { KERNEL } from '../events/envelope'
import { reduceBuild } from '../kernel/reducer'

test('local SQL row budgets include adapter-internal persisted reads on fresh consumers', async () => {
  const database = new Database(':memory:')
  const blobs = new MemoryBlobStore()
  const store = new SqliteBuildStore({ database, blobs })
  const costs = { events: 0, metadata: 0 }
  const query = database.query.bind(database)
  Reflect.set(database, 'query', (sql: string) => {
    const statement = query(sql)
    return new Proxy(statement, {
      get(target, key) {
        const method = Reflect.get(target, key, target)
        if (typeof method !== 'function') return method
        return (...args: unknown[]) => {
          const result = Reflect.apply(method, target, args)
          if (key === 'all' || key === 'get' || key === 'values') {
            const rows =
              key === 'get' ? (result == null ? 0 : 1) : Array.isArray(result) ? result.length : 0
            const events = /SELECT \* FROM (?:repo_)?events\b/i.test(sql)
            costs[events ? 'events' : 'metadata'] += rows
          }
          return result
        }
      },
    })
  })
  try {
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
