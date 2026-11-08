import { normalizeTicket } from './tree'
import { hostedRequestedIds } from './requested-id'
import { TicketRevisionConflict } from './revision'
import { TicketIssueLinksUnsupported } from './issue-links'
import { TicketPriorityUnsupported } from './priority'
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
  TICKET_PRIORITY_HEADER,
  TICKET_PRIORITY_CAPABILITY,
  TICKET_DEPENDENCY_STATE_HEADER,
  TICKET_DEPENDENCY_STATE_CAPABILITY,
  TICKET_POLICY_ROLES_HEADER,
  TICKET_POLICY_ROLES_CAPABILITY,
  TICKET_TARGETING_HEADER,
  TICKET_TARGETING_CAPABILITY,
  TICKET_TARGETING_PROBE_NODE,
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

/** Full TicketSource client for a hosted Autobuild service. Targeted listing
 * is declared only after a response from the service has carried the
 * targeting echo; product code obtains the source through `createTicketSource`,
 * which settles that decision before returning it. */
export class HostedTicketSource implements TicketSource {
  readonly name = 'hosted'
  readonly integrationTree = true
  readonly issueLinks = true
  readonly priority = true
  readonly requestedIds: ReturnType<typeof hostedRequestedIds>
  readonly assets: import('../types').TicketAssetStore
  private readonly base: string
  private readonly token: string
  private readonly fetchFn: HostedTicketFetch
  private readonly context: HostedTicketContext
  /** Unknown until a response settles it; see `noteTargeting`. */
  private targetingSupport: boolean | undefined
  private readonly targeted = (nodeId: string) => this.targetedListing(nodeId)

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
    await this.request('policy', parsed, successWireSchema, { policyRoles: namesRoles })
  }

  /** Present only once the service has positively advertised `list-targeting`;
   * while support is unknown or refused, observation keeps the exhaustive path. */
  get listTargeting(): TicketSource['listTargeting'] {
    return this.targetingSupport === true ? this.targeted : undefined
  }

  /** Settles targeted-listing support before any observation runs: free when a
   * response already settled it, otherwise one `list-targeting` probe for a
   * node id that can never exist. Throws when the answer is inconclusive. */
  async negotiateTargeting(): Promise<boolean> {
    if (this.targetingSupport !== undefined) return this.targetingSupport
    const response = await this.send('list-targeting', { nodeId: TICKET_TARGETING_PROBE_NODE })
    if (this.targetingSupport === undefined && (response.status === 404 || response.status === 400))
      this.targetingSupport = false
    await response.body?.cancel()
    if (this.targetingSupport === undefined)
      throw new Error(
        `could not negotiate targeted listing with the ticket service (HTTP ${response.status})`,
      )
    return this.targetingSupport
  }

  /** Any response carrying the echo declares support; an ok response without
   * it comes from a service predating `list-targeting`. A non-ok response
   * without it (a gateway page, say) proves nothing. */
  private noteTargeting(response: Response): void {
    if (response.headers.get(TICKET_TARGETING_HEADER) === TICKET_TARGETING_CAPABILITY)
      this.targetingSupport = true
    else if (response.ok) this.targetingSupport = false
  }

  private async send(operation: string, input: unknown): Promise<Response> {
    const response = await this.fetchFn(`${this.base}/tickets/${operation}`, {
      method: 'POST',
      headers: {
        [TICKET_TREE_HEADER]: TICKET_TREE_CAPABILITY,
        'content-type': 'application/json',
        [TICKET_COMMENTS_HEADER]: TICKET_COMMENTS_CAPABILITY,
        authorization: `Bearer ${this.token}`,
        [TICKET_REVISIONS_HEADER]: TICKET_REVISIONS_CAPABILITY,
        [TICKET_ISSUE_LINKS_HEADER]: TICKET_ISSUE_LINKS_CAPABILITY,
        [TICKET_PRIORITY_HEADER]: TICKET_PRIORITY_CAPABILITY,
        [TICKET_DEPENDENCY_STATE_HEADER]: TICKET_DEPENDENCY_STATE_CAPABILITY,
        [TICKET_POLICY_ROLES_HEADER]: TICKET_POLICY_ROLES_CAPABILITY,
        [TICKET_TARGETING_HEADER]: TICKET_TARGETING_CAPABILITY,
        [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
        [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
      },
      body: JSON.stringify({ context: this.context, input }),
    })
    this.noteTargeting(response)
    return response
  }

  private project(ticket: Ticket): Ticket {
    return normalizeTicket({ ...ticket, ref: { ...ticket.ref, source: this.name } })
  }

  private async request<T>(
    operation: string,
    input: unknown,
    schema: { parse(value: unknown): T },
    names: { issueLinks?: boolean; priority?: boolean; policyRoles?: boolean } = {},
  ): Promise<T> {
    const response = await this.send(operation, input)
    if (!response.ok) {
      // A service predating targeted listing has no such route (or refuses it
      // with a strict schema) and never echoes the capability header. The read
      // fails closed; the next observation takes the negotiated exhaustive path.
      if (
        operation === 'list-targeting' &&
        (response.status === 404 || response.status === 400) &&
        response.headers.get(TICKET_TARGETING_HEADER) !== TICKET_TARGETING_CAPABILITY
      ) {
        this.targetingSupport = false
        throw new Error(
          'ticket service predates targeted listing (list-targeting); upgrade the service',
        )
      }
      // A service predating the roles refuses them with its strict policy schema
      // and never echoes the capability header.
      if (
        names.policyRoles &&
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
        if (body.code === 'priority-unsupported') throw new TicketPriorityUnsupported(this.name)
        message = errorBodySchema.parse(body).error
        // A server predating issue links or priority refuses the unknown key with
        // its strict request schema and never echoes the capability header.
        if (
          names.issueLinks &&
          response.status === 400 &&
          response.headers.get(TICKET_ISSUE_LINKS_HEADER) !== TICKET_ISSUE_LINKS_CAPABILITY &&
          message.includes('issueLinks')
        )
          throw new TicketIssueLinksUnsupported(this.name)
        if (
          names.priority &&
          response.status === 400 &&
          response.headers.get(TICKET_PRIORITY_HEADER) !== TICKET_PRIORITY_CAPABILITY &&
          message.includes('priority')
        )
          throw new TicketPriorityUnsupported(this.name)
      } catch (error) {
        if (
          error instanceof TicketRevisionConflict ||
          error instanceof TicketIssueLinksUnsupported ||
          error instanceof TicketPriorityUnsupported
        )
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

  /** The exhaustive listing: non-recurring callers, and integration
   * observation against a service that negotiated no targeted listing. */
  listAll(): Promise<TicketListing> {
    return this.listReady({})
  }

  private async targetedListing(nodeId: string): Promise<TicketListing> {
    const listing = await this.request('list-targeting', { nodeId }, ticketListingWireSchema)
    return { ...listing, tickets: listing.tickets.map((ticket) => this.project(ticket)) }
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

  // Normal is the default, so a plain create never names priority and keeps
  // working against a service predating it.
  async create(draft: TicketDraft, options: TicketCreateOptions = {}): Promise<Ticket> {
    const { priority, ...rest } = draft
    const write = priority === 'urgent' ? { ...rest, priority } : rest
    const { idempotencyKeyReservedAt: _reservedAt, ...wireOptions } = options
    return this.project(
      await this.request('create', { draft: write, options: wireOptions }, ticketWireSchema, {
        issueLinks: write.issueLinks !== undefined,
        priority: priority === 'urgent',
      }),
    )
  }

  async mutateIfRevision(
    id: string,
    expectedRevision: string,
    mutation: TicketMutation,
  ): Promise<void> {
    await this.request(
      'mutate-if-revision',
      { id, expectedRevision, mutation },
      successWireSchema,
      mutation.kind === 'update'
        ? {
            issueLinks: mutation.patch.issueLinks !== undefined,
            priority: mutation.patch.priority !== undefined,
          }
        : {},
    )
  }

  async update(id: string, patch: TicketUpdate): Promise<void> {
    await this.request('update', { id, patch }, successWireSchema, {
      issueLinks: patch.issueLinks !== undefined,
      priority: patch.priority !== undefined,
    })
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
