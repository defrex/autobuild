import { missingAccountCredentials, reconcileMissingAccounts } from '../accounts/availability'
import { readRepositoryFacts } from '../store/reduced-reads'
import { READ_CATALOG_IDENTITY } from '../events/compatibility'
import { dispatchFrontendReducer } from '../cli/dispatch-repository-feed'
import { catalogSnapshotName, loadReducerSnapshot } from '../store/snapshots'
import { expect } from 'bun:test'
import { DispatchFrontend } from '../cli/dispatch-frontend'
import type { DispatchChildResult } from '../cli/dispatch-process'
import { createTerminalModeController } from '../cli/terminal-restore'
import { DISPATCHER, humanActor, KERNEL } from '../events/envelope'
import { WebModelHub } from '../web/hub'
import { readOnlyStore } from '../web/read-only'
import { RepositoryFrameSource } from '../web/repository-source'
import { FakeRefreshScheduler } from './refresh-scheduler'
import type { BuildStore } from '../store/types'
import type { RepositoryEvent } from '../events/repository'
import type { DashboardModel } from '../cli/dashboard/model'
import type { TicketSource } from '../ports/types'
import { FileTicketSource } from '../ports/tickets/file'
import { HostedTicketSource } from '../ports/tickets/remote'
import { FakeTicketSource } from '../ports/tickets/fake'
import { boundedStateCount } from '../ports/tickets/states'
import {
  TRIAGE_COUNT_REFRESH_MS,
  TriageCountSampler,
  triageReader,
} from '../cli/triage-count-sampler'

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
  await webReadBudget(store, backing, fillDiscarded)
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
  let checkpointSize: number | undefined
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
  // The interactive kernel child's dispatcher samples the triage count as
  // DispatchLoop wires it: poked between simulated ticks, never inside one,
  // and at most once per TRIAGE_COUNT_REFRESH_MS over the whole run.
  const kernelStates = { calls: 0, inTick: 0 }
  let kernelTicking = false
  const kernelSampler = new TriageCountSampler(
    triageReader(
      {
        countStates: async (names) => {
          kernelStates.calls++
          if (kernelTicking) kernelStates.inTick++
          return [{ name: names[0]!, tickets: 5 }]
        },
      },
      () => 'Triage',
    ),
    () => new Date(now),
  )
  const kernelStartedAt = now
  const kernelTick = async (work: () => Promise<void> = async () => {}) => {
    kernelTicking = true
    try {
      await work()
    } finally {
      kernelTicking = false
    }
    kernelSampler.poke()
    await kernelSampler.settled()
  }
  kernelSampler.poke()
  await kernelSampler.settled()
  try {
    for (let batch = 0; batch < 24; batch++) {
      await kernelTick(async () => {
        for (let i = 0; i < 128; i++) {
          const triage = kernelSampler.value
          await backing.appendRepo(repo, {
            actor: DISPATCHER,
            type: 'dispatcher.tick-completed',
            payload: {
              run: childRun,
              queued: 0,
              ...(triage !== undefined ? { triage } : {}),
              counters: tickCounters,
              janitorDiagnostics: [],
              ticketDiagnostics: [],
              creationDiagnostics: [],
              dependencyDiagnostics: [],
            },
          })
        }
        // Dashboard-class traffic is part of the bound: canonical facts present it.
        await backing.appendRepo(repo, {
          actor: humanActor('test'),
          type: 'dispatcher.pause-set',
          payload: { enabled: false },
        })
      })
      const before = { ...metrics }
      now += 6000
      await refresh()
      expect(metrics.puts - before.puts).toBe((batch + 1) % 5 === 0 ? 1 : 0)
      expect(metrics.rows - before.rows).toBe(129)
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
      // The first throttled save folds the child's identity; from then on the
      // checkpoint is fixed: neither ticks nor dashboard-class facts grow it.
      if (batch >= 4) {
        checkpointSize ??= size
        expect(size).toBe(checkpointSize)
      }
      const rows = metrics.rows
      await refresh()
      expect(metrics.rows).toBe(rows)
    }
    // Advance the clock across rejected equal-cursor saves. A standby can
    // remain quiet indefinitely; each 500 ms frame must not upload its cache.
    const beforeQuiet = { ...metrics }
    for (let poll = 0; poll < 40; poll++) {
      now += 500
      await kernelTick()
      await refresh()
    }
    expect(metrics.puts - beforeQuiet.puts).toBe(1)
    expect(metrics.rows).toBe(beforeQuiet.rows)
    const settled = { ...metrics }
    for (let poll = 0; poll < 120; poll++) {
      now += 500
      await kernelTick()
      await refresh()
    }
    expect(metrics.puts).toBe(settled.puts)
    expect(metrics.bytes).toBe(settled.bytes)
    expect(metrics.rows).toBe(settled.rows)
    expect(sourceStateReads.calls).toBe(0)
    expect(kernelStates.inTick).toBe(0)
    const elapsed = now - kernelStartedAt
    expect(kernelStates.calls).toBeGreaterThan(1)
    expect(kernelStates.calls).toBeLessThanOrEqual(Math.ceil(elapsed / TRIAGE_COUNT_REFRESH_MS) + 1)
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

  // Fixed relevant events/cursor isolate growth from unrelated legacy identities
  // and from the dashboard-event history a version-4 checkpoint cached.
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
  const dashboard: RepositoryEvent[] = []
  for (let i = 0; i < 10000; i++)
    dashboard.push(
      await backing.appendRepo(retentionRepo, {
        actor: humanActor('test'),
        type: i % 2 === 0 ? 'dispatcher.pause-set' : 'dispatcher.intake-set',
        payload: { enabled: i % 4 < 2 },
      }),
    )
  const cursor = dashboard.at(-1)!.seq
  const sizes: number[] = []
  const checkpoint = backing.getReducerSnapshot.bind(backing)
  try {
    for (const length of [100, 10000]) {
      // Model a validated pre-upgrade version-4 cache holding `length` run
      // starts and `length` dashboard facts; no current row exists yet.
      let upgraded = false
      backing.getReducerSnapshot = async (...args) => {
        if (args[0].kind !== 'repo' || args[0].repo !== retentionRepo) return checkpoint(...args)
        if (args[2] === 4)
          return {
            version: 4,
            cursor,
            state: {
              catalogIdentity: READ_CATALOG_IDENTITY,
              acc: {
                retained: [...history.slice(0, length - 1), latest, ...dashboard.slice(0, length)],
                incompleteIdentities: false,
                holder: 'old-0',
              },
            },
          }
        return upgraded ? checkpoint(...args) : null
      }
      const projection = new DispatchRepositoryFeed(store, retentionRepo, () => new Date(now))
      const rows = metrics.rows
      const bytes = metrics.bytes
      const puts = metrics.puts
      await projection.warm()
      // The legacy row normalizes without reading event rows, and is replaced once.
      expect(metrics.rows).toBe(rows)
      expect(metrics.puts - puts).toBe(1)
      expect(projection.identities).toEqual([holder, latest])
      expect(projection.incompleteIdentities).toBe(true)
      sizes.push(metrics.bytes - bytes)
      upgraded = true
      now += 60000
      await projection.refresh()
      await projection.save(true)
      expect(metrics.puts - puts).toBe(1)
      expect(metrics.rows).toBe(rows)
      // A restart restores the replacement clean: no write, no rows.
      const restarted = new DispatchRepositoryFeed(store, retentionRepo, () => new Date(now))
      await restarted.warm()
      await restarted.save(true)
      expect(restarted.identities).toEqual([holder, latest])
      expect(metrics.puts - puts).toBe(1)
      expect(metrics.rows).toBe(rows)
    }
    // The replacement's size is fixed by its identities, not the legacy history.
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
            now += TRIAGE_COUNT_REFRESH_MS
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
          now += TRIAGE_COUNT_REFRESH_MS
          await refresh()
          if (configured) expected++
          expect(slices.rows()).toBe(0)
          expect(counts.calls).toBe(expected)
          if (configured) {
            expect(new Set(counts.names)).toEqual(new Set(['Triage']))
            // A failed read keeps the last good count and reads no events.
            counts.fail = true
            now += TRIAGE_COUNT_REFRESH_MS
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

/** Store methods whose cost grows with build count; `ab web`'s shell never calls them. */
const BUILD_SCOPE_READS = new Set([
  'listBuildsForRepo',
  'listBuilds',
  'getRepoBuildDigests',
  'getEvents',
  'getBuild',
  'listStreams',
  'getArtifact',
  'getRepoArtifact',
])

/** Count every store call by name; reduced-value reads also by scope kind. */
function countingStore(store: BuildStore) {
  const calls: string[] = []
  const proxy = new Proxy(store, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        const name = String(key)
        calls.push(
          name === 'getReducerValue'
            ? `getReducerValue:${(args[0] as { kind?: string }).kind}`
            : name,
        )
        return Reflect.apply(value, target, args)
      }
    },
  })
  const histogram = () => {
    const counts: Record<string, number> = {}
    for (const name of [...calls].sort()) counts[name] = (counts[name] ?? 0) + 1
    return counts
  }
  return { proxy, calls, histogram }
}

