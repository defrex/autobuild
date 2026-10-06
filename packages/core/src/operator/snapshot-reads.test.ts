/**
 * The operator read paths run on the snapshot-backed repository view (AUT-650):
 * within one serving process a poll reads no event rows at idle and exactly the
 * newly appended rows after new events, whatever the number of concurrent
 * pollers; across serving processes each reads the same delta at most once; and
 * every response equals the one a full replay (no snapshots) produces.
 */
import { describe, expect, test } from 'bun:test'
import { parseConfig } from '../config/load'
import { DISPATCHER, KERNEL } from '../events/envelope'
import { MemoryBuildStore } from '../store/memory'
import type { BuildStore, Clock } from '../store/types'
import {
  getHarvestStatus,
  getOperatorDashboard,
  getRepositoryStatus,
  listOperatorBuilds,
  type BuildListScope,
} from './query'

const REPO = '/repo'
const now = new Date('2026-10-06T12:00:00.000Z')
const clock: Clock = () => now

const configContent = JSON.stringify({
  ...parseConfig(`
capacity = 2
[tickets]
source = "file"
readyState = "ready"
[verify]
steps = []
[finalize]
steps = []
`),
  verify: { steps: [] },
  finalize: { steps: [] },
})

async function seed(store: MemoryBuildStore, journalRuns = 40): Promise<void> {
  await store.ensureRepo(REPO)
  const artifact = await store.putRepoArtifact(REPO, {
    kind: 'dispatcher-effective-config',
    content: configContent,
  })
  for (let run = 0; run < journalRuns; run += 1) {
    await store.appendRepo(REPO, {
      actor: DISPATCHER,
      type: 'dispatcher.run-started',
      payload: {
        run: `run_${run}`,
        pid: 1,
        effectiveConfig: { kind: artifact.kind, rev: artifact.revision },
        roleWarnings: [],
      },
    })
    await store.appendRepo(REPO, {
      actor: DISPATCHER,
      type: 'dispatcher.tick-yielded',
      payload: { run: `run_${run}`, holder: 'other' },
    })
  }
  await store.createBuild({ slug: 'queued', repo: REPO })
  for (const slug of ['running', 'aborted', 'done']) {
    await store.createBuild({ slug, repo: REPO })
    await store.append(slug, {
      actor: KERNEL,
      type: 'runner.attached',
      payload: { instance: `${slug}-runner`, host: 'host' },
    })
    for (let round = 1; round <= 5; round += 1) {
      await store.append(slug, { actor: KERNEL, type: 'plan.started', payload: { round } })
    }
  }
  await store.append('aborted', { actor: KERNEL, type: 'build.aborted', payload: {} })
  await store.append('done', {
    actor: DISPATCHER,
    type: 'build.completed',
    payload: { outcome: 'merged' },
  })
}

let tick = 0
async function appendNew(store: MemoryBuildStore, build: number, journal: number): Promise<number> {
  for (let i = 0; i < build; i += 1) {
    tick += 1
    await store.append('running', {
      actor: KERNEL,
      type: 'observation.recorded',
      payload: { id: `o${tick}`, kind: 'followup', summary: `s${tick}` },
    })
  }
  for (let i = 0; i < journal; i += 1) {
    tick += 1
    await store.appendRepo(REPO, {
      actor: DISPATCHER,
      type: 'dispatcher.tick-yielded',
      payload: { run: 'run_0', holder: `h${tick}` },
    })
  }
  return build + journal
}

interface Instrumented {
  store: BuildStore
  rows: () => number
  lookups: () => number
  reset: () => void
  gate: { hold: Promise<void> | undefined }
}

/** A process-like handle on one backing store: its own object identity (so its
 * own coalescing state), counting every event row a read returns. */
function instrument(backing: MemoryBuildStore, opts: { noSnapshots?: boolean } = {}): Instrumented {
  let rows = 0
  let lookups = 0
  const gate: { hold: Promise<void> | undefined } = { hold: undefined }
  const proxy = new Proxy(backing as unknown as Record<string, unknown>, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target)
      if (typeof value !== 'function') return value
      const fn = value as (...args: unknown[]) => Promise<unknown>
      if (prop === 'getEvents' || prop === 'getRepoEvents' || prop === 'getRepoStateEvents') {
        return async (...args: unknown[]) => {
          const events = (await fn.apply(target, args)) as unknown[]
          rows += events.length
          return events
        }
      }
      if (prop === 'getReducerSnapshot') {
        return async (...args: unknown[]) => {
          lookups += 1
          if (gate.hold !== undefined) await gate.hold
          return opts.noSnapshots === true ? null : fn.apply(target, args)
        }
      }
      if (prop === 'putReducerSnapshot' && opts.noSnapshots === true) return async () => false
      return fn.bind(target)
    },
  })
  return {
    store: proxy as unknown as BuildStore,
    rows: () => rows,
    lookups: () => lookups,
    reset: () => {
      rows = 0
      lookups = 0
    },
    gate,
  }
}

const SCOPES: BuildListScope[] = ['active', 'queued', 'all']

async function pollAll(store: BuildStore) {
  return {
    dashboard: await getOperatorDashboard({ store, repo: REPO, clock }),
    status: await getRepositoryStatus(store, REPO),
    harvest: await getHarvestStatus(store, REPO),
    lists: await Promise.all(
      SCOPES.map((scope) => listOperatorBuilds({ store, repo: REPO, scope, now })),
    ),
  }
}

