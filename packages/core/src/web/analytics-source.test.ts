import { expect, test } from 'bun:test'
import { agentActor, DISPATCHER, KERNEL } from '../events/envelope'
import { MemoryBuildStore } from '../store/memory'
import type { BuildPageOptions } from '../store/build-feed'
import type { BuildStore } from '../store/types'
import { manualClock } from '../testing/fixed'
import { webAnalyticsReadBudget } from '../testing/reduced-read-budget'
import {
  type AnalyticsReader,
  analyticsWindowStart,
  parseAnalyticsQuery,
  WebAnalyticsSource,
} from './analytics-source'

const REPO = 'analytics/repo'
const query = (search: string) => parseAnalyticsQuery(new URLSearchParams(search))

test('the query defaults to 7 days of merged leaves and refuses unknown values', () => {
  expect(query('')).toEqual({ window: '7d', outcome: 'merged', kind: 'leaf' })
  expect(query('window=all&outcome=all&kind=node&page=abc&cls=1')).toEqual({
    window: 'all',
    outcome: 'all',
    kind: 'node',
    page: 'abc',
  })
  expect(query('page=')).toEqual({ window: '7d', outcome: 'merged', kind: 'leaf' })
  for (const bad of ['window=1y', 'outcome=closed', 'kind=work'])
    expect(() => query(bad)).toThrow('invalid analytics')
})

test('the window starts at the UTC day it overlaps, or the retention cutoff for all', () => {
  const now = new Date('2026-11-20T23:30:00.000Z')
  expect(analyticsWindowStart('24h', now)).toBe('2026-11-19T00:00:00.000Z')
  expect(analyticsWindowStart('7d', now)).toBe('2026-11-13T00:00:00.000Z')
  expect(analyticsWindowStart('all', now)).toBe('2025-10-16T00:00:00.000Z')
})

/** A reader over a canned answer that records each listing request. */
function cannedReader(position = { value: '1' }) {
  const listings: BuildPageOptions[] = []
  const reader: AnalyticsReader = {
    getRepoChangePosition: async () => position.value,
    listBuildsChangedSince: async () => ({ position: position.value, builds: [] }),
    listBuildsPage: async (_repo, opts) => {
      listings.push(opts!)
      return { builds: [], next: 'next-cursor' }
    },
    getReducerValue: async () => ({ version: 1, cursor: 0, value: { steps: [] } as never }),
    getBuild: async () => null,
  }
  return { reader, listings }
}

test('filters go to the store listing, and its cursor passes through', async () => {
  const { reader, listings } = cannedReader()
  const source = new WebAnalyticsSource(reader, REPO, {
    clock: () => Date.parse('2026-11-20T12:00:00.000Z'),
  })
  const answer = await source.analytics(query('outcome=all&kind=all&window=all&page=p2'))
  expect(answer.gantt.next).toBe('next-cursor')
  await source.analytics(query('kind=node'))
  expect(listings).toEqual([
    { limit: 25, activeSince: '2025-10-16T00:00:00.000Z', cursor: 'p2' },
    { limit: 25, activeSince: '2026-11-13T00:00:00.000Z', outcome: 'merged', kind: 'node' },
  ])
  expect(await source.timeline('nope')).toBeNull()
})

test('a build whose only in-window write is not an event is listed, and pages stay full', async () => {
  const clock = manualClock('2026-11-01T00:00:00.000Z')
  const store = new MemoryBuildStore({ clock })
  const merged = async (slug: string) => {
    await store.createBuild({ slug, repo: REPO })
    await store.append(slug, { actor: KERNEL, type: 'plan.started', payload: { round: 1 } })
    await store.append(slug, {
      actor: agentActor('plan', 's'),
      type: 'plan.completed',
      payload: { round: 1, artifact: { kind: 'plan', rev: 0 } },
    })
    await store.append(slug, {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: 'merged' },
    })
  }
  const stale = Array.from({ length: 30 }, (_, i) => `stale-${String(i).padStart(2, '0')}`)
  for (const slug of stale) await merged(slug)
  await store.createBuild({ slug: 'open-old', repo: REPO })
  clock.set('2026-11-20T00:00:00.000Z')
  for (const [i, slug] of stale.entries()) {
    clock.advance(60_000)
    if (i % 2 === 0) await store.putArtifact(slug, { kind: 'note', content: 'x' })
    else {
      await store.claimLease(slug, 'runner', 60_000)
      await store.releaseLease(slug, 'runner')
    }
    if (i % 3 === 0) await merged(`fresh-${i}`)
  }
  const source = new WebAnalyticsSource(store, REPO, { clock: () => clock().getTime() })
  const first = await source.analytics(query(''))
  expect(first.gantt.rows).toHaveLength(25)
  const second = await source.analytics(query(`page=${first.gantt.next}`))
  expect(second.gantt.rows).toHaveLength(15)
  expect(second.gantt.next).toBeNull()
  const shown = [...first.gantt.rows, ...second.gantt.rows].map((row) => row.slug)
  expect(new Set(shown).size).toBe(40)
  expect(shown).toContain('stale-00')
  const all = await source.analytics(query('outcome=all'))
  expect(all.gantt.rows.map((row) => row.slug)).not.toContain('open-old')
  clock.advance(60_000)
  await store.append('open-old', { actor: KERNEL, type: 'plan.started', payload: { round: 1 } })
  const later = await source.analytics(query('outcome=all'))
  expect(later.gantt.rows[0]?.slug).toBe('open-old')
  expect(later.gantt.rows[0]?.segments.some((s) => s.state === 'open')).toBe(true)
})