/**
 * `ab web`'s shared refresh loop (RFC 0007 §9.3): with no browser connected
 * it reads nothing; with one or ten connected, each tick reads one change
 * position while nothing changes; and the cost is the same at 100 and
 * 100,000 repository events and at 2 and 200 builds, because the repository
 * frame never makes a build-scope read.
 */
async function webReadBudget(
  store: BuildStore,
  backing: BuildStore,
  fill?: (repo: string, count: number) => Promise<void>,
): Promise<void> {
  const slices = countJournalSlices(backing)
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
  // Idle histograms per configuration; every journal length × build count cell must match.
  const reference = new Map<boolean, Record<string, number>>()
  const IDLE_MS = 25_000
  try {
    for (const length of [100, 100_000]) {
      for (const configured of [false, true]) {
        const repo = `/web-budget-${length}-${configured ? 'configured' : 'unconfigured'}`
        await backing.ensureRepo(repo)
        if (fill !== undefined) await fill(repo, length)
        else
          for (let i = 0; i < length; i++)
            await backing.appendRepo(repo, {
              actor: humanActor('budget'),
              type: 'dispatcher.intake-set',
              payload: { enabled: i % 2 === 0 },
            })
        if (configured) {
          const config = await backing.putRepoArtifact(repo, {
            kind: 'config',
            content: JSON.stringify({ capacity: 4 }),
          })
          await backing.appendRepo(repo, {
            actor: DISPATCHER,
            type: 'dispatcher.run-started',
            payload: {
              run: 'web-budget',
              pid: 1,
              roleWarnings: ['role implement has no model'],
              effectiveConfig: { kind: config.kind, rev: config.revision },
            },
          })
        }
        // The one canonical materialization is allowed once, never once per tab.
        await readRepositoryFacts(store, repo)
        let created = 0
        for (const builds of [2, 200]) {
          for (; created < builds; created++) {
            const slug = `web-budget-${length}-${configured ? 'c' : 'u'}-${created}`
            await backing.createBuild({ slug, repo })
            await backing.append(slug, {
              actor: KERNEL,
              type: 'runner.attached',
              payload: { instance: `runner-${created}`, host: 'budget', resumedFromSeq: 0 },
            })
          }
          const frames: string[][] = []
          for (const subscribers of [1, 10]) {
            const counter = countingStore(store)
            const time = new FakeRefreshScheduler()
            const hub = new WebModelHub({
              source: new RepositoryFrameSource(readOnlyStore(counter.proxy), repo),
              networkReads: store.networkReads === true,
              scheduler: time,
            })
            // 1. No subscriber: no read and no timer, however long it idles.
            await time.advance(60_000)
            expect(counter.calls).toEqual([])
            expect(time.tasks.size).toBe(0)

            const received = Array.from({ length: subscribers }, () => [] as string[])
            const offs = received.map((list) => hub.subscribe((json) => list.push(json)))
            await hub.join()
            // 2. Idle ticks after the first read only the change position.
            counter.calls.length = 0
            slices?.reset()
            rawCalls = 0
            await time.advance(IDLE_MS)
            await hub.join()
            const idle = counter.histogram()
            expect(Object.keys(idle)).toEqual(['getRepoChangePosition'])
            expect(slices?.rows() ?? 0).toBe(0)
            expect(rawCalls).toBe(0)
            // 4/5. Flat in tab count, history and build count.
            const expected = reference.get(configured)
            if (expected === undefined) reference.set(configured, idle)
            else expect(idle).toEqual(expected)

            // 6. Build activity moves the position; the next tick reads at most
            // one saved repository value and no journal rows.
            counter.calls.length = 0
            slices?.reset()
            await backing.append(`web-budget-${length}-${configured ? 'c' : 'u'}-0`, {
              actor: KERNEL,
              type: 'runner.attached',
              payload: { instance: 'runner-again', host: 'budget', resumedFromSeq: 0 },
            })
            await time.advance(5_000)
            await hub.join()
            const moved = counter.histogram()
            expect(moved.getRepo ?? 0).toBeLessThanOrEqual(1)
            expect(moved['getReducerValue:repo'] ?? 0).toBeLessThanOrEqual(1)
            expect(slices?.rows() ?? 0).toBe(0)
            expect(rawCalls).toBe(0)
            // One appended repository event costs one journal row.
            counter.calls.length = 0
            slices?.reset()
            await backing.appendRepo(repo, {
              actor: humanActor('budget'),
              type: 'dispatcher.pause-set',
              payload: { enabled: created % 2 === 0 },
            })
            await time.advance(5_000)
            await hub.join()
            if (slices !== undefined) expect(slices.rows()).toBe(1)
            expect(rawCalls).toBe(0)
            const changed = counter.histogram()
            expect(changed.getRepo).toBe(1)
            expect(changed['getReducerValue:repo']).toBe(1)

            // 3. Never a build-scope read, and every read goes through the guard.
            for (const name of counter.calls) {
              expect(BUILD_SCOPE_READS.has(name)).toBe(false)
              expect(name.startsWith('getReducerValue:') ? name : 'repo').toMatch(/repo$/u)
            }
            // Every subscriber received the same frames.
            for (const list of received) expect(list).toEqual(received[0]!)
            frames.push(received[0]!)

            // 7. After the last tab leaves, nothing more is read.
            for (const off of offs) off()
            expect(hub.subscribers).toBe(0)
            counter.calls.length = 0
            await time.advance(60_000)
            expect(counter.calls).toEqual([])
            expect(time.tasks.size).toBe(0)
            hub.close()
          }
          expect(frames[0]!.length).toBeGreaterThan(0)
        }
      }
    }
  } finally {
    slices?.restore()
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
 * on odd ones, and `priority` urgent on titles divisible by 3 and normal
 * otherwise; statement counts must not change with links or priority.
 *
 * With `triageState`, also measure the interactive dispatcher's triage sample
 * (one bounded `countStates` read, never a listing): it answers the fixture's
 * `size` with the same statement count at every ticket population. */
export async function ticketListReadBudget(
  fixture: (
    size: number,
    targets: 'none' | 'shared' | 'distinct',
  ) => {
    source: import('../ports/types').TicketSource
    reset(): void
    statements(): number
  },
  opts: { triageState?: string } = {},
): Promise<void> {
  const sampleCosts: number[] = []
  for (const size of [0, 1, 100]) {
    if (opts.triageState !== undefined) {
      const { source, reset, statements } = fixture(size, 'none')
      expect(source.countStates).toBeDefined()
      Object.defineProperty(source, 'listStates', {
        configurable: true,
        value: async () => {
          throw new Error('the triage sample never lists ticket states')
        },
      })
      reset()
      expect(await boundedStateCount(source, opts.triageState)).toBe(size)
      // Seed probe, state names, one primary-key probe: no ticket rows.
      expect(statements()).toBeLessThanOrEqual(3)
      sampleCosts.push(statements())
    }
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
            // Priority arrives on the listed row too.
            if (Number(ticket.title) % 3 === 0) expect(ticket.priority).toBe('urgent')
            else expect(ticket).not.toHaveProperty('priority')
          }
        }
      }
    }
  }
  // The bounded count costs the same at every ticket population.
  for (const cost of sampleCosts) expect(cost).toBe(sampleCosts[0]!)
}

