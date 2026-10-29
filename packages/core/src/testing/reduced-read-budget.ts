import { observeTarget } from '../kernel/target-observation'
import { autoMergeDeferralObservation } from '../kernel/auto-merge'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { abDispatch } from '../cli/dispatch'
import { createTerminalModeController } from '../cli/terminal-restore'
import { randomUuids } from '../ids'
import { ScriptedAgentRunner, defaultTurnResult } from '../ports/runner/fake'
import { Dispatcher } from '../processes/dispatcher'
import { FakeTicketSource } from '../ports/tickets/fake'
import { FakeWorkspaceProvider } from '../ports/workspace/fake'
import { FakeForge } from '../ports/forge/fake'
import { sequentialIds } from '../ids'
import { parseConfig } from '../config/load'
import {
  getOperatorDashboard,
  listOperatorBuilds,
  getOperatorBuild,
  getRepositoryStatus,
} from '../operator/query'
import { buildRegistry } from '../operator/registry'
import { expect } from 'bun:test'
import type { BuildStore } from '../store/types'
import { KERNEL, DISPATCHER, humanActor } from '../events/envelope'
import {
  readBuildFacts,
  readBuildStreamSeed,
  readRepositoryFacts,
  readForgeHealth,
  readRepositoryAttention,
  readBuildDigests,
  readDispatcherRunFacts,
  readOpenTick,
} from '../store/reduced-reads'
import { RepoViewStore } from '../processes/repo-view'
import { abWatch, decodeCursor } from '../cli/watch'
import { abWait } from '../cli/wait'
import type { Exec } from '../ports/workspace/git-worktree'

export interface ReducedReadCosts {
  events: number
  metadata: number
  bytes: number
  historicalEvents: number
  history?: { repo: string; through: number }
}
const repo = '/reduced-read-budget'
const slug = 'reduced-budget'
const exec: Exec = async (args) =>
  args[1] === 'remote'
    ? { stdout: '', stderr: 'no origin', exitCode: 2 }
    : { stdout: `${repo}/.git\n${repo}/.git\n${repo}\n`, stderr: '', exitCode: 0 }

/** Shared actual-consumer scenario. Costs must instrument SQL statement results,
 * including private reducer storage, rather than just public getEvents calls. */
