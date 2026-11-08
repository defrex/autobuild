/** Targeted ticket listing (`list-targeting`) across the real client, ticket
 * server and Postgres ticket store: its bounded cost, its negotiation against
 * current and older services, and its completeness parity. In memory: the
 * server is called through `fetch`, and SQL is a recording fake. */
import { expect, test } from 'bun:test'
import type { SQL } from 'bun'
import { mintToken } from '@defrex/autobuild/remote-store'
import { FakeTicketSource, type TicketSource } from '@defrex/autobuild/plugin-sdk'
import {
  HostedTicketSource,
  TICKET_TARGETING_HEADER,
  TICKET_TARGETING_PROBE_NODE,
} from '@defrex/autobuild/hosted-tickets'
import {
  integrationNodePass,
  targetedCompletenessParity,
  ticketTargetingReadBudget,
} from '@defrex/autobuild/testing'
import { PostgresTicketSource } from '@defrex/autobuild-postgres-store'
import { createTicketServer } from './ticket-server'

const secret = 'ticket-targeting-secret'
const now = new Date('2026-01-01T00:00:00.000Z')
const operator = mintToken(secret, {
  version: 1,
  ownerAdmin: { user: 'owner:fixture' },
  exp: now.getTime() + 60_000,
})

function withTargeting(
  fake: FakeTicketSource,
): FakeTicketSource & Required<Pick<TicketSource, 'listTargeting'>> {
  return Object.assign(fake, {
    listTargeting: async (nodeId: string) => {
      const all = await fake.listAll()
      return { ...all, tickets: all.tickets.filter((ticket) => ticket.target === nodeId) }
    },
  })
}

type Fetch = (req: Request) => Promise<Response>

/** A client over `fetch`, recording each operation and its response size. */
function client(fetch: Fetch, options: { token?: string; repo?: string } = {}) {
  const requests: { operation: string; bytes: number }[] = []
  const source = new HostedTicketSource({
    url: 'https://tickets.example',
    token: options.token ?? operator,
    teamKey: 'ENG',
    ...(options.repo !== undefined ? { repo: options.repo } : {}),
    fetchFn: async (input, init) => {
      const request = new Request(input instanceof Request ? input : input.toString(), init)
      const response = await fetch(request)
      requests.push({
        operation: new URL(request.url).pathname.slice('/tickets/'.length),
        bytes: (await response.clone().text()).length,
      })
      return response
    },
  })
  return { source, requests }
}

function server(backend: TicketSource) {
  return createTicketServer({ secret, clock: () => now, sourceFor: () => backend })
}

const lifecycle = { triage: 'Triage', ready: 'Ready', doing: 'Doing', done: 'Done' }

/** Postgres rows for a node (`ENG-1`), its three children, another node and
 * `unrelated` other tickets, half of them targeting that other node. */
function ticketRows(unrelated: number) {
  const row = (n: number, state: string, target: number | null, kind = 'work') => ({
    id: `storage-${n}`,
    readable_id: `ENG-${n}`,
    revision: '1',
    creation_key: null,
    kind,
    title: `ticket ${n}`,
    body: 'Body',
    state,
    labels: [],
    issue_links: '[]',
    priority: 'normal',
    target_id: target === null ? null : `storage-${target}`,
    target_readable_id: target === null ? null : `ENG-${target}`,
    blockers: [],
  })
  return [
    row(1, 'Ready', null, 'node'),
    row(2, 'Ready', 1),
    row(3, 'Done', 1),
    row(4, 'Rejected', 1),
    row(5, 'Ready', null, 'node'),
    ...Array.from({ length: unrelated }, (_, i) => row(100 + i, 'Ready', i % 2 ? 5 : null)),
  ]
}

/** A PostgresTicketSource whose SQL answers only the indexed targeted
 * statement; any other listing statement, a seed probe included, fails. */
function recordingPostgres(rows: ReturnType<typeof ticketRows>) {
  let statements = 0
  const q = Object.assign(
    async (parts: TemplateStringsArray, ...values: unknown[]) => {
      statements++
      const query = parts.join('?')
      if (!query.includes('target_id = (SELECT n.id'))
        throw new Error(`unexpected ticket statement: ${query}`)
      expect(query).toContain('AS target_readable_id')
      expect(query).toContain('AS blockers')
      const [repo, , lowered, exact] = values as string[]
      expect(repo).toBe('budget')
      const node = rows.find(
        (row) =>
          row.readable_id.toLowerCase() === lowered!.toLowerCase() && row.readable_id === exact,
      )
      return node === undefined ? [] : rows.filter((row) => row.target_id === node.id)
    },
    { array: (values: unknown[]) => values },
  )
  const runner = {
    run: (_pool: unknown, body: (exec: typeof q) => Promise<unknown>) => body(q),
    tx: (_pool: unknown, body: (exec: typeof q) => Promise<unknown>) => body(q),
  } as unknown as ConstructorParameters<typeof PostgresTicketSource>[3]
  const source = new PostgresTicketSource(
    {} as SQL,
    { repo: 'budget', teamKey: 'ENG', lifecycle, rejectedState: 'Rejected' },
    lifecycle,
    runner,
  )
  return { source, statements: () => statements, reset: () => (statements = 0) }
}

