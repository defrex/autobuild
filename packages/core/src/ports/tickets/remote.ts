import { normalizeTicket } from './tree'
import { hostedRequestedIds } from './requested-id'
import { checkTicketRevision, TicketRevisionConflict } from './revision'
import { TicketIssueLinksUnsupported } from './issue-links'
import { withoutUnsupportedPriority } from './priority'
import { ticketLifecycle } from './lifecycle'
import type { TicketsConfig } from '../../config/schema'
import type {
  DependencyState,
  Ticket,
  TicketCreateOptions,
  TicketDraft,
  TicketListing,
  TicketSource,
  TicketUpdate,
  TicketMutation,
} from '../types'
import { RemoteBuildStore, AuthError } from '../../store/remote/client'
import { errorBodySchema } from '../../store/remote/protocol'
import {
  claimWireSchema,
  TICKET_TREE_HEADER,
  TICKET_TREE_CAPABILITY,
  TICKET_REVISIONS_HEADER,
  TICKET_REVISIONS_CAPABILITY,
  hostedTicketPolicySchema,
  type HostedTicketPolicy,
  TICKET_COMMENTS_HEADER,
  TICKET_COMMENTS_CAPABILITY,
  TICKET_ISSUE_LINKS_HEADER,
  TICKET_ISSUE_LINKS_CAPABILITY,
  TICKET_DEPENDENCY_STATE_HEADER,
  TICKET_DEPENDENCY_STATE_CAPABILITY,
  TICKET_POLICY_ROLES_HEADER,
  TICKET_POLICY_ROLES_CAPABILITY,
  dependencyStatesWireSchema,
  type HostedTicketContext,
  successWireSchema,
  ticketListingWireSchema,
  ticketWireSchema,
  ticketStatesWireSchema,
  ticketStateCountsWireSchema,
  ticketStateCreateWireSchema,
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

/** The project ticket policy a hosted `[tickets]` table publishes. The backlog
 * and rejected roles appear only when configured, so a policy without them is
 * exactly what services predating the roles accept. */
export function hostedTicketPolicy(tickets: TicketsConfig): HostedTicketPolicy {
  if (tickets.teamKey === undefined) throw new Error('[tickets].source = "hosted" requires teamKey')
  const lifecycle = ticketLifecycle(tickets)
  return {
    version: 1,
    tickets: {
      source: 'hosted',
      teamKey: tickets.teamKey,
      readyState: lifecycle.ready,
      triageState: lifecycle.triage,
      claimedState: lifecycle.doing,
      doneState: lifecycle.done,
      createState: lifecycle.create,
      proposalState: lifecycle.proposal,
      ...(tickets.readyLabels !== undefined ? { readyLabels: tickets.readyLabels } : {}),
      ...(lifecycle.backlog !== undefined ? { backlogState: lifecycle.backlog } : {}),
      ...(lifecycle.rejected !== undefined ? { rejectedState: lifecycle.rejected } : {}),
    },
  }
}

/** Full TicketSource client for a hosted Autobuild service. */
export class HostedTicketSource implements TicketSource {
  readonly name = 'hosted'
  readonly integrationTree = true
  readonly issueLinks = true
  readonly requestedIds: ReturnType<typeof hostedRequestedIds>
  readonly assets: import('../types').TicketAssetStore
  private readonly base: string
  private readonly token: string
  private readonly fetchFn: HostedTicketFetch
  private readonly context: HostedTicketContext

  constructor(options: HostedTicketSourceOptions) {
    this.requestedIds = hostedRequestedIds(options.teamKey)
    const client = new RemoteBuildStore({
      url: options.url,
      token: options.token,
      ...(options.fetchFn ? { fetchFn: options.fetchFn as typeof fetch } : {}),
    })
    this.assets = {
      ticketAssetLimits: client.ticketAssetLimits.bind(client),
      putTicketAsset: client.putTicketAsset.bind(client),
      getTicketAsset: client.getTicketAsset.bind(client),
      listTicketAssets: client.listTicketAssets.bind(client),
      removeTicketAsset: client.removeTicketAsset.bind(client),
    }
    this.base = options.url.replace(/\/+$/, '')
    this.token = options.token
    this.fetchFn = options.fetchFn ?? fetch
    this.context = {
      teamKey: options.teamKey,
      ...(options.repo !== undefined ? { repo: options.repo } : {}),
      ...(options.claimedState !== undefined ? { claimedState: options.claimedState } : {}),
      ...(options.createState !== undefined ? { createState: options.createState } : {}),
    }
  }

  async synchronizePolicy(policy: HostedTicketPolicy): Promise<void> {
    const parsed = hostedTicketPolicySchema.parse(policy)
    const namesRoles =
      parsed.tickets.backlogState !== undefined || parsed.tickets.rejectedState !== undefined
    await this.request('policy', parsed, successWireSchema, false, namesRoles)
  }

  private project(ticket: Ticket): Ticket {
    return normalizeTicket({ ...ticket, ref: { ...ticket.ref, source: this.name } })
  }

  private async request<T>(
    operation: string,
    input: unknown,
    schema: { parse(value: unknown): T },
    namesIssueLinks = false,
    namesPolicyRoles = false,
  ): Promise<T> {
    const response = await this.fetchFn(`${this.base}/tickets/${operation}`, {
      method: 'POST',
      headers: {
        [TICKET_TREE_HEADER]: TICKET_TREE_CAPABILITY,
        'content-type': 'application/json',
        [TICKET_COMMENTS_HEADER]: TICKET_COMMENTS_CAPABILITY,
        authorization: `Bearer ${this.token}`,
        [TICKET_REVISIONS_HEADER]: TICKET_REVISIONS_CAPABILITY,
        [TICKET_ISSUE_LINKS_HEADER]: TICKET_ISSUE_LINKS_CAPABILITY,
        [TICKET_DEPENDENCY_STATE_HEADER]: TICKET_DEPENDENCY_STATE_CAPABILITY,
        [TICKET_POLICY_ROLES_HEADER]: TICKET_POLICY_ROLES_CAPABILITY,
        [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
        [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
      },
      body: JSON.stringify({ context: this.context, input }),
    })
    if (!response.ok) {
      // A service predating the roles refuses them with its strict policy schema
      // and never echoes the capability header.
      if (
        namesPolicyRoles &&
        response.status === 400 &&
        response.headers.get(TICKET_POLICY_ROLES_HEADER) !== TICKET_POLICY_ROLES_CAPABILITY
      )
        throw new Error(
          'ticket service predates backlog/rejected roles in ticket policy; upgrade the service or unset [tickets].backlogState and rejectedState',
        )
      let message = `ticket service responded ${response.status}`
      try {
        const body = (await response.json()) as Record<string, unknown>
        if (
          response.status === 409 &&
          typeof body.currentRevision === 'string' &&
          typeof body.expectedRevision === 'string' &&
          typeof body.id === 'string'
        )
          throw new TicketRevisionConflict(body.id, body.expectedRevision, body.currentRevision)
        if (body.code === 'issue-links-unsupported')
          throw new TicketIssueLinksUnsupported(this.name)
        message = errorBodySchema.parse(body).error
        // A server predating issue links refuses the unknown key with its strict
        // request schema and never echoes the capability header.
        if (
          namesIssueLinks &&
          response.status === 400 &&
          response.headers.get(TICKET_ISSUE_LINKS_HEADER) !== TICKET_ISSUE_LINKS_CAPABILITY &&
          message.includes('issueLinks')
        )
          throw new TicketIssueLinksUnsupported(this.name)
      } catch (error) {
        if (error instanceof TicketRevisionConflict || error instanceof TicketIssueLinksUnsupported)
          throw error
        // Keep the status-only safe fallback for non-protocol responses.
      }
      if (response.status === 401 || response.status === 403) throw new AuthError(message)
      throw new Error(message)
    }
    return schema.parse(await response.json())
  }

  async listReady(criteria: {
    labels?: string[]
    state?: string
    assignee?: string
  }): Promise<TicketListing> {
    if (criteria.assignee !== undefined) {
      throw new Error('the hosted ticket source does not support an assignee gate')
    }
    const listing = await this.request('list-ready', criteria, ticketListingWireSchema)
    return { ...listing, tickets: listing.tickets.map((ticket) => this.project(ticket)) }
  }

  listAll(): Promise<TicketListing> {
    return this.listReady({})
  }

  async listStates() {
    return this.request('states', {}, ticketStatesWireSchema)
  }

  async countStates(names: readonly string[]) {
    return this.request('state-counts', { names: [...names] }, ticketStateCountsWireSchema)
  }

  async addState(name: string, opts: { about?: string } = {}) {
    return this.request('add-state', { name, ...opts }, ticketStateCreateWireSchema)
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

  // The hosted wire does not carry priority: urgent is refused before any
  // request and normal is dropped, so requests stay byte-identical.
  async create(draft: TicketDraft, options: TicketCreateOptions = {}): Promise<Ticket> {
    const write = withoutUnsupportedPriority(this, draft)
    return this.project(
      await this.request(
        'create',
        { draft: write, options },
        ticketWireSchema,
        write.issueLinks !== undefined,
      ),
    )
  }

  async mutateIfRevision(
    id: string,
    expectedRevision: string,
    mutation: TicketMutation,
  ): Promise<void> {
    if (mutation.kind === 'update') {
      const patch = withoutUnsupportedPriority(this, mutation.patch)
      if (mutation.patch.priority !== undefined && Object.keys(patch).length === 0) {
        // Nothing to send, but a stale revision is still refused.
        if (!expectedRevision.trim()) throw new Error('expected revision must be nonblank')
        const current = await this.get(id)
        if (!current) throw new Error(`hosted ticket source: unknown ticket "${id}"`)
        checkTicketRevision(current, expectedRevision)
        return
      }
      mutation = { kind: 'update', patch }
    }
    await this.request(
      'mutate-if-revision',
      { id, expectedRevision, mutation },
      successWireSchema,
      mutation.kind === 'update' && mutation.patch.issueLinks !== undefined,
    )
  }

  async update(id: string, patch: TicketUpdate): Promise<void> {
    const write = withoutUnsupportedPriority(this, patch)
    if (patch.priority !== undefined && Object.keys(write).length === 0) return
    await this.request(
      'update',
      { id, patch: write },
      successWireSchema,
      write.issueLinks !== undefined,
    )
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
