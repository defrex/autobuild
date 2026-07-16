/**
 * In-memory TicketSource for seam tests (SPEC §3.2, §13). Mirrors the policy
 * shape of the real adapters: initiation (listReady/get/claim/create) plus
 * outward-only projections (comment/transition), which it journals so tests
 * can assert exactly what flowed to the tracker.
 */
import type {
  DependencyState,
  Ticket,
  TicketDraft,
  TicketSource,
} from '../types'

function cloneTicket(ticket: Ticket): Ticket {
  return {
    ref: { ...ticket.ref },
    title: ticket.title,
    body: ticket.body,
    state: ticket.state,
    labels: [...ticket.labels],
    ...(ticket.blockedBy !== undefined
      ? { blockedBy: [...ticket.blockedBy] }
      : {}),
  }
}

export class FakeTicketSource implements TicketSource {
  readonly name = 'fake'

  /** Journal of every projection sent outward (§13), in call order. */
  readonly comments: Array<{ id: string; body: string }> = []
  readonly transitions: Array<{ id: string; state: string }> = []
  /** Ids claimed, in call order — lets tests assert a blocked ticket was
   * never claimed (§12: gating precedes claim-before-launch). */
  readonly claims: string[] = []
  /** Every `dependencyStates` request, in call order — lets tests assert a
   * dependency-free ticket costs zero port calls. */
  readonly dependencyQueries: string[][] = []

  private readonly tickets = new Map<string, Ticket>()
  private readonly claimed = new Set<string>()
  private readonly createState: string
  private readonly doneState: string
  private nextId = 1

  constructor(
    seed: Ticket[] = [],
    opts: {
      /** State assigned by create — proposals land in Triage (SPEC §12). */
      createState?: string
      /** State this fake treats as resolved for dependencies (§13: the
       * adapter owns what "complete" means). */
      doneState?: string
    } = {},
  ) {
    for (const ticket of seed) {
      this.tickets.set(ticket.ref.id, cloneTicket(ticket))
    }
    this.createState = opts.createState ?? 'Triage'
    this.doneState = opts.doneState ?? 'Done'
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
    this.claims.push(id)
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
      // Recorded verbatim, never discarded — the same contract the real
      // adapters owe (§13).
      ...(draft.blockedBy !== undefined && draft.blockedBy.length > 0
        ? { blockedBy: [...draft.blockedBy] }
        : {}),
    }
    this.tickets.set(id, ticket)
    return cloneTicket(ticket)
  }

  /** Resolution is this fake's own lifecycle: `doneState` and nothing else. */
  async dependencyStates(ids: string[]): Promise<DependencyState[]> {
    this.dependencyQueries.push([...ids])
    return ids.map((id) => {
      const ticket = this.tickets.get(id)
      if (!ticket) return { id, exists: false, resolved: false, blockedBy: [] }
      return {
        id,
        exists: true,
        resolved: ticket.state === this.doneState,
        blockedBy: [...(ticket.blockedBy ?? [])],
      }
    })
  }

  private require(id: string, operation: string): Ticket {
    const ticket = this.tickets.get(id)
    if (!ticket) {
      throw new Error(`fake ticket source: ${operation} on unknown ticket "${id}"`)
    }
    return ticket
  }
}
