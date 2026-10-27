import { describe, expect, test } from 'bun:test'
import { parseConfig } from '../config/load'
import { DISPATCHER } from '../events/envelope'
import { FakeTicketSource } from '../ports/tickets/fake'
import { MemoryBuildStore } from '../store/memory'
import { getOperatorTicket, listOperatorTickets, mutateOperatorTicket } from './tickets'

const repo = 'acme/widgets'
const clock = () => new Date('2026-09-02T00:00:00Z')
const config = parseConfig(`
[tickets]
source = "hosted"
teamKey = "AUT"
triageState = "Backlog"
readyState = "Todo"
readyLabels = ["autobuild"]
[verify]
steps = []
[finalize]
steps = []
`)

async function configuredStore() {
  const store = new MemoryBuildStore({ clock })
  await store.ensureRepo(repo)
  const { verify, finalize, ...root } = config
  const artifact = await store.putRepoArtifact(repo, {
    kind: 'dispatcher-effective-config',
    content: JSON.stringify({
      ...root,
      verify: { steps: verify.steps, ...verify.stepConfigs },
      finalize: { steps: finalize.steps, ...finalize.stepConfigs },
    }),
  })
  await store.appendRepo(repo, {
    actor: DISPATCHER,
    type: 'dispatcher.run-started',
    payload: {
      run: 'run-1',
      pid: 1,
      effectiveConfig: { kind: artifact.kind, rev: artifact.revision },
      roleWarnings: [],
    },
  })
  return store
}

const seed = {
  revision: 'fixture',
  ref: { source: 'fake', id: 'AUT-1', title: 'Ticket' },
  title: 'Ticket',
  body: 'body\r\nwithout-final-newline',
  comments: [{ body: '  note\r\n☃\n', createdAt: '2026-01-01T00:00:00.000Z', author: 'Ada' }],
  state: 'Backlog',
  resolved: false,
  labels: ['autobuild'],
  blockedBy: ['AUT-2', 'AUT-404'],
}
const blocker = {
  revision: 'fixture',
  ref: { source: 'fake', id: 'AUT-2', title: 'Done' },
  title: 'Done',
  body: 'done',
  state: 'Done',
  resolved: true,
  labels: [],
}

function backend(source: FakeTicketSource) {
  return {
    sourceFor: async () => source,
    statesFor: async () => ['Backlog', 'Todo', 'In Progress', 'Done'],
  }
}

describe('operator ticket projections', () => {
  test('uses configured triage by default and exact explicit filters', async () => {
    const store = await configuredStore()
    const source = new FakeTicketSource([seed, blocker], { doneState: 'Done' })
    const backlog = await listOperatorTickets({ store, repo, backend: backend(source) })
    expect(backlog.criteria).toEqual({ state: 'Backlog' })
    expect(backlog.triageState).toBe('Backlog')
    expect(backlog.readyState).toBe('Todo')
    expect(backlog.tickets.map((ticket) => ticket.ref.id)).toEqual(['AUT-1'])
    expect(backlog.states).toEqual(['Backlog', 'Todo', 'In Progress', 'Done'])
    const labelled = await listOperatorTickets({
      store,
      repo,
      backend: backend(source),
      labels: ['autobuild'],
    })
    expect(labelled.criteria).toEqual({ state: 'Backlog', labels: ['autobuild'] })
    const done = await listOperatorTickets({ store, repo, backend: backend(source), state: 'Done' })
    expect(done.criteria).toEqual({ state: 'Done' })
  })

  test('projects blockers and prefers an active matching repository build', async () => {
    const store = await configuredStore()
    await store.createBuild({ slug: 'old', repo, ticket: { source: 'fake', id: 'AUT-1' } })
    await store.append('old', {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: 'merged' },
    })
    await store.createBuild({ slug: 'active', repo, ticket: { source: 'fake', id: 'AUT-1' } })
    const detail = await getOperatorTicket({
      store,
      repo,
      backend: backend(new FakeTicketSource([seed, blocker], { doneState: 'Done' })),
      id: 'AUT-1',
    })
    expect(detail.blockers).toEqual([
      { id: 'AUT-2', exists: true, resolved: true, blockedBy: [] },
      { id: 'AUT-404', exists: false, resolved: false, blockedBy: [] },
    ])
    expect(detail.build?.slug).toBe('active')
  })

  test('round-trips exact update bodies and refuses invented states verbatim', async () => {
    const store = await configuredStore()
    const source = new FakeTicketSource([seed, blocker], { doneState: 'Done' })
    const body = 'changed\r\ntrailing  \nno-final-newline'
    const updated = await mutateOperatorTicket({
      store,
      repo,
      backend: backend(source),
      operation: { kind: 'update', id: 'AUT-1', patch: { body } },
    })
    expect(updated.ticket.body).toBe(body)
    source.transition = async () => {
      throw new Error('provider says transition is forbidden')
    }
    await expect(
      mutateOperatorTicket({
        store,
        repo,
        backend: backend(source),
        operation: { kind: 'move', id: 'AUT-1', state: 'Invented' },
      }),
    ).rejects.toThrow('provider says transition is forbidden')
  })
})

