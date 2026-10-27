import { testProjects } from './testing/projects'
import { describe, expect, test } from 'bun:test'
import { parseConfig } from '@defrex/autobuild/testing'
import { DISPATCHER } from '@defrex/autobuild/testing'
import { FakeTicketSource } from '@defrex/autobuild/plugin-sdk'
import { MemoryBuildStore } from '@defrex/autobuild/plugin-sdk'
import { mintToken } from '@defrex/autobuild/remote-store'
import { OperatorApiClient, OperatorApiError } from './operator-client'
import { createOperatorServer } from './operator-server'

const repo = 'acme/widgets'
const secret = 'ticket-operator-secret'
const now = new Date('2026-09-02T00:00:00Z')
const config = parseConfig(`
[tickets]
source = "hosted"
teamKey = "AUT"
triageState = "Backlog"
readyState = "Todo"
[verify]
steps = []
[finalize]
steps = []
`)

async function setup(source: FakeTicketSource) {
  const store = new MemoryBuildStore({ clock: () => now })
  await store.ensureRepo(repo)
  const { verify, finalize, ...root } = config
  const artifact = await store.putRepoArtifact(repo, {
    kind: 'dispatcher-effective-config',
    content: JSON.stringify({
      ...root,
      verify: { steps: verify.steps },
      finalize: { steps: finalize.steps },
    }),
  })
  await store.appendRepo(repo, {
    actor: DISPATCHER,
    type: 'dispatcher.run-started',
    payload: {
      run: 'run',
      pid: 1,
      effectiveConfig: { kind: artifact.kind, rev: artifact.revision },
      roleWarnings: [],
    },
  })
  const server = createOperatorServer({
    projects: testProjects([repo]),
    store,
    secret,
    clock: () => now,
    ticketBackend: {
      sourceFor: async () => source,
      statesFor: async () => ['Backlog', 'Todo', 'Done'],
    },
  })
  const client = new OperatorApiClient({
    url: 'http://operator.test',
    token: mintToken(secret, {
      version: 1,
      internalOperator: { user: 'Ada', repo: repo },
      exp: now.getTime() + 60_000,
    }),
    fetchFn: ((input: string | URL | Request, init?: RequestInit) =>
      server.fetch(
        input instanceof Request ? new Request(input, init) : new Request(String(input), init),
      )) as typeof fetch,
  })
  return client
}

