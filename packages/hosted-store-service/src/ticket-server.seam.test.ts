import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { mintToken } from '@defrex/autobuild/remote-store'
import {
  AUTOBUILD_VERSION,
  classifyClient,
  supportedClientRange,
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION,
  RELEASE_LINE_PROTOCOLS,
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

/** Ticket shape/capability fixtures must identify each release with its actual
 * wire protocol, independently of which line is currently installed. */
function releasedClientProtocol(version: string): string {
  // Refusal cases need no retained historical handler or protocol evidence.
  if (classifyClient(version, supportedClientRange()) !== 'supported') return '6'
  const line = version.split('.').slice(0, 2).join('.')
  if (line === AUTOBUILD_VERSION.split('.').slice(0, 2).join('.')) {
    return REMOTE_STORE_PROTOCOL_VERSION
  }
  const protocol = RELEASE_LINE_PROTOCOLS[line]
  if (protocol === undefined) throw new Error(`missing protocol fixture for released line ${line}`)
  return protocol
}

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
      { state: 'Ready', idempotencyKey: 'creation-1', requestedId: 'ENG-706' },
    )
    expect(created.ref.id).toBe('ENG-706')
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

test.each([...new Set(['0.10.0', '0.11.0', '0.12.0', '0.12.1', '0.13.0', AUTOBUILD_VERSION])])(
  'released %s ticket responses honor the supported client window',
  async (version) => {
    const { source, server } = harness()
    const existing = await source.create({ title: 'Existing', body: 'Body' })
    const schema = releasedTicketSchema
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
            [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: releasedClientProtocol(version),
            'content-type': 'application/json',
          },
          body: JSON.stringify({ context: { teamKey: 'ENG' }, input }),
        }),
      )
      if (classifyClient(version, supportedClientRange()) !== 'supported') {
        expect(response.status).toBe(409)
        expect((await response.json()).error).toContain('version mismatch')
        continue
      }
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

test('retired 0.10 clients are rejected before ticket source access, regardless of capability opt-ins', async () => {
  const { server, contexts } = harness()
  for (const capability of [undefined, '1']) {
    for (const [operation, input] of [
      ['get', { id: 'AUT-1' }],
      ['list-ready', {}],
      ['create', { draft: { title: 'Retired client', body: 'Body' } }],
    ] as const) {
      const headers = new Headers({
        authorization: `Bearer ${operator}`,
        [AUTOBUILD_VERSION_HEADER]: '0.10.0',
        [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
        'content-type': 'application/json',
      })
      if (capability !== undefined) {
        headers.set('x-autobuild-ticket-comments', capability)
        headers.set(TICKET_REVISIONS_HEADER, capability)
      }
      const response = await server.fetch(
        new Request(`https://tickets.example/tickets/${operation}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ context: { teamKey: 'ENG' }, input }),
        }),
      )
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({
        kind: 'conflict',
        error: expect.stringContaining("upgrade the project's Autobuild"),
      })
    }
  }
  expect(contexts).toEqual([])
})

test('revision opt-in distinguishes new and released clients reporting the same admitted identity', async () => {
  const { server } = harness()
  const headersSeen: Headers[] = []
  const source = new HostedTicketSource({
    url: 'https://tickets.example',
    token: operator,
    teamKey: 'ENG',
    fetchFn: async (input, init) => {
      const req = new Request(String(input), init)
      req.headers.set(AUTOBUILD_VERSION_HEADER, AUTOBUILD_VERSION)
      req.headers.set(REMOTE_STORE_PROTOCOL_VERSION_HEADER, REMOTE_STORE_PROTOCOL_VERSION)
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
    expect(headers.get(AUTOBUILD_VERSION_HEADER)).toBe(AUTOBUILD_VERSION)
    expect(headers.get(REMOTE_STORE_PROTOCOL_VERSION_HEADER)).toBe(REMOTE_STORE_PROTOCOL_VERSION)
    expect(headers.get(TICKET_REVISIONS_HEADER)).toBe(TICKET_REVISIONS_CAPABILITY)
  }
  // Missing and unknown capabilities retain the strict released decoder shape.
  for (const capability of [undefined, 'unknown']) {
    const response = await server.fetch(
      new Request('https://tickets.example/tickets/get', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${operator}`,
          [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
          [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
          ...(capability ? { [TICKET_REVISIONS_HEADER]: capability } : {}),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ context: { teamKey: 'ENG' }, input: { id: created.ref.id } }),
      }),
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).not.toHaveProperty('revision')
    expect(releasedTicketSchema.parse(body).title).toBe('New client')
  }
})

test('comments require explicit capability independently of client version on every ticket route', async () => {
  const comments = [
    { body: '  first\r\n\r\n☃\n', createdAt: '2026-01-01T00:00:00.000Z', author: 'Ada' },
    { body: 'Attached asset: evidence/test.png\n', createdAt: '2026-01-02T00:00:00.000Z' },
  ]
  const ticket = {
    revision: 'fixture-revision',
    ref: { source: 'fake', id: 'AUT-1' },
    title: 'Comments',
    body: 'spec',
    resolved: false,
    labels: [],
    comments,
  }
  const backend = new FakeTicketSource()
  backend.get = async () => ticket
  backend.create = async () => ticket
  backend.listReady = async () => ({ tickets: [ticket], diagnostics: [] })
  const { server, source } = harness(backend)
  expect((await source.get('AUT-1'))?.comments).toEqual(comments)
  const { ticketWireSchema: published } = await import('./compatibility-fixtures/tickets-v0.12')
  for (const version of new Set(['0.10.0', '0.11.0', '0.12.0', '0.13.0', AUTOBUILD_VERSION])) {
    for (const [capability, revisionCapability] of [
      [undefined, undefined],
      ['', undefined],
      ['2', undefined],
      ['1', undefined],
      [undefined, '1'],
      ['1', '1'],
      ['1', 'unknown'],
    ]) {
      for (const [operation, input] of [
        ['get', { id: 'AUT-1' }],
        ['create', { draft: { title: 'Comments', body: 'spec' } }],
        ['list-ready', {}],
      ] as const) {
        const headers: Record<string, string> = {
          authorization: `Bearer ${operator}`,
          [AUTOBUILD_VERSION_HEADER]: version,
          [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: releasedClientProtocol(version),
          'content-type': 'application/json',
        }
        if (capability !== undefined) headers['x-autobuild-ticket-comments'] = capability
        if (revisionCapability !== undefined) headers[TICKET_REVISIONS_HEADER] = revisionCapability
        const response = await server.fetch(
          new Request(`https://tickets.example/tickets/${operation}`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ context: { teamKey: 'ENG' }, input }),
          }),
        )
        if (classifyClient(version, supportedClientRange()) !== 'supported') {
          expect(response.status).toBe(409)
          expect((await response.json()).error).toContain('version mismatch')
          continue
        }
        expect(response.status).toBe(operation === 'create' ? 201 : 200)
        const result = await response.json()
        const value = operation === 'list-ready' ? result.tickets[0] : result
        expect(value.comments).toEqual(capability === '1' ? comments : undefined)
        expect(value.revision).toBe(revisionCapability === '1' ? 'fixture-revision' : undefined)
        expect(value.resolved).toBe(false)
        if (capability !== '1' && revisionCapability !== '1') {
          expect(published.safeParse(value).success).toBe(true)
        }
      }
    }
  }
})

