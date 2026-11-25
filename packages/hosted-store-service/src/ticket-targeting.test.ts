/** The bounded hosted ticket reads across the real client, ticket server and
 * Postgres ticket store: targeted listing (`list-targeting`), with its
 * negotiation against current and older services and its completeness parity,
 * and native paging (`list-page`) against the fallback an older service
 * leaves. In memory: the server is called through `fetch`, and SQL is a
 * recording fake. */
import { expect, test } from 'bun:test'
import type { SQL } from 'bun'
import { mintToken } from '@defrex/autobuild/remote-store'
import { FakeTicketSource, type TicketSource } from '@defrex/autobuild/plugin-sdk'
import {
  HostedTicketSource,
  TICKET_PAGING_HEADER,
  TICKET_SEARCH_HEADER,
  TicketSearchUnsupported,
  searchTickets,
  TICKET_TARGETING_HEADER,
  TICKET_TARGETING_PROBE_NODE,
} from '@defrex/autobuild/hosted-tickets'
import {
  integrationNodePass,
  targetedCompletenessParity,
  ticketPageReadBudget,
  ticketSearchReadBudget,
  ticketSearchRows,
  ticketTargetingReadBudget,
  type TicketSearchRow,
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

/** `population` Ready rows with fixed-width ids and titles, so a window's bytes
 * do not depend on the population, filed one second apart. */
function pageRows(population: number) {
  return Array.from({ length: population }, (_, i) => {
    const n = String(i + 1).padStart(6, '0')
    return {
      id: `storage-${n}`,
      readable_id: `ENG-${n}`,
      revision: '1',
      creation_key: null,
      kind: 'work',
      title: `ticket ${n}`,
      body: 'Body',
      state: 'Ready',
      labels: [],
      issue_links: '[]',
      priority: 'normal',
      created_at: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
      target_id: null,
      target_readable_id: null,
      blockers: [],
    }
  })
}

/** A PostgresTicketSource whose SQL answers the paged listing: the state
 * lookup, the count and the window statement (and the targeting probe that
 * settles negotiation). The unbounded listing statement answers only in
 * `fallback` mode; in `native` mode it fails. */
function pagingPostgres(rows: ReturnType<typeof pageRows>, mode: 'native' | 'fallback') {
  let statements = 0
  const states = ['Triage', 'Ready', 'Doing', 'Done', 'Rejected']
  const q = Object.assign(
    async (parts: TemplateStringsArray, ...values: unknown[]) => {
      statements++
      const query = parts.join('?')
      if (query.includes('FROM ab_ticket_states s LEFT JOIN'))
        return states.map((name) => ({ name, about: null, tickets: 0 }))
      if (query.includes('SELECT name FROM ab_ticket_states'))
        return [...(values[1] as string[]), ...(values[2] as string[])].map((name) => ({ name }))
      if (query.includes('target_id = (SELECT n.id')) return []
      expect(values[0]).toBe('budget')
      const matching = rows.filter((row) => row.state === values[1])
      if (query.includes('count(*)::text AS total')) return [{ total: String(matching.length) }]
      if (query.includes('LIMIT')) {
        const [limit, offset] = values.slice(-2) as [number, number]
        const ordered = query.includes('created_at DESC')
          ? [...matching].reverse()
          : [...matching].sort(
              (a, b) => Number(b.priority === 'urgent') - Number(a.priority === 'urgent'),
            )
        return ordered.slice(offset, offset + limit)
      }
      if (mode === 'fallback' && query.includes("ORDER BY (priority = 'urgent') DESC")) {
        return [...matching].sort(
          (a, b) => Number(b.priority === 'urgent') - Number(a.priority === 'urgent'),
        )
      }
      throw new Error(`unexpected ticket statement: ${query}`)
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

/** A service predating `list-page`: no paging echo and no such route. */
function predatingPaging(fetch: Fetch): Fetch {
  return async (req) => {
    if (new URL(req.url).pathname === '/tickets/list-page')
      return Response.json({ error: 'no route', kind: 'not-found' }, { status: 404 })
    const response = await fetch(req)
    const headers = new Headers(response.headers)
    headers.delete(TICKET_PAGING_HEADER)
    return new Response(response.body, { status: response.status, headers })
  }
}

/** A PostgresTicketSource whose SQL answers only the one search statement
 * (and the targeting probe that settles negotiation), applying in JS what the
 * statement applies: the seed's name union, exact-then-unique folded state
 * resolution, terms over title or body, labels, the keyset and the limit. A
 * separate state lookup, a seed write, a count or a listing fails. */
function searchPostgres(
  tickets: TicketSearchRow[],
  options: { states?: string[]; failure?: Error } = {},
) {
  let statements = 0
  const existing = options.states ?? ['Triage', 'Ready', 'Doing', 'Done', 'Rejected']
  const lowered = new Map<string, string>()
  const lower = (value: string) => {
    let folded = lowered.get(value)
    if (folded === undefined) lowered.set(value, (folded = value.toLowerCase()))
    return folded
  }
  const q = Object.assign(
    async (parts: TemplateStringsArray, ...values: unknown[]) => {
      statements++
      const query = parts.join('?')
      if (query.includes('target_id = (SELECT n.id')) return []
      if (!query.includes('strpos(lower(ab_tickets.title COLLATE "und-x-icu")'))
        throw new Error(`unexpected ticket statement: ${query}`)
      if (options.failure) throw options.failure
      expect(values[0]).toBe('budget')
      const [configured, roles, state] = values.slice(1, 4) as [string[], string[], string | null]
      const [labels, after, , terms, limit] = values.slice(-5) as [
        string[],
        string | null,
        unknown,
        string[],
        number,
      ]
      const fold = (name: string) => name.trim().toLowerCase()
      const names = [
        ...new Set([
          ...existing,
          ...configured,
          ...roles.filter((role) => !existing.some((name) => fold(name) === fold(role))),
        ]),
      ]
      const folded = names.filter((name) => name.toLowerCase() === state?.toLowerCase())
      const resolved =
        state === null
          ? null
          : names.includes(state)
            ? state
            : folded.length === 1
              ? folded[0]!
              : undefined
      const empty = { readable_id: null, title: null, hit_state: null, labels: null }
      if (resolved === undefined) return [{ ok: false, state_names: names, ...empty }]
      const hits = []
      for (let i = tickets.length - 1; i >= 0 && hits.length < limit; i--) {
        const ticket = tickets[i]!
        if (after !== null && ticket.number >= Number(after)) continue
        if (resolved !== null && ticket.state !== resolved) continue
        if (!labels.every((label) => ticket.labels.includes(label))) continue
        if (
          !terms.every(
            (term) => lower(ticket.title).includes(term) || lower(ticket.body).includes(term),
          )
        )
          continue
        hits.push({
          ok: true,
          state_names: null,
          readable_id: ticket.id,
          title: ticket.title,
          hit_state: ticket.state,
          labels: ticket.labels,
          kind: 'work',
          search_number: String(ticket.number),
          target_readable_id: null,
        })
      }
      return hits.length > 0 ? hits : [{ ok: true, state_names: null, ...empty }]
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

/** A service predating `search`: no search echo and no such route. */
function predatingSearch(fetch: Fetch): Fetch {
  return async (req) => {
    if (new URL(req.url).pathname === '/tickets/search')
      return Response.json({ error: 'no route', kind: 'not-found' }, { status: 404 })
    const response = await fetch(req)
    const headers = new Headers(response.headers)
    headers.delete(TICKET_SEARCH_HEADER)
    return new Response(response.body, { status: response.status, headers })
  }
}

test('a search page through client, service and Postgres costs one request and one bounded query at 100 or 100,000 tickets', async () => {
  await ticketSearchReadBudget(async (_population, mode, tickets) => {
    const postgres = searchPostgres(tickets)
    const service = server(postgres.source).fetch
    const { source, requests } = client(mode === 'native' ? service : predatingSearch(service))
    // Production settles search on the construction-time response.
    expect(await source.negotiateTargeting()).toBe(true)
    return {
      source,
      reset: () => {
        postgres.reset()
        requests.length = 0
      },
      statements: postgres.statements,
      requests: () => [...requests],
    }
  })
})

test('a server without the ICU root collation refuses search typed, after one request and one statement', async () => {
  const failure = Object.assign(
    new Error('collation "und-x-icu" for encoding "UTF8" does not exist'),
    { errno: '42704' },
  )
  const postgres = searchPostgres(ticketSearchRows(10), { failure })
  const { source, requests } = client(server(postgres.source).fetch)
  await source.negotiateTargeting()
  postgres.reset()
  requests.length = 0
  const refusal = await searchTickets(source, { text: 'needle', limit: 5 }).catch((error) => error)
  expect(refusal).toBeInstanceOf(TicketSearchUnsupported)
  expect(refusal.source).toBe('hosted')
  expect(requests.map((request) => request.operation)).toEqual(['search'])
  expect(postgres.statements()).toBe(1)
})

test('a paged listing through client, service and Postgres reads only its window at any project size', async () => {
  await ticketPageReadBudget(async (population, mode) => {
    const postgres = pagingPostgres(pageRows(population), mode)
    const service = server(postgres.source).fetch
    const { source, requests } = client(mode === 'native' ? service : predatingPaging(service))
    // Production settles paging on the construction-time response.
    expect(await source.negotiateTargeting()).toBe(true)
    return {
      source,
      reset: () => {
        postgres.reset()
        requests.length = 0
      },
      statements: postgres.statements,
      requests: () => [...requests],
    }
  })
})

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
