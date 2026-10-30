import { loadReducerSnapshot, persistReducerSnapshot } from '../store/snapshots'
import { expect, test } from 'bun:test'
import { DISPATCHER, KERNEL, humanActor } from '../events/envelope'
import { MemoryBuildStore } from '../store/memory'
import { DispatchRepositoryFeed } from './dispatch-repository-feed'
import { reduceDispatchSettings } from '../kernel/dispatch-settings'

const tickCounters = {
  merged: 0,
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
  harvestStarted: 0,
  harvestResumed: 0,
  harvestCompleted: 0,
  harvestEscalated: 0,
  harvestFailed: 0,
}

const repo = '/feed'
const clock = () => new Date('2026-10-16T00:00:00Z')
async function setting(store: MemoryBuildStore, enabled = false) {
  return store.appendRepo(repo, {
    actor: humanActor('test'),
    type: 'dispatcher.intake-set',
    payload: { enabled },
  })
}
async function start(store: MemoryBuildStore, run: string) {
  return store.appendRepo(repo, {
    actor: DISPATCHER,
    type: 'dispatcher.run-started',
    payload: { run, pid: 1, effectiveConfig: { kind: 'config', rev: 0 }, roleWarnings: [] },
  })
}

test('persisted projection advances past discarded events and restarts with only a delta', async () => {
  const store = new MemoryBuildStore()
  await store.ensureRepo(repo)
  await setting(store)
  await start(store, 'old')
  await store.appendRepo(repo, {
    actor: DISPATCHER,
    type: 'dispatcher.run-stopped',
    payload: { run: 'old', outcome: 'normal' },
  })
  const feed = new DispatchRepositoryFeed(store, repo, clock)
  await feed.warm()
  const snapshot = await loadReducerSnapshot(store, { kind: 'repo', repo }, 'dispatchFrontend', {
    version: 4,
  })
  expect(snapshot?.cursor).toBe(3)
  expect(JSON.stringify(snapshot?.state)).not.toContain('run-stopped')
  await setting(store, true)
  store.getRepoStateEvents = async () => {
    throw new Error('must restore')
  }
  const resumed = new DispatchRepositoryFeed(store, repo, clock)
  expect((await resumed.refresh()).map((e) => e.seq)).toEqual([4])
  expect(reduceDispatchSettings(resumed.events)).toEqual(
    reduceDispatchSettings(await store.getRepoEvents(repo)),
  )
})

for (const bad of ['missing', 'version', 'malformed', 'ahead', 'unreadable']) {
  test(`${bad} snapshot uses bounded seed without full replay`, async () => {
    const store = new MemoryBuildStore()
    await store.ensureRepo(repo)
    await setting(store)
    await start(store, 'old')
    if (bad !== 'missing')
      await persistReducerSnapshot(store, { kind: 'repo', repo }, 'dispatchFrontend', {
        version: bad === 'version' ? 3 : 4,
        cursor: bad === 'ahead' ? 999 : 1,
        state: { retained: bad === 'malformed' ? [{}] : [], incompleteIdentities: true },
      })
    if (bad === 'unreadable')
      store.getReducerSnapshot = async () => {
        throw new Error('offline')
      }
    const reads: number[] = []
    const get = store.getRepoEvents.bind(store)
    store.getRepoEvents = async (repo, since = 0) => {
      reads.push(since)
      return get(repo, since)
    }
    const feed = new DispatchRepositoryFeed(store, repo, clock)
    await feed.warm()
    expect(reads.every((since) => since > 0)).toBe(true)
    expect(feed.events).toHaveLength(1)
  })
}

test('a gapped delta leaves the committed cursor retryable; overlapping refreshes consume once', async () => {
  const store = new MemoryBuildStore()
  await store.ensureRepo(repo)
  await setting(store)
  const feed = new DispatchRepositoryFeed(store, repo, clock)
  await feed.warm()
  await setting(store, true)
  await setting(store, false)
  const get = store.getRepoEvents.bind(store)
  store.getRepoEvents = async (repo, since) => (await get(repo, since)).slice(1)
  await expect(feed.refresh()).rejects.toThrow('invalid dashboard')
  expect(feed.events).toHaveLength(1)
  store.getRepoEvents = get
  const deltas = await Promise.all([feed.refresh(), feed.refresh()])
  expect(deltas.map((delta) => delta.length)).toEqual([2, 0])
  expect(feed.events.map((e) => e.seq)).toEqual([1, 2, 3])
})