test('canonical ticket detail finds historical build aliases and keeps sources separate', async () => {
  const store = await configuredStore()
  const source = new FakeTicketSource([seed])
  Object.defineProperty(source, 'name', { value: 'hosted' })
  const get = source.get.bind(source)
  source.get = async (id) => {
    const ticket = await get(id === 'ticket-legacy' || id === 'aut-1' ? 'AUT-1' : id)
    return ticket ? { ...ticket, ref: { ...ticket.ref, source: 'hosted' } } : null
  }
  await store.createBuild({
    slug: 'legacy',
    repo,
    ticket: { source: 'hosted', id: 'ticket-legacy' },
  })
  await store.createBuild({
    slug: 'foreign-source',
    repo,
    ticket: { source: 'linear', id: 'AUT-1' },
  })
  for (const id of ['AUT-1', 'aut-1', 'ticket-legacy']) {
    const detail = await getOperatorTicket({ store, repo, backend: backend(source), id })
    expect(detail.ticket.ref.id).toBe('AUT-1')
    expect(detail.build?.slug).toBe('legacy')
  }
})

for (const provider of ['linear', 'file', 'hosted', 'database']) {
  test(`${provider} exact build association never looks up unrelated historical tickets`, async () => {
    const store = await configuredStore()
    const source = new FakeTicketSource([
      { ...seed, ref: { ...seed.ref, source: provider }, blockedBy: [] },
    ])
    Object.defineProperty(source, 'name', { value: provider })
    const get = source.get.bind(source)
    const gets: string[] = []
    source.get = async (id) => {
      gets.push(id)
      if (id !== 'AUT-1') throw new Error('historical provider unavailable')
      return get(id)
    }
    for (let i = 0; i < 20; i++)
      await store.createBuild({
        slug: `old-${i}`,
        repo,
        ticket: { source: provider, id: `old-${i}` },
      })
    await store.createBuild({
      slug: 'matching',
      repo,
      ticket: { source: provider === 'database' ? 'hosted' : provider, id: 'AUT-1' },
    })
    expect(
      (await getOperatorTicket({ store, repo, backend: backend(source), id: 'AUT-1' })).build?.slug,
    ).toBe('matching')
    expect(
      (
        await mutateOperatorTicket({
          store,
          repo,
          backend: backend(source),
          operation: { kind: 'update', id: 'AUT-1', patch: { title: 'Updated' } },
        })
      ).ticket.title,
    ).toBe('Updated')
    expect(gets.every((id) => id === 'AUT-1')).toBe(true)
  })
}