/** One fixture per population: a fresh source (no client cache can hide a
 * read) whose node has exactly three children (open, resolved and in the
 * rejected role) among `unrelated` other tickets, some targeting another node.
 * `requests` are the ticket-service operations the source issued since
 * `reset`, with their response sizes; the children's sizes must not depend on
 * the population, so byte totals compare exactly. */
export interface TicketTargetingFixture {
  source: TicketSource
  node: string
  open: string
  children: string[]
  rejectedState: string
  reset(): void
  statements(): number
  requests(): { operation: string; bytes: number }[]
}

/** A due node's targeted read costs the same statements, requests and bytes at
 * 10 and 10,000 unrelated tickets, and an observation pass reads only that
 * node's children: nothing while no node is observed, one `list-targeting`
 * and no `list-ready` per observed node. */
export async function ticketTargetingReadBudget(
  fixture: (unrelated: number) => Promise<TicketTargetingFixture>,
): Promise<void> {
  const { MemoryBuildStore } = await import('../store/memory')
  const { integrationObservationInputs, observeIntegration } = await import(
    '../kernel/integration-completeness'
  )
  const costs: { statements: number; requests: string[]; bytes: number }[] = []
  for (const unrelated of [10, 10_000]) {
    const { source, node, open, children, rejectedState, reset, statements, requests } =
      await fixture(unrelated)
    expect(source.listTargeting).toBeDefined()
    reset()
    const listing = await source.listTargeting!(node)
    expect(listing.tickets.map((ticket) => ticket.ref.id).sort()).toEqual([...children].sort())
    for (const ticket of listing.tickets) expect(ticket.target).toBe(node)
    costs.push({
      statements: statements(),
      requests: requests().map((request) => request.operation),
      bytes: requests().reduce((total, request) => total + request.bytes, 0),
    })

    const store = new MemoryBuildStore()
    const ticket = { source: source.name, id: node }
    await store.createBuild({
      slug: 'node',
      repo: 'repo',
      ticket,
      created: {
        actor: DISPATCHER,
        type: 'build.created',
        payload: { repo: 'repo', ticket, kind: 'node', baseBranch: 'main' },
      },
    })
    reset()
    const inputs = await integrationObservationInputs(store, source, 'repo')
    // A pass in which no node is observed reads no ticket at all.
    expect(requests()).toEqual([])
    const observed = await observeIntegration(store, source, 'node', async () => inputs, {
      rejectedState,
    })
    expect(observed.diagnostics).toEqual([])
    expect(observed.openChildren).toEqual([open])
    expect(requests().map((request) => request.operation)).toEqual(['list-targeting'])
  }
  expect(costs[0]!.requests).toEqual(['list-targeting'])
  expect(costs[1]).toEqual(costs[0]!)
}

