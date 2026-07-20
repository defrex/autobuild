/**
 * In-memory TicketSource for seam tests (SPEC §3.2, §13). Mirrors the policy
 * shape of the real adapters: initiation (listReady/get/claim/create),
 * pre-build grooming writes (update/blockers), and outward projections
 * (comment/transition), all journaled where seam tests need exact evidence.
 */
import type {
  DependencyState,
  Ticket,
  TicketCreateOptions,
  TicketDraft,
  TicketListing,
  TicketSource,
  TicketUpdate,
} from '../types'
import { validateTicketUpdate } from './update'

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
  /** Every accepted grooming write, including idempotent blocker retries. */
  readonly updates: Array<{ id: string; patch: TicketUpdate }> = []
  readonly blockerAdds: Array<{ id: string; blockerId: string }> = []
  readonly blockerRemovals: Array<{ id: string; blockerId: string }> = []
  /** Ids claimed, in call order — lets tests assert a blocked ticket was
   * never claimed (§12: gating precedes claim-before-launch). */
  readonly claims: string[] = []
  /** Every `dependencyStates` request, in call order — lets tests assert a
   * dependency-free ticket costs zero port calls. */
  readonly dependencyQueries: string[][] = []

  private readonly tickets = new Map<string, Ticket>()
  private readonly claimed = new Set<string>()
  private readonly idempotency = new Map<string, string>()
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

  /** Seed a ticket after construction — lets a test make one become Ready
   * mid-run, which is how "a single pass does not claim tickets that arrive
   * after its initial selection" (§12) gets a real oracle rather than a
   * vacuous one. */
  add(ticket: Ticket): void {
    this.tickets.set(ticket.ref.id, cloneTicket(ticket))
  }

  async listReady(criteria: {
    labels?: string[]
    state?: string
  }): Promise<TicketListing> {
    const labels = criteria.labels ?? []
    return {
      tickets: [...this.tickets.values()]
        .filter(
          (ticket) =>
            (criteria.state === undefined || ticket.state === criteria.state) &&
            labels.every((label) => ticket.labels.includes(label)),
        )
        .map(cloneTicket),
      diagnostics: [],
    }
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

  async create(
    draft: TicketDraft,
    opts: TicketCreateOptions = {},
  ): Promise<Ticket> {
    if (opts.idempotencyKey !== undefined) {
      const adopted = this.idempotency.get(opts.idempotencyKey)
      if (adopted !== undefined) return cloneTicket(this.require(adopted, 'create'))
    }
    const id = `fake-${this.nextId++}`
    const ticket: Ticket = {
      ref: { source: this.name, id, title: draft.title },
      title: draft.title,
      body: draft.body,
      state: opts.state ?? this.createState,
      labels: [...(draft.labels ?? [])],
      // Recorded verbatim, never discarded — the same contract the real
      // adapters owe (§13).
      ...(draft.blockedBy !== undefined && draft.blockedBy.length > 0
        ? { blockedBy: [...draft.blockedBy] }
        : {}),
    }
    this.tickets.set(id, ticket)
    if (opts.idempotencyKey !== undefined) {
      this.idempotency.set(opts.idempotencyKey, id)
    }
    return cloneTicket(ticket)
  }

  async update(id: string, patch: TicketUpdate): Promise<void> {
    const validated = validateTicketUpdate(patch)
    const ticket = this.require(id, 'update')

    if (validated.title !== undefined) {
      ticket.title = validated.title
      ticket.ref.title = validated.title
    }
    if (validated.body !== undefined) ticket.body = validated.body
    if (validated.labels !== undefined) ticket.labels = [...validated.labels]

    this.updates.push({ id, patch: cloneUpdate(validated) })
  }

  async addBlocker(id: string, blockerId: string): Promise<void> {
    const ticket = this.require(id, 'addBlocker')
    if (id === blockerId) {
      throw new Error(`fake ticket source: ticket "${id}" cannot block itself`)
    }
    this.require(blockerId, 'addBlocker')

    this.blockerAdds.push({ id, blockerId })
    if (ticket.blockedBy?.includes(blockerId)) return
    ticket.blockedBy = [...(ticket.blockedBy ?? []), blockerId]
  }

  async removeBlocker(id: string, blockerId: string): Promise<void> {
    const ticket = this.require(id, 'removeBlocker')
    this.blockerRemovals.push({ id, blockerId })

    const remaining = (ticket.blockedBy ?? []).filter(
      (candidate) => candidate !== blockerId,
    )
    if (remaining.length === 0) delete ticket.blockedBy
    else ticket.blockedBy = remaining
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

function cloneUpdate(patch: TicketUpdate): TicketUpdate {
  return {
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.body !== undefined ? { body: patch.body } : {}),
    ...(patch.labels !== undefined ? { labels: [...patch.labels] } : {}),
  }
}
