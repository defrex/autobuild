import { describe, expect, test } from 'bun:test'
import { DISPATCHER, KERNEL } from '../events/envelope'
import { commandObjective } from '../kernel/generators/optimization-log'
import type { TicketRef } from '../ontology'
import { MemoryBuildStore } from '../store/memory'
import { PhaseSessionError, scopeLocalStoreToPhaseSession } from '../store/phase-session'
import { readBuildFacts } from '../store/reduced-reads'
import { attemptContextReadBudget, memoryStoreRequestCounter } from '../testing/reduced-read-budget'
import { readAttemptContext } from './attempt'

const repo = '/attempt/repo'
const node = 'opt-node'
const sha = 'a'.repeat(40)

async function nodeStore(opts: { objective?: boolean; proposed?: TicketRef[] } = {}) {
  const store = new MemoryBuildStore()
  await store.ensureRepo(repo)
  await store.createBuild({ slug: node, repo, branch: 'ab-node/opt-node' })
  await store.append(node, {
    actor: DISPATCHER,
    type: 'build.created',
    payload: { repo, ticket: { source: 'file', id: 'NODE' }, baseBranch: 'main', kind: 'node' },
  })
  if (opts.objective !== false) {
    await store.append(node, {
      actor: DISPATCHER,
      type: 'optimization.objective-accepted',
      payload: { objective: commandObjective(), revision: 1, harnessPin: sha, specRev: 0 },
    })
    await store.append(node, {
      actor: KERNEL,
      type: 'optimization.baseline-measured',
      payload: { revision: 1, head: sha, harnessPin: sha, samples: 7, median: 50, spread: 1 },
    })
  }
  if (opts.proposed !== undefined)
    await store.append(node, {
      actor: DISPATCHER,
      type: 'optimization.attempts-proposed',
      payload: {
        request: 'r1',
        proposals: opts.proposed.map((ticket, i) => ({
          id: `p${i}`,
          ticket,
          title: `Attempt ${i}`,
          strategy: `strategy ${i}`,
        })),
      },
    })
  return store
}

async function child(store: MemoryBuildStore, slug: string, ticket: TicketRef, target = true) {
  await store.createBuild({ slug, repo, branch: `ab/${slug}` })
  await store.append(slug, {
    actor: DISPATCHER,
    type: 'build.created',
    payload: {
      repo,
      ticket,
      baseBranch: 'ab-node/opt-node',
      ...(target ? { target: { ticket: { source: 'file', id: 'NODE' }, build: node } } : {}),
    },
  })
  const state = (await readBuildFacts(store, slug)).value.state
  return { slug, state, repo, ticket }
}

async function migrate(store: MemoryBuildStore, mapping: Record<string, string>) {
  await store.appendRepo(repo, {
    actor: { kind: 'human', user: 'operator' },
    type: 'tickets.migration-recorded',
    payload: { identity: 'file-to-hosted', from: 'file', to: 'hosted', mapping },
  })
}

const source = (name: string) => async () => name

describe('readAttemptContext', () => {
  test('a build without a target reads nothing', async () => {
    const store = await nodeStore({ proposed: [{ source: 'file', id: 'A-1' }] })
    const input = await child(store, 'plain', { source: 'file', id: 'A-1' }, false)
    const requests = memoryStoreRequestCounter(store)
    try {
      expect(await readAttemptContext(store, { ...input, ticketSource: source('file') })).toBe(
        undefined,
      )
      expect(requests.vector()).toEqual({})
    } finally {
      requests.restore()
    }
  })

  test('a plain node, a non-proposed child and a settled attempt are not attempts', async () => {
    const plain = await nodeStore({ objective: false })
    const plainChild = await child(plain, 'c1', { source: 'file', id: 'A-1' })
    const requests = memoryStoreRequestCounter(plain)
    try {
      expect(
        await readAttemptContext(plain, { ...plainChild, ticketSource: source('file') }),
      ).toBeUndefined()
      expect(requests.vector().getRepo).toBeUndefined()
    } finally {
      requests.restore()
    }

    const store = await nodeStore({ proposed: [{ source: 'file', id: 'A-1' }] })
    const other = await child(store, 'c2', { source: 'file', id: 'B-1' })
    expect(
      await readAttemptContext(store, { ...other, ticketSource: source('file') }),
    ).toBeUndefined()
    await store.append(node, {
      actor: DISPATCHER,
      type: 'attempt.settled',
      payload: {
        attempt: { proposal: 'p0', ticket: { source: 'file', id: 'A-1' } },
        outcome: 'declined',
      },
    })
    const settled = await child(store, 'c3', { source: 'file', id: 'A-1' })
    expect(
      await readAttemptContext(store, { ...settled, ticketSource: source('file') }),
    ).toBeUndefined()
  })

  test('an in-flight proposal resolves to its attempt', async () => {
    const store = await nodeStore({ proposed: [{ source: 'file', id: 'A-1' }] })
    const input = await child(store, 'c1', { source: 'file', id: 'A-1' })
    const attempt = await readAttemptContext(store, { ...input, ticketSource: source('file') })
    expect(attempt?.node).toBe(node)
    expect(attempt?.attempt.proposal).toBe('p0')
    expect(attempt?.optimization.current).toBe(50)
  })

  test('a proposal recorded before a ticket migration matches the migrated child', async () => {
    const store = await nodeStore({ proposed: [{ source: 'file', id: 'A-1' }] })
    await migrate(store, { NODE: 'H-1', 'A-1': 'H-9' })
    const input = await child(store, 'c1', { source: 'hosted', id: 'H-9' })
    const attempt = await readAttemptContext(store, { ...input, ticketSource: source('hosted') })
    expect(attempt?.attempt.proposal).toBe('p0')
  })

  test('unresolvable migration continuity fails closed', async () => {
    const store = await nodeStore({ proposed: [{ source: 'file', id: 'A-1' }] })
    await migrate(store, { NODE: 'H-1' })
    const input = await child(store, 'c1', { source: 'hosted', id: 'H-9' })
    await expect(
      readAttemptContext(store, { ...input, ticketSource: source('hosted') }),
    ).rejects.toThrow('cannot resolve optimization attempt identity for build c1')
  })
})

