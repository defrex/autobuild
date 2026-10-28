import { dispatchFrontendReducer } from '../cli/dispatch-repository-feed'
import { loadReducerSnapshot } from '../store/snapshots'
import { expect } from 'bun:test'
import { DispatchFrontend } from '../cli/dispatch-frontend'
import type { DispatchChildResult } from '../cli/dispatch-process'
import { createTerminalModeController } from '../cli/terminal-restore'
import { DISPATCHER, humanActor } from '../events/envelope'
import type { BuildStore } from '../store/types'

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

/** Run the actual frontend lifecycle with a deterministic child and manual
 * refreshes. Instrument the backing boundary, including HTTP server reads. */
export async function dispatchReadBudget(store: BuildStore, backing: BuildStore): Promise<void> {
  const repo = '/dashboard-read-budget'
  await backing.ensureRepo(repo)
  const metrics = {
    rows: 0,
    events: 0,
    state: 0,
    snapshots: 0,
    digests: 0,
    records: 0,
    high: 0,
    puts: 0,
  }
  const putSnapshot = backing.putReducerSnapshot.bind(backing)
  backing.putReducerSnapshot = async (...args) => {
    metrics.puts++
    return putSnapshot(...args)
  }
  const getEvents = backing.getRepoEvents.bind(backing)
  const getState = backing.getRepoStateEvents.bind(backing)
  const getSnapshot = backing.getReducerSnapshot.bind(backing)
  const getDigests = backing.getRepoBuildDigests.bind(backing)
  const getRepo = backing.getRepo.bind(backing)
  const getHigh = backing.getRepoHighWater.bind(backing)
  backing.getRepoEvents = async (repo, since) => {
    const events = await getEvents(repo, since)
    metrics.events++
    metrics.rows += events.length
    return events
  }
  backing.getRepoStateEvents = async (repo) => {
    metrics.state++
    return getState(repo)
  }
  backing.getReducerSnapshot = async (...args) => {
    metrics.snapshots++
    return getSnapshot(...args)
  }
  backing.getRepoBuildDigests = async (repo) => {
    metrics.digests++
    return getDigests(repo)
  }
  backing.getRepo = async (repo) => {
    metrics.records++
    return getRepo(repo)
  }
  backing.getRepoHighWater = async (repo) => {
    metrics.high++
    return getHigh(repo)
  }
  let now = 0
  let finish!: (result: DispatchChildResult) => void
  let started!: () => void
  let childRun = ''
  const startup = new Promise<void>((resolve) => {
    started = resolve
  })
  const frontend = new DispatchFrontend({
    repo,
    storeRef: 'test',
    store,
    env: {},
    once: true,
    clock: () => new Date(now),
    input: { start: () => () => {} },
    terminal: {
      columns: 100,
      rows: 24,
      interactive: true,
      write: () => {},
      modes: createTerminalModeController(
        () => {},
        () => {},
      ),
    },
    launchChild: ({ run }) => {
      childRun = run
      const completed = new Promise<DispatchChildResult>((resolve) => {
        finish = resolve
      })
      void backing
        .appendRepoWithArtifacts(
          repo,
          [
            {
              kind: 'config',
              content: JSON.stringify({
                capacity: 4,
                roles: { default: { runtime: 'claude' } },
                tickets: { source: 'file', readyState: 'ready' },
              }),
            },
          ],
          (artifacts) => ({
            actor: DISPATCHER,
            type: 'dispatcher.run-started',
            payload: {
              run,
              pid: 1,
              roleWarnings: [],
              effectiveConfig: { kind: artifacts[0]!.kind, rev: artifacts[0]!.revision },
            },
          }),
        )
        .then(started)
      return { completed, stop: async () => {} }
    },
  })
  const running = frontend.run()
  await startup
  // Exercise exactly the controller operation used by timers and actions,
  // without a wall-clock timer determining the batch boundaries.
  const refresh = () => (frontend as unknown as { renderOnce(): Promise<void> }).renderOnce()
  await refresh()
  const initialSize = JSON.stringify(
    (
      await loadReducerSnapshot(
        { getReducerSnapshot: getSnapshot },
        { kind: 'repo', repo },
        'dispatchFrontend',
        { version: dispatchFrontendReducer.version },
      )
    )?.state,
  ).length
  let recordReads: number | undefined
  try {
    for (let batch = 0; batch < 24; batch++) {
      for (let i = 0; i < 128; i++) {
        await backing.appendRepo(repo, {
          actor: DISPATCHER,
          type: 'dispatcher.tick-completed',
          payload: {
            run: childRun,
            queued: 0,
            counters: tickCounters,
            janitorDiagnostics: [],
            ticketDiagnostics: [],
            creationDiagnostics: [],
            dependencyDiagnostics: [],
          },
        })
      }
      const before = { ...metrics }
      now += 6000
      await refresh()
      expect(metrics.puts - before.puts).toBe(1)
      expect(metrics.rows - before.rows).toBe(128)
      expect(metrics.events - before.events).toBe(1)
      expect(metrics.state - before.state).toBe(0)
      expect(metrics.snapshots - before.snapshots).toBe(0)
      expect(metrics.digests - before.digests).toBe(1)
      expect(metrics.high - before.high).toBe(0)
      recordReads ??= metrics.records - before.records
      expect(metrics.records - before.records).toBe(recordReads)
      const size = JSON.stringify(
        (
          await loadReducerSnapshot(
            { getReducerSnapshot: getSnapshot },
            { kind: 'repo', repo },
            'dispatchFrontend',
            { version: dispatchFrontendReducer.version },
          )
        )?.state,
      ).length
      // First advancement adds the child's identity; ticks add nothing.
      expect(size).toBeLessThan(initialSize + 1000)
      const rows = metrics.rows
      await refresh()
      expect(metrics.rows).toBe(rows)
    }
    // Advance the clock across rejected equal-cursor saves. A standby can
    // remain quiet indefinitely; each 500 ms frame must not upload its cache.
    const beforeQuiet = { ...metrics }
    for (let poll = 0; poll < 40; poll++) {
      now += 500
      await refresh()
    }
    expect(metrics.puts - beforeQuiet.puts).toBe(4)
    expect(metrics.rows).toBe(beforeQuiet.rows)
  } finally {
    finish({ outcome: 'normal', exitCode: 0 })
    await running
  }
  await backing.appendRepo(repo, {
    actor: humanActor('test'),
    type: 'dispatcher.pause-set',
    payload: { enabled: true },
  })
  // A new invocation restores persisted state without any bounded/full seed.
  const { DispatchRepositoryFeed } = await import('../cli/dispatch-repository-feed')
  const feed = new DispatchRepositoryFeed(store, repo, () => new Date(now))
  const before = { ...metrics }
  expect((await feed.refresh()).length).toBe(1)
  expect(metrics.rows - before.rows).toBe(1)
  expect(metrics.state - before.state).toBe(0)
}

