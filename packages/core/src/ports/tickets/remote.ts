import type {
  DependencyState,
  Ticket,
  TicketCreateOptions,
  TicketDraft,
  TicketListing,
  TicketSource,
  TicketUpdate,
} from '../types'
import { AuthError } from '../../store/remote/client'
import { errorBodySchema } from '../../store/remote/protocol'
import {
  claimWireSchema,
  dependencyStatesWireSchema,
  type HostedTicketContext,
  successWireSchema,
  ticketListingWireSchema,
  ticketWireSchema,
} from './remote-protocol'
import {
  AUTOBUILD_VERSION,
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
} from '../../store/remote/version'

export type HostedTicketFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export interface HostedTicketSourceOptions extends HostedTicketContext {
  url: string
  token: string
  fetchFn?: HostedTicketFetch
}

/** Full TicketSource client for a hosted Autobuild service. */
export class HostedTicketSource implements TicketSource {
  readonly name = 'hosted'
  private readonly base: string
  private readonly token: string
  private readonly fetchFn: HostedTicketFetch
  private readonly context: HostedTicketContext

  constructor(options: HostedTicketSourceOptions) {
    this.base = options.url.replace(/\/+$/, '')
    this.token = options.token
    this.fetchFn = options.fetchFn ?? fetch
    this.context = {
      teamKey: options.teamKey,
      ...(options.claimedState !== undefined ? { claimedState: options.claimedState } : {}),
      ...(options.createState !== undefined ? { createState: options.createState } : {}),
    }
  }

  private project(ticket: Ticket): Ticket {
    return { ...ticket, ref: { ...ticket.ref, source: this.name } }
  }

  private async request<T>(
    operation: string,
    input: unknown,
    schema: { parse(value: unknown): T },
  ): Promise<T> {
    const response = await this.fetchFn(`${this.base}/tickets/${operation}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.token}`,
        [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
        [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
      },
      body: JSON.stringify({ context: this.context, input }),
    })
    if (!response.ok) {
      let message = `ticket service responded ${response.status}`
      try {
        message = errorBodySchema.parse(await response.json()).error
      } catch {
        // Keep the status-only safe fallback for non-protocol responses.
      }
      if (response.status === 401 || response.status === 403) throw new AuthError(message)
      throw new Error(message)
    }
    return schema.parse(await response.json())
  }

  async listReady(criteria: { labels?: string[]; state?: string }): Promise<TicketListing> {
    const listing = await this.request('list-ready', criteria, ticketListingWireSchema)
    return { ...listing, tickets: listing.tickets.map((ticket) => this.project(ticket)) }
  }

  async get(id: string): Promise<Ticket | null> {
    const ticket = await this.request('get', { id }, ticketWireSchema.nullable())
    return ticket === null ? null : this.project(ticket)
  }

  async claim(id: string): Promise<boolean> {
    return (await this.request('claim', { id }, claimWireSchema)).claimed
  }

  async comment(id: string, body: string): Promise<void> {
    await this.request('comment', { id, body }, successWireSchema)
  }

  async transition(id: string, state: string): Promise<void> {
    await this.request('transition', { id, state }, successWireSchema)
  }

  async create(draft: TicketDraft, options: TicketCreateOptions = {}): Promise<Ticket> {
    return this.project(await this.request('create', { draft, options }, ticketWireSchema))
  }

  async update(id: string, patch: TicketUpdate): Promise<void> {
    await this.request('update', { id, patch }, successWireSchema)
  }

  async addBlocker(id: string, blockerId: string): Promise<void> {
    await this.request('add-blocker', { id, blockerId }, successWireSchema)
  }

  async removeBlocker(id: string, blockerId: string): Promise<void> {
    await this.request('remove-blocker', { id, blockerId }, successWireSchema)
  }

  dependencyStates(ids: string[]): Promise<DependencyState[]> {
    return this.request('dependency-states', { ids }, dependencyStatesWireSchema)
  }
}
