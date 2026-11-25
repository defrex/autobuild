import { normalizeTicket } from './tree'
import { hostedRequestedIds } from './requested-id'
import { TicketRevisionConflict } from './revision'
import { TicketIssueLinksUnsupported } from './issue-links'
import { TicketPriorityUnsupported } from './priority'
import { ticketLifecycle } from './lifecycle'
import { TicketSearchCursorInvalid, TicketSearchUnsupported } from './search'
import type { TicketsConfig } from '../../config/schema'
import type {
  DependencyState,
  Ticket,
  TicketCreateOptions,
  TicketDraft,
  TicketCriteria,
  TicketListing,
  TicketPage,
  TicketPageListing,
  TicketSearchPage,
  TicketSearchQuery,
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
  TICKET_POLICY_CREATE_LABELS_HEADER,
  TICKET_POLICY_CREATE_LABELS_CAPABILITY,
  TICKET_TARGETING_HEADER,
  TICKET_TARGETING_CAPABILITY,
  TICKET_TARGETING_PROBE_NODE,
  TICKET_PAGING_HEADER,
  TICKET_PAGING_CAPABILITY,
  TICKET_SEARCH_HEADER,
  TICKET_SEARCH_CAPABILITY,
  dependencyStatesWireSchema,
  type HostedTicketContext,
  successWireSchema,
  ticketListingWireSchema,
  ticketPageWireSchema,
  ticketSearchPageWireSchema,
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
 * and rejected roles appear only when configured, and `createLabels` only when
 * nonempty, so a policy without them is exactly what services predating them
 * accept. */
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
      ...(tickets.createLabels?.length ? { createLabels: tickets.createLabels } : {}),
    },
  }
}

/** A hosted page the client cannot use: the service predates or refuses
 * `list-page`, or its answer contradicts the request. Never answered by a
 * fallback listing within the same call. */
export class HostedTicketPagingError extends Error {
  override readonly name = 'HostedTicketPagingError'
  constructor(
    readonly code: 'service-predates' | 'paging-unsupported' | 'invalid-page',
    message: string,
  ) {
    super(message)
  }
}

