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

for (const cadence of [500, 5000]) {
  test(`slow reads keep enrichment within ten seconds at ${cadence}ms cadence`, async () => {
    const cache = new RepositoryPollCache<number>()
    let now = 0
    const starts: number[] = []
    const enrichments: number[] = []
    for (let start = 0; start <= 30_000; start += cadence) {
      now = start
      await cache.refresh({
        position: async () => {
          now += 25
          return '0'
        },
        now: () => now,
        revision: 0,
        enabled: true,
        admitted: () => true,
        nextPollMs: cadence,
        read: async ({ fullEnrichment }) => {
          starts.push(start)
          if (fullEnrichment) enrichments.push(start)
          now += 100
          return start
        },
      })
    }
    expect(starts).toEqual([0, 10_000, 20_000, 30_000])
    expect(enrichments).toEqual([10_000, 20_000, 30_000])
  })
}

test('position-driven reads do not enrich unrelated rows or postpone the safety deadline', async () => {
  const cache = new RepositoryPollCache<number>()
  let now = 0
  let position = 0
  const enriched: number[] = []
  for (const start of [0, 1000, 4000, 9000, 10_000, 11_000]) {
    now = start
    await cache.refresh({
      position: async () => String(position++),
      now: () => now,
      revision: 0,
      enabled: true,
      admitted: () => true,
      read: async ({ fullEnrichment }) => {
        if (fullEnrichment) enriched.push(start)
        now += 100
        return start
      },
    })
  }
  expect(enriched).toEqual([10_000])
})

test('refreshes before a jittered next poll would cross the enrichment deadline', async () => {
  const cache = new RepositoryPollCache<number>()
  let now = 3
  const read = async () => now
  const options = {
    position: async () => '0',
    now: () => now,
    revision: 0,
    enabled: true,
    admitted: () => true,
    nextPollMs: 5000,
    read,
  }
  expect(await cache.refresh(options)).toBe(3)
  now = 5004
  expect(await cache.refresh(options)).toBe(5004)
})