test('a repository reset clears both caches', async () => {
  const position = { value: '9' }
  const { reader } = cannedReader(position)
  let timelineReads = 0
  reader.getBuild = async (slug) => ({ slug, repo: REPO, createdAt: '', updatedAt: '' })
  const base = reader.getReducerValue
  reader.getReducerValue = async (scope, request) => {
    if (scope.kind === 'build') timelineReads++
    return scope.kind === 'build'
      ? { version: 1, cursor: 0, value: { kind: 'work', segments: [] } }
      : base(scope, request)
  }
  const source = new WebAnalyticsSource(reader, REPO)
  await source.timeline('a')
  await source.timeline('a')
  expect(timelineReads).toBe(1)
  position.value = '2'
  await source.timeline('a')
  expect(timelineReads).toBe(2)
})

test('a timeline read racing a change never caches the stale value', async () => {
  const store = new MemoryBuildStore({ clock: manualClock('2026-11-20T00:00:00.000Z') })
  await store.createBuild({ slug: 'b', repo: REPO })
  const holds: { reached: () => void; release: Promise<void> }[] = []
  const reader: BuildStore = new Proxy(store, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if (key !== 'getReducerValue') return typeof value === 'function' ? value.bind(target) : value
      return async (...args: Parameters<BuildStore['getReducerValue']>) => {
        // The read takes its snapshot, then a change lands before it returns.
        const answer = await store.getReducerValue(...args)
        const hold = holds.shift()
        if (hold !== undefined) {
          hold.reached()
          await hold.release
        }
        return answer
      }
    },
  })
  const source = new WebAnalyticsSource(reader, REPO)
  expect(await source.timeline('unknown')).toBeNull()
  let reached!: () => void
  let release!: () => void
  const atHold = new Promise<void>((resolve) => {
    reached = resolve
  })
  holds.push({
    reached,
    release: new Promise((resolve) => {
      release = resolve
    }),
  })
  const racing = source.timeline('b')
  await atHold
  await store.append('b', { actor: KERNEL, type: 'plan.started', payload: { round: 1 } })
  const after = source.timeline('b')
  release()
  expect((await racing)?.segments.map((s) => s.category)).not.toContain('plan')
  const categories = async (row: Promise<{ segments: { category: string }[] } | null>) =>
    (await row)?.segments.map((s) => s.category)
  expect(await categories(after)).toContain('plan')
  expect(await categories(source.timeline('b'))).toContain('plan')
})

test('analytics read a bounded, change-proportional set of saved values', async () => {
  await webAnalyticsReadBudget()
}, 120_000)

test('a failed timeline read holds the request until its sibling reads settle', async () => {
  const position = { value: '1' }
  const { reader } = cannedReader(position)
  const record = (slug: string) => ({ slug, repo: REPO, createdAt: '', updatedAt: '' })
  const timeline = (category: string) => ({
    version: 1,
    cursor: 0,
    value: { kind: 'work', segments: [{ category, start: '', state: 'open' }] } as never,
  })
  let reached!: () => void
  let release!: () => void
  const siblingStarted = new Promise<void>((resolve) => {
    reached = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let stale = true
  reader.listBuildsPage = async () => ({ builds: [record('a'), record('b')], next: null })
  reader.listBuildsChangedSince = async () => ({
    position: position.value,
    builds: [{ slug: 'b', position: position.value }],
  })
  reader.getBuild = async (slug) => record(slug)
  const base = reader.getReducerValue
  reader.getReducerValue = async (scope, request) => {
    if (scope.kind !== 'build') return base(scope, request)
    if (scope.slug === 'a') {
      await siblingStarted
      throw new Error('temporary store failure')
    }
    if (!stale) return timeline('implement')
    stale = false
    reached()
    await held
    return timeline('plan')
  }
  const source = new WebAnalyticsSource(reader, REPO)
  const failing = source.analytics(query('outcome=all&kind=all'))
  const outcome = failing.then(
    () => 'answered',
    (error: Error) => error.message,
  )
  await siblingStarted
  // Build b changes while its old read is still in flight.
  position.value = '2'
  const fresh = source.timeline('b')
  // Long enough for the next request to run if the failed one let it.
  const flush = async () => {
    for (let i = 0; i < 200; i++) await Promise.resolve()
  }
  await flush()
  release()
  expect(await outcome).toBe('temporary store failure')
  const category = async (row: Promise<{ segments: { category: string }[] } | null>) =>
    (await row)?.segments[0]?.category
  expect(await category(fresh)).toBe('implement')
  await flush()
  expect(await category(source.timeline('b'))).toBe('implement')
})
