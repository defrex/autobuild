import { expect, test } from 'bun:test'
import { DISPATCHER } from '../events/envelope'
import { MemoryBuildStore } from '../store/memory'
import type { BuildStore } from '../store/types'
import { StandbyIdentityResolver } from './dispatcher-liveness'

async function fixture() {
  let now = new Date('2026-10-15T12:00:00Z')
  const store = new MemoryBuildStore({ clock: () => now })
  const repo = '/repo'
  await store.ensureRepo(repo)
  const start = (run: string, pid = 123) =>
    store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'dispatcher.run-started',
      payload: {
        run,
        pid,
        host: `${run}-host`,
        roleWarnings: [],
        effectiveConfig: { kind: 'config', rev: 0 },
      },
    })
  await start('owner')
  await store.claimRepoLease(repo, 'owner', 60000)
  await store.heartbeatRepo(repo, 'owner')
  await start('self') // bounded correlation excludes the owner's older start
  let fullReads = 0
  let boundedReads = 0
  let failReads = false
  let failRecord = false
  const counted = new Proxy(store, {
    get(target, key) {
      if (key === 'getReducerValue')
        return async (...args: Parameters<BuildStore['getReducerValue']>) => {
          boundedReads++
          if (failReads) throw new Error('unavailable')
          return target.getReducerValue(...args)
        }
      if (key === 'getRepoEvents')
        return async (repo: string, cursor = 0) => {
          if (cursor === 0) fullReads++
          if (failReads) throw new Error('unavailable')
          return target.getRepoEvents(repo, cursor)
        }
      if (key === 'getRepoStateEvents')
        return async (repo: string) => {
          boundedReads++
          if (failReads) throw new Error('unavailable')
          return target.getRepoStateEvents(repo)
        }
      if (key === 'getRepo')
        return async (repo: string) => {
          if (failRecord) throw new Error('unavailable')
          return target.getRepo(repo)
        }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as BuildStore
  return {
    store,
    repo,
    start,
    resolver: new StandbyIdentityResolver(counted, repo),
    reads: () => ({ fullReads, boundedReads }),
    fail: () => {
      failReads = true
    },
    failRecord: () => {
      failRecord = true
    },
    advance: (ms: number) => {
      now = new Date(+now + ms)
    },
    now: () => now,
  }
}

test('standby refresh caches correlation, recomputes age, isolates peers and clears own ownership', async () => {
  const f = await fixture()
  const refresh = () => f.resolver.refresh('self', 'owner', f.now())
  const first = await Promise.all([refresh(), refresh()])
  expect(first[0]).toContain('owner; pid 123; host owner-host; started ')
  expect(first[0]).toContain('heartbeat 0ms ago')
  expect(f.reads()).toEqual({ fullReads: 0, boundedReads: 1 })
  for (let i = 1; i <= 3; i++) {
    f.advance(1000)
    expect(await refresh()).toContain(`heartbeat ${i * 1000}ms ago`)
  }
  expect(f.reads()).toEqual({ fullReads: 0, boundedReads: 1 })
  await f.store.releaseRepoLease(f.repo, 'owner')
  await f.start('peer', 456)
  await f.start('later') // force the permitted second full lookup
  await f.store.claimRepoLease(f.repo, 'peer', 60000)
  expect(await refresh()).toContain('peer; pid 456; host peer-host;')
  expect(f.reads().fullReads).toBe(0)
  await f.store.releaseRepoLease(f.repo, 'peer')
  await f.store.claimRepoLease(f.repo, 'owner', 60000)
  expect(await refresh()).toContain('owner; pid 123;')
  expect(f.reads().fullReads).toBe(0)
  await f.store.releaseRepoLease(f.repo, 'owner')
  await f.store.claimRepoLease(f.repo, 'self', 60000)
  expect(await refresh()).toBeUndefined()
  expect(f.reads().fullReads).toBe(0)
})

test('negative lookups stay cached; later deltas fill identity without another replay', async () => {
  const f = await fixture()
  f.fail()
  for (let i = 0; i < 3; i++)
    expect(await f.resolver.refresh('self', 'owner', f.now())).toBe('owner')
  expect(f.reads().boundedReads).toBe(1)
  f.resolver.ingest(await f.store.getRepoEvents(f.repo))
  expect(await f.resolver.refresh('self', 'owner', f.now())).toContain('owner; pid 123;')
  expect(f.reads().boundedReads).toBe(1)
  f.failRecord()
  expect(await f.resolver.refresh('self', 'owner', f.now())).toBe('owner')
  expect(await f.resolver.refresh('self', undefined, f.now())).toBeUndefined()
})

test('seed starts avoid correlation and expired leases retain attributable identity', async () => {
  const f = await fixture()
  f.resolver.ingest(await f.store.getRepoEvents(f.repo))
  f.advance(61000)
  expect(await f.resolver.refresh('self', 'owner', f.now())).toContain('heartbeat 61000ms ago')
  expect(f.reads()).toEqual({ fullReads: 0, boundedReads: 0 })
})

test('missing starts permit only one full lookup per holder', async () => {
  const f = await fixture()
  await f.store.releaseRepoLease(f.repo, 'owner')
  await f.store.claimRepoLease(f.repo, 'missing', 60000)
  for (let i = 0; i < 3; i++)
    expect(await f.resolver.refresh('self', 'missing', f.now())).toBe('missing')
  expect(f.reads()).toEqual({ fullReads: 0, boundedReads: 2 })
})

test('frontend warm history never correlates; cold history remembers a holder once', async () => {
  const f = await fixture()
  let bounded = 0
  let full = 0
  const state = f.store.getRepoStateEvents.bind(f.store)
  const events = f.store.getRepoEvents.bind(f.store)
  f.store.getRepoStateEvents = async (repo) => {
    bounded++
    return state(repo)
  }
  f.store.getRepoEvents = async (repo, since) => {
    full++
    return events(repo, since)
  }
  const remembered: import('../events/repository').RepositoryEvent[] = []
  const completeness: boolean[] = []
  const warm = new StandbyIdentityResolver(f.store, f.repo, {
    allowLookup: () => false,
    remember: () => {},
  })
  expect(await warm.refresh('self', undefined, f.now())).toBe('owner')
  expect([bounded, full]).toEqual([0, 0])
  const cold = new StandbyIdentityResolver(f.store, f.repo, {
    allowLookup: () => true,
    remember: (events, complete) => {
      remembered.push(...events)
      completeness.push(complete)
    },
  })
  expect(await cold.refresh('self', undefined, f.now())).toContain('pid 123')
  await cold.refresh('self', undefined, f.now())
  expect([bounded, full]).toEqual([0, 0])
  expect(completeness).toEqual([false])
  warm.ingest(remembered)
  expect(await warm.refresh('self', undefined, f.now())).toContain('pid 123')
  await f.store.releaseRepoLease(f.repo, 'owner')
  await f.start('next-owner', 456)
  await f.store.claimRepoLease(f.repo, 'next-owner', 60000)
  expect(await cold.refresh('self', undefined, f.now())).toContain('pid 456')
  expect(completeness).toEqual([false, false])
  expect([bounded, full]).toEqual([0, 0])
})

test('successful lease samples select self and no holder; metadata failures preserve selection', async () => {
  const f = await fixture()
  const selected: (string | undefined)[] = []
  let fail = false
  const getRepo = f.store.getRepo.bind(f.store)
  f.store.getRepo = async (repo) => {
    if (fail) throw new Error('offline')
    return getRepo(repo)
  }
  const resolver = new StandbyIdentityResolver(f.store, f.repo, {
    selectHolder: (holder) => selected.push(holder),
    allowLookup: () => true,
    remember: (events) =>
      expect(
        events.every((e) => e.type === 'dispatcher.run-started' && e.payload.run === 'owner'),
      ).toBe(true),
  })
  await resolver.refresh('self', undefined, f.now())
  fail = true
  await resolver.refresh('self', 'owner', f.now())
  expect(selected).toEqual(['owner'])
  fail = false
  await f.store.releaseRepoLease(f.repo, 'owner')
  await resolver.refresh('self', undefined, f.now())
  await f.store.claimRepoLease(f.repo, 'self', 60000)
  await resolver.refresh('self', undefined, f.now())
  expect(selected).toEqual(['owner', undefined, 'self'])
})