test('hosted alias association failure preserves a completed mutation', async () => {
  const store = await configuredStore()
  const source = new FakeTicketSource([
    { ...seed, ref: { ...seed.ref, source: 'hosted' }, blockedBy: [] },
  ])
  Object.defineProperty(source, 'name', { value: 'hosted' })
  const get = source.get.bind(source)
  source.get = async (id) => {
    if (id === 'legacy-unavailable') throw new Error('provider unavailable')
    return get(id)
  }
  await store.createBuild({
    slug: 'old',
    repo,
    ticket: { source: 'hosted', id: 'legacy-unavailable' },
  })
  const detail = await mutateOperatorTicket({
    store,
    repo,
    backend: backend(source),
    operation: { kind: 'move', id: 'AUT-1', state: 'Todo' },
  })
  expect(detail.ticket.state).toBe('Todo')
  expect(detail.build).toBeNull()
  expect((await get('AUT-1'))?.state).toBe('Todo')
  expect(source.transitions).toEqual([{ id: 'AUT-1', state: 'Todo' }])
})

test('the service database backend never looks up historical refs for an undispatched ticket', async () => {
  const store = await configuredStore()
  const source = new FakeTicketSource([
    { ...seed, ref: { ...seed.ref, source: 'database' }, blockedBy: [] },
  ])
  Object.defineProperty(source, 'name', { value: 'database' })
  const get = source.get.bind(source)
  const reads: string[] = []
  source.get = async (id) => {
    reads.push(id)
    if (id !== 'AUT-1') throw new Error('unrelated ticket read')
    return get(id)
  }
  for (let i = 0; i < 20; i++)
    await store.createBuild({
      slug: `unrelated-${i}`,
      repo,
      ticket: { source: 'hosted', id: `AUT-${i + 2}` },
    })
  const detail = await getOperatorTicket({ store, repo, backend: backend(source), id: 'AUT-1' })
  expect(detail.build).toBeNull()
  expect(reads).toEqual(['AUT-1'])
})

test('operator detail retains recorded comment bodies and authors', async () => {
  const store = await configuredStore()
  const source = new FakeTicketSource([seed])
  source.get = async () => seed
  const detail = await getOperatorTicket({ store, repo, backend: backend(source), id: seed.ref.id })
  expect(detail.ticket.comments).toEqual(seed.comments)
})

