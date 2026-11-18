/** The dispatcher's attempt-settlement paths that a forge-side human merge,
 * a decline or a no-improvement settlement take (SPEC §15.7), in memory:
 * the merged path's unmeasured marker, and the node sweep's branch cleanup
 * obligation with its guards, failures and resumption. */
import { describe, expect, test } from 'bun:test'
import { parseConfig } from '../config/load'
import { DISPATCHER, KERNEL, agentActor } from '../events/envelope'
import type { EventWrite } from '../events/catalog'
import { sequentialIds } from '../ids'
import { commandObjective, OPTIMIZATION_SHA as sha } from '../kernel/generators/optimization-log'
import { FakeForge } from '../ports/forge/fake'
import { FakeTicketSource } from '../ports/tickets/fake'
import { FakeWorkspaceProvider } from '../ports/workspace/fake'
import type { TicketRef } from '../ontology'
import { MemoryBuildStore } from '../store/memory'
import { readBuildFacts } from '../store/reduced-reads'
import { detailFromFacts, renderDetail } from '../cli/status'
import { Dispatcher } from './dispatcher'

const repo = '/attempt-settlement-paths'
const node = 'opt-node'
const child = 'attempt-a'
const MERGED = sha('d')

async function world(rejectedRole = true) {
  const store = new MemoryBuildStore()
  const tickets = new FakeTicketSource()
  const forge = new FakeForge()
  await store.ensureRepo(repo)
  await store.createBuild({ slug: node, repo, branch: 'ab-node/opt' })
  await store.append(node, {
    actor: DISPATCHER,
    type: 'build.created',
    payload: { repo, ticket: { source: 'fake', id: 'NODE' }, baseBranch: 'main', kind: 'node' },
  })
  await store.append(node, {
    actor: DISPATCHER,
    type: 'optimization.objective-accepted',
    payload: { objective: commandObjective(), revision: 1, harnessPin: sha('a'), specRev: 0 },
  })
  const ticket = (await tickets.create({ title: 'Attempt a', body: 'Attempt' })).ref
  await store.append(node, {
    actor: DISPATCHER,
    type: 'optimization.attempts-proposed',
    payload: { request: 'r', proposals: [{ id: 'p-a', ticket, title: 'a', strategy: 'a' }] },
  })
  await store.createBuild({ slug: child, repo, branch: `ab/${child}`, ticket })
  await store.append(child, {
    actor: DISPATCHER,
    type: 'build.created',
    payload: {
      repo,
      ticket,
      baseBranch: 'ab-node/opt',
      target: { build: node, ticket: { source: 'fake', id: 'NODE' } },
    },
  })
  const dispatcher = new Dispatcher({
    store,
    tickets,
    workspaces: new FakeWorkspaceProvider({
      root: '/attempt-settlement-paths',
      mode: 'logical',
      base: { source: 'remote', sha: sha('a') },
    }),
    forge,
    config: parseConfig(
      `[tickets]\nsource = "fake"\nreadyState = "Ready"\n${rejectedRole ? 'rejectedState = "Rejected"\n' : ''}[verify]\nsteps = []\n[finalize]\nsteps = []\n`,
    ),
    repo,
    exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    launchRunner: async () => {
      throw new Error('no launches')
    },
    ids: sequentialIds(),
    clock: () => new Date('2026-11-18T00:00:00Z'),
  })
  const call = <T>(name: string, ...args: unknown[]): Promise<T> =>
    (Reflect.get(dispatcher, name) as (...a: unknown[]) => Promise<T>).apply(dispatcher, args)
  const events = async (slug: string, type: EventWrite['type']) =>
    (await store.getEvents(slug)).filter((event) => event.type === type)
  const nodeState = async () => (await readBuildFacts(store, node)).value.state
  return { store, tickets, forge, ticket, call, events, nodeState }
}

type World = Awaited<ReturnType<typeof world>>