test('failed prelaunch seed recovers all invocation facts despite a competing anchor', async () => {
  const store = new MemoryBuildStore()
  await store.ensureRepo(repo)
  await setting(store)
  const seed = store.getRepoStateEvents.bind(store)
  store.getRepoStateEvents = async () => {
    throw new Error('timeout')
  }
  const feed = new DispatchRepositoryFeed(store, repo, clock)
  await expect(feed.warm()).rejects.toThrow('timeout')
  await start(store, 'own')
  await start(store, 'competitor')
  store.getRepoStateEvents = seed
  expect((await feed.refresh()).map((e) => e.seq)).toEqual([2, 3])
  expect(feed.identities.map((e) => e.type === 'dispatcher.run-started' && e.payload.run)).toEqual([
    'competitor',
  ])
})

test('high water before bounded seed handles concurrent appends and failed snapshot writes', async () => {
  const store = new MemoryBuildStore()
  await store.ensureRepo(repo)
  await setting(store)
  const seed = store.getRepoStateEvents.bind(store)
  store.getRepoStateEvents = async (repo) => {
    const subset = await seed(repo)
    await setting(store, true)
    return subset
  }
  store.putReducerSnapshot = async () => {
    throw new Error('offline')
  }
  const feed = new DispatchRepositoryFeed(store, repo, clock)
  await feed.warm()
  expect(feed.events.map((e) => e.seq)).toEqual([1, 2])
  expect(await feed.refresh()).toEqual([])
})