test('a targeted read through client, service and Postgres has a fixed budget at any project size', async () => {
  await ticketTargetingReadBudget(async (unrelated) => {
    const postgres = recordingPostgres(ticketRows(unrelated))
    const { source, requests } = client(server(postgres.source).fetch)
    // The negotiation probe: one request, one indexed statement that misses.
    expect(await source.negotiateTargeting()).toBe(true)
    expect(requests.map((request) => request.operation)).toEqual(['list-targeting'])
    expect(postgres.statements()).toBe(1)
    return {
      source,
      node: 'ENG-1',
      open: 'ENG-2',
      children: ['ENG-2', 'ENG-3', 'ENG-4'],
      rejectedState: 'Rejected',
      reset: () => {
        postgres.reset()
        requests.length = 0
      },
      statements: postgres.statements,
      requests: () => [...requests],
    }
  })
})

test('the Postgres targeted read matches the node id exactly and misses the probe id', async () => {
  const postgres = recordingPostgres(ticketRows(3))
  expect((await postgres.source.listTargeting('eng-1')).tickets).toEqual([])
  expect((await postgres.source.listTargeting(TICKET_TARGETING_PROBE_NODE)).tickets).toEqual([])
  expect(postgres.statements()).toBe(2)
})

test('an older service is negotiated before any pass and observed through listAll', async () => {
  const backend = new FakeTicketSource([], { doneState: 'Done' })
  const current = server(backend)
  // Emulates a service predating the operation: no echo, no route.
  const older: Fetch = async (req) => {
    if (new URL(req.url).pathname === '/tickets/list-targeting')
      return Response.json({ error: 'no route', kind: 'not-found' }, { status: 404 })
    const response = await current.fetch(req)
    const headers = new Headers(response.headers)
    headers.delete(TICKET_TARGETING_HEADER)
    return new Response(response.body, { status: response.status, headers })
  }

  const old = client(older)
  expect(old.source.listTargeting).toBeUndefined()
  expect(await old.source.negotiateTargeting()).toBe(false)
  expect(old.source.listTargeting).toBeUndefined()
  old.requests.length = 0
  const exhaustive = await integrationNodePass(old.source, 'ENG-1')
  expect(exhaustive.path).toBe('exhaustive')
  expect(old.requests.map((request) => request.operation)).toEqual(['list-ready'])

  const fresh = client(current.fetch)
  expect(fresh.source.listTargeting).toBeUndefined()
  expect(await fresh.source.negotiateTargeting()).toBe(true)
  fresh.requests.length = 0
  const targeted = await integrationNodePass(fresh.source, 'ENG-1')
  expect(targeted.path).toBe('targeted')
  expect(fresh.requests).toEqual([])
  await targeted.observe()
  expect(fresh.requests.map((request) => request.operation)).toEqual(['list-targeting'])
})

test('a failed targeted read fails closed with no listing fallback, and the next pass retries', async () => {
  const backend = withTargeting(new FakeTicketSource([], { doneState: 'Done' }))
  const targeted = backend.listTargeting
  let failures = 0
  backend.listTargeting = async (nodeId: string) => {
    if (failures-- > 0) throw new Error('database unavailable')
    return targeted(nodeId)
  }
  const { source, requests } = client(server(backend).fetch)
  await source.negotiateTargeting()
  const node = await source.create({ title: 'node', body: 'node', kind: 'node' })
  const child = await source.create({ title: 'child', body: 'child', target: node.ref.id })
  requests.length = 0
  failures = 1
  const failed = await (await integrationNodePass(source, node.ref.id)).observe()
  expect(failed.diagnostics).toEqual(['database unavailable'])
  expect(requests.map((request) => request.operation)).toEqual(['list-targeting'])
  expect(source.listTargeting).toBeDefined()
  const retried = await (await integrationNodePass(source, node.ref.id)).observe()
  expect(retried.diagnostics).toEqual([])
  expect(retried.openChildren).toEqual([child.ref.id])
  expect(requests.map((request) => request.operation)).toEqual(['list-targeting', 'list-targeting'])
})

test('targeted completeness matches the exhaustive listing through the hosted service', async () => {
  const backend = withTargeting(new FakeTicketSource([], { doneState: 'Done' }))
  const { source } = client(server(backend).fetch)
  expect(await source.negotiateTargeting()).toBe(true)
  await targetedCompletenessParity(source, { completed: 'Done', rejectedState: 'Rejected' })
})

test('runner and phase grants may list targeting tickets but gain no write', async () => {
  for (const kind of ['runner', 'phase'] as const) {
    const grant = {
      id: kind,
      repo: 'https://github.com/acme/grants',
      execution: 'execution',
      kind,
      parent: null,
      expiresAt: '2099-01-01T00:00:00Z',
    }
    const backend = withTargeting(new FakeTicketSource([], { doneState: 'Done' }))
    const restricted = createTicketServer({
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
    const { source } = client(restricted.fetch, { token: 'abt_restricted', repo: grant.repo })
    expect(await source.negotiateTargeting()).toBe(true)
    expect(await source.listTargeting!('ENG-1')).toEqual({ tickets: [], diagnostics: [] })
    await expect(source.update('ENG-1', { title: 'x' })).rejects.toThrow(
      'ticket grant cannot perform',
    )
    await expect(source.claim('ENG-1')).rejects.toThrow('ticket grant cannot perform')
  }
})