describe('operator ticket HTTP routes', () => {
  test('supports create, detail, update, move, block and unblock', async () => {
    const source = new FakeTicketSource([], { createState: 'Backlog', doneState: 'Done' })
    const client = await setup(source)
    expect(await client.listTickets(repo)).toMatchObject({
      triageState: 'Backlog',
      readyState: 'Todo',
      criteria: { state: 'Backlog' },
    })
    const blocker = await client.createTicket(repo, { title: 'Blocker', body: 'body' })
    const created = await client.createTicket(repo, {
      title: 'Target',
      body: 'line\r\ntrailing  \nno-final-newline',
      labels: ['web'],
      blockedBy: [blocker.ticket.ref.id],
    })
    expect(created.ticket.body).toBe('line\r\ntrailing  \nno-final-newline')
    expect((await client.getTicket(repo, created.ticket.ref.id)).blockers[0]?.resolved).toBe(false)
    expect(
      (await client.updateTicket(repo, created.ticket.ref.id, { labels: [] })).ticket.labels,
    ).toEqual([])
    expect(
      (await client.moveTicket(repo, created.ticket.ref.id, { state: 'Done' })).ticket.state,
    ).toBe('Done')
    await client.unblockTicket(repo, created.ticket.ref.id, { blockerIds: [blocker.ticket.ref.id] })
    expect(
      (
        await client.blockTicket(repo, created.ticket.ref.id, {
          blockerIds: [blocker.ticket.ref.id],
        })
      ).ticket.blockedBy,
    ).toEqual([blocker.ticket.ref.id])
  })

  test('pages a listing newest or oldest first and counts every match', async () => {
    const source = new FakeTicketSource([], { createState: 'Backlog', doneState: 'Done' })
    const client = await setup(source)
    for (const title of ['one', 'two', 'three', 'four', 'five'])
      await client.createTicket(repo, { title, body: 'body' })
    const titles = (queue: Awaited<ReturnType<typeof client.listTickets>>) =>
      queue.tickets.map((ticket) => ticket.title)

    const first = await client.listTickets(repo, { page: { limit: 2, order: 'newest' } })
    expect(titles(first)).toEqual(['five', 'four'])
    expect(first.total).toBe(5)
    expect(
      titles(await client.listTickets(repo, { page: { limit: 2, offset: 4, order: 'newest' } })),
    ).toEqual(['one'])
    expect(titles(await client.listTickets(repo, { page: { limit: 2, offset: 1 } }))).toEqual([
      'two',
      'three',
    ])
    expect((await client.listTickets(repo)).tickets).toHaveLength(5)
    const invalid = await client
      .listTickets(repo, { page: { limit: 500 } })
      .catch((error: unknown) => error)
    expect(invalid).toBeInstanceOf(OperatorApiError)
  })

  test('maps missing tickets and exact backend refusals', async () => {
    const source = new FakeTicketSource([
      {
        revision: 'fixture',
        ref: { source: 'fake', id: 'AUT-1', title: 'One' },
        title: 'One',
        body: 'body',
        state: 'Ready',
        resolved: false,
        labels: [],
      },
    ])
    const client = await setup(source)
    const missing = await client.getTicket(repo, 'AUT-404').catch((error) => error)
    expect(missing).toMatchObject({ status: 404, kind: 'not-found' })
    source.transition = async () => {
      throw new Error('provider refuses this exact transition')
    }
    const refusal = await client
      .moveTicket(repo, 'AUT-1', { state: 'Done' })
      .catch((error) => error)
    expect(refusal).toBeInstanceOf(OperatorApiError)
    expect(refusal).toMatchObject({
      status: 409,
      kind: 'refusal',
      message: 'provider refuses this exact transition',
    })
  })
})

test('operator writes forward expected revisions for update, move, block and unblock', async () => {
  const source = new FakeTicketSource()
  const client = await setup(source)
  const target = await client.createTicket(repo, { title: 'Target', body: 'Body' })
  const blocker = await client.createTicket(repo, { title: 'Blocker', body: 'Body' })
  const id = target.ticket.ref.id
  const stale = target.ticket.revision
  const updated = await client.updateTicket(repo, id, { title: 'Updated', expectedRevision: stale })
  const operations = [
    () => client.updateTicket(repo, id, { body: 'Lost', expectedRevision: stale }),
    () => client.moveTicket(repo, id, { state: 'Done', expectedRevision: stale }),
    () =>
      client.blockTicket(repo, id, {
        blockerIds: [blocker.ticket.ref.id],
        expectedRevision: stale,
      }),
    () =>
      client.unblockTicket(repo, id, {
        blockerIds: [blocker.ticket.ref.id],
        expectedRevision: stale,
      }),
  ]
  for (const operation of operations) {
    await expect(operation()).rejects.toMatchObject({ status: 409, kind: 'conflict' })
    expect((await client.getTicket(repo, id)).ticket).toEqual(updated.ticket)
  }
  const blocked = await client.blockTicket(repo, id, {
    blockerIds: [blocker.ticket.ref.id],
    expectedRevision: updated.ticket.revision,
  })
  const unblocked = await client.unblockTicket(repo, id, {
    blockerIds: [blocker.ticket.ref.id],
    expectedRevision: blocked.ticket.revision,
  })
  const moved = await client.moveTicket(repo, id, {
    state: 'Done',
    expectedRevision: unblocked.ticket.revision,
  })
  expect(moved.ticket.state).toBe('Done')
})
