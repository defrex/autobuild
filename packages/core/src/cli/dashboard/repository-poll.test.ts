import { expect, test } from 'bun:test'
import { RepositoryPollCache } from './repository-poll'

test('snapshot gate samples before reads, retries failures and cancellation, and bounds mutable staleness', async () => {
  const cache = new RepositoryPollCache<number>()
  let position = '0'
  let now = 0
  let revision = 0
  let admitted = true
  let reads = 0
  let probes = 0
  let fail = false
  let duringRead: (() => void) | undefined
  const refresh = () =>
    cache.refresh({
      position: async () => {
        probes++
        return position
      },
      now: () => now,
      get revision() {
        return revision
      },
      enabled: true,
      admitted: () => admitted,
      read: async () => {
        reads++
        duringRead?.()
        if (fail) throw new Error('failed')
        return reads
      },
    })
  expect(await refresh()).toBe(1)
  expect(await refresh()).toBe(1)
  expect(reads).toBe(1)
  expect(probes).toBe(2)
  position = '1'
  fail = true
  await expect(refresh()).rejects.toThrow('failed')
  fail = false
  expect(await refresh()).toBe(3)
  position = '2'
  duringRead = () => {
    position = '3'
  }
  expect(await refresh()).toBe(4)
  duringRead = undefined
  expect(await refresh()).toBe(5)
  now = 9999
  expect(await refresh()).toBe(5)
  now = 10000
  expect(await refresh()).toBe(6)
  revision++
  expect(await refresh()).toBe(7)
  position = '4'
  duringRead = () => {
    admitted = false
  }
  expect(await refresh()).toBeUndefined()
  admitted = true
  duringRead = undefined
  expect(await refresh()).toBe(9)
  await Promise.all([refresh(), refresh()])
  expect(reads).toBe(9)
})
