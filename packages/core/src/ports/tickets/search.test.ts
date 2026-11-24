import { describe, expect, test } from 'bun:test'
import type { Ticket, TicketSearchQuery, TicketSource } from '../types'
import {
  matchesSearch,
  pageSearch,
  searchTickets,
  TicketSearchCursorInvalid,
  TicketSearchUnsupported,
} from './search'

function ticket(id: string, over: Partial<Omit<Ticket, 'ref'>> = {}): Ticket {
  return {
    revision: 'fixture',
    ref: { source: 'fake', id },
    title: over.title ?? `Ticket ${id}`,
    body: over.body ?? '',
    state: over.state ?? 'Ready',
    resolved: false,
    labels: over.labels ?? [],
    ...(over.kind !== undefined ? { kind: over.kind } : {}),
    ...(over.target !== undefined ? { target: over.target } : {}),
  }
}

const tickets = [
  ticket('t-1', { title: 'Rate limit the auth endpoint', labels: ['bug', 'auth'] }),
  ticket('t-2', { title: 'Auth docs', body: 'Mention the RATE limit.', state: 'Done' }),
  ticket('t-3', { title: 'Unrelated', body: 'rate only' }),
  ticket('t-4', { title: 'rate LIMIT auth node', kind: 'node', state: 'Done', labels: ['auth'] }),
]

function query(over: Partial<TicketSearchQuery> = {}): TicketSearchQuery {
  return { text: 'rate limit auth', limit: 10, ...over }
}

describe('ticket search matching', () => {
  test('every term must occur case-insensitively in the title or body', () => {
    expect(matchesSearch({ title: 'Rate limit', body: 'for AUTH' }, ['rate', 'auth'])).toBe(true)
    expect(matchesSearch({ title: 'Rate limit', body: '' }, ['rate', 'auth'])).toBe(false)
  })

  test('pages filter by state and every label, in listing order', () => {
    expect(pageSearch('fake', tickets, query()).tickets.map((hit) => hit.id)).toEqual([
      't-1',
      't-2',
      't-4',
    ])
    expect(pageSearch('fake', tickets, query({ state: 'Done' })).tickets.map((h) => h.id)).toEqual([
      't-2',
      't-4',
    ])
    expect(
      pageSearch('fake', tickets, query({ labels: ['auth', 'bug'] })).tickets.map((h) => h.id),
    ).toEqual(['t-1'])
    expect(pageSearch('fake', tickets, query({ text: '  RATE\t  ' })).tickets).toHaveLength(4)
  })

  test('cursors reach every match exactly once and the last page has none', () => {
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = pageSearch('fake', tickets, query({ limit: 2, ...(cursor ? { cursor } : {}) }))
      seen.push(...page.tickets.map((hit) => hit.id))
      cursor = page.cursor
    } while (cursor !== undefined)
    expect(seen).toEqual(['t-1', 't-2', 't-4'])
  })

  test('a malformed cursor is a typed refusal naming the source', () => {
    for (const cursor of ['-1', 'abc', '01', '1.5', '99999999999999999999']) {
      expect(() => pageSearch('file', tickets, query({ cursor }))).toThrow(
        TicketSearchCursorInvalid,
      )
    }
    try {
      pageSearch('file', tickets, query({ cursor: 'x' }))
    } catch (error) {
      expect((error as TicketSearchCursorInvalid).source).toBe('file')
    }
  })
})

describe('searchTickets', () => {
  test('a source without search refuses before any read', async () => {
    const mustNotRead = () => {
      throw new Error('must not list')
    }
    const source = {
      name: 'nosearch',
      listReady: mustNotRead,
      listAll: mustNotRead,
      listPage: mustNotRead,
      get: mustNotRead,
    } as unknown as TicketSource
    const refusal = await searchTickets(source, { text: 'auth' }).catch((error) => error)
    expect(refusal).toBeInstanceOf(TicketSearchUnsupported)
    expect(refusal.source).toBe('nosearch')
    expect(refusal.message).toContain('nosearch')
  })

  test('applies the default limit, validates input and normalizes hits', async () => {
    const seen: TicketSearchQuery[] = []
    const source = {
      name: 'stub',
      search: async (q: TicketSearchQuery) => {
        seen.push(q)
        return {
          tickets: [{ id: 'x', title: 'X', labels: [], kind: undefined, state: undefined }],
          diagnostics: [],
        }
      },
    } as unknown as TicketSource
    expect(await searchTickets(source, { text: 'x' })).toEqual({
      tickets: [{ id: 'x', title: 'X', labels: [], kind: 'work' }],
      diagnostics: [],
    })
    expect(seen).toEqual([{ text: 'x', limit: 20 }])
    for (const input of [{ text: '  ' }, { text: 'x', limit: 0 }, { text: 'x', limit: 101 }]) {
      await expect(searchTickets(source, input)).rejects.toThrow()
    }
  })
})
