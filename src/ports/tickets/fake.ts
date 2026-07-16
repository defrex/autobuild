/**
 * In-memory TicketSource for seam tests (SPEC §3.2, §13). Mirrors the policy
 * shape of the real adapters: initiation (listReady/get/claim/create) plus
 * outward-only projections (comment/transition), which it journals so tests
 * can assert exactly what flowed to the tracker.
 */
import type { Ticket, TicketDraft, TicketSource } from '../types'

function cloneTicket(ticket: Ticket): Ticket {
  return {
    ref: { ...ticket.ref },
    title: ticket.title,
    body: ticket.body,
    state: ticket.state,
    labels: [...ticket.labels],
  }
}

export class FakeTicketSource implements TicketSource {
  readonly name = 'fake'

  /** Journal of every projection sent outward (§13), in call order. */
  readonly comments: Array<{ id: string; body: string }> = []
  readonly transitions: Array<{ id: string; state: string }> = []

  private readonly tickets = new Map<string, Ticket>()
  private readonly claimed = new Set<string>()
  private readonly createState: string
  private nextId = 1

  constructor(
    seed: Ticket[] = [],
    opts: {
      /** State assigned by create — proposals land in Triage (SPEC §12). */
      createState?: string
    } = {},
  ) {
    for (const ticket of seed) {
      this.tickets.set(ticket.ref.id, cloneTicket(ticket))
    }
    this.createState = opts.createState ?? 'Triage'
  }

  async listReady(criteria: {
    labels?: string[]
    state?: string
  }): Promise<Ticket[]> {
    const labels = criteria.labels ?? []
    return [...this.tickets.values()]
      .filter(
        (ticket) =>
          (criteria.state === undefined || ticket.state === criteria.state) &&
          labels.every((label) => ticket.labels.includes(label)),
      )
      .map(cloneTicket)
  }

  async get(id: string): Promise<Ticket | null> {
    const ticket = this.tickets.get(id)
    return ticket ? cloneTicket(ticket) : null
  }

  /** Claim-before-launch (SPEC §12): true exactly once per ticket. */
  async claim(id: string): Promise<boolean> {
    if (!this.tickets.has(id) || this.claimed.has(id)) return false
    this.claimed.add(id)
    return true
  }

  async comment(id: string, body: string): Promise<void> {
    this.require(id, 'comment')
    this.comments.push({ id, body })
  }

  async transition(id: string, state: string): Promise<void> {
    const ticket = this.require(id, 'transition')
    ticket.state = state
    this.transitions.push({ id, state })
  }

  async create(draft: TicketDraft): Promise<Ticket> {
    const id = `fake-${this.nextId++}`
    const ticket: Ticket = {
      ref: { source: this.name, id, title: draft.title },
      title: draft.title,
      body: draft.body,
      state: this.createState,
      labels: [...(draft.labels ?? [])],
    }
    this.tickets.set(id, ticket)
    return cloneTicket(ticket)
  }

  private require(id: string, operation: string): Ticket {
    const ticket = this.tickets.get(id)
    if (!ticket) {
      throw new Error(`fake ticket source: ${operation} on unknown ticket "${id}"`)
    }
    return ticket
  }
}
