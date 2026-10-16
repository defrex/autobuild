import { describe, expect, test } from 'bun:test'
import { mintToken } from '@defrex/autobuild/remote-store'
import {
  AUTOBUILD_VERSION,
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
} from '@defrex/autobuild/remote-store'
import { describeTicketSourceContract } from '@defrex/autobuild/plugin-sdk'
import { FakeTicketSource } from '@defrex/autobuild/plugin-sdk'
import { HostedTicketSource } from '@defrex/autobuild/hosted-tickets'
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

test('comments require explicit capability independently of client version on every ticket route', async () => {
  const comments = [
    { body: '  first\r\n\r\n☃\n', createdAt: '2026-01-01T00:00:00.000Z', author: 'Ada' },
    { body: 'Attached asset: evidence/test.png\n', createdAt: '2026-01-02T00:00:00.000Z' },
  ]
  const ticket = {
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
  const { ticketWireSchema: old } = await import('./compatibility-fixtures/tickets-v0.9')
  for (const version of ['0.10.0', '0.11.0', '0.12.0']) {
    for (const capability of [undefined, '', '2', '1']) {
      for (const [operation, input] of [
        ['get', { id: 'AUT-1' }],
        ['create', { draft: { title: 'Comments', body: 'spec' } }],
        ['list-ready', {}],
      ] as const) {
        const headers: Record<string, string> = {
          authorization: `Bearer ${operator}`,
          [AUTOBUILD_VERSION_HEADER]: version,
          [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
          'content-type': 'application/json',
        }
        if (capability !== undefined) headers['x-autobuild-ticket-comments'] = capability
        const response = await server.fetch(
          new Request(`https://tickets.example/tickets/${operation}`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ context: { teamKey: 'ENG' }, input }),
          }),
        )
        expect(response.status).toBe(operation === 'create' ? 201 : 200)
        const result = await response.json()
        const value = operation === 'list-ready' ? result.tickets[0] : result
        expect(value.comments).toEqual(capability === '1' ? comments : undefined)
        expect(value.resolved).toBe(version === '0.10.0' ? undefined : false)
        if (capability !== '1') {
          expect((version === '0.10.0' ? old : published).safeParse(value).success).toBe(true)
        }
      }
    }
  }
})
