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