test('hosted state transport preserves metadata and parses strict create envelopes', async () => {
  const backend = Object.assign(new FakeTicketSource(), {
    listStates: async () => [
      { name: 'triage', tickets: 0 },
      { name: 'icebox', tickets: 2, about: 'Deferred' },
    ],
    addState: async (name: string, opts: { about?: string } = {}) => ({
      state: { name, tickets: 0, ...opts },
      created: true,
    }),
  })
  const { source, server } = harness(backend)
  expect(await source.listStates()).toEqual(await backend.listStates())
  expect(await source.addState('later', { about: 'Waiting' })).toEqual({
    state: { name: 'later', tickets: 0, about: 'Waiting' },
    created: true,
  })
  const malformed = await server.fetch(
    new Request('https://tickets.example/tickets/add-state', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${operator}`,
        'content-type': 'application/json',
        [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
        [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
      },
      body: JSON.stringify({
        context: { teamKey: 'ENG' },
        input: { name: 'later', surprise: true },
      }),
    }),
  )
  expect(malformed.status).toBe(400)
})

test('runner and phase grants can discover states but cannot create them', async () => {
  for (const kind of ['runner', 'phase'] as const) {
    let mutations = 0
    const grant = {
      id: kind,
      repo: 'https://github.com/acme/grants',
      execution: 'execution',
      kind,
      parent: null,
      expiresAt: '2099-01-01T00:00:00Z',
    }
    const backend = Object.assign(new FakeTicketSource(), {
      listStates: async () => [{ name: 'triage', tickets: 0 }],
      addState: async () => {
        mutations++
        return { state: { name: 'later', tickets: 0 }, created: true }
      },
    })
    const server = createTicketServer({
      secret,
      clock: () => now,
      sourceFor: () => backend,
      grants: {
        authenticate: async () => grant,
        issue: async () => {
          throw new Error('unused')
        },
        revoke: async () => {},
        renew: async () => {},
      },
    })
    const source = new HostedTicketSource({
      url: 'https://tickets.example',
      token: 'abt_restricted',
      teamKey: 'ENG',
      repo: grant.repo,
      fetchFn: (input, init) => server.fetch(new Request(input, init)),
    })
    expect(await source.listStates()).toEqual([{ name: 'triage', tickets: 0 }])
    await expect(source.addState('later')).rejects.toThrow('ticket grant cannot perform')
    expect(mutations).toBe(0)
  }
})

test('tree, revision and comment response capabilities are independent', async () => {
  const { source, server } = harness()
  const parent = await source.create({ title: 'Parent', body: 'Body', kind: 'node' })
  const child = await source.create({
    title: 'Child',
    body: 'Body',
    kind: 'node',
    target: parent.ref.id,
  })
  for (let mask = 0; mask < 8; mask++) {
    const response = await server.fetch(
      new Request('https://tickets.example/tickets/get', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${operator}`,
          'content-type': 'application/json',
          [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
          [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
          ...(mask & 1 ? { 'x-autobuild-ticket-tree': '1' } : {}),
          ...(mask & 2 ? { 'x-autobuild-ticket-revisions': '1' } : {}),
          ...(mask & 4 ? { 'x-autobuild-ticket-comments': '1' } : {}),
        },
        body: JSON.stringify({ context: { teamKey: 'ENG' }, input: { id: child.ref.id } }),
      }),
    )
    expect(response.status).toBe(200)
    const value = (await response.json()) as Record<string, unknown>
    expect('kind' in value).toBe(!!(mask & 1))
    expect('target' in value).toBe(!!(mask & 1))
    expect('revision' in value).toBe(!!(mask & 2))
    if (mask & 1) expect(value).toMatchObject({ kind: 'node', target: parent.ref.id })
  }
})
