import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { mintToken } from '@defrex/autobuild/remote-store'
import {
  AUTOBUILD_VERSION,
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
} from '@defrex/autobuild/remote-store'
import { describeTicketSourceContract } from '@defrex/autobuild/plugin-sdk'
import { FakeTicketSource } from '@defrex/autobuild/plugin-sdk'
import {
  HostedTicketSource,
  TICKET_REVISIONS_HEADER,
  TICKET_REVISIONS_CAPABILITY,
} from '@defrex/autobuild/hosted-tickets'
import { createTicketServer } from './ticket-server'

const secret = 'ticket-test-secret'
const now = new Date('2026-01-01T00:00:00.000Z')
const operator = mintToken(secret, {
  version: 1,
  ownerAdmin: { user: 'owner:fixture' },
  exp: now.getTime() + 60_000,
})

function harness(backend = new FakeTicketSource([], { doneState: 'Done' })) {
  const contexts: unknown[] = []
  const server = createTicketServer({
    secret,
    clock: () => now,
    sourceFor: (context) => {
      contexts.push(context)
      return backend
    },
  })
  const source = new HostedTicketSource({
    url: 'https://tickets.example',
    token: operator,
    teamKey: 'ENG',
    claimedState: 'Doing',
    createState: 'Triage',
    fetchFn: (input, init) => {
      if (input instanceof Request) return server.fetch(new Request(input, init))
      return server.fetch(new Request(input.toString(), init))
    },
  })
  return { backend, contexts, server, source }
}

describeTicketSourceContract('HostedTicketSource (HTTP → FakeTicketSource)', async () => ({
  source: harness().source,
  states: { ready: 'Ready', claimed: 'Doing', completed: 'Done' },
  editableLabel: 'autobuild',
}))