test('operator re-pin opens a configured native file source and snapshots its bytes', async () => {
  const { FileTicketSource } = await import('../ports/tickets/file')
  const { prepareOperatorTicketAssets } = await import('./tickets')
  const { readAssetSnapshot } = await import('../store/ticket-asset-snapshots')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'operator-native-'))
  try {
    const source = new FileTicketSource({ dir })
    const ticket = await source.create({ title: 'Native', body: 'body' })
    await source.assets.putTicketAsset(repo, ticket.ref.id, {
      kind: 'design',
      name: 'reference',
      layout: 'file',
      entries: [{ type: 'file', path: 'image', content: new Uint8Array([0, 255]) }],
    })
    const store = new MemoryBuildStore()
    const fileConfig = parseConfig('[tickets]\nsource = "file"\nreadyState = "ready"\n')
    let opens = 0
    const pins = await prepareOperatorTicketAssets({
      store,
      repo,
      ref: ticket.ref,
      backend: {
        contextFor: async () => ({ repo, tickets: fileConfig.tickets, teamKey: '' }),
        sourceFor: () => {
          opens++
          return source
        },
        statesFor: () => [],
      },
    })
    expect(opens).toBe(1)
    await source.assets.removeTicketAsset(repo, ticket.ref.id, 'design', 'reference')
    expect((await readAssetSnapshot(store, repo, ticket.ref.id, pins[0]!)).entries).toEqual([
      { type: 'file', path: 'image', content: new Uint8Array([0, 255]) },
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('operator create and metadata-only patches preserve ticket kind, target and revision guards', async () => {
  const store = await configuredStore()
  const source = new FakeTicketSource()
  const common = { store, repo, backend: backend(source) }
  const node = await mutateOperatorTicket({
    ...common,
    operation: { kind: 'create', ticketKind: 'node', title: 'Node', body: 'spec' },
  })
  const child = await mutateOperatorTicket({
    ...common,
    operation: { kind: 'create', title: 'Child', body: 'spec', target: node.ticket.ref.id },
  })
  expect(node.ticket.kind).toBe('node')
  expect(child.ticket.target).toBe(node.ticket.ref.id)
  const cleared = await mutateOperatorTicket({
    ...common,
    operation: {
      kind: 'update',
      id: child.ticket.ref.id,
      patch: { target: null },
      expectedRevision: child.ticket.revision,
    },
  })
  expect(cleared.ticket.target).toBeUndefined()
  await expect(
    mutateOperatorTicket({
      ...common,
      operation: {
        kind: 'update',
        id: child.ticket.ref.id,
        patch: { kind: 'node' },
        expectedRevision: child.ticket.revision,
      },
    }),
  ).rejects.toThrow('changed')
  const listed = await listOperatorTickets({ ...common, state: 'Triage' })
  expect(listed.tickets.every((ticket) => ticket.kind !== undefined)).toBe(true)
})

test('tree service retains completed source tickets, diagnostics and invalid graph refusal', async () => {
  const { readTicketTree, getOperatorTicketTree } = await import('./tickets')
  const source = new FakeTicketSource()
  const node = await source.create({ title: 'Node', body: 'spec', kind: 'node' })
  const child = await source.create({ title: 'Child', body: 'spec', target: node.ref.id })
  await source.transition(child.ref.id, 'Done')
  const listAll = source.listAll.bind(source)
  source.listAll = async () => ({ ...(await listAll()), diagnostics: ['provider diagnostic'] })
  const direct = await readTicketTree(source, config.baseBranch)
  const operator = await getOperatorTicketTree({
    store: await configuredStore(),
    repo,
    backend: backend(source),
  })
  expect(operator).toEqual(direct)
  expect(direct.children[0]!.children[0]!.ticket.state).toBe('Done')
  expect(direct.diagnostics).toEqual(['provider diagnostic'])
  source.listAll = async () => ({ tickets: [{ ...node, target: node.ref.id }], diagnostics: [] })
  await expect(readTicketTree(source, 'main')).rejects.toThrow('cyclic')
})

test('native pages forward criteria and window without a full read or double slicing', async () => {
  const store = await configuredStore()
  const source = new FakeTicketSource([seed])
  const calls: unknown[] = []
  const native = Object.assign(source, {
    async listPage(criteria: unknown, page: unknown) {
      expect(this).toBe(source)
      calls.push({ criteria, page })
      return { tickets: [seed], diagnostics: ['native diagnostic'], total: 99 }
    },
  })
  const full = source.listReady.bind(source)
  source.listReady = async () => {
    throw new Error('full read')
  }
  const page = { limit: 1, offset: 40, order: 'newest' as const }
  const result = await listOperatorTickets({
    store,
    repo,
    backend: backend(native),
    labels: ['x'],
    page,
  })
  expect(result.tickets.map((t) => t.ref.id)).toEqual([seed.ref.id])
  expect(result.total).toBe(99)
  expect(result.diagnostics).toEqual(['native diagnostic'])
  expect(calls).toEqual([{ criteria: { state: 'Backlog', labels: ['x'] }, page }])
  await expect(listOperatorTickets({ store, repo, backend: backend(native) })).rejects.toThrow(
    'full read',
  )
  native.listPage = async () => {
    throw new Error('native failure')
  }
  await expect(
    listOperatorTickets({ store, repo, backend: backend(native), page: { limit: 0 } }),
  ).rejects.toThrow('native failure')
  source.listReady = full
  expect((await listOperatorTickets({ store, repo, backend: backend(native) })).total).toBe(1)
})