/** One fixture per population and listing path: a fresh source over
 * `population` tickets, all in `Ready`, none urgent. `native` is a service
 * answering `list-page`; `fallback` is one predating it. `requests` are the
 * ticket-service operations the source issued since `reset`, with their
 * response sizes; window rows must not vary in size with the population. */
export interface TicketPageFixture {
  source: TicketSource
  reset(): void
  statements(): number
  requests(): { operation: string; bytes: number }[]
}

/** A paged operator listing (per operator request and per dashboard page view)
 * through a hosted service that pages natively costs one `list-page` request
 * whose statements are the same, and whose bytes differ only by the width of
 * the total's digits, at 10 and 10,000 tickets. Against a service predating it,
 * the same listing reads every ticket through one `list-ready`. */
export async function ticketPageReadBudget(
  fixture: (population: number, mode: 'native' | 'fallback') => Promise<TicketPageFixture>,
): Promise<void> {
  const { MemoryBuildStore } = await import('../store/memory')
  const { listOperatorTickets } = await import('../operator/tickets')
  const { ticketsSchema } = await import('../config/schema')
  const tickets = ticketsSchema.parse({ source: 'hosted', teamKey: 'ENG', readyState: 'Ready' })
  const populations = [10, 10_000] as const
  const costs = new Map<string, { statements: number; bytes: number; ids: string[] }>()
  for (const mode of ['native', 'fallback'] as const)
    for (const population of populations) {
      const { source, reset, statements, requests } = await fixture(population, mode)
      if (mode === 'native') expect(source.listPage).toBeDefined()
      else expect(source.listPage).toBeUndefined()
      for (const order of ['oldest', 'newest'] as const) {
        reset()
        const queue = await listOperatorTickets({
          store: new MemoryBuildStore(),
          repo: 'repo',
          state: 'Ready',
          page: { limit: 3, offset: 2, order },
          backend: {
            contextFor: async () => ({ repo: 'repo', tickets, teamKey: 'ENG' }),
            sourceFor: () => source,
            statesFor: () => ['Ready'],
          },
        })
        expect(queue.tickets).toHaveLength(3)
        expect(queue.total).toBe(population)
        expect(requests().map((request) => request.operation)).toEqual([
          mode === 'native' ? 'list-page' : 'list-ready',
        ])
        costs.set(`${mode}:${population}:${order}`, {
          statements: statements(),
          bytes: requests().reduce((total, request) => total + request.bytes, 0),
          ids: queue.tickets.map((ticket) => ticket.ref.id),
        })
      }
    }
  const digits = String(populations[1]).length - String(populations[0]).length
  for (const order of ['oldest', 'newest'] as const) {
    const small = costs.get(`native:${populations[0]}:${order}`)!
    const large = costs.get(`native:${populations[1]}:${order}`)!
    expect(large.statements).toBe(small.statements)
    expect(Math.abs(large.bytes - small.bytes)).toBeLessThanOrEqual(digits)
    // With no urgent ticket both paths agree on the window; the fallback read
    // every ticket to produce it.
    const fallback = costs.get(`fallback:${populations[1]}:${order}`)!
    expect(fallback.ids).toEqual(large.ids)
    expect(fallback.bytes).toBeGreaterThan(large.bytes * 100)
  }
}

