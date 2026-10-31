import { missingAccountCredentials, reconcileMissingAccounts } from '../accounts/availability'
import { readRepositoryFacts } from '../store/reduced-reads'
import { dispatchFrontendReducer } from '../cli/dispatch-repository-feed'
import { loadReducerSnapshot, persistReducerSnapshot } from '../store/snapshots'
import { expect } from 'bun:test'
import { DispatchFrontend } from '../cli/dispatch-frontend'
import type { DispatchChildResult } from '../cli/dispatch-process'
import { createTerminalModeController } from '../cli/terminal-restore'
import { DISPATCHER, humanActor } from '../events/envelope'
import type { BuildStore } from '../store/types'
import type { RepositoryEvent } from '../events/repository'

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
export async function dispatchReadBudget(
  store: BuildStore,
  backing: BuildStore,
  fixtureBatch?: (write: () => void) => void,
): Promise<void> {
  await warmRestoreReadBudget(store, backing, true, fixtureBatch)
  await viewerReadBudget(store, backing)
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
    written: 0,
    refused: 0,
    exceptions: 0,
    bytes: 0,
  }
  const putSnapshot = backing.putReducerSnapshot.bind(backing)
  backing.putReducerSnapshot = async (...args) => {
    metrics.puts++
    metrics.bytes += Buffer.byteLength(JSON.stringify(args[2]))
    try {
      const written = await putSnapshot(...args)
      if (written) metrics.written++
      else metrics.refused++
      return written
    } catch (error) {
      metrics.exceptions++
      throw error
    }
  }
  const getEvents = backing.getRepoEvents.bind(backing)
  const getTail = backing.getRepositoryTail?.bind(backing)
  if (getTail)
    backing.getRepositoryTail = async (...args) => {
      const events = await getTail(...args)
      metrics.events++
      metrics.rows += events.length
      return events
    }
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
      expect(metrics.puts - before.puts).toBe((batch + 1) % 5 === 0 ? 1 : 0)
      expect(metrics.rows - before.rows).toBe(128)
      expect(metrics.events - before.events).toBe(1)
      expect(metrics.state - before.state).toBe(0)
      expect(metrics.snapshots - before.snapshots).toBe(0)
      expect(metrics.digests - before.digests).toBe(1)
      expect(metrics.high - before.high).toBe(store === backing ? 0 : 1)
      recordReads ??= metrics.records - before.records
      expect(metrics.records - before.records).toBe(
        recordReads + (store === backing ? 0 : metrics.puts - before.puts),
      )
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
    expect(metrics.puts - beforeQuiet.puts).toBe(1)
    expect(metrics.rows).toBe(beforeQuiet.rows)
    const settled = { ...metrics }
    for (let poll = 0; poll < 120; poll++) {
      now += 500
      await refresh()
    }
    expect(metrics.puts).toBe(settled.puts)
    expect(metrics.bytes).toBe(settled.bytes)
    expect(metrics.rows).toBe(settled.rows)
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

  // Fixed relevant events/cursor isolate growth from unrelated legacy identities.
  // This runs through both the local and existing real HTTP invocations.
  const retentionRepo = '/dashboard-retention-budget'
  await backing.ensureRepo(retentionRepo)
  const history: RepositoryEvent[] = []
  for (let i = 0; i < 10000; i++) {
    history.push(
      await backing.appendRepo(retentionRepo, {
        actor: DISPATCHER,
        type: 'dispatcher.run-started',
        payload: {
          run: `old-${i}`,
          pid: 1,
          effectiveConfig: { kind: 'config', rev: 0 },
          roleWarnings: [],
        },
      }),
    )
  }
  const holder = history[0]!
  const latest = history.at(-1)!
  const sizes: number[] = []
  const checkpoint = backing.getReducerSnapshot.bind(backing)
  try {
    for (const length of [100, 10000]) {
      // Model a validated pre-upgrade version-4 cache without changing ordering.
      backing.getReducerSnapshot = async (...args) => {
        const snapshot = await checkpoint(...args)
        if (!snapshot || args[0].kind !== 'repo' || args[0].repo !== retentionRepo) return snapshot
        const state = snapshot.state as { catalogIdentity: string }
        return {
          ...snapshot,
          state: {
            ...state,
            acc: {
              retained: [...history.slice(0, length - 1), latest],
              incompleteIdentities: false,
              holder: 'old-0',
            },
          },
        }
      }
      await persistReducerSnapshot(
        store,
        { kind: 'repo', repo: retentionRepo },
        'dispatchFrontend',
        {
          version: 4,
          cursor: latest.seq,
          state: { retained: [], incompleteIdentities: true },
        },
      )
      const projection = new DispatchRepositoryFeed(store, retentionRepo, () => new Date(now))
      const rows = metrics.rows
      const bytes = metrics.bytes
      await projection.warm()
      expect(projection.identities).toEqual([holder, latest])
      expect(projection.incompleteIdentities).toBe(true)
      sizes.push(metrics.bytes - bytes)
      const puts = metrics.puts
      now += 60000
      await projection.refresh()
      await projection.save(true)
      expect(metrics.puts).toBe(puts)
      expect(metrics.rows).toBe(rows)
    }
    expect(sizes[0]).toBe(sizes[1])
  } finally {
    backing.getReducerSnapshot = checkpoint
  }
  // A long journal's account hold is served from the durable reduced value.
  const missing = missingAccountCredentials(
    { billing: { kind: 'claude-subscription', credentialEnv: 'BILLING_TOKEN' } },
    {},
    'project-secrets',
  )
  for (const next of [missing, []]) {
    const facts = (await readRepositoryFacts(store, retentionRepo)).value
    await reconcileMissingAccounts(next, facts.missingAccounts, (event) =>
      store.appendRepo(retentionRepo, event),
    )
    await readRepositoryFacts(store, retentionRepo)
    const before = { ...metrics }
    const position = await store.getRepoHighWater(retentionRepo)
    for (let tick = 0; tick < 8; tick++) {
      const facts = (await readRepositoryFacts(store, retentionRepo)).value
      await reconcileMissingAccounts(next, facts.missingAccounts, (event) =>
        store.appendRepo(retentionRepo, event),
      )
    }
    expect(metrics.rows).toBe(before.rows)
    expect(await store.getRepoHighWater(retentionRepo)).toBe(position)
  }
}

