import { describe, expect, test } from 'bun:test'
import { parseConfig } from '../../config/load'
import { KERNEL } from '../../events/envelope'
import { MemoryBuildStore } from '../../store/memory'
import type { BuildRecord } from '../../store/types'
import { DashboardBuildPollCache, type DashboardBuildReader } from './poll'

const REPO = '/repos/dashboard-cache'
const CONFIG = parseConfig(`
[tickets]
source = "file"
readyState = "ready"
`)

class CountingReader implements DashboardBuildReader {
  listCalls = 0
  eventCalls: Array<{ slug: string; since: number }> = []
  hidden = new Set<string>()
  failNextFor: string | undefined
  activeLists = 0
  maxActiveLists = 0

  constructor(private readonly store: MemoryBuildStore) {}

  async listBuilds(): Promise<BuildRecord[]> {
    this.listCalls += 1
    this.activeLists += 1
    this.maxActiveLists = Math.max(this.maxActiveLists, this.activeLists)
    try {
      // Make concurrent callers overlap here if the cache does not serialize
      // refreshes itself.
      await Promise.resolve()
      return (await this.store.listBuilds()).filter((record) => !this.hidden.has(record.slug))
    } finally {
      this.activeLists -= 1
    }
  }

  async getEvents(slug: string, sinceSeq = 0): ReturnType<MemoryBuildStore['getEvents']> {
    this.eventCalls.push({ slug, since: sinceSeq })
    if (this.failNextFor === slug) {
      this.failNextFor = undefined
      throw new Error(`scripted read failure for ${slug}`)
    }
    return this.store.getEvents(slug, sinceSeq)
  }

  resetCalls(): void {
    this.listCalls = 0
    this.eventCalls = []
    this.maxActiveLists = 0
  }
}

async function addRunning(store: MemoryBuildStore, slug: string): Promise<void> {
  await store.createBuild({ slug, repo: REPO })
  await store.append(slug, {
    actor: KERNEL,
    type: 'runner.attached',
    payload: { instance: `runner-${slug}`, host: 'test' },
  })
}

async function addTerminal(
  store: MemoryBuildStore,
  slug: string,
  terminal: 'done' | 'aborted',
): Promise<void> {
  await addRunning(store, slug)
  if (terminal === 'done') {
    await store.append(slug, {
      actor: { kind: 'dispatcher' },
      type: 'build.completed',
      payload: { outcome: 'merged' },
    })
  } else {
    await store.append(slug, {
      actor: KERNEL,
      type: 'build.aborted',
      payload: {},
    })
  }
}

function row(snapshot: Awaited<ReturnType<DashboardBuildPollCache['refresh']>>, slug: string) {
  return snapshot.builds.find((build) => build.slug === slug)
}