/** Script a minute at both launcher cadences using the real runtime reader and
 * launcher cache. Each helper gets a fresh facade; private reads use that same
 * instrumented receiver rather than escaping into an uncounted reducer. */
export async function upgradeReadBudget(store: BuildStore): Promise<void> {
  const { readUpgradeProjection } = await import('../cli/dispatch-handoff')
  const { conditionalUpgradeClient } = await import('../cli/dispatch-launch-contract')
  for (const length of [100, 10_000]) {
    const repo = `/upgrade-budget-${length}`
    await store.ensureRepo(repo)
    for (let i = 0; i < length; i++)
      await store.appendRepo(repo, {
        actor: humanActor('budget'),
        type: 'dispatcher.intake-set',
        payload: { enabled: false },
      })
    const metrics = { position: 0, metadata: 0, reducer: 0, events: 0, rows: 0 }
    const launch = {
      version: 1 as const,
      runtimeRoot: '/runtime',
      checkout: repo,
      journal: { repo, storeRef: '/memory' },
      run: 'budget',
      lineage: 'budget',
    }
    const client = conditionalUpgradeClient()
    const check = () =>
      client(repo, (condition) =>
        readUpgradeProjection(
          launch,
          ['dispatch'],
          {},
          {
            condition,
            openStore: () =>
              new Proxy(store, {
                get(target, key, receiver) {
                  if (key === 'close') return async () => {}
                  // Memory reducer storage reads bypass public getRepoEvents. Count
                  // the actual sliced rows at that private boundary as well.
                  if (key === 'repoState')
                    return (...args: unknown[]) => {
                      const state = Reflect.get(target, key).apply(receiver, args)
                      return new Proxy(state, {
                        get(state, field) {
                          const value = Reflect.get(state, field)
                          if (field !== 'events') return value
                          return new Proxy(value, {
                            get(events, method) {
                              if (method === 'slice')
                                return (since: number, through: number) => {
                                  const rows = events.slice(since, through)
                                  metrics.events++
                                  metrics.rows += rows.length
                                  return rows
                                }
                              return Reflect.get(events, method)
                            },
                          })
                        },
                      })
                    }
                  const value = Reflect.get(target, key, receiver)
                  if (typeof value !== 'function') return value
                  if (typeof key !== 'string' || !key.startsWith('get')) return value.bind(receiver)
                  return async (...args: unknown[]) => {
                    // The queried run has not started. No candidate means no
                    // historical per-run reconstruction, even at bootstrap.
                    if (key === 'getReducerValue')
                      expect((args[1] as { reducer: string }).reducer).not.toBe(
                        'dispatcherRunFacts',
                      )
                    if (key === 'getRepoChangePosition') metrics.position++
                    else if (key === 'getReducerValue' || key === 'getReducerSnapshot')
                      metrics.reducer++
                    else if (key === 'getRepoEvents' || key === 'getRepoStateEvents')
                      metrics.events++
                    else if (typeof key === 'string' && key.startsWith('get')) metrics.metadata++
                    const result = await value.apply(receiver, args)
                    if (
                      (key === 'getRepoEvents' || key === 'getRepoStateEvents') &&
                      Array.isArray(result)
                    )
                      metrics.rows += result.length
                    return result
                  }
                },
              }),
          },
        ),
      )
    // Bootstrap is explicitly measured separately from the idle bound.
    await check()
    expect(metrics.position).toBe(1)
    expect(metrics.metadata).toBeGreaterThan(0)
    expect(metrics.reducer).toBeGreaterThan(0)
    expect(metrics.rows).toBeGreaterThanOrEqual(length)
    for (const interval of [1_000, 250]) {
      for (const key of Object.keys(metrics) as (keyof typeof metrics)[]) metrics[key] = 0
      let now = 0
      while (now < 60_000) {
        await check()
        now += interval
      }
      expect(metrics).toEqual({
        position: 60_000 / interval,
        metadata: 0,
        reducer: 0,
        events: 0,
        rows: 0,
      })
    }
    await store.appendRepo(repo, {
      actor: humanActor('budget'),
      type: 'dispatcher.intake-set',
      payload: { enabled: true },
    })
    metrics.reducer = 0
    await check()
    expect(metrics.reducer).toBeGreaterThan(0)
  }
}
