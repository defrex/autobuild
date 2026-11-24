// Ticket search: the shared matcher and pager for in-memory sources, the
// typed refusals, and the one caller-side entry point. Dependency-light on
// purpose — file.ts and fake.ts import it — so it imports only port types.
import type {
  Ticket,
  TicketSearchHit,
  TicketSearchPage,
  TicketSearchQuery,
  TicketSource,
} from '../types'

export const TICKET_SEARCH_DEFAULT_LIMIT = 20
export const TICKET_SEARCH_MAX_LIMIT = 100

/** The configured source has no `search`; nothing was read. */
export class TicketSearchUnsupported extends Error {
  constructor(readonly source: string) {
    super(`${source} ticket source does not support search; no tickets were read`)
    this.name = 'TicketSearchUnsupported'
  }
}

/** A cursor this source did not issue for this search. */
export class TicketSearchCursorInvalid extends Error {
  constructor(
    readonly source: string,
    readonly cursor: string,
  ) {
    super(
      `invalid search cursor "${cursor}" for the ${source} ticket source — pass the cursor from the previous page of the same search`,
    )
    this.name = 'TicketSearchCursorInvalid'
  }
}

/** Lowercased whitespace-separated terms; empty terms dropped. */
export function searchTerms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== '')
}

/** Every term occurs in the title or the body (each term may hit either). */
export function matchesSearch(ticket: Pick<Ticket, 'title' | 'body'>, terms: string[]): boolean {
  const title = ticket.title.toLowerCase()
  const body = ticket.body.toLowerCase()
  return terms.every((term) => title.includes(term) || body.includes(term))
}

export function searchHit(ticket: Ticket): TicketSearchHit {
  return {
    id: ticket.ref.id,
    title: ticket.title,
    ...(ticket.state !== undefined ? { state: ticket.state } : {}),
    labels: [...ticket.labels],
    kind: ticket.kind ?? 'work',
    ...(ticket.target !== undefined ? { target: ticket.target } : {}),
  }
}

/** Search an in-memory listing in its own order. `query.state` must already be
 * the source's canonical state name. The cursor is a decimal match offset. */
export function pageSearch(
  sourceName: string,
  tickets: Ticket[],
  query: TicketSearchQuery,
  diagnostics: string[] = [],
): TicketSearchPage {
  const terms = searchTerms(query.text)
  const labels = query.labels ?? []
  const matches = tickets.filter(
    (ticket) =>
      (query.state === undefined || ticket.state === query.state) &&
      labels.every((label) => ticket.labels.includes(label)) &&
      matchesSearch(ticket, terms),
  )
  const offset = decodeOffset(sourceName, query.cursor)
  const end = offset + query.limit
  return {
    tickets: matches.slice(offset, end).map(searchHit),
    ...(end < matches.length ? { cursor: String(end) } : {}),
    diagnostics: [...diagnostics],
  }
}

function decodeOffset(sourceName: string, cursor: string | undefined): number {
  if (cursor === undefined) return 0
  if (!/^(0|[1-9]\d*)$/.test(cursor)) throw new TicketSearchCursorInvalid(sourceName, cursor)
  const offset = Number(cursor)
  if (!Number.isSafeInteger(offset)) throw new TicketSearchCursorInvalid(sourceName, cursor)
  return offset
}

export interface TicketSearchInput {
  text: string
  state?: string
  labels?: string[]
  limit?: number
  cursor?: string
}

/** The one caller-side entry point (operator tool and CLI). Refuses a source
 * without `search` before calling any source method — never a listing
 * fallback — and returns a JSON-clean, normalized page. */
export async function searchTickets(
  source: TicketSource,
  input: TicketSearchInput,
): Promise<TicketSearchPage> {
  if (input.text.trim() === '') throw new Error('ticket search needs a nonblank query')
  const limit = input.limit ?? TICKET_SEARCH_DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > TICKET_SEARCH_MAX_LIMIT) {
    throw new Error(`ticket search limit must be an integer from 1 to ${TICKET_SEARCH_MAX_LIMIT}`)
  }
  if (typeof source.search !== 'function') throw new TicketSearchUnsupported(source.name)
  const page = await source.search({
    text: input.text,
    ...(input.state !== undefined ? { state: input.state } : {}),
    ...(input.labels !== undefined ? { labels: [...input.labels] } : {}),
    limit,
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
  })
  return {
    tickets: page.tickets.map(normalizeHit),
    ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
    diagnostics: [...page.diagnostics],
  }
}

function normalizeHit(hit: TicketSearchHit): TicketSearchHit {
  return {
    id: hit.id,
    title: hit.title,
    ...(hit.state !== undefined ? { state: hit.state } : {}),
    labels: [...hit.labels],
    kind: hit.kind ?? 'work',
    ...(hit.target !== undefined ? { target: hit.target } : {}),
  }
}
