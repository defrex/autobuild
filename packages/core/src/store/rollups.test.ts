import { describe, expect, test } from 'bun:test'
import { buildTimelineReducer } from '../cli/dashboard/timeline'
import { DISPATCHER, KERNEL, agentActor, humanActor } from '../events/envelope'
import { stepDurationsRollup, type StepDurationsValue } from '../kernel/step-durations'
import { manualClock } from '../testing/fixed'
import {
  buildRosterReadBudget,
  measureStoreReads,
  rollupReadBudget,
} from '../testing/reduced-read-budget'
import { MemoryBuildStore } from './memory'
import {
  readRollupValue,
  resolveRollupValue,
  type RollupAdvance,
  type RollupRow,
  type RollupStorage,
} from './rollups'

const REPO = 'o/r'
const scope = { kind: 'rollup', repo: REPO } as const
const ALL = { reducer: 'stepDurations', args: { outcome: 'all' }, read: { window: 'all' } }

function fixture() {
  const clock = manualClock('2026-11-20T00:00:00.000Z')
  const store = new MemoryBuildStore({ clock })
  const minute = () => clock.advance(60_000)
  const plan = async (slug: string, round: number, minutes = 1) => {
    await store.append(slug, { actor: KERNEL, type: 'plan.started', payload: { round } })
    for (let i = 0; i < minutes; i++) minute()
    await store.append(slug, {
      actor: agentActor('plan', 's'),
      type: 'plan.completed',
      payload: { round, artifact: { kind: 'plan', rev: 0 } },
    })
  }
  const pause = async (slug: string, minutes: number) => {
    await store.append(slug, { actor: KERNEL, type: 'build.paused', payload: {} })
    for (let i = 0; i < minutes; i++) minute()
    await store.append(slug, { actor: KERNEL, type: 'build.resumed', payload: {} })
  }
  const complete = (slug: string) =>
    store.append(slug, {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: 'merged' },
    })
  return { clock, store, minute, plan, pause, complete }
}

const value = async (store: MemoryBuildStore, request: object = ALL) =>
  (await store.getReducerValue(scope, request as never)).value as unknown as StepDurationsValue

const stepCount = (v: StepDurationsValue, step: string) =>
  v.steps.find((s) => s.step === step)?.count ?? 0

function snapshots(store: MemoryBuildStore): Map<string, { state: unknown }> {
  return Reflect.get(store, 'snapshots')
}

