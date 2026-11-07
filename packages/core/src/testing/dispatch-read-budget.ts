import { missingAccountCredentials, reconcileMissingAccounts } from '../accounts/availability'
import { readRepositoryFacts } from '../store/reduced-reads'
import { dispatchFrontendReducer } from '../cli/dispatch-repository-feed'
import {
  catalogSnapshotName,
  loadReducerSnapshot,
  persistReducerSnapshot,
} from '../store/snapshots'
import { expect } from 'bun:test'
import { DispatchFrontend } from '../cli/dispatch-frontend'
import type { DispatchChildResult } from '../cli/dispatch-process'
import { createTerminalModeController } from '../cli/terminal-restore'
import { DISPATCHER, humanActor } from '../events/envelope'
import type { BuildStore } from '../store/types'
import type { RepositoryEvent } from '../events/repository'
import type { DashboardModel } from '../cli/dashboard/model'
import type { TicketSource } from '../ports/types'
import { FileTicketSource } from '../ports/tickets/file'
import { HostedTicketSource } from '../ports/tickets/remote'
import { FakeTicketSource } from '../ports/tickets/fake'

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
  fillDiscarded?: (repo: string, count: number) => Promise<void>,
): Promise<void> {
  await warmRestoreReadBudget(store, backing, true, fillDiscarded)
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
  // Startup without a checkpoint seeds from the canonical value, not the journal.
  expect(metrics.state).toBe(0)
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
  // The execution-mode frontend renders the kernel's published triage count;
  // it never reads the ticket source itself, on any refresh.
  const sourceStateReads = { calls: 0 }
  type StateReads = Record<'listStates' | 'countStates', StateRead | undefined>
  type StateRead = (...args: unknown[]) => Promise<unknown>
  const stateSources = [FileTicketSource, HostedTicketSource, FakeTicketSource].map(
    (source) => source.prototype as unknown as StateReads,
  )
  const stateMethods = ['listStates', 'countStates'] as const
  const originalStateReads = stateSources.map((prototype) =>
    stateMethods.map((method) => prototype[method]),
  )
  for (const [index, prototype] of stateSources.entries()) {
    for (const [slot, method] of stateMethods.entries()) {
      const original = originalStateReads[index]![slot]
      if (original === undefined) continue
      prototype[method] = function (this: unknown, ...args: unknown[]) {
        sourceStateReads.calls++
        return original.apply(this, args)
      }
    }
  }
  try {
    for (let batch = 0; batch < 24; batch++) {
      for (let i = 0; i < 128; i++) {
        await backing.appendRepo(repo, {
          actor: DISPATCHER,
          type: 'dispatcher.tick-completed',
          payload: {
            run: childRun,
            queued: 0,
            triage: 5,
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
      // Observation pressure is no longer sampled, so a refresh reads no digests.
      expect(metrics.digests - before.digests).toBe(0)
      expect(sourceStateReads.calls).toBe(0)
      expect((frontend as unknown as { model?: DashboardModel }).model?.triage).toBe(5)
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
    expect(sourceStateReads.calls).toBe(0)
  } finally {
    for (const [index, prototype] of stateSources.entries())
      for (const [slot, method] of stateMethods.entries()) {
        const original = originalStateReads[index]![slot]
        if (original !== undefined) prototype[method] = original
      }
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
/** Count rows sliced from the in-memory journal, also when reached through HTTP.
 * Server-side reductions are visible here even though no public read returns them. */
function countJournalSlices(
  backing: BuildStore,
): { rows(): number; reset(): void; restore(): void } | undefined {
  const memory = backing as unknown as { repoState(repo: string): { events: RepositoryEvent[] } }
  const originalState = memory.repoState
  if (originalState === undefined) return undefined
  let rows = 0
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
  return {
    rows: () => rows,
    reset: () => {
      rows = 0
    },
    restore: () => {
      memory.repoState = originalState
    },
  }
}

async function viewerReadBudget(store: BuildStore, backing: BuildStore): Promise<void> {
  const slices = countJournalSlices(backing)
  if (slices === undefined) return
  const originalEvents = backing.getRepoEvents.bind(backing)
  const originalSeed = backing.getRepoStateEvents.bind(backing)
  let rawCalls = 0
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
        slices.reset()
        rawCalls = 0
        for (let fresh = 0; fresh < 3; fresh++) {
          let now = 0
          const controller = new AbortController()
          let painted!: () => void
          let outputs = 0
          const firstFrame = new Promise<void>((resolve) => {
            painted = resolve
          })
          // The viewer's own triage read: one bounded count per due refresh.
          const counts = { calls: 0, names: [] as string[], fail: false }
          const tickets = {
            name: 'budget',
            countStates: async (names: readonly string[]) => {
              counts.calls++
              counts.names.push(...names)
              if (counts.fail) throw new Error('ticket service unavailable')
              return [{ name: names[0]!, tickets: 7 }]
            },
          } as unknown as TicketSource
          const frontend = new DispatchFrontend({
            viewer: {},
            repo,
            store,
            ticketSource: async () => tickets,
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
          const internals = frontend as unknown as {
            readFrame(): Promise<void>
            viewerTriageRead?: Promise<void>
            model?: DashboardModel
          }
          const refresh = async () => {
            await internals.readFrame()
            await internals.viewerTriageRead
          }
          await internals.viewerTriageRead
          let expected = configured ? 1 : 0
          expect(counts.calls).toBe(expected)
          for (let poll = 0; poll < 4; poll++) {
            now += 15_000
            await refresh()
            if (configured) expected++
            expect(counts.calls).toBe(expected)
            if (configured) expect(internals.model?.triage).toBe(7)
            for (let quick = 0; quick < 3; quick++) {
              now += 500
              await refresh()
            }
            expect(counts.calls).toBe(expected)
          }
          expect(slices.rows()).toBe(0)
          expect(rawCalls).toBe(0)
          await backing.appendRepo(repo, {
            actor: humanActor('budget'),
            type: 'dispatcher.pause-set',
            payload: { enabled: true },
          })
          await refresh()
          expect(slices.rows()).toBe(1)
          expect(rawCalls).toBe(0)
          slices.reset()
          now += 15_000
          await refresh()
          if (configured) expected++
          expect(slices.rows()).toBe(0)
          expect(counts.calls).toBe(expected)
          if (configured) {
            expect(new Set(counts.names)).toEqual(new Set(['Triage']))
            // A failed read keeps the last good count and reads no events.
            counts.fail = true
            now += 15_000
            await refresh()
            expect(counts.calls).toBe(++expected)
            expect(internals.model?.triage).toBe(7)
            expect(slices.rows()).toBe(0)
            expect(rawCalls).toBe(0)
            // A headless tick publishes no count; the viewer keeps its own.
            await backing.appendRepo(repo, {
              actor: DISPATCHER,
              type: 'dispatcher.tick-completed',
              payload: {
                run: 'elsewhere',
                queued: 0,
                counters: tickCounters,
                janitorDiagnostics: [],
                ticketDiagnostics: [],
                creationDiagnostics: [],
                dependencyDiagnostics: [],
              },
            })
            await refresh()
            expect(internals.model?.triage).toBe(7)
            expect(rawCalls).toBe(0)
            slices.reset()
          }
          controller.abort()
          await running
        }
        await backing.appendRepo(repo, {
          actor: humanActor('budget'),
          type: 'dispatcher.intake-set',
          payload: { enabled: true },
        })
        await readRepositoryFacts(store, repo)
        expect(slices.rows()).toBe(1)
        expect(rawCalls).toBe(0)
      }
    }
  } finally {
    slices.restore()
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
  await upgradeGenerationReadBudget()
}

/** Completed dispatcher generations must not grow the saved upgrade values or
 * the idle cost of any recurring reader: a dispatch tick, a dashboard poll, an
 * `ab watch` liveness check and `ab repository status`. */
async function upgradeGenerationReadBudget(): Promise<void> {
  const { MemoryBuildStore } = await import('../store/memory')
  const { manualClock } = await import('./fixed')
  const { readDispatchUpgrade } = await import('../store/reduced-reads')
  const { memoryRepositoryReadCounter } = await import('./reduced-read-budget')
  const { upgradeGenerationRun, upgradeGenerationWrites, resolutionOnlyWrites } = await import(
    './upgrade-generations'
  )
  const { Dispatcher } = await import('../processes/dispatcher')
  const { authorizeRemoteHandoffs } = await import('../kernel/dispatch-drain-recovery')
  const { getOperatorDashboard, getRepositoryStatus } = await import('../operator/query')
  const { abWatch } = await import('../cli/watch')
  const { abRepositoryStatus } = await import('../cli/repository-status')
  const { parseConfig } = await import('../config/load')
  const { FakeWorkspaceProvider } = await import('../ports/workspace/fake')
  const { FakeForge } = await import('../ports/forge/fake')
  const { sequentialIds } = await import('../ids')
  const config = parseConfig(
    '[tickets]\nsource="file"\nreadyState="ready"\n[verify]\nsteps=[]\n[finalize]\nsteps=[]',
  )
  const baseline = new Map<string, number>()
  for (const generations of [20, 2_000]) {
    const repo = '/upgrade-generation-budget'
    const exec = async (args: string[]) =>
      args[1] === 'remote'
        ? { stdout: '', stderr: 'no origin', exitCode: 2 }
        : { stdout: `${repo}/.git\n${repo}/.git\n${repo}\n`, stderr: '', exitCode: 0 }
    const clock = manualClock()
    const store = new MemoryBuildStore({ clock })
    await store.ensureRepo(repo)
    for (let i = 0; i < generations; i++)
      for (const write of upgradeGenerationWrites(i)) await store.appendRepo(repo, write)
    const current = upgradeGenerationRun(generations)
    const { verify: _verify, finalize: _finalize, ...root } = config
    const artifact = await store.putRepoArtifact(repo, {
      kind: 'dispatcher-effective-config',
      content: JSON.stringify({ ...root, verify: { steps: [] }, finalize: { steps: [] } }),
    })
    for (const write of resolutionOnlyWrites(current, 'current', 'launcher', {
      kind: artifact.kind,
      rev: artifact.revision,
    }))
      await store.appendRepo(repo, write)
    await store.claimRepoLease(repo, current, 3_600_000)
    const tick = async () => {
      await new Dispatcher({
        store,
        repo,
        config,
        tickets: new FakeTicketSource([]),
        workspaces: new FakeWorkspaceProvider({ root: '/upgrade-budget', mode: 'logical' }),
        forge: new FakeForge(),
        ids: sequentialIds(),
        clock,
        exec,
        launchRunner: async () => 'scheduled',
      }).tick({ acceptNewWork: false })
      await authorizeRemoteHandoffs(
        store,
        repo,
        (await readRepositoryFacts(store, repo)).value.upgrades,
        new Set(),
      )
    }
    const watch = () =>
      abWatch({
        targetRepo: repo,
        env: {},
        exec,
        storeRef: '/budget',
        openStore: () => store,
        repository: true,
        json: true,
        timeout: '3',
        now: clock,
        stdout: () => {},
        stderr: (line) => {
          throw new Error(line)
        },
        delay: async () => clock.advance(1000),
      })
    const status = async () => {
      await getRepositoryStatus(store, repo, clock())
      const lines: string[] = []
      await abRepositoryStatus({
        targetRepo: repo,
        env: {},
        exec,
        storeRef: '/budget',
        openStore: () => store,
        now: clock,
        stdout: (line) => lines.push(line),
      })
      const upgrades = lines.filter((line) => /^(resolved target|upgrade|handoff) /.test(line))
      expect(upgrades.length).toBeLessThanOrEqual(4)
      expect(upgrades.join('\n')).toContain(`resolved target ${current}:`)
    }
    const readers = {
      tick,
      dashboard: () => getOperatorDashboard({ store, repo, clock }),
      watch,
      status,
    }
    // The one serialized reduction per key, and each reader's own first
    // appends, happen before measurement.
    for (const read of Object.values(readers)) await read()
    for (const read of Object.values(readers)) await read()
    const upgrades = (await readDispatchUpgrade(store, repo)).value
    const {
      scan: _scan,
      scanSeq: _scanSeq,
      ...facts
    } = (await readRepositoryFacts(store, repo)).value
    const bytes = {
      upgrades: Buffer.byteLength(JSON.stringify(upgrades)),
      facts: Buffer.byteLength(JSON.stringify(facts)),
    }
    for (const [name, size] of Object.entries(bytes)) {
      // Only seq digit growth is allowed between journal lengths.
      if (generations === 20) baseline.set(`bytes:${name}`, size)
      else expect(size).toBeLessThanOrEqual(baseline.get(`bytes:${name}`)! + 1024)
    }
    const counter = memoryRepositoryReadCounter(store, repo)
    for (const [name, read] of Object.entries(readers)) {
      counter.reset()
      await read()
      expect({ name, rows: counter.rows }).toEqual({ name, rows: 0 })
      if (generations === 20) baseline.set(name, counter.reducedCalls)
      else
        expect({ name, reduced: counter.reducedCalls }).toEqual({
          name,
          reduced: baseline.get(name)!,
        })
    }
    await store.close()
  }
}

/** Measure real ticket-source operations through an injected statement boundary.
 * Each fixture is fresh, so a source-local cache cannot conceal target reads.
 * Listed rows carry one `closes #1` issue link on even-titled tickets and none
 * on odd ones; statement counts must not change with links. */
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
            // Issue links arrive on the listed row itself, never via a per-ticket read.
            if (Number(ticket.title) % 2 === 0)
              expect(ticket.issueLinks).toEqual([{ issue: 1, intent: 'closes' }])
            else expect(ticket).not.toHaveProperty('issueLinks')
          }
        }
      }
    }
  }
}

/** Persisted caches isolate startup transfer from unrelated discarded history.
 * Without a usable checkpoint, startup seeds from the canonical repository value:
 * its transfer is the same at every journal and current-run length. */
export async function warmRestoreReadBudget(
  store: BuildStore,
  backing: BuildStore,
  verify = true,
  fillDiscarded?: (repo: string, count: number) => Promise<void>,
): Promise<unknown[]> {
  const { DispatchRepositoryFeed } = await import('../cli/dispatch-repository-feed')
  const reports: {
    gap: number
    seeds: number
    seedRows: number
    canonical: number
    missing: { rows: number; slices?: number; identities: number; events: number }
  }[] = []
  const slices = countJournalSlices(backing)
  try {
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
      // The current run's tail spans the whole gap, as a long-running dispatcher's does.
      const latest = await backing.appendRepo(repo, {
        actor: DISPATCHER,
        type: 'dispatcher.run-started',
        payload: {
          run: 'latest',
          pid: 1,
          roleWarnings: [],
          effectiveConfig: { kind: 'config', rev: 0 },
        },
      })
      // Local tests can populate identical irrelevant rows in one SQL statement.
      // Restoration still uses the public store boundary on every adapter.
      if (fillDiscarded && gap > 1) await fillDiscarded(repo, gap - 1)
      else
        for (let i = 0; i < gap - 1; i++)
          await backing.appendRepo(repo, {
            actor: DISPATCHER,
            type: 'dispatcher.run-stopped',
            payload: { run: 'latest', outcome: 'normal' },
          })
      await append(true)
      // The canonical value's one serialized, durably saved reduction precedes startup.
      await readRepositoryFacts(store, repo)
      const metrics = {
        raw: 0,
        tails: 0,
        rows: 0,
        seeds: 0,
        seedRows: 0,
        canonical: 0,
        cursors: [] as number[],
      }
      const raw = backing.getRepoEvents.bind(backing)
      const tail = backing.getRepositoryTail?.bind(backing)
      const seed = backing.getRepoStateEvents.bind(backing)
      const value = backing.getReducerValue.bind(backing)
      const checkpoint = backing.getReducerSnapshot.bind(backing)
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
      backing.getReducerValue = async (scope, request) => {
        if (request.reducer === 'repositoryReadFacts') metrics.canonical++
        return value(scope, request)
      }
      try {
        // A checkpoint `gap` events stale: restore within the window, else canonical seed.
        const feed = new DispatchRepositoryFeed(store, repo, () => new Date(60_000))
        await feed.refresh()
        const head = await backing.getRepoHighWater(repo)
        // Within the window the delta carries the fact; presentation reads canonical facts.
        if (gap === 1) expect(feed.events.at(-1)?.payload).toEqual({ enabled: true })
        if (verify) {
          expect(metrics.raw).toBe(0)
          expect(metrics.seeds).toBe(0)
          expect(metrics.seedRows).toBe(0)
          expect(metrics.canonical).toBe(gap === 1 ? 0 : 1)
          expect(metrics.rows).toBe(gap === 1 ? 2 : 0)
          expect(metrics.tails).toBe(gap === 2 ? 2 : 1)
          expect(metrics.cursors).toEqual(gap === 2 ? [1, head] : [gap === 1 ? 1 : head])
        }
        const before = metrics.rows
        await feed.refresh()
        expect(metrics.rows).toBe(before)
        expect((await readRepositoryFacts(store, repo)).value.settings.paused).toBe(true)

        // A missing checkpoint: a fresh process with no presentation state at all.
        backing.getReducerSnapshot = async (...args) =>
          args[0].kind === 'repo' &&
          args[0].repo === repo &&
          args[1] === catalogSnapshotName('dispatchFrontend')
            ? null
            : checkpoint(...args)
        const counted = { ...metrics }
        slices?.reset()
        const fresh = new DispatchRepositoryFeed(store, repo, () => new Date(120_000))
        await fresh.warm()
        const missing = {
          rows: metrics.rows - counted.rows,
          ...(slices ? { slices: slices.rows() } : {}),
          identities: fresh.identities.length,
          events: fresh.events.length,
        }
        expect(metrics.seeds).toBe(counted.seeds)
        expect(metrics.raw).toBe(counted.raw)
        expect(metrics.canonical - counted.canonical).toBe(1)
        expect(missing.rows).toBe(0)
        if (slices) expect(slices.rows()).toBe(0)
        expect(
          fresh.identities.map((e) => e.type === 'dispatcher.run-started' && e.payload.run),
        ).toEqual([gap === 2 ? 'racing-anchor' : 'latest'])
        if (gap !== 2) expect(fresh.identities).toEqual([latest])
        expect(fresh.events).toEqual([])
        // Unchanged: zero event rows. One new fact: exactly one row.
        slices?.reset()
        expect(await fresh.refresh()).toEqual([])
        expect(metrics.rows - counted.rows).toBe(0)
        if (slices) expect(slices.rows()).toBe(0)
        const next = await append(false)
        expect((await fresh.refresh()).map((e) => e.seq)).toEqual([next.seq])
        expect(metrics.rows - counted.rows).toBe(1)
        expect(fresh.events.at(-1)).toEqual(next)
        reports.push({
          gap,
          seeds: metrics.seeds,
          seedRows: metrics.seedRows,
          canonical: metrics.canonical,
          missing,
        })
      } finally {
        backing.getRepoEvents = raw
        if (tail) backing.getRepositoryTail = tail
        backing.getRepoStateEvents = seed
        backing.getReducerValue = value
        backing.getReducerSnapshot = checkpoint
      }
    }
  } finally {
    slices?.restore()
  }
  // History independence: a fresh process transfers the same rows and retains the
  // same state at 3, 10,000 and 100,000 journal events.
  if (verify)
    for (const report of reports.slice(1, 3)) expect(report.missing).toEqual(reports[0]!.missing)
  return reports
}
