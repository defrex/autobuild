import { expect, test } from 'bun:test'
import {
  repositoryRead,
  withRepositoryReads,
  knownRepositoryExists,
  recordRepositoryExistence,
} from './request-context'

test('repository reads share promises only within a nested invocation and store', async () => {
  const a = {},
    b = {}
  let calls = 0
  const read = async () => ++calls
  await withRepositoryReads(async () => {
    expect(await repositoryRead(a, 'repo', read)).toBe(1)
    await withRepositoryReads(async () => {
      expect(await repositoryRead(a, 'repo', read)).toBe(1)
      expect(await repositoryRead(b, 'repo', read)).toBe(2)
    })
    expect(await repositoryRead(a, 'other', read)).toBe(3)
  })
  expect(await withRepositoryReads(() => repositoryRead(a, 'repo', read))).toBe(4)
  expect(await repositoryRead(a, 'repo', read)).toBe(5)
})

test('null, failures and simultaneous invocations never leak into another request', async () => {
  const store = {}
  let calls = 0
  const read = async () => {
    calls++
    await Promise.resolve()
    return null
  }
  await Promise.all(
    Array.from({ length: 3 }, () =>
      withRepositoryReads(async () => {
        expect(await repositoryRead(store, 'repo', read)).toBeNull()
        expect(await repositoryRead(store, 'repo', read)).toBeNull()
      }),
    ),
  )
  expect(calls).toBe(3)
  await expect(
    withRepositoryReads(async () => {
      await repositoryRead(store, 'repo', read)
      throw new Error('request failed')
    }),
  ).rejects.toThrow('request failed')
  await withRepositoryReads(() => repositoryRead(store, 'repo', read))
  expect(calls).toBe(5)
})

test('existence evidence is scoped to a store and invocation without caching authorization', async () => {
  const a = {},
    b = {}
  await withRepositoryReads(async () => {
    recordRepositoryExistence(a, 'repo', true)
    expect(knownRepositoryExists(a, 'repo')).toBe(true)
    expect(knownRepositoryExists(b, 'repo')).toBeUndefined()
    await withRepositoryReads(async () => expect(knownRepositoryExists(a, 'repo')).toBe(true))
  })
  await withRepositoryReads(async () => expect(knownRepositoryExists(a, 'repo')).toBeUndefined())
})

test('hosted admission is single-flight including null and failures, separate from seeded identity', async () => {
  const { withHostedProjectContext, rememberProjectGeneration, projectAdmission } = await import(
    './request-context'
  )
  let calls = 0
  const read = async () => {
    calls++
    return { repo: 'repo', generation: 'g', registration: '1' }
  }
  await withHostedProjectContext(async () => {
    rememberProjectGeneration('repo', 'seed')
    const results = await Promise.all(
      Array.from({ length: 8 }, () => projectAdmission('repo', read)),
    )
    expect(calls).toBe(1)
    expect(results.every((r) => r?.generation === 'g')).toBe(true)
    await withHostedProjectContext(() => projectAdmission('repo', read))
    expect(calls).toBe(1)
    let missing = 0
    const absent = async () => {
      missing++
      return null
    }
    expect(await projectAdmission('missing', absent)).toBeNull()
    expect(await projectAdmission('missing', absent)).toBeNull()
    expect(missing).toBe(1)
    let failures = 0
    const fail = async () => {
      failures++
      throw new Error('database unavailable')
    }
    await expect(projectAdmission('failed', fail)).rejects.toThrow('database unavailable')
    await expect(projectAdmission('failed', fail)).rejects.toThrow('database unavailable')
    expect(failures).toBe(1)
  })
  await withHostedProjectContext(() => projectAdmission('repo', read))
  await projectAdmission('repo', read)
  expect(calls).toBe(3)
})

test('generation boundary deduplicates per executor and identity, never per request', async () => {
  const { admitProject } = await import('./project-lifecycle')
  const { withHostedProjectContext } = await import('./request-context')
  let queries = 0
  const executor = () =>
    (async () => {
      queries++
      return [{ generation: 'g' }]
    }) as unknown as import('./retry').Exec
  await withHostedProjectContext(async () => {
    const tx = executor()
    await Promise.all(
      Array.from({ length: 5 }, () => admitProject(tx, { repo: 'repo', generation: 'g' })),
    )
    expect(queries).toBe(1)
    await admitProject(executor(), { repo: 'repo', generation: 'g' })
    expect(queries).toBe(2)
    await admitProject(tx, { repo: 'other', generation: 'g' })
    expect(queries).toBe(3)
  })
})

test('detached work cannot reuse a completed invocation admission', async () => {
  const { withHostedProjectContext, projectAdmission } = await import('./request-context')
  let later!: () => Promise<unknown>
  let inNewRequest!: () => Promise<unknown>
  const { AsyncLocalStorage } = await import('node:async_hooks')
  await withHostedProjectContext(async () => {
    await projectAdmission('repo', async () => ({ repo: 'repo', generation: 'g' }))
    later = AsyncLocalStorage.bind(async () => projectAdmission('repo', async () => null))
    inNewRequest = AsyncLocalStorage.bind(async () =>
      withHostedProjectContext(() => projectAdmission('repo', async () => null)),
    )
  })
  expect(await later()).toBeNull()
  expect(await inNewRequest()).toBeNull()
})