export async function reducedReadBudget(opts: {
  store: BuildStore
  costs: ReducedReadCosts
  fresh: () => Promise<BuildStore>
  storeRef?: string
}) {
  const { store, costs } = opts
  await store.ensureRepo(repo)
  const config = parseConfig(
    '[tickets]\nsource="file"\nreadyState="ready"\n[verify]\nsteps=[]\n[finalize]\nsteps=[]',
  )
  const { verify: _verify, finalize: _finalize, ...root } = config
  const configArtifact = await store.putRepoArtifact(repo, {
    kind: 'dispatcher-effective-config',
    content: JSON.stringify({ ...root, verify: { steps: [] }, finalize: { steps: [] } }),
  })
  await store.appendRepo(repo, {
    actor: DISPATCHER,
    type: 'dispatcher.run-started',
    payload: {
      run: 'budget-run',
      pid: 1,
      roleWarnings: [],
      effectiveConfig: { kind: configArtifact.kind, rev: configArtifact.revision },
    },
  })
  await store.createBuild({ slug, repo })
  await store.append(slug, {
    actor: KERNEL,
    type: 'runner.attached',
    payload: { instance: 'budget', host: 'host' },
  })
  await store.append(slug, {
    actor: KERNEL,
    type: 'finalize.completed',
    payload: { pr: { number: 7, url: 'https://example.test/7', headSha: 'abc' } },
  })
  await store.append(slug, {
    actor: KERNEL,
    type: 'landing.decided',
    payload: {
      candidate: { head: 'abc', parent: 'base', cycle: '1' },
      from: 'leaf',
      into: { kind: 'root' },
      labels: [],
      mode: 'consent',
      rule: { default: true },
    },
  })
  const gateCommand = await store.append(slug, {
    actor: humanActor('human'),
    type: 'build.auto-merge-requested',
    payload: {},
  })
  await store.append(
    slug,
    autoMergeDeferralObservation(
      { code: 'repository-auto-merge-disabled', detail: 'disabled' },
      7,
      gateCommand.seq,
      'historical-gate',
    ),
  )
  const targetForge = new FakeForge()
  const target = 'a'.repeat(40)
  await observeTarget({
    store,
    forge: targetForge,
    slug,
    branch: 'main',
    sha: target,
    actor: KERNEL,
  })
  const reset = () => {
    costs.events = 0
    costs.metadata = 0
    costs.bytes = 0
  }
  let repositoryBytes: number | undefined
  for (const length of [32, 256]) {
    for (let i = 0; i < length; i++) {
      await store.append(slug, {
        actor: humanActor('human'),
        type: 'build.auto-merge-requested',
        payload: {},
      })
      await store.appendRepo(repo, {
        actor: humanActor('human'),
        type: 'dispatcher.intake-set',
        payload: { enabled: true },
      })
      const run = `old-${length}-${String(i).padStart(4, '0')}`
      await store.appendRepo(repo, {
        actor: DISPATCHER,
        type: 'dispatcher.run-started',
        payload: {
          run,
          pid: 1,
          roleWarnings: [],
          effectiveConfig: { kind: configArtifact.kind, rev: configArtifact.revision },
        },
      })
      await store.appendRepo(repo, {
        actor: DISPATCHER,
        type: 'dispatcher.run-stopped',
        payload: { run, outcome: 'normal' },
      })
    }
    await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'dispatcher.run-started',
      payload: {
        run: 'budget-run',
        pid: 1,
        roleWarnings: [],
        effectiveConfig: { kind: configArtifact.kind, rev: configArtifact.revision },
      },
    })
    const factsBytes = Buffer.byteLength(
      JSON.stringify((await readRepositoryFacts(store, repo)).value),
    )
    if (repositoryBytes !== undefined) expect(factsBytes).toBeLessThan(repositoryBytes + 512)
    repositoryBytes = factsBytes
    // Warm persisted values independently of any consumer instance.
    await readBuildStreamSeed(store, slug)
    await readBuildFacts(store, slug)
    await readRepositoryFacts(store, repo)
    await readForgeHealth(store, repo)
    await readBuildDigests(store, repo)
    await readRepositoryAttention(store, repo)
    const handle = await opts.fresh()
    const cold = new Proxy(handle, {
      get(target, key) {
        if (key === 'close') return async () => {}
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    // Explicit operation multiplication on fresh handles at both history sizes.
    // Unchanged reduced reads never acquire historical event rows.
    for (const operations of [1, 8]) {
      reset()
      for (let n = 0; n < operations; n++) {
        await readBuildFacts(cold, slug)
        expect(
          await observeTarget({
            store: cold,
            forge: targetForge,
            slug,
            branch: 'main',
            sha: target,
            actor: KERNEL,
          }),
        ).toBe('unchanged')
        await readRepositoryFacts(cold, repo)
      }
      expect(costs.events).toBe(0)
      expect(costs.metadata).toBeLessThan(operations * 20)
    }
    await coldDispatchOnceBudget(store, cold, length, costs)
    await coldDispatchOnceBudget(store, cold, length, costs, true)
    reset()
    const view = new RepoViewStore(cold, { repo })
    await view.refresh()
    expect((await view.buildFacts(slug)).state.pr?.number).toBe(7)
    expect((await view.buildState(slug)).status).toBe('running')
    expect(costs.events).toBe(0)
    expect(costs.metadata).toBeLessThan(100)

    const dispatcher = () =>
      new Dispatcher({
        store: cold,
        repo,
        config,
        tickets: new FakeTicketSource([]),
        workspaces: new FakeWorkspaceProvider({ root: '/budget-workspaces', mode: 'logical' }),
        forge: new FakeForge(),
        ids: sequentialIds(),
        clock: () => new Date(1000),
        exec,
        launchRunner: async () => 'scheduled',
      })
    await dispatcher().tick({ acceptNewWork: false })
    await getOperatorDashboard({ store: cold, repo, clock: () => new Date(1000) })
    reset()
    await dispatcher().tick({ acceptNewWork: false })
    await getOperatorDashboard({ store: cold, repo, clock: () => new Date(1000) })
    await listOperatorBuilds({ store: cold, repo, scope: 'all', now: new Date(1000) })
    await getOperatorBuild({ store: cold, repo, slug, now: new Date(1000) })
    await getRepositoryStatus(cold, repo, new Date(1000))
    await buildRegistry({ store: cold, clock: () => new Date(1000) }).call('builds.get', {
      repo,
      slug,
    })
    expect(costs.events).toBe(0)
    expect(costs.metadata).toBeLessThan(400)
    expect(costs.bytes).toBeLessThan(1_000_000)

    // A fresh watch must suppress historical gate attention despite armed
    // consent at registration, including its first event-bearing poll.
    reset()
    let ticks = 0
    let time = 0
    const out: string[] = []
    await abWatch({
      targetRepo: repo,
      env: {},
      exec,
      storeRef: opts.storeRef ?? '/budget',
      openStore: () => cold,
      slugs: [slug],
      json: true,
      timeout: '2',
      now: () => new Date(time),
      stdout: (line) => out.push(line),
      stderr: () => {},
      delay: async () => {
        time += 1000
        if (++ticks === 1)
          await store.append(slug, {
            actor: humanActor('human'),
            type: 'build.auto-merge-cancelled',
            payload: {},
          })
      },
    })
    expect(out).toHaveLength(1)
    const cursor = JSON.parse(out[0]!).cursor
    expect(
      decodeCursor(cursor, { store: opts.storeRef ?? '/budget', repo }).deliveredAttention,
    ).toEqual([JSON.stringify([slug, 7])])
    expect(costs.events).toBeLessThanOrEqual(4)
    expect(costs.metadata).toBeLessThan(100)

    await store.append(slug, {
      actor: humanActor('human'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    await readBuildStreamSeed(store, slug)
    reset()
    let discoveryTick = 0
    time = 0
    const discovered = new Proxy(cold, {
      get(target, key) {
        if (key === 'listBuilds')
          return async () => (discoveryTick === 0 ? [] : target.listBuilds())
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const discoveryOut: string[] = []
    await abWatch({
      targetRepo: repo,
      env: {},
      exec,
      storeRef: opts.storeRef ?? '/budget',
      openStore: () => discovered,
      json: true,
      timeout: '3',
      now: () => new Date(time),
      stdout: (line) => discoveryOut.push(line),
      stderr: () => {},
      delay: async () => {
        time += 1000
        if (++discoveryTick === 2)
          await store.append(slug, {
            actor: humanActor('human'),
            type: 'build.auto-merge-cancelled',
            payload: {},
          })
      },
    })
    expect(discoveryOut).toHaveLength(1)
    expect(costs.events).toBeLessThanOrEqual(6)
    expect(costs.metadata).toBeLessThan(180)

    // Wait applies its current gate-attention policy instead of watch suppression.
    const immediateCommand = await store.append(slug, {
      actor: humanActor('human'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    await store.append(
      slug,
      autoMergeDeferralObservation(
        { code: 'repository-auto-merge-disabled', detail: 'disabled' },
        7,
        immediateCommand.seq,
        `gate-wait-${length}`,
      ),
    )
    await readBuildStreamSeed(store, slug)
    reset()
    const waitOut: string[] = []
    const result = await abWait({
      targetRepo: repo,
      env: {},
      exec,
      storeRef: opts.storeRef ?? '/budget',
      openStore: () => cold,
      slugs: [slug],
      forValues: ['attention'],
      json: true,
      now: () => new Date(time),
      stdout: (line) => waitOut.push(line),
      stderr: () => {},
    })
    expect(result).toBe(0)
    expect(JSON.parse(waitOut[0]!).observation.pr.number).toBe(7)
    expect(costs.events).toBe(0)
    expect(costs.metadata).toBeLessThan(40)
    const waitCommand = await store.append(slug, {
      actor: humanActor('human'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    await readBuildStreamSeed(store, slug)
    reset()
    let waitTick = 0
    time = 0
    const polled: string[] = []
    const waited = await abWait({
      targetRepo: repo,
      env: {},
      exec,
      storeRef: opts.storeRef ?? '/budget',
      openStore: () => cold,
      slugs: [slug],
      forValues: ['attention'],
      json: true,
      timeout: '4',
      now: () => new Date(time),
      stdout: (line) => polled.push(line),
      stderr: () => {},
      delay: async () => {
        time += 1000
        // The first pass stays idle; the next delivers the first event batch.
        if (++waitTick === 1) {
          expect(costs.events).toBe(0)
          expect(costs.metadata).toBeLessThan(40)
        }
        if (waitTick === 2) {
          expect(costs.events).toBe(0)
          await store.append(
            slug,
            autoMergeDeferralObservation(
              { code: 'repository-auto-merge-disabled', detail: 'disabled' },
              7,
              waitCommand.seq,
              `gate-poll-${length}`,
            ),
          )
        }
      },
    })
    expect(waited).toBe(0)
    expect(waitTick).toBe(2)
    expect(JSON.parse(polled[0]!).observation.pr.number).toBe(7)
    expect(costs.events).toBeLessThanOrEqual(2)
    expect(costs.metadata).toBeLessThan(50)
  }
}

/** Exercise the real outer DispatchLoop with a new invocation identity, either
 * once or for cold and warmed interactive ticks. Only shared values are warmed:
 * no parameterized run value may hide a cold replay. */
async function coldDispatchOnceBudget(
  store: BuildStore,
  cold: BuildStore,
  length: number,
  costs: ReducedReadCosts,
  interactive = false,
) {
  const onceRepo = interactive
    ? 'https://github.com/budget/interactive-ticks'
    : 'https://github.com/budget/cold-once'
  await store.ensureRepo(onceRepo)
  for (let i = 0; i < length; i++)
    await store.appendRepo(onceRepo, {
      actor: humanActor('human'),
      type: 'dispatcher.intake-set',
      payload: { enabled: false },
    })
  const boundary = (await readRepositoryFacts(store, onceRepo)).cursor
  await readForgeHealth(store, onceRepo)
  const directory = await mkdtemp(join(tmpdir(), 'ab-cold-once-'))
  try {
    await writeFile(
      join(directory, 'autobuild.toml'),
      `[roles.default]
runtime = "claude"
[tickets]
source = "file"
readyState = "ready"
[verify]
steps = []
[finalize]
steps = []
`,
    )
    const acquisitions = { facts: 0, digests: 0 }
    const stop = new AbortController()
    let ticks = 0
    let ticketScanWrites = 0
    let tickAcquisitions = { facts: 0, digests: 0 }
    const checked = new Proxy(cold, {
      get(target, key) {
        if (interactive && key === 'beginRepoTick')
          return async (...args: Parameters<BuildStore['beginRepoTick']>) => {
            // Drain startup presentation before opening the kernel window.
            await new Promise((resolve) => setTimeout(resolve, 0))
            // Startup is outside the tick call budget, but must obey the same
            // no-history-replay rule after the prepared boundary.
            expect(costs.historicalEvents).toBe(0)
            acquisitions.facts = acquisitions.digests = ticketScanWrites = 0
            costs.events = costs.historicalEvents = 0
            return target.beginRepoTick(...args)
          }
        if (interactive && key === 'finishRepoTick')
          return (...args: Parameters<BuildStore['finishRepoTick']>) => {
            // Close the kernel window before the independent dashboard poll.
            tickAcquisitions = { ...acquisitions, facts: acquisitions.facts - ticketScanWrites }
            return target.finishRepoTick(...args)
          }
        if (interactive && key === 'appendRepo')
          return (...args: Parameters<BuildStore['appendRepo']>) => {
            // Cold readiness publishes a scan and refreshes its committed facts;
            // this is separate from acquiring the shared tick inputs.
            if (args[1].type === 'dispatcher.ticket-scan-completed') ticketScanWrites++
            return target.appendRepo(...args)
          }
        if (key === 'getRepoBuildDigests')
          return (...args: Parameters<BuildStore['getRepoBuildDigests']>) => {
            acquisitions.digests++
            return target.getRepoBuildDigests(...args)
          }
        if (key === 'getReducerValue')
          return (...args: Parameters<BuildStore['getReducerValue']>) => {
            expect(['dispatcherRunFacts', 'openTick']).not.toContain(args[1].reducer)
            if (args[1].reducer === 'repositoryReadFacts') acquisitions.facts++
            return target.getReducerValue(...args)
          }
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    costs.events = 0
    costs.metadata = 0
    costs.bytes = 0
    costs.historicalEvents = 0
    costs.history = { repo: onceRepo, through: boundary }
    const run = `never-read-once-${length}`
    await abDispatch({
      targetRepo: directory,
      repo: onceRepo,
      env: {},
      exec: async (args) =>
        args[1] === 'remote'
          ? { stdout: `${onceRepo}.git\n`, stderr: '', exitCode: 0 }
          : {
              stdout: `${directory}/.git\n${directory}/.git\n${directory}\n`,
              stderr: '',
              exitCode: 0,
            },
      stdout: () => {},
      stderr: () => {},
      once: !interactive,
      plain: !interactive,
      signal: stop.signal,
      terminal: interactive
        ? {
            columns: 100,
            rows: 24,
            interactive: true,
            write: () => {},
            modes: createTerminalModeController(
              () => {},
              () => {},
            ),
          }
        : undefined,
      sleep: async () => {
        // Drain the asynchronous launch gate before closing each tick window.
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(tickAcquisitions).toEqual({ facts: 1, digests: 1 })
        expect(costs.historicalEvents).toBe(0)
        expect(costs.events).toBeLessThanOrEqual(32)
        // Prepare the newly written tick-completed tail, then prove an
        // unchanged read acquires zero rows.
        await readRepositoryFacts(cold, onceRepo)
        await readBuildDigests(cold, onceRepo)
        const rows = costs.events
        await readRepositoryFacts(cold, onceRepo)
        await readBuildDigests(cold, onceRepo)
        expect(costs.events).toBe(rows)
        if (++ticks === 2) stop.abort()
      },
      kernelRunId: run,
      storeRef: '/budget',
      wire: () => ({
        store: checked,
        storeRef: '/budget',
        tickets: new FakeTicketSource([]),
        forge: new FakeForge(),
        workspaces: new FakeWorkspaceProvider({ root: '/once-workspaces', mode: 'logical' }),
        buildExecution: {
          start: () => {
            throw new Error('no builds in once budget')
          },
        },
        runtimes: {
          claude: {
            runner: new ScriptedAgentRunner({ script: () => defaultTurnResult() }),
            servesModels: [],
          },
        },
        ids: sequentialIds(),
        uuids: randomUuids(),
        clock: () => new Date(1000),
      }),
    })
    if (interactive) expect(ticks).toBe(2)
    const finished = (await readRepositoryFacts(checked, onceRepo)).value.recentRuns.find(
      ([id]) => id === run,
    )?.[1]
    expect(finished?.completed?.type).toBe('dispatcher.tick-completed')
    expect(finished?.stop?.type).toBe('dispatcher.run-stopped')
    // The same fresh invocation may fail before writing its start fact.
    expect(
      (await readDispatcherRunFacts(checked, onceRepo, `never-started-${length}`, false)).value,
    ).toEqual({})
    expect(await readOpenTick(checked, onceRepo, `never-started-${length}`, false)).toBe(false)
    expect(costs.historicalEvents).toBe(0)
    expect(costs.events).toBeLessThanOrEqual(32)
    expect(costs.metadata).toBeLessThan(300)
    expect(costs.bytes).toBeLessThan(1_000_000)
  } finally {
    delete costs.history
    await rm(directory, { recursive: true, force: true })
  }
}

/** SQL result instrumentation handles both raw object rows and Drizzle values. */
export function countHistoricalRows(costs: ReducedReadCosts, rows: unknown): number {
  if (!costs.history || !Array.isArray(rows)) return 0
  return rows.filter((row) => {
    const repo = Array.isArray(row) ? row[0] : row?.repo
    const seq = Number(Array.isArray(row) ? row[1] : row?.seq)
    return repo === costs.history!.repo && seq <= costs.history!.through
  }).length
}

/** Fresh remote processes must never turn catalog skew into history reads.
 * Callers instrument backing storage (including private checkpoint reads). */
export async function catalogSkewReadBudget(opts: {
  backing: BuildStore
  fresh: () => BuildStore
  repo: string
  slug: string
  reset: () => void
  eventRows: () => number
}) {
  const reads = [
    [{ kind: 'repo', repo: opts.repo }, { reducer: 'dispatchUpgrade' }],
    [{ kind: 'build', slug: opts.slug }, { reducer: 'buildReadFacts' }],
    [
      { kind: 'build', slug: opts.slug },
      { reducer: 'phaseFailures', args: { phase: 'plan', round: 1 } },
    ],
  ] as const
  const expected = []
  for (const [scope, request] of reads)
    expected.push(await opts.backing.getReducerValue(scope, request))
  const batch = await opts.backing.getRepoBuildDigests(opts.repo)
  opts.reset()
  for (let i = 0; i < 3; i++) {
    const client = opts.fresh()
    for (const [index, [scope, request]] of reads.entries()) {
      const { catalogIdentity: _, ...answer } = await client.getReducerValue(scope, request)
      const { catalogIdentity: __, ...canonical } = expected[index]!
      expect(answer).toEqual(canonical)
    }
    expect(await client.getRepoBuildDigests(opts.repo)).toEqual(batch)
    await client.close()
  }
  expect(opts.eventRows()).toBe(0)
}

/** Real parked ticks, with array-result instrumentation beneath MemoryBuildStore's
 * public and private reducer reads. History is seeded and projections warmed
 * outside the measured interval; fresh dispatchers retain no pin cache. */
export async function parkedSweepReadBudget(opts: {
  store: import('../store/memory').MemoryBuildStore
  slugs: string[]
  dispatcher: () => Dispatcher
  pin: (slug: string) => Promise<void>
  advance: () => void
}) {
  const { store, slugs } = opts
  const kind = 'build-runner-effective-config'
  const metrics = { meta: 0, bodies: 0, bytes: 0, historicalRows: 0 }
  const meta = store.getLatestArtifactMeta.bind(store)
  const get = store.getArtifact.bind(store)
  const pinBlobs = new Set(
    await Promise.all(slugs.map(async (slug) => (await get(slug, kind))!.meta.blobRef)),
  )
  const pinBytes = (await get(slugs[0]!, kind))!.content.byteLength
  let blobReads = 0
  const getBlob = store.blobs.get.bind(store.blobs)
  store.blobs.get = async (ref) => {
    if (pinBlobs.has(ref)) blobReads++
    return getBlob(ref)
  }
  store.getLatestArtifactMeta = async (...args) => {
    if (args[1] === kind) metrics.meta++
    return meta(...args)
  }
  store.getArtifact = async (...args) => {
    const result = await get(...args)
    if (args[1] === kind) {
      metrics.bodies++
      metrics.bytes += result?.content.byteLength ?? 0
    }
    return result
  }
  const reset = () => {
    metrics.meta = metrics.bodies = metrics.bytes = metrics.historicalRows = blobReads = 0
  }
  let seeded = 0
  for (const length of [100, 100_000]) {
    for (; seeded < length; seeded++) {
      await store.append(slugs[0]!, {
        actor: humanActor('budget'),
        type: 'build.auto-merge-cancelled',
        payload: {},
      })
    }
    // Instrument returned event rows, including getReducerValue's private
    // snapshot-tail reads (instrumenting getEvents alone would miss these).
    const build = Reflect.get(store, 'builds').get(slugs[0]!)
    const events = build.events as import('../events/catalog').AbEvent[]
    const historyTail = events.at(-1)!.seq
    const slice = Array.prototype.slice
    events.slice = function (start?: number, end?: number) {
      const result = slice.call(this, start, end) as typeof events
      metrics.historicalRows += result.filter((event) => event.seq <= historyTail).length
      return result
    }
    opts.advance()
    await opts.dispatcher().tick({ acceptNewWork: false }) // warm durable projections
    const dispatcher = opts.dispatcher()
    reset()
    for (let tick = 0; tick < 4; tick++) {
      await dispatcher.tick({ acceptNewWork: false })
    }
    expect(metrics).toEqual({
      meta: slugs.length * 4,
      bodies: slugs.length,
      bytes: pinBytes * slugs.length,
      historicalRows: 0,
    })
    expect(blobReads).toBe(slugs.length)
    const coldBytes = metrics.bytes
    await opts.pin(slugs[0]!)
    opts.advance()
    reset()
    await dispatcher.tick({ acceptNewWork: false })
    expect(metrics.meta).toBe(slugs.length)
    expect(metrics.bodies).toBe(1)
    expect(blobReads).toBe(1)
    expect(metrics.historicalRows).toBe(0)
    reset()
    await opts.dispatcher().tick({ acceptNewWork: false })
    expect(metrics.bodies).toBe(slugs.length)
    expect(blobReads).toBe(slugs.length)
    expect(metrics.historicalRows).toBe(0)
    console.log('parked sweep read budget', {
      history: length,
      builds: slugs.length,
      sweeps: 4,
      coldBodies: slugs.length,
      coldBytes,
      warmBodies: 0,
      metadata: slugs.length * 4,
      historicalRows: metrics.historicalRows,
    })
    Reflect.deleteProperty(events, 'slice')
  }
}

/** In-memory history seeding for preparation budgets; never used as a recurring read. */
export async function seedPreparationHistory(store: BuildStore, repo: string, facts: number) {
  await store.ensureRepo(repo)
  for (let i = 0; i < facts / 2; i++) {
    const ticket = { source: 'fake', id: `old-${i}` }
    const attempt = `historical-${i}`
    await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'ticket-preparation.intended',
      payload: { attempt, ticket, readyState: 'Ready', claimedState: 'Doing' },
    })
    await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'ticket-preparation.resolved',
      payload: { attempt, ticket, outcome: 'handed-back' },
    })
  }
  await store.appendRepo(repo, {
    actor: DISPATCHER,
    type: 'ticket-preparation.intended',
    payload: {
      attempt: 'pending',
      ticket: { source: 'fake', id: 'pending' },
      readyState: 'Ready',
      claimedState: 'Doing',
    },
  })
  await store.appendRepo(repo, {
    actor: DISPATCHER,
    type: 'ticket-preparation.recovery-failed',
    payload: {
      attempt: 'pending',
      ticket: { source: 'fake', id: 'pending' },
      error: 'unknown claim outcome',
      retryAt: '2099-01-01T00:00:00.000Z',
    },
  })
}

/** Count the memory adapter's private reducer-storage event slices, in addition
 * to public history reads. This deliberately observes storage, not a selector. */
export function memoryRepositoryReadCounter(
  store: import('../store/memory').MemoryBuildStore,
  repo: string,
) {
  const repositories = Reflect.get(store, 'repos') as Map<string, { events: unknown[] }>
  const events = repositories.get(repo)?.events
  if (!events) throw new Error(`missing read-budget repository ${repo}`)
  const slice = events.slice.bind(events)
  let rows = 0
  Object.defineProperty(events, 'slice', {
    configurable: true,
    value: (start?: number, end?: number) => {
      const selected = slice(start, end)
      rows += selected.length
      return selected
    },
  })
  return {
    get rows() {
      return rows
    },
    reset() {
      rows = 0
    },
  }
}