describe('hosted ticket protocol', () => {
  test('forwards repository context and preserves exact body bytes while projecting source identity', async () => {
    const { backend, contexts, source } = harness()
    const body = '# Spec\r\n\r\nUnicode: ☃  \r\ntrailing\t '
    const created = await source.create(
      { title: 'Exact', body, labels: ['ready'] },
      { state: 'Ready', idempotencyKey: 'creation-1' },
    )
    expect(created.resolved).toBe(false)
    expect(created.body).toBe(body)
    expect(created.ref.source).toBe('hosted')
    expect((await backend.get(created.ref.id))?.body).toBe(body)
    expect(contexts).toEqual([{ teamKey: 'ENG', claimedState: 'Doing', createState: 'Triage' }])
    await source.transition(created.ref.id, 'Done')
    expect((await source.get(created.ref.id))?.resolved).toBe(true)
  })

  test('only operator scope reaches parsing or backend construction', async () => {
    let invoked = 0
    const server = createTicketServer({
      secret,
      clock: () => now,
      sourceFor: () => {
        invoked++
        return new FakeTicketSource()
      },
    })
    const admin = mintToken(secret, {
      build: '*',
      session: '*',
      exp: now.getTime() + 60_000,
    })
    const response = await server.fetch(
      new Request('https://tickets.example/tickets/get', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${admin}`,
          [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
          [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
          'content-type': 'application/json',
        },
        body: '{not json',
      }),
    )
    expect(response.status).toBe(401)
    expect(invoked).toBe(0)
  })

  test('reports only unexpected source failures and preserves standalone responses', async () => {
    const failure = new Error('blob provider credentials rejected')
    const backend = new FakeTicketSource()
    backend.listReady = async () => {
      throw failure
    }
    const reports: Array<[unknown, Request]> = []
    const server = createTicketServer({
      secret,
      clock: () => now,
      sourceFor: () => backend,
      onInternalError: (error, request) => reports.push([error, request]),
    })
    const request = new Request('https://tickets.example/tickets/list-ready', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${operator}`,
        [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
        [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ context: { teamKey: 'ENG' }, input: {} }),
    })

    const response = await server.fetch(request)

    expect(response.status).toBe(500)
    expect(await response.text()).toContain(failure.message)
    expect(reports).toEqual([[failure, request]])

    const denied = await server.fetch(
      new Request('https://tickets.example/tickets/get', {
        method: 'POST',
        headers: {
          [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
          [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
        },
      }),
    )
    expect(denied.status).toBe(401)
    expect(reports).toHaveLength(1)
  })

  test('a failing internal reporter cannot replace the ticket response', async () => {
    const backend = new FakeTicketSource()
    backend.listReady = async () => {
      throw new Error('source failed')
    }
    const server = createTicketServer({
      secret,
      clock: () => now,
      sourceFor: () => backend,
      onInternalError: () => {
        throw new Error('logger failed')
      },
    })
    const response = await server.fetch(
      new Request('https://tickets.example/tickets/list-ready', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${operator}`,
          [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
          [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ context: { teamKey: 'ENG' }, input: {} }),
      }),
    )
    expect(response.status).toBe(500)
    expect(await response.text()).toContain('source failed')
  })
})

test('guarded transport rehydrates a conflict', async () => {
  const { source } = harness()
  const ticket = await source.create({ title: 'Original', body: 'Body' })
  await source.mutateIfRevision(ticket.ref.id, ticket.revision, {
    kind: 'update',
    patch: { title: 'New' },
  })
  const current = (await source.get(ticket.ref.id))!
  try {
    await source.mutateIfRevision(ticket.ref.id, ticket.revision, {
      kind: 'transition',
      state: 'Done',
    })
    throw new Error('expected conflict')
  } catch (error) {
    expect(error).toMatchObject({
      name: 'TicketRevisionConflict',
      currentRevision: current.revision,
      expectedRevision: ticket.revision,
    })
  }
  expect(await source.get(ticket.ref.id)).toEqual(current)
})

// Frozen released ticket shape (v0.11/v0.12): strict decoders reject extra fields.
const releasedTicketSchema = z.strictObject({
  ref: z.strictObject({
    source: z.string().min(1),
    id: z.string().min(1),
    url: z.string().optional(),
    title: z.string().optional(),
  }),
  creationKey: z.string().optional(),
  title: z.string(),
  body: z.string(),
  state: z.string().optional(),
  resolved: z.boolean(),
  labels: z.array(z.string()),
  blockersResolved: z.boolean().optional(),
  blockedBy: z.array(z.string()).optional(),
})

test.each(['0.10.0', '0.11.0', '0.12.0', '0.12.1'])(
  'released %s ticket decoders accept get, list-ready and create responses',
  async (version) => {
    const { source, server } = harness()
    const existing = await source.create({ title: 'Existing', body: 'Body' })
    const schema = version.startsWith('0.10.')
      ? releasedTicketSchema.omit({ resolved: true, blockersResolved: true })
      : releasedTicketSchema
    for (const [operation, input] of [
      ['get', { id: existing.ref.id }],
      ['list-ready', {}],
      ['create', { draft: { title: 'Legacy create', body: 'Body' } }],
    ] as const) {
      const response = await server.fetch(
        new Request(`https://tickets.example/tickets/${operation}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${operator}`,
            [AUTOBUILD_VERSION_HEADER]: version,
            [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ context: { teamKey: 'ENG' }, input }),
        }),
      )
      expect(response.status).toBe(operation === 'create' ? 201 : 200)
      const body = await response.json()
      if (operation === 'list-ready') {
        expect(
          z.strictObject({ tickets: z.array(schema), diagnostics: z.array(z.string()) }).parse(body)
            .tickets,
        ).toHaveLength(1)
      } else
        expect(schema.parse(body).title).toBe(operation === 'get' ? 'Existing' : 'Legacy create')
    }
  },
)

test('revision opt-in distinguishes new and released clients reporting the same 0.12.0 version', async () => {
  const { server } = harness()
  const headersSeen: Headers[] = []
  const source = new HostedTicketSource({
    url: 'https://tickets.example',
    token: operator,
    teamKey: 'ENG',
    fetchFn: async (input, init) => {
      const req = new Request(String(input), init)
      req.headers.set(AUTOBUILD_VERSION_HEADER, '0.12.0')
      headersSeen.push(new Headers(req.headers))
      return server.fetch(req)
    },
  })
  const created = await source.create({ title: 'New client', body: 'Body' })
  expect(created.revision).toEqual(expect.any(String))
  expect(created.revision.length).toBeGreaterThan(0)
  expect((await source.get(created.ref.id))?.revision).toBe(created.revision)
  expect((await source.listReady({})).tickets[0]?.revision).toBe(created.revision)
  for (const headers of headersSeen) {
    expect(headers.get(AUTOBUILD_VERSION_HEADER)).toBe('0.12.0')
    expect(headers.get(TICKET_REVISIONS_HEADER)).toBe(TICKET_REVISIONS_CAPABILITY)
  }
  // An unknown capability must retain the strict released decoder shape.
  const response = await server.fetch(
    new Request('https://tickets.example/tickets/get', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${operator}`,
        [AUTOBUILD_VERSION_HEADER]: '0.12.0',
        [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
        [TICKET_REVISIONS_HEADER]: 'unknown',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ context: { teamKey: 'ENG' }, input: { id: created.ref.id } }),
    }),
  )
  expect(response.status).toBe(200)
  expect(releasedTicketSchema.parse(await response.json()).title).toBe('New client')
})
