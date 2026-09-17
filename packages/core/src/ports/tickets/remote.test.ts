/**
 * Client-only unit coverage for HostedTicketSource: the client is driven
 * against a recording fake fetch whose canned responses are parsed through
 * the wire schemas in remote-protocol.ts — the same vocabulary the hosted
 * ticket server composes (the linear.test.ts fake-fetch pattern). The other
 * half of the seam — client → real HTTP → ticket server over a real socket —
 * runs in packages/hosted-store-service/src/ticket-server.seam.test.ts; no
 * server fixture is created here.
 *
 * Pinned as core surface: every operation POSTs `{context, input}` to
 * `{base}/tickets/{operation}` with the bearer token and both version
 * headers, the response projection onto the hosted source identity, and the
 * error rehydration (401/403 → AuthError, protocol bodies → the server's
 * message, non-protocol bodies → the status-line fallback).
 */
import { describe, expect, test } from 'bun:test'
import { AuthError } from '../../store/remote/client'
import { errorBodySchema } from '../../store/remote/protocol'
import {
  AUTOBUILD_VERSION,
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
} from '../../store/remote/version'
import {
  claimWireSchema,
  dependencyStatesWireSchema,
  successWireSchema,
  ticketListingWireSchema,
  ticketWireSchema,
} from './remote-protocol'
import { HostedTicketSource, type HostedTicketFetch } from './remote'

// ── The fake fetch ───────────────────────────────────────────────────────────

interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: { context: unknown; input: unknown }
}

interface CannedResponse {
  status?: number
  body?: unknown
  /** Simulate a non-JSON response (a gateway error page): `json()` rejects. */
  jsonThrows?: boolean
}

/** Canned-exchange fetch: dequeues one response per request, records each. */
function fakeTickets(responses: CannedResponse[]) {
  const calls: RecordedCall[] = []
  const fetchFn: HostedTicketFetch = async (input, init) => {
    calls.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(init?.body as string) as { context: unknown; input: unknown },
    })
    const next = responses.shift()
    if (!next) throw new Error('fakeTickets: no canned response left')
    const status = next.status ?? 200
    return {
      ok: status < 400,
      status,
      json: async () => {
        if (next.jsonThrows) throw new Error('invalid json')
        return next.body
      },
    } as Response
  }
  return { fetchFn, calls }
}

// ── Canned responses, built with the protocol's wire schemas ─────────────────

const CONTEXT = { teamKey: 'ENG', claimedState: 'Doing', createState: 'Triage' }

function wireError(error: string, kind: 'auth' | 'validation' | 'internal' | 'conflict') {
  return errorBodySchema.parse({ error, kind })
}

/** A ticket as the *backend source* shapes it — the client must project the
 * ref onto its own 'hosted' identity, so the canned ref says 'linear'. */
const TICKET = ticketWireSchema.parse({
  ref: {
    source: 'linear',
    id: 'ENG-42',
    url: 'https://linear.app/acme/issue/ENG-42',
    title: 'Rate-limit auth',
  },
  creationKey: 'uuid-42',
  title: 'Rate-limit auth',
  body: '# Spec\n\nToken bucket on /auth/*.',
  state: 'Ready',
  labels: ['autobuild'],
  blockedBy: ['ENG-8'],
})

const OK = successWireSchema.parse({ ok: true })

function makeSource(
  responses: CannedResponse[],
  opts: { url?: string } = {},
): { source: HostedTicketSource; calls: RecordedCall[] } {
  const { fetchFn, calls } = fakeTickets(responses)
  const source = new HostedTicketSource({
    url: opts.url ?? 'https://tickets.example',
    token: 't0k',
    ...CONTEXT,
    fetchFn,
  })
  return { source, calls }
}

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Error) return error
    throw new Error(`expected an Error rejection, received ${String(error)}`)
  }
  throw new Error('expected promise to reject')
}