describe('operator reads from snapshots (AUT-650)', () => {
  test('every route reads zero event rows at idle and exactly the new rows after new events', async () => {
    const backing = new MemoryBuildStore({ clock })
    await seed(backing)
    const process = instrument(backing)
    await pollAll(process.store) // warm: cold replay, snapshots persisted

    process.reset()
    await pollAll(process.store)
    expect(process.rows()).toBe(0)

    const m = await appendNew(backing, 3, 2)
    process.reset()
    await pollAll(process.store)
    expect(process.rows()).toBe(m)

    process.reset()
    await pollAll(process.store)
    expect(process.rows()).toBe(0)
  })

  test('each route alone pays only its own delta, whichever route polls first', async () => {
    for (const first of ['dashboard', 'status', 'harvest', 'list'] as const) {
      const backing = new MemoryBuildStore({ clock })
      await seed(backing)
      const process = instrument(backing)
      await pollAll(process.store)
      const m = await appendNew(backing, 2, 2)
      process.reset()
      const routes = {
        dashboard: () => getOperatorDashboard({ store: process.store, repo: REPO, clock }),
        status: () => getRepositoryStatus(process.store, REPO),
        harvest: () => getHarvestStatus(process.store, REPO),
        list: () => listOperatorBuilds({ store: process.store, repo: REPO, scope: 'all', now }),
      }
      await routes[first]()
      await pollAll(process.store)
      expect(process.rows()).toBe(m)
    }
  })

  test('concurrent pollers in one process cost the new rows once, not once each', async () => {
    const backing = new MemoryBuildStore({ clock })
    await seed(backing)
    const process = instrument(backing)
    await pollAll(process.store)
    const m = await appendNew(backing, 4, 3)
    process.reset()
    const results = await Promise.all(Array.from({ length: 5 }, () => pollAll(process.store)))
    // Up to two passes serve the burst (the running one and the trailing one);
    // the delta is read once because the first pass persists what it folded.
    expect(process.rows()).toBe(m)
    for (const result of results) expect(result).toEqual(results[0]!)
  })

  test('requests arriving mid-pass join one trailing pass restored from the first pass’s snapshot', async () => {
    const backing = new MemoryBuildStore({ clock })
    await seed(backing)
    const process = instrument(backing)
    await pollAll(process.store)
    const m = await appendNew(backing, 3, 2)
    process.reset()

    let release!: () => void
    process.gate.hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = getOperatorDashboard({ store: process.store, repo: REPO, clock })
    while (process.lookups() === 0) await new Promise((resolve) => setTimeout(resolve, 1))
    const parked = process.lookups()
    const joiners = [
      getRepositoryStatus(process.store, REPO),
      getHarvestStatus(process.store, REPO),
      getOperatorDashboard({ store: process.store, repo: REPO, clock }),
      listOperatorBuilds({ store: process.store, repo: REPO, scope: 'active', now }),
    ]
    await new Promise((resolve) => setTimeout(resolve, 20))
    // No independent restore began while the first pass is parked.
    expect(process.lookups()).toBe(parked)
    expect(process.rows()).toBe(0)

    process.gate.hold = undefined
    release()
    await Promise.all([first, ...joiners])
    // Pass 1 read the m new rows and persisted them; the trailing pass
    // restored from that snapshot and read none: m rows, never 5·m.
    expect(process.rows()).toBe(m)
    expect(process.lookups()).toBeGreaterThan(parked)
  })

  test('a request after the first pass sees events appended since it started', async () => {
    const backing = new MemoryBuildStore({ clock })
    await seed(backing)
    const process = instrument(backing)
    await pollAll(process.store)
    const m1 = await appendNew(backing, 2, 0)
    process.reset()
    let release!: () => void
    process.gate.hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = listOperatorBuilds({ store: process.store, repo: REPO, scope: 'all', now })
    while (process.lookups() === 0) await new Promise((resolve) => setTimeout(resolve, 1))
    const joiner = listOperatorBuilds({ store: process.store, repo: REPO, scope: 'all', now })
    const m2 = await appendNew(backing, 3, 0)
    process.gate.hold = undefined
    release()
    const [a, b] = await Promise.all([first, joiner])
    expect(process.rows()).toBe(m1 + m2)
    // The joiner arrived after m1 but before m2 was appended; the pass that
    // served it started after m2, so it reflects every event.
    const latest = b.find((summary) => summary.slug === 'running')!
    const stale = a.find((summary) => summary.slug === 'running')!
    expect(latest.updatedAt >= stale.updatedAt).toBe(true)
  })

  test('P serving processes read the new rows at most P times in total, never history', async () => {
    const backing = new MemoryBuildStore({ clock })
    await seed(backing)
    const a = instrument(backing)
    const b = instrument(backing)
    await Promise.all([pollAll(a.store), pollAll(b.store)])
    const m = await appendNew(backing, 3, 2)
    a.reset()
    b.reset()
    await Promise.all([pollAll(a.store), pollAll(b.store)])
    expect(a.rows()).toBeLessThanOrEqual(m)
    expect(b.rows()).toBeLessThanOrEqual(m)
    expect(a.rows() + b.rows()).toBeLessThanOrEqual(2 * m)
    a.reset()
    b.reset()
    await Promise.all([pollAll(a.store), pollAll(b.store)])
    expect(a.rows() + b.rows()).toBe(0)
  })

  test('responses with snapshots equal the full-replay responses', async () => {
    const backing = new MemoryBuildStore({ clock })
    await seed(backing)
    const warm = instrument(backing)
    await pollAll(warm.store)
    await appendNew(backing, 3, 2)
    const withSnapshots = await pollAll(warm.store)
    const replay = await pollAll(instrument(backing, { noSnapshots: true }).store)
    expect(withSnapshots).toEqual(replay)
    expect(JSON.stringify(withSnapshots)).toBe(JSON.stringify(replay))
  })
})