/** One ticket of a search-budget population: fixed-width id and title, a body
 * of at least 1 KiB, and strides that give each budget query more than two
 * pages of matches. The pattern repeats every 60 numbers, so the newest
 * matches of 100 and 100,000 tickets carry the same states and labels. */
export interface TicketSearchRow {
  number: number
  id: string
  title: string
  body: string
  state: string
  labels: string[]
}

const SEARCH_PAD = 'x'.repeat(1024)
const SEARCH_BODY = `Body ${SEARCH_PAD}`
const SEARCH_NEEDLE_BODY = `Body with a needle in it ${SEARCH_PAD}`

export function ticketSearchRows(population: number): TicketSearchRow[] {
  return Array.from({ length: population }, (_, i) => {
    const number = i + 1
    const n = String(number).padStart(6, '0')
    return {
      number,
      id: `ENG-${n}`,
      title: `${number % 5 === 0 ? 'Needle' : 'ticket'} ${n}`,
      body: number % 3 === 0 ? SEARCH_NEEDLE_BODY : SEARCH_BODY,
      state: number % 4 < 2 ? 'Ready' : 'Triage',
      labels: number % 2 === 0 ? ['dup'] : [],
    }
  })
}

/** Same shape as `TicketPageFixture`: a fresh source over `tickets`;
 * `native` is a service answering `search`, `predating` one without it. */
