import { describe, expect, test } from 'bun:test'
import { DISPATCHER, KERNEL } from '../events/envelope'
import type { EventWrite } from '../events/catalog'
import { markUnmeasuredMerge, settleAttempt } from '../kernel/attempt-settlement'
import { commandObjective, OPTIMIZATION_SHA as sha } from '../kernel/generators/optimization-log'
import { MemoryBuildStore } from '../store/memory'
import { readBuildDigests, readBuildFacts } from '../store/reduced-reads'
import { memoryStoreRequestCounter } from '../testing/reduced-read-budget'
import { reconcileMergedAttempts } from './optimization-merges'
import { RepoViewStore } from './repo-view'

const repo = 'repo'
const node = 'opt-node'
const ticket = (id: string) => ({ source: 'file', id: `T-${id}` })

async function world(proposals: string[]) {
  const store = new MemoryBuildStore()
  await store.ensureRepo(repo)
  await store.createBuild({ slug: node, repo, branch: 'ab-node/opt' })
  await store.append(node, {
    actor: DISPATCHER,
    type: 'build.created',
    payload: { repo, ticket: { source: 'file', id: 'node' }, baseBranch: 'main', kind: 'node' },
  })
  await store.append(node, {
    actor: DISPATCHER,
    type: 'optimization.objective-accepted',
    payload: { objective: commandObjective(), revision: 1, harnessPin: sha('a'), specRev: 0 },
  })
  await store.append(node, {
    actor: DISPATCHER,
    type: 'optimization.attempts-proposed',
    payload: {
      request: 'r',
      proposals: proposals.map((id) => ({ id, ticket: ticket(id), title: id, strategy: id })),
    },
  })
  return store
}

/** An attempt build of `id` that merged as `merged`, completed unless `open`. */
async function child(
  store: MemoryBuildStore,
  id: string,
  options: { merged?: string; open?: boolean; measured?: string; requestNode?: string } = {},
) {
  const slug = `attempt-${id}`
  await store.createBuild({ slug, repo, branch: `ab/${slug}`, ticket: ticket(id) })
  await store.append(slug, {
    actor: DISPATCHER,
    type: 'build.created',
    payload: {
      repo,
      ticket: ticket(id),
      baseBranch: 'ab-node/opt',
      target: { build: node, ticket: { source: 'file', id: 'node' } },
    },
  })
  if (options.measured !== undefined) {
    const pair = {
      candidate: options.measured,
      baseline: sha('b'),
      harnessPin: sha('a'),
      revision: 1,
    }
    await store.append(slug, {
      actor: DISPATCHER,
      type: 'attempt.measurement-requested',
      payload: { id: 'm1', node: options.requestNode ?? node, ...pair },
    })
    await store.append(slug, {
      actor: KERNEL,
      type: 'attempt.measured',
      payload: {
        request: 'm1',
        ...pair,
        samples: 7,
        medians: { candidate: 40, baseline: 50 },
        delta: 10,
        decision: 'improved',
      },
    })
  }
  await store.append(slug, {
    actor: DISPATCHER,
    type: 'pr.opened',
    payload: { pr: { number: 1, url: 'https://forge/1', headSha: sha('d') } },
  })
  if (options.merged !== undefined)
    await store.append(slug, {
      actor: DISPATCHER,
      type: 'pr.merged',
      payload: { sha: options.merged },
    })
  if (!options.open)
    await store.append(slug, {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: options.merged !== undefined ? 'merged' : 'closed-unmerged' },
    })
  return slug
}

async function tick(store: MemoryBuildStore, view = new RepoViewStore(store, { repo })) {
  const digests = await readBuildDigests(store, repo)
  const builds = (await store.listBuilds())
    .filter((record) => record.repo === repo)
    .map((record) => ({ record, digest: digests.get(record.slug)! }))
  const state = (await readBuildFacts(store, node)).value.state
  const record = builds.find((b) => b.record.slug === node)!.record
  const requests = memoryStoreRequestCounter(store)
  try {
    const wrote = await reconcileMergedAttempts(
      { store: view, migrations: { migrations: [] }, ticketSource: 'file' },
      record,
      state,
      builds,
    )
    return { wrote, vector: requests.vector() }
  } finally {
    requests.restore()
  }
}

const nodeEvents = async (store: MemoryBuildStore, type: EventWrite['type']) =>
  (await store.getEvents(node)).filter((event) => event.type === type)

const digest = async (store: MemoryBuildStore) =>
  (await readBuildFacts(store, node)).value.state.optimization!