test('SQLite frontend read budget stays flat across thousands of journal events', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { openLocalStore } = await import('../store/local/store')
  const { dispatchReadBudget } = await import('../testing/dispatch-read-budget')
  const root = await mkdtemp(join(tmpdir(), 'ab-dashboard-feed-'))
  try {
    const store = openLocalStore(root)
    await dispatchReadBudget(store, store)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('scripted harvest, settings and live status retain full replay and rendered parity', async () => {
  const { randomHarvestJournal, randomSettingsJournal, randomStatusJournal } = await import(
    '../kernel/generators/repository-journals'
  )
  const { reduceDispatchStatus } = await import('../kernel/dispatch-status')
  const { reduceHarvest } = await import('../kernel/harvest')
  const { unclaimedObservationCount } = await import('../processes/harvest')
  const { buildDashboardFromProjected } = await import('./dashboard/model')
  const { renderDashboard } = await import('./dashboard/render')
  const { reduceBuildDigest } = await import('../store/digest')
  const store = new MemoryBuildStore()
  await store.ensureRepo(repo)
  const feed = new DispatchRepositoryFeed(store, repo, clock)
  await feed.warm()
  const digests = new Map(
    Array.from({ length: 30 }, (_, i) => {
      const slug = `b${i + 1}`
      return [
        slug,
        {
          slug,
          ...reduceBuildDigest([
            { type: 'observation.recorded', seq: 1, ts: clock().toISOString() },
          ]),
        },
      ] as const
    }),
  )
  let status = reduceDispatchStatus([], 'run-a')
  const log = [
    ...randomHarvestJournal(2, 100),
    ...randomSettingsJournal(4, 30),
    ...randomStatusJournal(5, 100),
  ]
  for (const fact of log) {
    if (fact.type === 'dispatcher.intake-set' || fact.type === 'dispatcher.operator-reported')
      fact.actor = humanActor('test')
    if (fact.type === 'harvest.paused') {
      fact.actor = KERNEL
      fact.payload = {}
    }
    if (fact.type === 'dispatcher.tick-completed') fact.payload.counters = tickCounters
    await store.appendRepo(repo, { actor: fact.actor, type: fact.type, payload: fact.payload })
    const delta = await feed.refresh()
    status = reduceDispatchStatus(delta, 'run-a', status)
    const full = await store.getRepoEvents(repo)
    expect(status).toEqual(reduceDispatchStatus(full, 'run-a'))
    const { lastSeq: _projectedSeq, ...projectedHarvest } = reduceHarvest(feed.events)
    const { lastSeq: _fullSeq, ...fullHarvest } = reduceHarvest(full)
    expect(projectedHarvest).toEqual(fullHarvest)
    expect(reduceDispatchSettings(feed.events)).toEqual(reduceDispatchSettings(full))
    const count = unclaimedObservationCount({ digests, harvestEvents: feed.events })
    expect(count).toBe(unclaimedObservationCount({ digests, harvestEvents: full }))
    const input = {
      repo,
      queued: status.queued ?? 0,
      activeCount: 0,
      capacity: 4,
      observationCount: count,
      observationLimit: 10,
    }
    const options = { color: true, width: 100, height: 24, now: clock().getTime() }
    expect(renderDashboard(buildDashboardFromProjected([], input, feed.events), options)).toEqual(
      renderDashboard(buildDashboardFromProjected([], input, full), options),
    )
  }
})

test('a failed prelaunch boundary refreshes bounded state without replay', async () => {
  const store = new MemoryBuildStore()
  await store.ensureRepo(repo)
  await setting(store)
  const high = store.getRepoHighWater.bind(store)
  store.getRepoHighWater = async () => {
    throw new Error('offline')
  }
  const feed = new DispatchRepositoryFeed(store, repo, clock)
  await expect(feed.warm()).rejects.toThrow('offline')
  await start(store, 'own')
  await start(store, 'competitor')
  store.getRepoHighWater = high
  expect(await feed.refresh()).toEqual([])
})

test('foreign repository cache facts are rejected and missing repositories are not materialized', async () => {
  const store = new MemoryBuildStore()
  const empty = new DispatchRepositoryFeed(store, repo, clock)
  expect(await empty.refresh()).toEqual([])
  expect(await store.getRepo(repo)).toBeNull()
  await store.ensureRepo(repo)
  const fact = await setting(store)
  await persistReducerSnapshot(store, { kind: 'repo', repo }, 'dispatchFrontend', {
    version: 4,
    cursor: 1,
    state: { retained: [{ ...fact, repo: '/other' }], incompleteIdentities: true },
  })
  const feed = new DispatchRepositoryFeed(store, repo, clock)
  await feed.warm()
  expect(feed.events).toEqual([fact])
})

test('a stale frontend cannot replace a newer persisted cursor', async () => {
  const store = new MemoryBuildStore()
  await store.ensureRepo(repo)
  await setting(store)
  const stale = new DispatchRepositoryFeed(store, repo, clock)
  await stale.warm()
  const current = new DispatchRepositoryFeed(store, repo, clock)
  await current.warm()
  await setting(store, true)
  await current.refresh()
  await current.save(true)
  await stale.save(true)
  expect(
    (await loadReducerSnapshot(store, { kind: 'repo', repo }, 'dispatchFrontend', { version: 4 }))
      ?.cursor,
  ).toBe(2)
})

test('a standby identity remembered during a pending refresh survives its commit', async () => {
  const store = new MemoryBuildStore()
  await store.ensureRepo(repo)
  const owner = await start(store, 'owner')
  await start(store, 'self')
  const feed = new DispatchRepositoryFeed(store, repo, clock)
  await feed.warm()
  let release!: () => void
  let reading!: () => void
  const entered = new Promise<void>((resolve) => {
    reading = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  store.getRepoEvents = async () => {
    reading()
    await gate
    return []
  }
  const pending = feed.refresh()
  await entered
  feed.selectHolder('owner')
  feed.remember([owner], true)
  release()
  await pending
  expect(feed.identities.map((e) => e.seq)).toEqual([1, 2])
  expect(feed.incompleteIdentities).toBe(true)
})

for (const outcome of ['equal-cursor', 'unavailable']) {
  test(`quiet refreshes suppress settled ${outcome} attempts and force only dirty saves`, async () => {
    const store = new MemoryBuildStore()
    await store.ensureRepo(repo)
    await setting(store)
    let now = 0
    let puts = 0
    let writes = 0
    const put = store.putReducerSnapshot.bind(store)
    store.putReducerSnapshot = async (...args) => {
      puts++
      if (outcome === 'unavailable') throw new Error('offline')
      const written = await put(...args)
      if (written) writes++
      return written
    }
    const feed = new DispatchRepositoryFeed(store, repo, () => new Date(now))
    await feed.warm()
    for (let poll = 0; poll < 40; poll++) {
      now += 500
      await feed.refresh()
    }
    expect(puts).toBe(1)
    expect(writes).toBe(outcome === 'equal-cursor' ? 1 : 0)
    await feed.save(true)
    expect(puts).toBe(outcome === 'equal-cursor' ? 1 : 2)
  })
}

test('a restarted partial identity cache correlates an older takeover holder and persists its bounded correlation', async () => {
  const { StandbyIdentityResolver } = await import('./dispatcher-liveness')
  const store = new MemoryBuildStore({ clock })
  await store.ensureRepo(repo)
  await start(store, 'older-owner')
  await start(store, 'self')
  await store.claimRepoLease(repo, 'self', 60000)
  const initial = new DispatchRepositoryFeed(store, repo, clock)
  await initial.warm()
  expect(initial.identities.map((e) => e.seq)).toEqual([2])
  expect(initial.incompleteIdentities).toBe(true)

  const restarted = new DispatchRepositoryFeed(store, repo, clock)
  const state = store.getRepoStateEvents.bind(store)
  let bounded = 0
  let full = 0
  const events = store.getRepoEvents.bind(store)
  store.getRepoStateEvents = async (repo) => {
    bounded++
    return state(repo)
  }
  store.getRepoEvents = async (repo, since = 0) => {
    if (since === 0) full++
    return events(repo, since)
  }
  await restarted.warm()
  expect([bounded, full]).toEqual([0, 0])
  expect(restarted.incompleteIdentities).toBe(true)
  const resolver = new StandbyIdentityResolver(store, repo, {
    selectHolder: (holder) => restarted.selectHolder(holder),
    allowLookup: () => restarted.incompleteIdentities,
    remember: (events, complete) => restarted.remember(events, complete),
  })
  resolver.ingest(restarted.identities)
  expect(await resolver.refresh('self', undefined, clock())).toBeUndefined()
  await store.releaseRepoLease(repo, 'self')
  await store.claimRepoLease(repo, 'older-owner', 60000)
  expect(await resolver.refresh('self', undefined, clock())).toContain('older-owner; pid 1;')
  expect([bounded, full]).toEqual([0, 0])
  expect(restarted.incompleteIdentities).toBe(true)
  await resolver.refresh('self', undefined, clock())
  expect([bounded, full]).toEqual([0, 0])

  // Snapshot puts are monotone: a later journal delta publishes the newly
  // correlated identity without claiming completeness at its advanced cursor.
  await setting(store)
  await restarted.refresh()
  await restarted.save(true)
  const complete = new DispatchRepositoryFeed(store, repo, clock)
  await complete.warm()
  expect(complete.incompleteIdentities).toBe(true)
  const warm = new StandbyIdentityResolver(store, repo, {
    selectHolder: (holder) => complete.selectHolder(holder),
    allowLookup: () => complete.incompleteIdentities,
    remember: (events, all) => complete.remember(events, all),
  })
  warm.ingest(complete.identities)
  expect(await warm.refresh('self', undefined, clock())).toContain('older-owner; pid 1;')
  expect([bounded, full]).toEqual([0, 0])
})

test('persisted holder correlation keeps unqueried identities incomplete without replay', async () => {
  const { StandbyIdentityResolver } = await import('./dispatcher-liveness')
  const store = new MemoryBuildStore({ clock })
  await store.ensureRepo(repo)
  await start(store, 'older')
  await start(store, 'self')
  const feed = new DispatchRepositoryFeed(store, repo, clock)
  await feed.warm()
  // A new holder is visible to the bounded lookup before the next feed delta.
  await start(store, 'new-holder')
  await store.claimRepoLease(repo, 'new-holder', 60000)
  const resolver = new StandbyIdentityResolver(store, repo, {
    selectHolder: (holder) => feed.selectHolder(holder),
    allowLookup: () => feed.incompleteIdentities,
    remember: (events, complete) => feed.remember(events, complete),
  })
  resolver.ingest(feed.identities)
  expect(await resolver.refresh('self', undefined, clock())).toContain('new-holder; pid 1;')
  expect(feed.incompleteIdentities).toBe(true)
  await feed.refresh()
  await feed.save(true)
  const restarted = new DispatchRepositoryFeed(store, repo, clock)
  await restarted.warm()
  expect(restarted.incompleteIdentities).toBe(true)
})

test('handoff seed, deadline delta and restored completion agree with the full journal across run anchors', async () => {
  const { handoffEvents } = await import('../../../../tools/handoff-capture')
  const { dispatchUpgradeReducer } = await import('../kernel/dispatch-upgrade')
  const { projectHandoffs } = await import('./dashboard/handoff')
  const store = new MemoryBuildStore()
  await store.ensureRepo(repo)
  const events = handoffEvents('old-build')
  for (const event of events) await store.appendRepo(repo, event)
  await start(store, 'successor')
  const feed = new DispatchRepositoryFeed(store, repo, clock)
  await feed.warm()
  const expected = async () =>
    projectHandoffs(dispatchUpgradeReducer.reduce(await store.getRepoEvents(repo)))
  expect(projectHandoffs(dispatchUpgradeReducer.reduce(feed.events))).toEqual(await expected())
  const startEvent = events[2]!
  if (startEvent.type !== 'dispatcher.handoff-started') throw new Error('fixture')
  const {
    successor: _successor,
    mode: _mode,
    deadline: _deadline,
    builds: _builds,
    ...identity
  } = startEvent.payload
  await store.appendRepo(repo, {
    actor: DISPATCHER,
    type: 'dispatcher.drain-deadline',
    payload: { ...identity, deadline: '2026-07-15T12:30:00.000Z' },
  })
  await feed.refresh()
  expect(projectHandoffs(dispatchUpgradeReducer.reduce(feed.events)).handoffs[0]?.deadline).toBe(
    '2026-07-15T12:30:00.000Z',
  )
  for (const event of handoffEvents('old-build', 'completed').slice(3))
    await store.appendRepo(repo, event)
  await start(store, 'next-generation')
  await feed.refresh()
  await feed.save(true)
  const full = await expected()
  expect(full.handoffs).toEqual([])
  store.getRepoStateEvents = async () => {
    throw new Error('snapshot should restore')
  }
  const restored = new DispatchRepositoryFeed(store, repo, clock)
  await restored.refresh()
  expect(projectHandoffs(dispatchUpgradeReducer.reduce(restored.events))).toEqual(full)
})

test('in-memory launcher idle reads cost one position request at both cadences and journal lengths', async () => {
  const { upgradeReadBudget } = await import('../testing/dispatch-read-budget')
  await upgradeReadBudget(new MemoryBuildStore())
})

test('transient writes retry without events at capped exponential deadlines, then settle', async () => {
  const store = new MemoryBuildStore()
  await store.ensureRepo(repo)
  await setting(store)
  let now = 0
  const attempts: number[] = []
  let offline = true
  store.putReducerSnapshot = async () => {
    attempts.push(now)
    if (offline) throw new Error('offline')
    return true
  }
  const feed = new DispatchRepositoryFeed(store, repo, () => new Date(now))
  await feed.warm()
  for (const deadline of [30000, 90000, 210000, 450000, 750000]) {
    now = deadline - 1
    await feed.save()
    now = deadline
    await feed.save()
  }
  expect(attempts).toEqual([0, 30000, 90000, 210000, 450000, 750000])
  offline = false
  now = 1050000
  await feed.save()
  await feed.save(true)
  expect(attempts).toHaveLength(7)
})

test('overlapping saves acknowledge only the captured projection and dirty force flushes once', async () => {
  const store = new MemoryBuildStore()
  await store.ensureRepo(repo)
  await setting(store)
  const feed = new DispatchRepositoryFeed(store, repo, clock)
  await feed.refresh(false)
  let release!: () => void
  let puts = 0
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const snapshots: unknown[] = []
  store.putReducerSnapshot = async (_scope, _name, snapshot) => {
    puts++
    snapshots.push(snapshot)
    await gate
    return false
  }
  const first = feed.save()
  const overlap = feed.save()
  expect(first).toBe(overlap)
  await setting(store, true)
  await feed.refresh(false)
  release()
  await first
  await feed.save()
  expect(puts).toBe(1)
  await feed.save(true)
  await feed.save(true)
  expect(puts).toBe(2)
  expect(snapshots.map((s) => (s as { cursor: number }).cursor)).toEqual([1, 2])
})

test('restored clean snapshots and duplicate remembers stay clean; holder changes persist once', async () => {
  const store = new MemoryBuildStore()
  await store.ensureRepo(repo)
  const owner = await start(store, 'owner')
  await start(store, 'latest')
  const initial = new DispatchRepositoryFeed(store, repo, clock)
  await initial.warm()
  let puts = 0
  store.putReducerSnapshot = async () => {
    puts++
    return false
  }
  const feed = new DispatchRepositoryFeed(store, repo, clock)
  await feed.warm()
  await feed.save(true)
  expect(puts).toBe(0)
  feed.selectHolder('owner')
  feed.remember([owner])
  await feed.save(true)
  feed.remember([owner])
  await feed.save(true)
  expect(puts).toBe(1)
  feed.selectHolder(undefined)
  await feed.save(true)
  expect(puts).toBe(2)
  expect(feed.identities.map((e) => e.seq)).toEqual([2])
})

test('legacy complete history normalizes to bounded identities and remains lookup eligible', async () => {
  for (const count of [100, 10000]) {
    const store = new MemoryBuildStore({ clock })
    await store.ensureRepo(repo)
    const history = []
    for (let i = 0; i < count; i++) history.push(await start(store, `old-${i}`))
    const latest = await start(store, 'latest')
    await persistReducerSnapshot(store, { kind: 'repo', repo }, 'dispatchFrontend', {
      version: 4,
      cursor: latest.seq,
      state: { retained: [...history, latest], incompleteIdentities: false },
    })
    const feed = new DispatchRepositoryFeed(store, repo, clock)
    await feed.warm()
    expect(feed.identities).toEqual([latest])
    expect(feed.incompleteIdentities).toBe(true)
    const { StandbyIdentityResolver } = await import('./dispatcher-liveness')
    const resolver = new StandbyIdentityResolver(store, repo, {
      selectHolder: (holder) => feed.selectHolder(holder),
      allowLookup: () => feed.incompleteIdentities,
      remember: (events) => feed.remember(events),
    })
    resolver.ingest(feed.identities)
    for (const holder of ['old-0', 'old-1', 'old-0']) {
      const current = (await store.getRepo(repo))?.lease?.holder
      if (current) await store.releaseRepoLease(repo, current)
      await store.claimRepoLease(repo, holder, 60000)
      expect(await resolver.refresh('self', undefined, clock())).toContain(holder)
      expect(feed.identities).toHaveLength(2)
      expect(
        feed.identities[0]?.type === 'dispatcher.run-started' && feed.identities[0].payload.run,
      ).toBe(holder)
    }
  }
})

test('refused equal-cursor correlation reconstructs on restart and rides the next cursor', async () => {
  const { StandbyIdentityResolver } = await import('./dispatcher-liveness')
  const store = new MemoryBuildStore({ clock })
  await store.ensureRepo(repo)
  await start(store, 'holder')
  await start(store, 'latest')
  await store.claimRepoLease(repo, 'holder', 60000)
  const initial = new DispatchRepositoryFeed(store, repo, clock)
  await initial.warm()
  for (const feed of [initial, new DispatchRepositoryFeed(store, repo, clock)]) {
    await feed.refresh()
    const resolver = new StandbyIdentityResolver(store, repo, {
      selectHolder: (holder) => feed.selectHolder(holder),
      allowLookup: () => feed.incompleteIdentities,
      remember: (events) => feed.remember(events),
    })
    resolver.ingest(feed.identities)
    expect(await resolver.refresh('self', undefined, clock())).toContain('holder; pid 1;')
    await feed.save(true)
    expect(
      (await loadReducerSnapshot(store, { kind: 'repo', repo }, 'dispatchFrontend', { version: 4 }))
        ?.state,
    ).toEqual({ retained: [feed.identities[1]], incompleteIdentities: true, holder: undefined })
  }
  initial.selectHolder('holder')
  await setting(store)
  await initial.refresh()
  await initial.save(true)
  const restored = new DispatchRepositoryFeed(store, repo, clock)
  await restored.warm()
  expect(restored.identities).toHaveLength(2)
})

test('unsupported snapshots settle without retrying and forced teardown drains newer in-flight state', async () => {
  const store = new MemoryBuildStore()
  await store.ensureRepo(repo)
  await setting(store)
  let calls = 0
  Object.defineProperty(store, 'putReducerSnapshot', {
    get: () => {
      calls++
      return undefined
    },
    configurable: true,
  })
  const unsupported = new DispatchRepositoryFeed(store, repo, clock)
  await unsupported.warm()
  const attempted = calls
  await unsupported.save(true)
  await unsupported.save()
  expect(calls).toBe(attempted)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const cursors: number[] = []
  Object.defineProperty(store, 'putReducerSnapshot', {
    value: async (_s: unknown, _n: string, snapshot: { cursor: number }) => {
      cursors.push(snapshot.cursor)
      await gate
      return true
    },
    configurable: true,
  })
  const feed = new DispatchRepositoryFeed(store, repo, clock)
  await feed.refresh(false)
  const first = feed.save()
  await setting(store, true)
  await feed.refresh(false)
  const teardown = feed.save(true)
  release()
  await Promise.all([first, teardown])
  expect(cursors).toEqual([1, 2])
})

test('recovery facts below a restored cursor still dirty the restored projection', async () => {
  const store = new MemoryBuildStore()
  await store.ensureRepo(repo)
  await setting(store)
  await persistReducerSnapshot(store, { kind: 'repo', repo }, 'dispatchFrontend', {
    version: 4,
    cursor: 1,
    state: { retained: [], incompleteIdentities: true },
  })
  const high = store.getRepoHighWater.bind(store)
  let probes = 0
  store.getRepoHighWater = async (repo) => (++probes === 1 ? 0 : high(repo))
  const events = store.getRepoEvents.bind(store)
  let fail = true
  store.getRepoEvents = async (...args) => {
    if (fail) throw new Error('offline')
    return events(...args)
  }
  const feed = new DispatchRepositoryFeed(store, repo, clock)
  await expect(feed.warm()).rejects.toThrow('offline')
  fail = false
  let attempts = 0
  store.putReducerSnapshot = async () => {
    attempts++
    return false
  }
  await feed.refresh()
  expect(feed.events).toHaveLength(1)
  expect(attempts).toBe(1)
  await feed.save(true)
  expect(attempts).toBe(1)
})

test('placement read budget is bounded across fresh readers', async () => {
  const { placementReadBudget } = await import('../testing/reduced-read-budget')
  const { readDispatchPlacement } = await import('../store/reduced-reads')
  const { MemoryBuildStore } = await import('../store/memory')
  const store = new MemoryBuildStore()
  await placementReadBudget({
    store,
    fresh: async () => ({
      getDispatchPlacement: async (repo) => (await readDispatchPlacement(store, repo)).value,
    }),
  })
})
