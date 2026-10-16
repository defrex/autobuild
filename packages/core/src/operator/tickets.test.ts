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
  ref: { source: 'fake', id: 'AUT-1', title: 'Ticket' },
  title: 'Ticket',
  body: 'body\r\nwithout-final-newline',
  state: 'Backlog',
  resolved: false,
  labels: ['autobuild'],
  blockedBy: ['AUT-2', 'AUT-404'],
}
const blocker = {
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