describe('readAttemptContext through a session-scoped store (AUT-1279)', () => {
  const scoped = (store: MemoryBuildStore, slug: string) =>
    scopeLocalStoreToPhaseSession(store, {
      kind: 'build',
      id: slug,
      session: 's_1',
    })

  test('an in-flight attempt resolves exactly as it does unscoped', async () => {
    const store = await nodeStore({
      proposed: [{ source: 'file', id: 'A-1' }],
    })
    const input = {
      ...(await child(store, 'c1', { source: 'file', id: 'A-1' })),
    }
    const ticketSource = source('file')
    const unscoped = await readAttemptContext(store, {
      ...input,
      ticketSource,
    })
    expect(unscoped).toBeDefined()
    expect(await readAttemptContext(scoped(store, 'c1'), { ...input, ticketSource })).toEqual(
      unscoped,
    )
  })

  test('a migrated proposal still matches under scope', async () => {
    const store = await nodeStore({
      proposed: [{ source: 'file', id: 'A-1' }],
    })
    await migrate(store, { NODE: 'H-1', 'A-1': 'H-9' })
    const input = await child(store, 'c1', { source: 'hosted', id: 'H-9' })
    const attempt = await readAttemptContext(scoped(store, 'c1'), {
      ...input,
      ticketSource: source('hosted'),
    })
    expect(attempt?.attempt.proposal).toBe('p0')
  })

  test('a plain node child is not an attempt and does not fail', async () => {
    const store = await nodeStore({ objective: false })
    const input = await child(store, 'c1', { source: 'file', id: 'A-1' })
    expect(
      await readAttemptContext(scoped(store, 'c1'), {
        ...input,
        ticketSource: source('file'),
      }),
    ).toBeUndefined()
  })

  test('an untargeted build reads nothing and gains no node access', async () => {
    const store = await nodeStore({
      proposed: [{ source: 'file', id: 'A-1' }],
    })
    const input = await child(store, 'plain', { source: 'file', id: 'A-1' }, false)
    const handle = scoped(store, 'plain')
    const requests = memoryStoreRequestCounter(store)
    try {
      expect(
        await readAttemptContext(handle, {
          ...input,
          ticketSource: source('file'),
        }),
      ).toBeUndefined()
      expect(requests.vector()).toEqual({})
    } finally {
      requests.restore()
    }
    await expect(readBuildFacts(handle, node)).rejects.toBeInstanceOf(PhaseSessionError)
  })

  test('each invocation reads a fixed vector of served values at every log length', async () => {
    const store = await nodeStore({
      proposed: [{ source: 'file', id: 'A-1' }],
    })
    await migrate(store, { NODE: 'NODE', 'A-1': 'A-1' })
    const input = await child(store, 'c1', { source: 'file', id: 'A-1' })
    const calls = await attemptContextReadBudget({
      store,
      node,
      repo,
      sizes: [100, 10_000],
      // A fresh scoped handle per invocation, as each `ab` process opens one.
      run: async () => {
        const attempt = await readAttemptContext(scoped(store, 'c1'), {
          ...input,
          ticketSource: source('file'),
        })
        expect(attempt?.attempt.proposal).toBe('p0')
      },
    })
    // The grant (own facts), the node's facts, the repository record and its facts.
    expect(calls).toEqual({ getReducerValue: 3, getRepo: 1 })
  })
})