export type TicketSearchFixture = TicketPageFixture

/** A search page (per operator or agent request) through a hosted service
 * that searches costs exactly one `search` request and one bounded statement,
 * state-filtered pages and state refusals included, and ships no bodies, at
 * 100 and 100,000 tickets. Against a service predating search, the caller
 * refuses with `TicketSearchUnsupported` before any request: nothing is
 * listed. */
export async function ticketSearchReadBudget(
  fixture: (
    population: number,
    mode: 'native' | 'predating',
    tickets: TicketSearchRow[],
  ) => Promise<TicketSearchFixture>,
): Promise<void> {
  const { searchTickets, searchTerms, matchesSearch, TicketSearchUnsupported } = await import(
    '../ports/tickets/search'
  )
  const populations = [100, 100_000] as const
  const limit = 5
  const queries = [
    { key: 'all' },
    { key: 'labels', labels: ['dup'] },
    { key: 'state', state: 'Ready' },
    { key: 'folded state', state: 'ready' },
  ] as const
  const bytes = new Map<string, number>()
  for (const population of populations) {
    const tickets = ticketSearchRows(population)
    const newestFirst = [...tickets].reverse()
    const terms = searchTerms('NEEDLE')
    const { source, reset, statements, requests } = await fixture(population, 'native', tickets)
    expect(source.search).toBeDefined()
    for (const query of queries) {
      const state = 'state' in query ? 'Ready' : undefined
      const labels = 'labels' in query ? query.labels : []
      const expected = newestFirst
        .filter(
          (ticket) =>
            (state === undefined || ticket.state === state) &&
            labels.every((label) => ticket.labels.includes(label)) &&
            matchesSearch(ticket, terms),
        )
        .slice(0, 2 * limit)
        .map((ticket) => ticket.id)
      let cursor: string | undefined
      const seen: string[] = []
      for (const pageNumber of [1, 2]) {
        reset()
        const page = await searchTickets(source, {
          text: 'NEEDLE',
          limit,
          ...('state' in query ? { state: query.state } : {}),
          ...('labels' in query ? { labels: [...query.labels] } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
        })
        expect(requests().map((request) => request.operation)).toEqual(['search'])
        expect(statements()).toBe(1)
        expect(page.tickets).toHaveLength(limit)
        expect(page.cursor).toBeDefined()
        const size = requests().reduce((total, request) => total + request.bytes, 0)
        // A body is at least 1 KiB, so no page of five hits shipped one.
        expect(size).toBeLessThan(limit * 1024)
        bytes.set(`${population}:${query.key}:${pageNumber}`, size)
        seen.push(...page.tickets.map((hit) => hit.id))
        cursor = page.cursor
      }
      expect(seen).toEqual(expected)
    }
    reset()
    await expect(
      searchTickets(source, { text: 'NEEDLE', limit, state: 'nonexistent' }),
    ).rejects.toThrow(/unknown state "nonexistent"/)
    expect(requests().map((request) => request.operation)).toEqual(['search'])
    expect(statements()).toBe(1)

    const predating = await fixture(population, 'predating', tickets)
    expect(predating.source.search).toBeUndefined()
    predating.reset()
    await expect(searchTickets(predating.source, { text: 'NEEDLE', limit })).rejects.toBeInstanceOf(
      TicketSearchUnsupported,
    )
    expect(predating.requests()).toEqual([])
    expect(predating.statements()).toBe(0)
  }
  // Only the cursor's digits grow with the population.
  const digits = String(populations[1]).length - String(populations[0]).length
  for (const query of queries)
    for (const pageNumber of [1, 2]) {
      const small = bytes.get(`${populations[0]}:${query.key}:${pageNumber}`)!
      const large = bytes.get(`${populations[1]}:${query.key}:${pageNumber}`)!
      expect(Math.abs(large - small)).toBeLessThanOrEqual(digits)
    }
}

/** A provider-backed source over `tickets`, counting provider requests: each
 * entry is one request's sent and received byte sizes. */
export interface TicketSearchRequestFixture {
  source: TicketSource
  reset(): void
  requests(): Array<{ request: number; response: number }>
}

/** A search page through a provider-backed source (Linear, for one) costs
 * exactly one provider request, ships no bodies, returns the shared matcher's
 * newest-first matches, and costs the same bytes at 100 and 100,000 tickets. */
export async function ticketSearchRequestBudget(
  fixture: (population: number, tickets: TicketSearchRow[]) => Promise<TicketSearchRequestFixture>,
): Promise<void> {
  const { searchTickets, searchTerms, matchesSearch } = await import('../ports/tickets/search')
  const populations = [100, 100_000] as const
  const limit = 5
  const queries = [
    { key: 'all' },
    { key: 'labels', labels: ['dup'] },
    { key: 'state', state: 'Ready' },
  ] as const
  const sizes = new Map<string, { request: number; response: number }>()
  for (const population of populations) {
    const tickets = ticketSearchRows(population)
    const newestFirst = [...tickets].reverse()
    const terms = searchTerms('NEEDLE')
    const { source, reset, requests } = await fixture(population, tickets)
    for (const query of queries) {
      const state = 'state' in query ? query.state : undefined
      const labels: readonly string[] = 'labels' in query ? query.labels : []
      const expected = newestFirst
        .filter(
          (ticket) =>
            (state === undefined || ticket.state === state) &&
            labels.every((label) => ticket.labels.includes(label)) &&
            matchesSearch(ticket, terms),
        )
        .slice(0, 2 * limit)
        .map((ticket) => ticket.id)
      let cursor: string | undefined
      const seen: string[] = []
      for (const pageNumber of [1, 2]) {
        reset()
        const page = await searchTickets(source, {
          text: 'NEEDLE',
          limit,
          ...(state !== undefined ? { state } : {}),
          ...(labels.length > 0 ? { labels: [...labels] } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
        })
        const sent = requests()
        expect(sent).toHaveLength(1)
        expect(page.tickets).toHaveLength(limit)
        expect(page.cursor).toBeDefined()
        // A body is at least 1 KiB, so no page of five hits shipped one.
        expect(sent[0]!.response).toBeLessThan(limit * 1024)
        sizes.set(`${population}:${query.key}:${pageNumber}`, sent[0]!)
        seen.push(...page.tickets.map((hit) => hit.id))
        cursor = page.cursor
      }
      expect(seen).toEqual(expected)
    }
  }
  // Only a cursor's digits may grow with the population; cursors may be
  // encoded, so allow the encoded width of those digits.
  const digits = 2 * (String(populations[1]).length - String(populations[0]).length)
  for (const query of queries)
    for (const pageNumber of [1, 2]) {
      const small = sizes.get(`${populations[0]}:${query.key}:${pageNumber}`)!
      const large = sizes.get(`${populations[1]}:${query.key}:${pageNumber}`)!
      expect(Math.abs(large.request - small.request)).toBeLessThanOrEqual(digits)
      expect(Math.abs(large.response - small.response)).toBeLessThanOrEqual(digits)
    }
}

/** Builds one dispatcher pass's observation inputs for a node build over a
 * fresh memory store, reporting which listing path the source decided on
 * before the pass; `observe` then observes the node with those inputs. */
export async function integrationNodePass(
  source: TicketSource,
  nodeId: string,
): Promise<{
  path: 'targeted' | 'exhaustive'
  observe(): Promise<{ openChildren: string[]; diagnostics: string[] }>
}> {
  const { MemoryBuildStore } = await import('../store/memory')
  const { integrationObservationInputs, observeIntegration } = await import(
    '../kernel/integration-completeness'
  )
  const store = new MemoryBuildStore()
  const ticket = { source: source.name, id: nodeId }
  await store.createBuild({
    slug: 'node',
    repo: 'repo',
    ticket,
    created: {
      actor: DISPATCHER,
      type: 'build.created',
      payload: { repo: 'repo', ticket, kind: 'node', baseBranch: 'main' },
    },
  })
  const inputs = await integrationObservationInputs(store, source, 'repo')
  return {
    path: inputs.targeting ? 'targeted' : 'exhaustive',
    observe: async () => {
      const { openChildren, diagnostics } = await observeIntegration(
        store,
        source,
        'node',
        async () => inputs,
      )
      return { openChildren, diagnostics }
    },
  }
}

/** Nested nodes, retargeted, removed, resolved and rejected-role children
 * observe the same open children through `source`'s targeted read as through
 * its exhaustive listing. `source` must declare `listTargeting` and accept
 * `completed` and `rejectedState` as create states. */
export async function targetedCompletenessParity(
  source: TicketSource,
  states: { completed: string; rejectedState: string },
): Promise<void> {
  const { MemoryBuildStore } = await import('../store/memory')
  const { integrationObservationInputs, observeIntegration } = await import(
    '../kernel/integration-completeness'
  )
  expect(source.listTargeting).toBeDefined()
  const exhaustive = {
    name: source.name,
    integrationTree: true,
    listAll: () => source.listAll!(),
  } as unknown as TicketSource
  const node = await source.create({ title: 'node', body: 'node', kind: 'node' })
  const nested = await source.create({
    title: 'nested',
    body: 'nested',
    kind: 'node',
    target: node.ref.id,
  })
  const child = (title: string, target: string, state?: string) =>
    source.create({ title, body: title, target }, state === undefined ? {} : { state })
  const moved = await child('moved', node.ref.id)
  const removed = await child('removed', nested.ref.id)
  await child('resolved', node.ref.id, states.completed)
  await child('rejected', node.ref.id, states.rejectedState)
  await child('unrelated', nested.ref.id)
  const store = new MemoryBuildStore()
  for (const [slug, ticket] of [
    ['node', node],
    ['nested', nested],
  ] as const) {
    const ref = { source: source.name, id: ticket.ref.id }
    await store.createBuild({
      slug,
      repo: 'repo',
      ticket: ref,
      created: {
        actor: DISPATCHER,
        type: 'build.created',
        payload: { repo: 'repo', ticket: ref, kind: 'node', baseBranch: 'main' },
      },
    })
  }
  const compare = async () => {
    const open: Record<string, string[]> = {}
    for (const slug of ['node', 'nested']) {
      const observe = async (tickets: TicketSource) => {
        const inputs = await integrationObservationInputs(store, tickets, 'repo')
        const observed = await observeIntegration(store, tickets, slug, async () => inputs, {
          rejectedState: states.rejectedState,
        })
        expect(observed.diagnostics).toEqual([])
        return observed.openChildren
      }
      open[slug] = await observe(source)
      expect(open[slug]).toEqual(await observe(exhaustive))
    }
    return open
  }
  const initial = await compare()
  expect(initial.node).toContain(moved.ref.id)
  expect(initial.node).not.toContain(removed.ref.id)
  expect(initial.nested).toContain(removed.ref.id)
  await source.update(moved.ref.id, { target: nested.ref.id })
  await compare()
  await source.update(removed.ref.id, { target: null })
  await compare()
  await source.transition(moved.ref.id, states.completed)
  await compare()
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
    missing: { rows: number; slices?: number; identities: number; checkpointReads: number }
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
      const frontendCheckpoint = (args: Parameters<BuildStore['getReducerSnapshot']>) =>
        args[0].kind === 'repo' &&
        args[0].repo === repo &&
        args[1] === catalogSnapshotName('dispatchFrontend')
      const checkpointVersions: number[] = []
      backing.getReducerSnapshot = async (...args) => {
        if (frontendCheckpoint(args)) checkpointVersions.push(args[2])
        return checkpoint(...args)
      }
      try {
        // A checkpoint `gap` events stale: restore within the window, else canonical seed.
        const feed = new DispatchRepositoryFeed(store, repo, () => new Date(60_000))
        const restored = await feed.refresh()
        const head = await backing.getRepoHighWater(repo)
        // Within the window the delta carries the fact; presentation reads canonical facts.
        if (gap === 1) expect(restored.at(-1)?.payload).toEqual({ enabled: true })
        // A present current checkpoint is the only checkpoint read, even when stale.
        expect(checkpointVersions).toEqual([dispatchFrontendReducer.version])
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
        backing.getReducerSnapshot = async (...args) => {
          if (!frontendCheckpoint(args)) return checkpoint(...args)
          checkpointVersions.push(args[2])
          return null
        }
        checkpointVersions.length = 0
        const counted = { ...metrics }
        slices?.reset()
        const fresh = new DispatchRepositoryFeed(store, repo, () => new Date(120_000))
        await fresh.warm()
        const missing = {
          rows: metrics.rows - counted.rows,
          ...(slices ? { slices: slices.rows() } : {}),
          identities: fresh.identities.length,
          checkpointReads: checkpointVersions.length,
        }
        // A current-version miss makes one legacy read, then seeds canonically.
        expect(checkpointVersions).toEqual([dispatchFrontendReducer.version, 4])
        expect(metrics.seeds).toBe(counted.seeds)
        expect(metrics.raw).toBe(counted.raw)
        expect(metrics.canonical - counted.canonical).toBe(1)
        expect(missing.rows).toBe(0)
        if (slices) expect(slices.rows()).toBe(0)
        expect(
          fresh.identities.map((e) => e.type === 'dispatcher.run-started' && e.payload.run),
        ).toEqual([gap === 2 ? 'racing-anchor' : 'latest'])
        if (gap !== 2) expect(fresh.identities).toEqual([latest])
        // Unchanged: zero event rows. One new fact: exactly one row.
        slices?.reset()
        expect(await fresh.refresh()).toEqual([])
        expect(metrics.rows - counted.rows).toBe(0)
        if (slices) expect(slices.rows()).toBe(0)
        const next = await append(false)
        expect(await fresh.refresh()).toEqual([next])
        expect(metrics.rows - counted.rows).toBe(1)
        expect(checkpointVersions).toHaveLength(2)
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