async function measuredChild(w: World, candidate: string, requestNode = node) {
  const pair = { candidate, baseline: sha('b'), harnessPin: sha('a'), revision: 1 }
  await w.store.append(child, {
    actor: DISPATCHER,
    type: 'attempt.measurement-requested',
    payload: { id: 'm1', node: requestNode, ...pair },
  })
  await w.store.append(child, {
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

async function mergedPath(w: World) {
  const record = (await w.store.getBuild(child))!
  const state = (await readBuildFacts(w.store, child)).value.state
  await w.call('settleMergedAttempt', record, state, MERGED)
}

describe('a merged attempt without a landing measurement of its merged head', () => {
  test('is marked once on the node, keeps its slot, and notes it once on the child', async () => {
    const w = await world()
    await mergedPath(w)
    await mergedPath(w)
    expect((await w.events(node, 'attempt.merged-unmeasured')).map((e) => e.payload)).toEqual([
      { proposal: 'p-a', ticket: w.ticket, build: child, sha: MERGED, reason: 'absent' },
    ])
    expect(await w.events(node, 'attempt.settled')).toEqual([])
    const observations = await w.events(child, 'observation.recorded')
    expect(observations).toHaveLength(1)
    expect(JSON.stringify(observations[0]!.payload)).toContain(
      `ab objective ${node} --settle-unmeasured p-a --policy release-unmeasured`,
    )
    const state = await w.nodeState()
    expect(state.optimization!.inFlight).toHaveLength(1)
    // `ab build status <node>` names it and why its slot stays held.
    const record = (await w.store.getBuild(node))!
    const lines = renderDetail(
      detailFromFacts(record, { state, open: null as never, observations: [] }, new Date()),
      new Date(),
    )
    expect(lines.some((line) => line.includes('unmeasured merge: p-a (attempt-a)'))).toBe(true)
    expect(lines.some((line) => line.includes('holds a concurrency slot'))).toBe(true)
  })

  test('a measurement of another head is a stale head, not a measured improvement', async () => {
    const w = await world()
    await measuredChild(w, sha('c'))
    await mergedPath(w)
    expect((await w.events(node, 'attempt.merged-unmeasured'))[0]!.payload).toMatchObject({
      reason: 'stale-head',
      measuredCandidate: sha('c'),
    })
    expect(await w.events(node, 'attempt.settled')).toEqual([])
  })

  test("another node's measurement of the same head is unrelated", async () => {
    const w = await world()
    await measuredChild(w, MERGED, 'other-node')
    await mergedPath(w)
    expect((await w.events(node, 'attempt.merged-unmeasured'))[0]!.payload).toMatchObject({
      reason: 'unrelated',
    })
  })

  test('a measurement of exactly the merged head settles accepted, as before', async () => {
    const w = await world()
    await measuredChild(w, MERGED)
    await mergedPath(w)
    await mergedPath(w)
    expect((await w.events(node, 'attempt.settled')).map((e) => e.payload.outcome)).toEqual([
      'accepted',
    ])
    expect(await w.events(node, 'attempt.merged-unmeasured')).toEqual([])
    expect(await w.events(child, 'observation.recorded')).toEqual([])
  })
})

describe('branch cleanup after decline or no-improvement', () => {
  async function settled(w: World, branch?: string) {
    await w.store.append(node, {
      actor: DISPATCHER,
      type: 'attempt.settled',
      payload: {
        attempt: {
          proposal: 'p-a',
          ticket: w.ticket,
          build: child,
          ...(branch !== undefined ? { branch } : {}),
        },
        outcome: 'declined',
      },
    })
  }
  const complete = (w: World) =>
    w.store.append(child, {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: 'closed-unmerged' },
    })
  const sweep = async (w: World) =>
    w.call<boolean>('sweepAttemptRejections', (await w.store.getBuild(node))!, await w.nodeState())
  const rejected = async (w: World, ticket: TicketRef) => (await w.tickets.get(ticket.id))?.state

  test('a published branch is deleted once, then the ticket moves', async () => {
    const w = await world()
    await settled(w, `ab/${child}`)
    // The sweep waits for the attempt build to finish.
    expect(await sweep(w)).toBe(false)
    expect(w.forge.deleteBranchCalls).toEqual([])
    await complete(w)
    expect(await sweep(w)).toBe(true)
    expect(w.forge.deleteBranchCalls.map((c) => c.branch)).toEqual([`ab/${child}`])
    expect((await w.events(node, 'attempt.branch-deleted')).map((e) => e.payload)).toEqual([
      { proposal: 'p-a', build: child, branch: `ab/${child}` },
    ])
    expect(await rejected(w, w.ticket)).toBe('Rejected')
    expect((await w.nodeState()).optimization!.rejections).toEqual([])
    expect(await sweep(w)).toBe(false)
    expect(w.forge.deleteBranchCalls).toHaveLength(1)
  })

  test('an attempt that never published needs no deletion', async () => {
    const w = await world()
    await settled(w)
    await complete(w)
    expect(await sweep(w)).toBe(true)
    expect(w.forge.deleteBranchCalls).toEqual([])
    expect(await w.events(node, 'attempt.branch-deleted')).toEqual([])
    expect(await rejected(w, w.ticket)).toBe('Rejected')
  })

  test('a failed deletion is a durable obligation, recorded once per error and retried', async () => {
    const w = await world()
    await settled(w, `ab/${child}`)
    await complete(w)
    w.forge.failNextDeleteBranch('forge refused the delete')
    w.forge.failNextDeleteBranch('forge refused the delete')
    expect(await sweep(w)).toBe(true)
    expect(await sweep(w)).toBe(false)
    expect((await w.events(node, 'attempt.branch-cleanup-failed')).map((e) => e.payload)).toEqual([
      { proposal: 'p-a', build: child, branch: `ab/${child}`, error: 'forge refused the delete' },
    ])
    const pending = (await w.nodeState()).optimization!.rejections[0]!
    expect(pending).toMatchObject({
      outcome: 'declined',
      branch: `ab/${child}`,
      branchCleanupError: 'forge refused the delete',
    })
    expect(await rejected(w, w.ticket)).not.toBe('Rejected')
    // The obligation clears on the next success; the settlement never changed.
    expect(await sweep(w)).toBe(true)
    expect(w.forge.deleteBranchCalls).toHaveLength(3)
    expect(await w.events(node, 'attempt.branch-deleted')).toHaveLength(1)
    expect(await rejected(w, w.ticket)).toBe('Rejected')
    expect((await w.events(node, 'attempt.settled')).map((e) => e.payload.outcome)).toEqual([
      'declined',
    ])
  })

  test('a deletion whose record was lost is repeated harmlessly and recorded once', async () => {
    const w = await world()
    await settled(w, `ab/${child}`)
    await complete(w)
    const append = w.store.append.bind(w.store)
    let lost = false
    w.store.append = (async (slug: string, write: EventWrite) => {
      if (!lost && write.type === 'attempt.branch-deleted') {
        lost = true
        throw new Error('store write lost')
      }
      return append(slug, write)
    }) as typeof w.store.append
    await sweep(w)
    expect(await w.events(node, 'attempt.branch-deleted')).toEqual([])
    // The branch is already absent now; the fake forge, like the real
    // adapters, treats that delete as a success.
    await sweep(w)
    expect(w.forge.deleteBranchCalls.map((c) => c.branch)).toEqual([`ab/${child}`, `ab/${child}`])
    expect(await w.events(node, 'attempt.branch-deleted')).toHaveLength(1)
    expect(await rejected(w, w.ticket)).toBe('Rejected')
  })

  test("the guards never delete the node's branch or another build's", async () => {
    for (const branch of ['ab-node/opt', 'ab/someone-else']) {
      const w = await world()
      await settled(w, branch)
      await complete(w)
      await sweep(w)
      expect(w.forge.deleteBranchCalls).toEqual([])
      const [failure] = await w.events(node, 'attempt.branch-cleanup-failed')
      expect(failure!.payload).toMatchObject({ branch })
      expect(await rejected(w, w.ticket)).not.toBe('Rejected')
    }
  })

  test('the cleanup runs without a rejected role, which gates only the move', async () => {
    const w = await world(false)
    await settled(w, `ab/${child}`)
    await complete(w)
    expect(await sweep(w)).toBe(true)
    expect(w.forge.deleteBranchCalls).toHaveLength(1)
    expect(await w.events(node, 'attempt.ticket-rejected')).toEqual([])
    // With the obligation met and no rejected role, nothing is left to do.
    expect(await sweep(w)).toBe(false)
    expect(w.forge.deleteBranchCalls).toHaveLength(1)
  })
})

describe('decline settlement records the branch only when the attempt published', () => {
  async function decline(w: World, published: boolean) {
    if (published)
      await w.store.append(child, {
        actor: DISPATCHER,
        type: 'pr.opened',
        payload: { pr: { number: 3, url: 'https://forge/3', headSha: sha('e') } },
      })
    await w.store.append(child, {
      actor: agentActor('implement', 's_1'),
      type: 'implement.declined',
      payload: { round: 1, reason: 'no gain' },
    })
    const record = (await w.store.getBuild(child))!
    await w.call('settleDeclinedAttempt', record, (await readBuildFacts(w.store, child)).value)
    return (await w.events(node, 'attempt.settled'))[0]!.payload
  }

  test('published', async () => {
    const payload = await decline(await world(), true)
    expect(payload).toMatchObject({ outcome: 'declined', attempt: { branch: `ab/${child}` } })
  })

  test('never published', async () => {
    const payload = await decline(await world(), false)
    expect(payload.outcome).toBe('declined')
    expect(payload.attempt.branch).toBeUndefined()
  })
})