/** Full TicketSource client for a hosted Autobuild service. Targeted listing,
 * native paging and search are each declared only after a response from the
 * service has carried its echo; product code obtains the source through
 * `createTicketSource`, whose construction-time response settles all three. */
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
  /** Unknown until a response settles it; see `noteCapabilities`. */
  private targetingSupport: boolean | undefined
  private readonly targeted = (nodeId: string) => this.targetedListing(nodeId)
  /** Unknown until a response settles it; see `noteCapabilities`. */
  private pagingSupport: boolean | undefined
  private readonly paged = (criteria: TicketCriteria, page: TicketPage) =>
    this.pagedListing(criteria, page)
  /** Unknown until a response settles it; see `noteCapabilities`. */
  private searchSupport: boolean | undefined
  private readonly searched = (query: TicketSearchQuery) => this.searchPage(query)

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
    await this.request('policy', parsed, successWireSchema, {
      policyRoles: namesRoles,
      policyCreateLabels: parsed.tickets.createLabels !== undefined,
    })
  }

  /** Present only once the service has positively advertised `list-targeting`;
   * while support is unknown or refused, observation keeps the exhaustive path. */
  get listTargeting(): TicketSource['listTargeting'] {
    return this.targetingSupport === true ? this.targeted : undefined
  }

  /** Present only once the service has positively advertised `list-page`;
   * while support is unknown or refused, operator paging reads `list-ready`. */
  get listPage(): TicketSource['listPage'] {
    return this.pagingSupport === true ? this.paged : undefined
  }

  /** Present only once the service has positively advertised `search`; while
   * support is unknown or refused, callers refuse with `TicketSearchUnsupported`
   * before any request. There is never a listing fallback. */
  get search(): TicketSource['search'] {
    return this.searchSupport === true ? this.searched : undefined
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

  /** Any response carrying an echo declares that capability; an ok response
   * without it comes from a service predating `list-targeting`, `list-page` or
   * `search`.
   * A non-ok response without it (a gateway page, say) proves nothing. */
  private noteCapabilities(response: Response): void {
    if (response.headers.get(TICKET_TARGETING_HEADER) === TICKET_TARGETING_CAPABILITY)
      this.targetingSupport = true
    else if (response.ok) this.targetingSupport = false
    if (response.headers.get(TICKET_PAGING_HEADER) === TICKET_PAGING_CAPABILITY)
      this.pagingSupport = true
    else if (response.ok) this.pagingSupport = false
    if (response.headers.get(TICKET_SEARCH_HEADER) === TICKET_SEARCH_CAPABILITY)
      this.searchSupport = true
    else if (response.ok) this.searchSupport = false
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
        [TICKET_POLICY_CREATE_LABELS_HEADER]: TICKET_POLICY_CREATE_LABELS_CAPABILITY,
        [TICKET_TARGETING_HEADER]: TICKET_TARGETING_CAPABILITY,
        [TICKET_PAGING_HEADER]: TICKET_PAGING_CAPABILITY,
        [TICKET_SEARCH_HEADER]: TICKET_SEARCH_CAPABILITY,
        [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
        [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
      },
      body: JSON.stringify({ context: this.context, input }),
    })
    this.noteCapabilities(response)
    return response
  }

  private project(ticket: Ticket): Ticket {
    return normalizeTicket({ ...ticket, ref: { ...ticket.ref, source: this.name } })
  }

  private async request<T>(
    operation: string,
    input: unknown,
    schema: { parse(value: unknown): T },
    names: {
      issueLinks?: boolean
      priority?: boolean
      policyRoles?: boolean
      policyCreateLabels?: boolean
    } = {},
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
      // Likewise for native paging. The call fails typed; only the next listing
      // takes the negotiated `list-ready` path.
      if (
        operation === 'list-page' &&
        (response.status === 404 || response.status === 400) &&
        response.headers.get(TICKET_PAGING_HEADER) !== TICKET_PAGING_CAPABILITY
      ) {
        this.pagingSupport = false
        throw new HostedTicketPagingError(
          'service-predates',
          'ticket service predates paged listing (list-page); upgrade the service',
        )
      }
      // Likewise for search, which never falls back to a listing.
      if (
        operation === 'search' &&
        (response.status === 404 || response.status === 400) &&
        response.headers.get(TICKET_SEARCH_HEADER) !== TICKET_SEARCH_CAPABILITY
      ) {
        this.searchSupport = false
        throw new TicketSearchUnsupported(this.name)
      }
      // A service predating createLabels or the roles refuses them with its
      // strict policy schema and never echoes the capability header.
      if (
        names.policyCreateLabels &&
        response.status === 400 &&
        response.headers.get(TICKET_POLICY_CREATE_LABELS_HEADER) !==
          TICKET_POLICY_CREATE_LABELS_CAPABILITY
      )
        throw new Error(
          'ticket service predates createLabels in ticket policy; upgrade the service or unset [tickets].createLabels',
        )
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
        if (body.code === 'paging-unsupported')
          throw new HostedTicketPagingError(
            'paging-unsupported',
            typeof body.error === 'string'
              ? body.error
              : 'ticket service cannot page this ticket source',
          )
        if (body.code === 'search-unsupported') throw new TicketSearchUnsupported(this.name)
        if (body.code === 'search-cursor-invalid')
          throw new TicketSearchCursorInvalid(this.name, String(body.cursor ?? ''))
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
          error instanceof TicketPriorityUnsupported ||
          error instanceof HostedTicketPagingError ||
          error instanceof TicketSearchUnsupported ||
          error instanceof TicketSearchCursorInvalid
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

  /** The service's native window: its order and total are canonical, so an
   * answer that contradicts the request fails rather than being repaired. */
  private async pagedListing(
    criteria: TicketCriteria,
    page: TicketPage,
  ): Promise<TicketPageListing> {
    if (criteria.assignee !== undefined) {
      throw new Error('the hosted ticket source does not support an assignee gate')
    }
    const offset = page.offset ?? 0
    const listing = await this.request(
      'list-page',
      {
        criteria: {
          ...(criteria.labels !== undefined ? { labels: criteria.labels } : {}),
          ...(criteria.state !== undefined ? { state: criteria.state } : {}),
        },
        page: {
          limit: page.limit,
          ...(page.offset !== undefined ? { offset: page.offset } : {}),
          ...(page.order !== undefined ? { order: page.order } : {}),
        },
      },
      {
        parse: (value: unknown) => {
          const parsed = ticketPageWireSchema.safeParse(value)
          if (!parsed.success)
            throw new HostedTicketPagingError(
              'invalid-page',
              `ticket service answered an invalid page: ${parsed.error.message}`,
            )
          return parsed.data
        },
      },
    )
    if (
      listing.tickets.length > page.limit ||
      (listing.tickets.length > 0 && offset + listing.tickets.length > listing.total)
    )
      throw new HostedTicketPagingError(
        'invalid-page',
        `ticket service answered ${listing.tickets.length} tickets of ${listing.total} for limit ${page.limit} at offset ${offset}`,
      )
    return { ...listing, tickets: listing.tickets.map((ticket) => this.project(ticket)) }
  }

  /** One `search` request per page; the service's hits and cursor are canonical. */
  private async searchPage(query: TicketSearchQuery): Promise<TicketSearchPage> {
    const page = await this.request(
      'search',
      {
        text: query.text,
        ...(query.state !== undefined ? { state: query.state } : {}),
        ...(query.labels !== undefined ? { labels: query.labels } : {}),
        limit: query.limit,
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      },
      {
        parse: (value: unknown) => {
          const parsed = ticketSearchPageWireSchema.safeParse(value)
          if (!parsed.success)
            throw new Error(
              `ticket service answered an invalid search page: ${parsed.error.message}`,
            )
          return parsed.data
        },
      },
    )
    if (page.tickets.length > query.limit)
      throw new Error(
        `ticket service answered an invalid search page: ${page.tickets.length} hits for limit ${query.limit}`,
      )
    return page
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