describe('rollup engine', () => {
  test('the rollup equals a direct fold of every timeline contribution', async () => {
    const { store, clock, plan, pause, complete } = fixture()
    for (const [i, slug] of ['a', 'b', 'c'].entries()) {
      await store.createBuild({ slug, repo: REPO })
      await plan(slug, 1, i + 1)
      await pause(slug, 2 * i + 1)
      if (slug !== 'c') await complete(slug)
    }
    const acc = stepDurationsRollup.initial()
    const args = stepDurationsRollup.args.parse({ outcome: 'all' })
    for (const slug of ['a', 'b', 'c']) {
      const c = stepDurationsRollup.contribute(
        buildTimelineReducer.reduce(await store.getEvents(slug)),
        args,
        clock(),
        slug,
      )
      if (c) stepDurationsRollup.add(acc, c)
    }
    const position = await store.getRepoChangePosition(REPO)
    expect(await value(store)).toEqual(
      stepDurationsRollup.finish(acc, { window: 'all' }, clock(), position),
    )
    // The merged-only default sees only completed builds.
    expect(stepCount(await value(store, { reducer: 'stepDurations' }), 'plan')).toBe(2)
  })

  test('an incremental append changes only the affected step', async () => {
    const { store, plan, pause } = fixture()
    await store.createBuild({ slug: 'a', repo: REPO })
    await plan('a', 1)
    const before = await value(store)
    await pause('a', 3)
    const after = await value(store)
    expect(after.steps.find((s) => s.step === 'plan')).toEqual(
      before.steps.find((s) => s.step === 'plan'),
    )
    expect(stepCount(after, 'paused')).toBe(1)
    expect(after.position).toBe(await store.getRepoChangePosition(REPO))
  })

  test("a reopened build's new timeline replaces its contribution rather than adding to it", async () => {
    const { store, plan, complete } = fixture()
    await store.createBuild({ slug: 'a', repo: REPO })
    await plan('a', 1, 2)
    await complete('a')
    const merged = { reducer: 'stepDurations', read: { window: 'all' } }
    expect(stepCount(await value(store, merged), 'plan')).toBe(1)
    await store.append('a', {
      actor: humanActor('op'),
      type: 'build.reopened',
      payload: { feedback: 'again' },
    })
    // Reopened and not yet merged again: the merged-only rollup drops it.
    expect(stepCount(await value(store, merged), 'plan')).toBe(0)
    await plan('a', 2, 4)
    await complete('a')
    const v = await value(store, merged)
    expect(v.steps.find((s) => s.step === 'plan')).toMatchObject({
      count: 2,
      totalMs: 6 * 60_000,
    })
  })

  test('concurrent cold readers count each build once and reduce each log once', async () => {
    const { store, plan, complete } = fixture()
    const slugs = ['a', 'b', 'c', 'd']
    for (const slug of slugs) {
      await store.createBuild({ slug, repo: REPO })
      await plan(slug, 1)
      await complete(slug)
    }
    const feedFrom: string[] = []
    const feed = store.listBuildsChangedSince.bind(store)
    Reflect.set(store, 'listBuildsChangedSince', (repo: string, since: string) => {
      feedFrom.push(since)
      return feed(repo, since)
    })
    // Slow the first reader's build-value reads so the second arrives mid-advance.
    const readValue = Reflect.get(store, 'readValue').bind(store)
    let delayed = false
    Reflect.set(store, 'readValue', async (...args: unknown[]) => {
      if (!delayed) {
        delayed = true
        await Promise.resolve()
        for (let i = 0; i < 20; i++) await Promise.resolve()
      }
      return readValue(...args)
    })
    let answers: StepDurationsValue[] = []
    const metrics = await measureStoreReads(store, async () => {
      answers = await Promise.all([value(store), value(store)])
    })
    expect(answers[0]).toEqual(answers[1]!)
    expect(stepCount(answers[0]!, 'plan')).toBe(4)
    for (const slug of slugs)
      expect(metrics.read.filter((read) => read.slug === slug && read.seq === 1)).toHaveLength(1)
    expect(feedFrom).toEqual(['0'])
  })

  test('a reader that loses the commit returns the winner value', async () => {
    const { store, plan } = fixture()
    await store.createBuild({ slug: 'a', repo: REPO })
    await plan('a', 1)
    const resolved = resolveRollupValue(REPO, ALL)
    const rows = new Map<string, RollupRow>()
    const winner = {
      version: resolved.version,
      state: {
        identity: resolved.identity,
        position: '2',
        acc: {
          days: { '2026-11-20': { 'awaiting-merge': { '30': [7, 7 * 20_000] } } },
        },
      },
    }
    let commits = 0
    const advance: RollupAdvance = {
      head: async () => '2',
      read: async (key) => rows.get(key) ?? null,
      changed: (since) => store.listBuildsChangedSince(REPO, since),
      buildValue: (slug, request) => store.getReducerValue({ kind: 'build', slug }, request),
      contributions: async () => new Map(),
      commit: async (key) => {
        commits++
        rows.set(key, { ...winner, token: 'winner' })
        return false
      },
      renew: async () => {},
    }
    const storage: RollupStorage = {
      now: () => new Date('2026-11-20T12:00:00.000Z'),
      buildReadConcurrency: 16,
      head: advance.head,
      read: advance.read,
      serialize: (_key, run) => run(advance),
    }
    const answer = await readRollupValue(scope, ALL, storage)
    expect(commits).toBe(1)
    expect((answer.value as unknown as StepDurationsValue).steps).toEqual([
      expect.objectContaining({ step: 'awaiting-merge', count: 7 }),
    ])
  })

  test('a reset repository and a corrupt row both recompute', async () => {
    const { store, plan } = fixture()
    await store.createBuild({ slug: 'a', repo: REPO })
    await plan('a', 1)
    const expected = await value(store)
    const { key } = resolveRollupValue(REPO, ALL)
    const rowKey = `rollup:${REPO}\u0000${key}`
    const row = snapshots(store).get(rowKey)!
    ;(row.state as { position: string }).position = '999'
    expect(await value(store)).toEqual(expected)
    expect((snapshots(store).get(rowKey)!.state as { position: string }).position).toBe(
      expected.position,
    )
    snapshots(store).get(rowKey)!.state = { garbage: true }
    expect(await value(store)).toEqual(expected)
  })

  test('idle retention prunes without reading events or the feed', async () => {
    const { store, clock, plan } = fixture()
    await store.createBuild({ slug: 'a', repo: REPO })
    await plan('a', 1)
    expect(stepCount(await value(store), 'plan')).toBe(1)
    clock.advance(402 * 86_400_000)
    const feedFrom: string[] = []
    const feed = store.listBuildsChangedSince.bind(store)
    Reflect.set(store, 'listBuildsChangedSince', (repo: string, since: string) => {
      feedFrom.push(since)
      return feed(repo, since)
    })
    let pruned: StepDurationsValue | undefined
    const metrics = await measureStoreReads(store, async () => {
      pruned = await value(store)
    })
    expect(pruned!.steps).toEqual([])
    expect(metrics.rows).toBe(0)
    expect(feedFrom).toEqual([])
    const { key } = resolveRollupValue(REPO, ALL)
    const saved = snapshots(store).get(`rollup:${REPO}\u0000${key}`)!.state as {
      acc: { days: object }
    }
    expect(saved.acc.days).toEqual({})
    // The next read takes the plain fast path: no write.
    const token = JSON.stringify(snapshots(store).get(`rollup:${REPO}\u0000${key}`))
    await value(store)
    expect(JSON.stringify(snapshots(store).get(`rollup:${REPO}\u0000${key}`))).toBe(token)
  })

  test('read windows share one key; default key arguments share one key', async () => {
    const { store, plan } = fixture()
    await store.createBuild({ slug: 'a', repo: REPO })
    await plan('a', 1)
    for (const window of ['24h', '7d', '30d', 'all'])
      await value(store, { ...ALL, read: { window } })
    const rollupRows = [...snapshots(store).keys()].filter((key) => key.startsWith('rollup:'))
    expect(rollupRows).toHaveLength(1)
    expect(resolveRollupValue(REPO, { reducer: 'stepDurations', args: {} }).key).toBe(
      resolveRollupValue(REPO, {
        reducer: 'stepDurations',
        args: { outcome: 'merged', kind: 'leaf' },
        read: { window: '30d' },
      }).key,
    )
    expect(resolveRollupValue(REPO, ALL).key).not.toBe(
      resolveRollupValue(REPO, { reducer: 'stepDurations' }).key,
    )
  })

  test('requests are validated before storage', async () => {
    const { store } = fixture()
    await store.createBuild({ slug: 'a', repo: REPO })
    await expect(
      store.getReducerValue(
        { kind: 'build', slug: 'a' },
        { reducer: 'buildTimeline', read: { window: '7d' } },
      ),
    ).rejects.toThrow('read-time')
    await expect(store.getReducerValue(scope, { reducer: 'nope' })).rejects.toThrow(
      'unknown rollup',
    )
    await expect(
      store.getReducerValue(scope, { reducer: 'stepDurations', read: { window: '1y' } }),
    ).rejects.toThrow()
    await expect(
      store.getReducerValue(scope, { reducer: 'stepDurations', args: { window: '7d' } }),
    ).rejects.toThrow()
  })

  test('an unknown repository answers the empty value and creates nothing', async () => {
    const { store } = fixture()
    const answer = await store.getReducerValue(
      { kind: 'rollup', repo: 'nobody/here' },
      { reducer: 'stepDurations' },
    )
    expect(answer).toMatchObject({
      cursor: 0,
      version: stepDurationsRollup.version,
      value: { position: '0', window: '7d', steps: [] },
    })
    expect(await store.getRepo('nobody/here')).toBeNull()
    expect(snapshots(store).size).toBe(0)
  })

  test('rollup reads cost what changed, flat from 100 to 10,000 builds', async () => {
    await rollupReadBudget()
  }, 180_000)

  test('roster reads cost O(live builds + 50), flat from 100 to 100,000 builds', async () => {
    await buildRosterReadBudget()
  }, 180_000)
})