describe('DashboardBuildPollCache', () => {
  test('steady-state event reads scale with nonterminal builds, not terminal history', async () => {
    const store = new MemoryBuildStore()
    for (let index = 0; index < 40; index += 1) {
      await addTerminal(
        store,
        `history-${String(index).padStart(2, '0')}`,
        index % 2 === 0 ? 'done' : 'aborted',
      )
    }
    await addRunning(store, 'live-alpha')
    await addRunning(store, 'live-beta')
    await store.append('live-beta', {
      actor: KERNEL,
      type: 'plan.started',
      payload: { round: 1 },
    })

    const records = await store.listBuilds()
    const before = new Map<string, Awaited<ReturnType<typeof store.getEvents>>>()
    for (const record of records) {
      before.set(record.slug, await store.getEvents(record.slug))
    }

    const reader = new CountingReader(store)
    const cache = new DashboardBuildPollCache(reader, REPO, CONFIG)
    const cold = await cache.refresh()
    expect(reader.listCalls).toBe(1)
    expect(reader.eventCalls).toHaveLength(42)
    expect(cold.builds.map((build) => build.slug)).toEqual(['live-alpha', 'live-beta'])

    const alphaRow = row(cold, 'live-alpha')
    const betaRow = row(cold, 'live-beta')
    const alphaState = cold.states.get('live-alpha')
    const betaState = cold.states.get('live-beta')
    reader.resetCalls()

    const steady = await cache.refresh()
    expect(reader.listCalls).toBe(1)
    expect(reader.eventCalls).toEqual([
      { slug: 'live-alpha', since: 1 },
      { slug: 'live-beta', since: 2 },
    ])
    expect(row(steady, 'live-alpha')).toBe(alphaRow)
    expect(row(steady, 'live-beta')).toBe(betaRow)
    expect(steady.states.get('live-alpha')).toBe(alphaState)
    expect(steady.states.get('live-beta')).toBe(betaState)

    // The cache receives only the narrow reader and polling changes no stream.
    for (const record of records) {
      expect(await store.getEvents(record.slug)).toEqual(before.get(record.slug)!)
    }
    await store.close()
  })

  test('reflects deltas, new builds, terminalization, and listing removal on the next refresh', async () => {
    const store = new MemoryBuildStore()
    await addRunning(store, 'alpha')
    await store.append('alpha', {
      actor: KERNEL,
      type: 'plan.started',
      payload: { round: 1 },
    })
    const reader = new CountingReader(store)
    const cache = new DashboardBuildPollCache(reader, REPO, CONFIG)

    const initial = await cache.refresh()
    const initialAlpha = row(initial, 'alpha')
    const initialPlan = initialAlpha?.steps.find((step) => step.label === 'plan')
    expect(initialPlan?.state).toBe('current')
    expect(initialPlan?.timing?.runningSince).toBeDefined()

    await store.append('alpha', {
      actor: KERNEL,
      type: 'escalation.raised',
      payload: {
        id: 'esc-cache',
        phase: 'plan',
        round: 1,
        source: 'policy',
        question: 'Which cached behavior should be used?',
      },
    })
    reader.resetCalls()
    const blocked = await cache.refresh()
    const blockedAlpha = row(blocked, 'alpha')
    expect(reader.eventCalls).toEqual([{ slug: 'alpha', since: 2 }])
    expect(blockedAlpha).not.toBe(initialAlpha)
    expect(blockedAlpha?.status).toBe('blocked')
    expect(blockedAlpha?.blockers).toEqual(['Which cached behavior should be used?'])
    expect(
      blockedAlpha?.steps.find((step) => step.label === 'plan')?.timing?.runningSince,
    ).toBeUndefined()

    await addRunning(store, 'beta')
    reader.resetCalls()
    const discovered = await cache.refresh()
    expect(discovered.builds.map((build) => build.slug)).toEqual(['alpha', 'beta'])
    expect(reader.eventCalls).toEqual([
      { slug: 'alpha', since: 3 },
      { slug: 'beta', since: 0 },
    ])

    await store.append('alpha', {
      actor: { kind: 'dispatcher' },
      type: 'build.completed',
      payload: { outcome: 'merged' },
    })
    reader.resetCalls()
    const terminal = await cache.refresh()
    expect(terminal.builds.map((build) => build.slug)).toEqual(['beta'])
    expect(terminal.states.has('alpha')).toBe(false)
    expect(reader.eventCalls).toEqual([
      { slug: 'alpha', since: 3 },
      { slug: 'beta', since: 1 },
    ])

    reader.resetCalls()
    await cache.refresh()
    expect(reader.eventCalls).toEqual([{ slug: 'beta', since: 1 }])

    reader.hidden.add('beta')
    reader.resetCalls()
    const pruned = await cache.refresh()
    expect(pruned.builds).toEqual([])
    expect(pruned.states.size).toBe(0)
    expect(reader.eventCalls).toEqual([])
    await store.close()
  })

  test('failed and overlapping refreshes cannot partially advance or regress the cache', async () => {
    const store = new MemoryBuildStore()
    await addRunning(store, 'alpha')
    await addRunning(store, 'beta')
    const reader = new CountingReader(store)
    const cache = new DashboardBuildPollCache(reader, REPO, CONFIG)
    const cold = await cache.refresh()

    await store.append('alpha', {
      actor: KERNEL,
      type: 'plan.started',
      payload: { round: 1 },
    })
    await store.append('beta', {
      actor: KERNEL,
      type: 'plan.started',
      payload: { round: 1 },
    })
    reader.failNextFor = 'beta'
    reader.resetCalls()
    await expect(cache.refresh()).rejects.toThrow('scripted read failure for beta')
    expect(reader.eventCalls).toEqual([
      { slug: 'alpha', since: 1 },
      { slug: 'beta', since: 1 },
    ])

    // Alpha's successful read from the failed transaction was not committed;
    // both streams retry from their prior lastSeq.
    reader.resetCalls()
    const recovered = await cache.refresh()
    expect(recovered.revision).toBe(cold.revision + 1)
    expect(reader.eventCalls).toEqual([
      { slug: 'alpha', since: 1 },
      { slug: 'beta', since: 1 },
    ])
    expect(
      recovered.builds.every(
        (build) => build.steps.find((step) => step.label === 'plan')?.state === 'current',
      ),
    ).toBe(true)

    reader.resetCalls()
    const [older, newer] = await Promise.all([cache.refresh(), cache.refresh()])
    expect(reader.maxActiveLists).toBe(1)
    expect(newer.revision).toBe(older.revision + 1)
    expect(cache.isCurrent(older)).toBe(false)
    expect(cache.isCurrent(newer)).toBe(true)
    await store.close()
  })
})