/** Viewer cold/idle reads must reuse canonical values even without a frontend checkpoint. */
async function viewerReadBudget(store: BuildStore, backing: BuildStore): Promise<void> {
  // Instrument the existing in-memory backing boundary, also when reached through HTTP.
  const memory = backing as unknown as { repoState(repo: string): { events: RepositoryEvent[] } }
  const originalState = memory.repoState
  if (originalState === undefined) return
  const originalEvents = backing.getRepoEvents.bind(backing)
  const originalSeed = backing.getRepoStateEvents.bind(backing)
  let rows = 0
  let rawCalls = 0
  memory.repoState = function (repo) {
    const state = originalState.call(this, repo)
    return new Proxy(state, {
      get(target, key) {
        if (key !== 'events') return Reflect.get(target, key)
        return new Proxy(target.events, {
          get(events, method) {
            if (method === 'slice')
              return (since: number, through: number) => {
                const result = events.slice(since, through)
                rows += result.length
                return result
              }
            return Reflect.get(events, method)
          },
        })
      },
    })
  }
  backing.getRepoEvents = async (...args) => {
    rawCalls++
    return originalEvents(...args)
  }
  backing.getRepoStateEvents = async (...args) => {
    rawCalls++
    return originalSeed(...args)
  }
  try {
    for (const length of [100, 100_000]) {
      const repo = `/viewer-budget-${length}`
      await backing.ensureRepo(repo)
      for (let i = 0; i < length; i++)
        await backing.appendRepo(repo, {
          actor: humanActor('budget'),
          type: 'dispatcher.intake-set',
          payload: { enabled: false },
        })
      // The one canonical materialization is allowed once, never once per viewer.
      await readRepositoryFacts(store, repo)
      const snapshot = await backing.putRepoArtifact(repo, {
        kind: 'config',
        content: JSON.stringify({
          capacity: 4,
          roles: { default: { runtime: 'claude' } },
          tickets: { source: 'file', readyState: 'ready' },
        }),
      })
      for (const configured of [false, true]) {
        if (configured)
          await backing.appendRepo(repo, {
            actor: DISPATCHER,
            type: 'dispatcher.run-started',
            payload: {
              run: 'elsewhere',
              pid: 1,
              roleWarnings: [],
              effectiveConfig: { kind: snapshot.kind, rev: snapshot.revision },
            },
          })
        await readRepositoryFacts(store, repo)
        rows = 0
        rawCalls = 0
        for (let fresh = 0; fresh < 3; fresh++) {
          let now = 0
          const controller = new AbortController()
          let painted!: () => void
          let outputs = 0
          const firstFrame = new Promise<void>((resolve) => {
            painted = resolve
          })
          const frontend = new DispatchFrontend({
            viewer: {},
            repo,
            store,
            storeRef: 'memory',
            env: {},
            once: false,
            signal: controller.signal,
            refreshScheduler: { now: () => now, set: () => undefined, clear: () => {} },
            clock: () => new Date(now),
            plainOutput: () => {
              if (++outputs >= 2) painted()
            },
            terminal: {
              columns: 100,
              rows: 24,
              interactive: false,
              write: () => {},
              modes: createTerminalModeController(
                () => {},
                () => {},
              ),
            },
            input: {
              start: () => {
                throw new Error('viewer input')
              },
            },
            launchChild: () => {
              throw new Error('viewer child')
            },
          })
          const running = frontend.run()
          await firstFrame
          const refresh = () => (frontend as unknown as { readFrame(): Promise<void> }).readFrame()
          for (let poll = 0; poll < 4; poll++) {
            now += 15_000
            await refresh()
          }
          expect(rows).toBe(0)
          expect(rawCalls).toBe(0)
          await backing.appendRepo(repo, {
            actor: humanActor('budget'),
            type: 'dispatcher.pause-set',
            payload: { enabled: true },
          })
          await refresh()
          expect(rows).toBe(1)
          expect(rawCalls).toBe(0)
          rows = 0
          now += 15_000
          await refresh()
          expect(rows).toBe(0)
          controller.abort()
          await running
        }
        await backing.appendRepo(repo, {
          actor: humanActor('budget'),
          type: 'dispatcher.intake-set',
          payload: { enabled: true },
        })
        await readRepositoryFacts(store, repo)
        expect(rows).toBe(1)
        expect(rawCalls).toBe(0)
      }
    }
  } finally {
    memory.repoState = originalState
    backing.getRepoEvents = originalEvents
    backing.getRepoStateEvents = originalSeed
  }
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

/** Measure real ticket-source operations through an injected statement boundary.
 * Each fixture is fresh, so a source-local cache cannot conceal target reads. */
export async function ticketListReadBudget(
  fixture: (
    size: number,
    targets: 'none' | 'shared' | 'distinct',
  ) => {
    source: import('../ports/types').TicketSource
    reset(): void
    statements(): number
  },
): Promise<void> {
  for (const size of [0, 1, 100]) {
    for (const targets of ['none', 'shared', 'distinct'] as const) {
      for (const state of [undefined, 'Ready']) {
        const { source, reset, statements } = fixture(size, targets)
        const criteria = state === undefined ? {} : { state }
        const operations = [
          { run: () => source.listReady(criteria), count: state ? 3 : 2 },
          ...(state ? [] : [{ run: () => source.listAll!(), count: 2 }]),
          ...(['oldest', 'newest'] as const).map((order) => ({
            run: () => source.listPage!(criteria, { limit: 100, order }),
            count: state ? 4 : 3,
          })),
          { run: () => source.listPage!(criteria, { limit: 0 }), count: state ? 3 : 2 },
        ]
        for (const [index, operation] of operations.entries()) {
          reset()
          const result = await operation.run()
          expect(statements()).toBe(operation.count)
          expect(result.tickets).toHaveLength(index === operations.length - 1 ? 0 : size)
          for (const ticket of result.tickets) {
            if (targets === 'none') expect(ticket).not.toHaveProperty('target')
            else
              expect(ticket.target).toBe(
                targets === 'shared' ? 'AUT-1000' : `AUT-${1000 + Number(ticket.title)}`,
              )
          }
        }
      }
    }
  }
}

/** Persisted caches isolate startup transfer from unrelated discarded history. */
export async function warmRestoreReadBudget(
  store: BuildStore,
  backing: BuildStore,
  verify = true,
  fixtureBatch: (write: () => void) => void = (write) => write(),
): Promise<unknown[]> {
  const { DispatchRepositoryFeed } = await import('../cli/dispatch-repository-feed')
  const reports = []
  for (const gap of verify ? [1, 10_000, 100_000, 2] : [1, 10_000, 100_000]) {
    const repo = `/warm-restore-${gap}`
    await backing.ensureRepo(repo)
    const append = (enabled: boolean) =>
      backing.appendRepo(repo, {
        actor: humanActor('budget'),
        type: 'dispatcher.pause-set',
        payload: { enabled },
      })
    await append(false)
    await new DispatchRepositoryFeed(store, repo, () => new Date(0)).refresh()
    // Batch fixture writes where the adapter supports a synchronous transaction;
    // restoration itself always uses the normal public store boundary.
    const pending: Promise<unknown>[] = []
    fixtureBatch(() => {
      for (let i = 0; i < gap - 1; i++)
        pending.push(
          backing.appendRepo(repo, {
            actor: DISPATCHER,
            type: 'dispatcher.run-stopped',
            payload: { run: 'discarded', outcome: 'normal' },
          }),
        )
    })
    await Promise.all(pending)
    // New anchor makes the recovery seed independent of the gap.
    if (gap > 1)
      await backing.appendRepo(repo, {
        actor: DISPATCHER,
        type: 'dispatcher.run-started',
        payload: {
          run: 'latest',
          pid: 1,
          roleWarnings: [],
          effectiveConfig: { kind: 'config', rev: 0 },
        },
      })
    await append(true)
    const metrics = { raw: 0, tails: 0, rows: 0, seeds: 0, seedRows: 0, cursors: [] as number[] }
    const raw = backing.getRepoEvents.bind(backing)
    const tail = backing.getRepositoryTail?.bind(backing)
    const seed = backing.getRepoStateEvents.bind(backing)
    backing.getRepoEvents = async (...args) => {
      metrics.raw++
      const events = await raw(...args)
      metrics.rows += events.length
      return events
    }
    if (tail)
      backing.getRepositoryTail = async (...args) => {
        metrics.tails++
        metrics.cursors.push(args[1] ?? 0)
        if (gap === 2 && metrics.tails === 1) {
          for (let i = 0; i < 1001; i++)
            await backing.appendRepo(repo, {
              actor: DISPATCHER,
              type: 'dispatcher.run-stopped',
              payload: { run: 'racing', outcome: 'normal' },
            })
          await backing.appendRepo(repo, {
            actor: DISPATCHER,
            type: 'dispatcher.run-started',
            payload: {
              run: 'racing-anchor',
              pid: 1,
              roleWarnings: [],
              effectiveConfig: { kind: 'config', rev: 0 },
            },
          })
          await append(true)
        }
        const events = await tail(...args)
        if (verify) expect(events.length).toBeLessThanOrEqual(1000)
        metrics.rows += events.length
        return events
      }
    backing.getRepoStateEvents = async (...args) => {
      metrics.seeds++
      const events = await seed(...args)
      metrics.seedRows += events.length
      return events
    }
    try {
      const feed = new DispatchRepositoryFeed(store, repo, () => new Date(60_000))
      await feed.refresh()
      expect(feed.events.findLast((e) => e.type === 'dispatcher.pause-set')?.payload).toEqual({
        enabled: true,
      })
      if (verify) {
        expect(metrics.raw).toBe(0)
        expect(metrics.seeds).toBe(gap === 1 ? 0 : 1)
        expect(metrics.rows).toBe(gap === 1 ? 1 : 0)
        expect(metrics.tails).toBe(gap === 2 ? 2 : 1)
      }
      reports.push({ gap, ...metrics, cursors: [...metrics.cursors] })
      const before = metrics.rows
      await feed.refresh()
      expect(metrics.rows).toBe(before)
    } finally {
      backing.getRepoEvents = raw
      if (tail) backing.getRepositoryTail = tail
      backing.getRepoStateEvents = seed
    }
  }
  if (verify)
    expect((reports[1] as { seedRows: number }).seedRows).toBe(
      (reports[2] as { seedRows: number }).seedRows,
    )
  return reports
}