describe('HostedTicketSource (client half)', () => {
  test('every operation POSTs {context, input} to {base}/tickets/{operation}', async () => {
    const { source, calls } = makeSource([
      { body: ticketListingWireSchema.parse({ tickets: [], diagnostics: [] }) },
      { body: null }, // get: the ticket server answers JSON null for unknown ids
      { body: claimWireSchema.parse({ claimed: true }) },
      { body: OK }, // comment
      { body: OK }, // transition
      { body: TICKET }, // create
      { body: OK }, // update
      { body: OK }, // add-blocker
      { body: OK }, // remove-blocker
      { body: dependencyStatesWireSchema.parse([]) },
    ])

    await source.listReady({ labels: ['autobuild'], state: 'Ready' })
    expect(await source.get('ENG-42')).toBeNull()
    expect(await source.claim('ENG-42')).toBe(true)
    await source.comment('ENG-42', 'claimed')
    await source.transition('ENG-42', 'Done')
    await source.create({ title: 'X', body: 'y' })
    await source.update('ENG-42', { title: 'Renamed' })
    await source.addBlocker('ENG-42', 'ENG-8')
    await source.removeBlocker('ENG-42', 'ENG-8')
    await source.dependencyStates(['ENG-42'])

    expect(calls.map((c) => c.url)).toEqual([
      'https://tickets.example/tickets/list-ready',
      'https://tickets.example/tickets/get',
      'https://tickets.example/tickets/claim',
      'https://tickets.example/tickets/comment',
      'https://tickets.example/tickets/transition',
      'https://tickets.example/tickets/create',
      'https://tickets.example/tickets/update',
      'https://tickets.example/tickets/add-blocker',
      'https://tickets.example/tickets/remove-blocker',
      'https://tickets.example/tickets/dependency-states',
    ])
    for (const call of calls) {
      expect(call.method).toBe('POST')
      expect(call.headers).toEqual({
        'content-type': 'application/json',
        authorization: 'Bearer t0k',
        [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
        [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
      })
      expect(call.body.context).toEqual(CONTEXT)
    }
    expect(calls.map((c) => c.body.input)).toEqual([
      { labels: ['autobuild'], state: 'Ready' },
      { id: 'ENG-42' },
      { id: 'ENG-42' },
      { id: 'ENG-42', body: 'claimed' },
      { id: 'ENG-42', state: 'Done' },
      { draft: { title: 'X', body: 'y' }, options: {} },
      { id: 'ENG-42', patch: { title: 'Renamed' } },
      { id: 'ENG-42', blockerId: 'ENG-8' },
      { id: 'ENG-42', blockerId: 'ENG-8' },
      { ids: ['ENG-42'] },
    ])
  })

  test('a trailing slash on the base URL is normalized away', async () => {
    const { source, calls } = makeSource([{ body: OK }], { url: 'https://tickets.example/' })
    await source.transition('ENG-42', 'Done')
    expect(calls[0]?.url).toBe('https://tickets.example/tickets/transition')
  })

  test('create forwards per-create state and idempotency options', async () => {
    const { source, calls } = makeSource([{ body: TICKET }])
    await source.create(
      { title: 'X', body: 'y', labels: ['ready'], blockedBy: ['ENG-8'] },
      { state: 'Triage', idempotencyKey: 'creation-1' },
    )
    expect(calls[0]?.body.input).toEqual({
      draft: { title: 'X', body: 'y', labels: ['ready'], blockedBy: ['ENG-8'] },
      options: { state: 'Triage', idempotencyKey: 'creation-1' },
    })
  })

  test('listReady/get/create project the ticket ref onto the hosted source', async () => {
    const { source } = makeSource([
      {
        body: ticketListingWireSchema.parse({ tickets: [TICKET], diagnostics: ['dropped ENG-9'] }),
      },
      { body: TICKET },
      { body: TICKET },
    ])
    const listing = await source.listReady({})
    expect(listing.tickets.every((ticket) => ticket.ref.source === 'hosted')).toBe(true)
    expect(listing.diagnostics).toEqual(['dropped ENG-9'])
    expect((await source.get('ENG-42'))?.ref.source).toBe('hosted')
    expect(
      (await source.create({ title: 'X', body: 'y' }, { idempotencyKey: 'k1' })).ref.source,
    ).toBe('hosted')
  })

  test('the rest of the ticket shape survives the projection unchanged', async () => {
    const { source } = makeSource([{ body: TICKET }])
    expect(await source.get('ENG-42')).toEqual({
      ref: {
        source: 'hosted',
        id: 'ENG-42',
        url: 'https://linear.app/acme/issue/ENG-42',
        title: 'Rate-limit auth',
      },
      creationKey: 'uuid-42',
      title: 'Rate-limit auth',
      body: '# Spec\n\nToken bucket on /auth/*.',
      state: 'Ready',
      labels: ['autobuild'],
      blockedBy: ['ENG-8'],
    })
  })

  test('claim reads its boolean from the claim response', async () => {
    const won = makeSource([{ body: claimWireSchema.parse({ claimed: true }) }])
    expect(await won.source.claim('ENG-42')).toBe(true)
    const lost = makeSource([{ body: claimWireSchema.parse({ claimed: false }) }])
    expect(await lost.source.claim('ENG-42')).toBe(false)
  })

  test('dependencyStates parses the wire list unchanged', async () => {
    const { source } = makeSource([
      {
        body: dependencyStatesWireSchema.parse([
          { id: 'ENG-8', exists: true, resolved: true, blockedBy: [] },
          { id: 'ENG-9', exists: false, resolved: false, blockedBy: ['ENG-8'] },
        ]),
      },
    ])
    expect(await source.dependencyStates(['ENG-8', 'ENG-9'])).toEqual([
      { id: 'ENG-8', exists: true, resolved: true, blockedBy: [] },
      { id: 'ENG-9', exists: false, resolved: false, blockedBy: ['ENG-8'] },
    ])
  })

  // ── Error rehydration ────────────────────────────────────────────────────

  test('401 and 403 surface as AuthError carrying the server message', async () => {
    const denied = makeSource([{ status: 401, body: wireError('missing bearer token', 'auth') }])
    const deniedErr = await rejectionOf(denied.source.get('ENG-42'))
    expect(deniedErr).toBeInstanceOf(AuthError)
    expect(deniedErr.message).toBe('missing bearer token')

    const forbidden = makeSource([
      {
        status: 403,
        body: wireError('token scoped to build "b" may not access ticket operations', 'auth'),
      },
    ])
    const forbiddenErr = await rejectionOf(forbidden.source.listReady({}))
    expect(forbiddenErr).toBeInstanceOf(AuthError)
    expect(forbiddenErr.message).toBe('token scoped to build "b" may not access ticket operations')
  })

  test('other protocol error bodies reject with the server message', async () => {
    const { source } = makeSource([
      { status: 500, body: wireError('blob provider offline', 'internal') },
    ])
    const err = await rejectionOf(source.get('ENG-42'))
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(AuthError)
    expect(err.message).toBe('blob provider offline')
  })

  test('a non-protocol body falls back to the status line', async () => {
    const { source } = makeSource([{ status: 502, body: '<html>bad gateway</html>' }])
    expect((await rejectionOf(source.claim('ENG-42'))).message).toBe('ticket service responded 502')
  })

  test('a non-JSON gateway response also falls back to the status line', async () => {
    const { source } = makeSource([{ status: 504, jsonThrows: true }])
    expect((await rejectionOf(source.transition('ENG-42', 'Done'))).message).toBe(
      'ticket service responded 504',
    )
  })
})
