import { expect, test } from 'bun:test'
import { DISPATCHER } from '../events/envelope'
import { MemoryBuildStore } from '../store/memory'
import { manualClock } from '../testing/fixed'
import { projectDispatcherLiveness } from './dispatcher-liveness'
import { readDispatcherLiveness } from '../cli/dispatcher-liveness'

async function start(store: MemoryBuildStore, repo: string, run: string) {
  await store.appendRepo(repo, {
    actor: DISPATCHER,
    type: 'dispatcher.run-started',
    payload: {
      run,
      pid: 123,
      host: 'test-host',
      effectiveConfig: { kind: 'config', rev: 0 },
      roleWarnings: [],
    },
  })
}

test('lease health is independent of progress and heartbeat is attributable only to its holder', async () => {
  const clock = manualClock()
  const store = new MemoryBuildStore({ clock })
  const repo = 'repo'
  await store.ensureRepo(repo)
  await start(store, repo, 'A')
  await store.claimRepoLease(repo, 'A', 1000)
  await store.heartbeatRepo(repo, 'A')
  await store.releaseRepoLease(repo, 'A')
  clock.advance(2000)
  await start(store, repo, 'B')
  await store.claimRepoLease(repo, 'B', 1000)
  let result = await readDispatcherLiveness(store, repo, clock())
  expect(result.dispatcher.state).toBe('held')
  expect(result.dispatcher.holder?.heartbeatAt).toBeNull()
  await store.heartbeatRepo(repo, 'B')
  result = await readDispatcherLiveness(store, repo, clock())
  expect(result.dispatcher.holder?.heartbeatAgeMs).toBe(0)
  expect(result.dispatcher.holder?.lastTick).toBeNull()
  await start(store, repo, 'yielding')
  await store.appendRepo(repo, {
    actor: DISPATCHER,
    type: 'dispatcher.run-stopped',
    payload: { run: 'yielding', outcome: 'normal' },
  })
  result = await readDispatcherLiveness(store, repo, clock())
  expect(result.dispatcher.holder?.run).toBe('B')
  expect(result.dispatcher.latestRun?.heartbeatAt).toBeNull()
  clock.advance(Date.parse((await store.getRepo(repo))!.lease!.expiresAt) - clock().getTime())
  result = await readDispatcherLiveness(store, repo, clock())
  expect(result.dispatcher.state).toBe('lost')
  expect(result.dispatcher.expiredHolder?.run).toBe('B')
  await store.appendRepo(repo, {
    actor: DISPATCHER,
    type: 'dispatcher.run-stopped',
    payload: { run: 'B', outcome: 'normal', signal: 'SIGTERM' },
  })
  expect((await readDispatcherLiveness(store, repo, clock())).dispatcher.state).toBe('stopped')
})

test('missing start or legacy metadata never invents heartbeat or identity', () => {
  const record = {
    repo: 'r',
    createdAt: '',
    updatedAt: '',
    lease: { holder: 'unknown', expiresAt: '2030-01-01' },
    heartbeatAt: '2025-01-01',
  }
  const result = projectDispatcherLiveness(record, [], new Date('2026-01-01'))
  expect(result.state).toBe('held')
  expect(result.holder?.heartbeatAt).toBeNull()
  expect(result.holder?.host).toBeNull()
  expect(projectDispatcherLiveness(null, [], new Date()).state).toBe('absent')
})

test('failed ticks supersede counters by sequence and stops correlate by run', async () => {
  const clock = manualClock()
  const store = new MemoryBuildStore({ clock })
  await store.ensureRepo('r')
  await start(store, 'r', 'owner')
  await store.claimRepoLease('r', 'owner', 60000)
  const counters = {
    harvestStarted: 0,
    harvestResumed: 0,
    harvestCompleted: 0,
    harvestEscalated: 0,
    harvestFailed: 0,
    merged: 1,
    closed: 0,
    conflicted: 0,
    abandoned: 0,
    discarded: 0,
    janitorFailed: 0,
    recovered: 0,
    dispatchFailed: 0,
    resumed: 0,
    swept: 0,
    dispatched: 0,
    authored: 0,
    bounced: 0,
    claimRaces: 0,
    invalidTickets: 0,
    dependencyBlocked: 0,
  }
  await store.appendRepo('r', {
    actor: DISPATCHER,
    type: 'dispatcher.tick-completed',
    payload: {
      run: 'owner',
      queued: 0,
      counters,
      janitorDiagnostics: [],
      ticketDiagnostics: [],
      dependencyDiagnostics: [],
    },
  })
  expect((await readDispatcherLiveness(store, 'r', clock())).dispatcher.holder?.lastTick).toEqual({
    outcome: 'completed',
    counters,
  })
  clock.advance(1000)
  await store.appendRepo('r', {
    actor: DISPATCHER,
    type: 'dispatcher.tick-failed',
    payload: { run: 'owner', error: 'failed tick' },
  })
  await store.appendRepo('r', {
    actor: DISPATCHER,
    type: 'dispatcher.run-stopped',
    payload: { run: 'other', outcome: 'abnormal' },
  })
  await store.heartbeatRepo('r', 'owner')
  const result = await readDispatcherLiveness(store, 'r', clock())
  expect(result.dispatcher.state).toBe('held')
  expect(result.dispatcher.holder?.lastTick).toEqual({ outcome: 'failed', error: 'failed tick' })
  expect(result.dispatcher.holder?.heartbeatAgeMs).toBe(0)
})
