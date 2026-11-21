/** Operator single-ticket start requests (AUT-1293): a durable, attributed
 * request that the running dispatcher claims one named ticket through the
 * ordinary admission gates on its next tick with a free slot, independent of
 * intake. The request only canonicalizes the id; the dispatcher decides and
 * settles eligibility. One invocation costs one source `get`, one reduced-value
 * read and at most one append, whatever the number of builds. */
import { humanActor, type Via } from '../events/envelope'
import type { RepositoryEventEnvelope } from '../events/repository'
import { ticketStartKey } from '../kernel/ticket-starts'
import type { TicketRef } from '../ontology'
import { requireTicket } from '../ports/tickets/operations'
import type { TicketSource } from '../ports/types'
import { readRepositoryFacts } from '../store/reduced-reads'
import { openOperatorTickets, type OperatorTicketBackend } from './tickets'
import type { BuildStore } from '../store/types'

interface TicketStartOptions {
  store: BuildStore
  repo: string
  source: TicketSource
  id: string
  user: string
  via?: Via
}

export interface TicketStartRequested {
  status: 'pending'
  /** True when an equivalent request was already pending; nothing was written. */
  existing: boolean
  request: number
  requestedAt: string
  ticket: TicketRef
  event?: RepositoryEventEnvelope
}

export type TicketStartCancelled =
  | { cancelled: true; request: number; ticket: TicketRef; event: RepositoryEventEnvelope }
  | { cancelled: false; id: string }

/** The hosted service's operator backend reads hosted tickets through its
 * `database` source; requests are keyed in the dispatcher's `hosted` namespace. */
function startRef(ref: TicketRef): TicketRef {
  return ref.source === 'database' ? { ...ref, source: 'hosted' } : ref
}

/** Record a start request for the canonical ticket, or return the pending one. */
export async function requestTicketStart(opts: TicketStartOptions): Promise<TicketStartRequested> {
  const ticket = startRef((await requireTicket(opts.source, opts.id)).ref)
  await opts.store.ensureRepo(opts.repo)
  const facts = (await readRepositoryFacts(opts.store, opts.repo, true)).value
  const pending = facts.ticketStarts.pending[ticketStartKey(ticket)]
  if (pending !== undefined)
    return {
      status: 'pending',
      existing: true,
      request: pending.seq,
      requestedAt: pending.ts,
      ticket: pending.ticket,
    }
  const event = await opts.store.appendRepo(opts.repo, {
    actor: humanActor(opts.user, opts.via),
    type: 'ticket.start-requested',
    payload: { ticket },
  })
  return {
    status: 'pending',
    existing: false,
    request: event.seq,
    requestedAt: event.ts,
    ticket,
    event,
  }
}

/** Cancel a pending start request. Idempotent: with nothing pending for the
 * ticket it writes nothing. The raw id is matched first so a ticket deleted
 * since the request can still be cancelled. */
export async function cancelTicketStart(opts: TicketStartOptions): Promise<TicketStartCancelled> {
  await opts.store.ensureRepo(opts.repo)
  const facts = (await readRepositoryFacts(opts.store, opts.repo, true)).value
  const pending = facts.ticketStarts.pending
  const raw = opts.id.trim().replace(/^#/, '')
  let entry = pending[ticketStartKey(startRef({ source: opts.source.name, id: raw }))]
  if (entry === undefined) {
    const ticket = await opts.source.get(opts.id)
    if (ticket !== null) entry = pending[ticketStartKey(startRef(ticket.ref))]
  }
  if (entry === undefined) return { cancelled: false, id: opts.id }
  const event = await opts.store.appendRepo(opts.repo, {
    actor: humanActor(opts.user, opts.via),
    type: 'ticket.start-cancelled',
    payload: { request: entry.seq, ticket: entry.ticket },
  })
  return { cancelled: true, request: entry.seq, ticket: entry.ticket, event }
}

/** The operator surface's single entry (MCP tool and HTTP routes): open the
 * repository's ticket source through the operator backend, then request or
 * cancel. */
export async function controlTicketStart(opts: {
  store: BuildStore
  repo: string
  backend: OperatorTicketBackend
  id: string
  user: string
  via?: Via
  cancel?: boolean
}): Promise<TicketStartRequested | TicketStartCancelled> {
  const { source } = await openOperatorTickets(opts)
  const control = {
    store: opts.store,
    repo: opts.repo,
    source,
    id: opts.id,
    user: opts.user,
    ...(opts.via !== undefined ? { via: opts.via } : {}),
  }
  return opts.cancel ? cancelTicketStart(control) : requestTicketStart(control)
}
