import { describe, expect, test } from 'bun:test'
import { parseConfig } from '../config/load'
import { DISPATCHER } from '../events/envelope'
import { FakeTicketSource } from '../ports/tickets/fake'
import { MemoryBuildStore } from '../store/memory'
import { mintToken } from '../store/remote/token'
import { OperatorApiClient, OperatorApiError } from './client'
import { createOperatorServer } from './server'

const repo = 'acme/widgets'
const secret = 'ticket-operator-secret'
const now = new Date('2026-09-02T00:00:00Z')
const config = parseConfig(`
[tickets]
source = "hosted"
teamKey = "AUT"
readyState = "Ready"
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
    store,
    secret,
    clock: () => now,
    ticketBackend: { sourceFor: async () => source, statesFor: async () => ['Ready', 'Done'] },
  })
  const client = new OperatorApiClient({
    url: 'http://operator.test',
    token: mintToken(secret, { operator: { user: 'Ada' }, exp: now.getTime() + 60_000 }),
    fetchFn: ((input: string | URL | Request, init?: RequestInit) =>
      server.fetch(
        input instanceof Request ? new Request(input, init) : new Request(String(input), init),
      )) as typeof fetch,
  })
  return client
}

describe('operator ticket HTTP routes', () => {
  test('supports create, detail, update, move, block and unblock', async () => {
    const source = new FakeTicketSource([], { createState: 'Ready', doneState: 'Done' })
    const client = await setup(source)
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

  test('maps missing tickets and exact backend refusals', async () => {
    const source = new FakeTicketSource([
      {
        ref: { source: 'fake', id: 'AUT-1', title: 'One' },
        title: 'One',
        body: 'body',
        state: 'Ready',
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