describe('reconcileMergedAttempts', () => {
  test('marks a completed, unmarked merge once with its reason; later ticks read nothing', async () => {
    const store = await world(['a', 'b', 'c'])
    await child(store, 'a', { merged: sha('d') })
    await child(store, 'b', { merged: sha('d'), measured: sha('c') })
    await child(store, 'c', { merged: sha('d'), measured: sha('d'), requestNode: 'other-node' })
    expect((await tick(store)).wrote).toBe(true)
    const marked = Object.fromEntries(
      (await digest(store)).inFlight.map((entry) => [entry.proposal, entry.unmeasuredMerge]),
    )
    expect(marked.a).toMatchObject({ build: 'attempt-a', sha: sha('d'), reason: 'absent' })
    expect(marked.b).toMatchObject({ reason: 'stale-head', measuredCandidate: sha('c') })
    expect(marked.c).toMatchObject({ reason: 'unrelated' })
    const idle = await tick(store)
    expect(idle).toEqual({ wrote: false, vector: {} })
    expect(await nodeEvents(store, 'attempt.merged-unmeasured')).toHaveLength(3)
  })

  test('a merge whose head was measured settles accepted, exactly as the merged path would', async () => {
    const store = await world(['a'])
    await child(store, 'a', { merged: sha('d'), measured: sha('d') })
    expect((await tick(store)).wrote).toBe(true)
    expect((await tick(store)).wrote).toBe(false)
    const settled = await nodeEvents(store, 'attempt.settled')
    expect(settled).toHaveLength(1)
    expect(settled[0]!.payload).toMatchObject({
      outcome: 'accepted',
      measurement: { candidate: 40, baseline: 50, delta: 10 },
    })
    expect(await nodeEvents(store, 'attempt.merged-unmeasured')).toEqual([])
  })

  test('leaves unmerged, still-open and never-built attempts alone without reading them', async () => {
    const store = await world(['a', 'b', 'c'])
    await child(store, 'a', { merged: sha('d'), open: true })
    await child(store, 'b')
    const result = await tick(store)
    expect(result).toEqual({ wrote: false, vector: {} })
    expect(await store.getEvents(node)).toHaveLength(3)
  })

  test('a merged child with no recorded head is marked unresolvable', async () => {
    const store = await world(['a'])
    await child(store, 'a', { merged: sha('d') })
    const view = new RepoViewStore(store, { repo })
    const buildFacts = view.buildFacts.bind(view)
    view.buildFacts = (async (slug: string) => {
      const facts = await buildFacts(slug)
      if (slug !== 'attempt-a') return facts
      const { mergedSha: _, ...state } = facts.state
      return { ...facts, state }
    }) as typeof view.buildFacts
    expect((await tick(store, view)).wrote).toBe(true)
    expect((await digest(store)).inFlight[0]!.unmeasuredMerge).toMatchObject({
      build: 'attempt-a',
      reason: 'unresolvable',
    })
    expect((await digest(store)).inFlight[0]!.unmeasuredMerge!.sha).toBeUndefined()
    expect((await tick(store, view)).wrote).toBe(false)
  })

  test('a marker or settlement already written by another path means no duplicate', async () => {
    const store = await world(['a', 'b'])
    await child(store, 'a', { merged: sha('d') })
    await child(store, 'b', { merged: sha('d') })
    await markUnmeasuredMerge(
      store,
      node,
      { proposal: 'a', ticket: ticket('a') },
      { build: 'attempt-a', sha: sha('d'), reason: 'absent' },
    )
    await settleAttempt(store, node, { proposal: 'b', ticket: ticket('b') }, 'merged-unmeasured', {
      policy: 'release-unmeasured',
    })
    expect(await tick(store)).toEqual({ wrote: false, vector: {} })
    expect(await nodeEvents(store, 'attempt.merged-unmeasured')).toHaveLength(1)
  })

  test('a crash between the read and the append writes exactly once on the retry', async () => {
    const store = await world(['a'])
    await child(store, 'a', { merged: sha('d') })
    const appendIfCurrent = store.appendIfCurrent.bind(store)
    let crashed = false
    store.appendIfCurrent = (async (...args: Parameters<typeof appendIfCurrent>) => {
      if (!crashed) {
        crashed = true
        throw new Error('process died')
      }
      return appendIfCurrent(...args)
    }) as typeof store.appendIfCurrent
    await expect(tick(store)).rejects.toThrow('process died')
    expect((await tick(store)).wrote).toBe(true)
    expect((await tick(store)).wrote).toBe(false)
    expect(await nodeEvents(store, 'attempt.merged-unmeasured')).toHaveLength(1)
  })
})
