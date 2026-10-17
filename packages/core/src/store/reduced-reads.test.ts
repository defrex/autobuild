import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SqliteBuildStore } from './local/store'
import { MemoryBlobStore } from './memory'
import { readPersistedBuildDigests } from './reduced-reads'
import type { BuildRecord, BuildStore } from './types'

test('persisted digest reads overlap and preserve discovery order', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started: string[] = []
  const records = ['a', 'b'].map((slug) => ({ slug, repo: 'repo' }) as BuildRecord)
  const reading = readPersistedBuildDigests(
    {
      listBuilds: async () => {
        throw new Error('records already scoped')
      },
      getReducerValue: async (scope) => {
        if (scope.kind !== 'build') throw new Error('expected build')
        started.push(scope.slug)
        if (scope.slug === 'a') await gate
        return { version: 3, cursor: 0, value: { observations: [] } }
      },
    },
    'repo',
    records,
  )
  try {
    await Promise.resolve()
    expect(started).toEqual(['a', 'b'])
  } finally {
    release()
  }
  expect([...(await reading).keys()]).toEqual(['a', 'b'])
})

test('SQLite digest discovery scopes records before reading persisted values', async () => {
  const database = new Database(':memory:')
  const store = new SqliteBuildStore({ database, blobs: new MemoryBlobStore() })
  try {
    await store.createBuild({ slug: 'selected', repo: 'repo' })
    await store.createBuild({ slug: 'foreign', repo: 'another-project' })
    Reflect.set(store, 'listBuilds', async () => {
      throw new Error('unscoped discovery')
    })
    const read = store.getReducerValue.bind(store)
    const slugs: string[] = []
    Reflect.set(store, 'getReducerValue', (...args: Parameters<BuildStore['getReducerValue']>) => {
      if (args[0].kind === 'build') slugs.push(args[0].slug)
      return read(...args)
    })
    expect([...(await store.getRepoBuildDigests('repo')).keys()]).toEqual(['selected'])
    expect(slugs).toEqual(['selected'])
  } finally {
    database.close()
  }
})
