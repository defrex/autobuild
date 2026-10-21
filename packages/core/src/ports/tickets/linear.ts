import { validateTicketTree } from './tree'
import { ticketRevision } from './revision'
/**
 * Linear TicketSource (SPEC §3.2, §13): GraphQL over an injectable fetch, so
 * tests run offline against canned exchanges. Queries are deliberately
 * minimal — only the fields the Ticket shape needs — and responses are typed
 * as small structural types rather than a generated client.
 *
 * Policy (§13): initiation, pre-build grooming, and outward projections only.
 * Nothing here is called mid-build; the build never reads or edits Linear
 * after dispatch imports the spec.
 */
import { z } from 'zod'
import type {
  ExportSnapshotOptions,
  DependencyState,
  Ticket,
  TicketCreateOptions,
  TicketDraft,
  TicketListing,
  TicketSource,
  TicketUpdate,
} from '../types'
import { TicketSourceRateLimitError } from '../types'
import { validateTicketUpdate } from './update'

export const LINEAR_API_URL = 'https://api.linear.app/graphql'

/** One entry of a GraphQL `errors` array — the fields this adapter reads. */
interface GqlError {
  message: string
  path?: string[]
  extensions?: { code?: string; type?: string }
}

/**
 * A GraphQL-level failure, carrying the structured errors rather than only a
 * joined message: callers must be able to tell "no such issue" from "rate
 * limited", and a substring match on prose cannot be trusted with that.
 */
export class LinearGqlError extends Error {
  constructor(
    message: string,
    readonly errors: GqlError[],
  ) {
    super(message)
    this.name = 'LinearGqlError'
  }
}

/**
 * Linear reports an unknown issue identifier as a GraphQL ERROR
 * (`Entity not found: Issue`, extensions.code `INPUT_ERROR`) — NOT as
 * `{issue: null}`, which is what the shape of the query suggests. Verified
 * against the live API; a canned fixture would happily agree with either
 * guess, so this predicate exists because the real thing was asked.
 *
 * Every error in the set must be a not-found for this to be "missing": a
 * response mixing not-found with a rate-limit error is a real failure and
 * must not be quietly read as an absent ticket.
 */
function isEntityNotFound(error: unknown): boolean {
  return (
    error instanceof LinearGqlError &&
    error.errors.length > 0 &&
    error.errors.every(
      (e) => e.extensions?.code === 'INPUT_ERROR' && /entity not found/i.test(e.message),
    )
  )
}

/** The narrow slice of fetch this adapter needs — injectable for tests. */
export type LinearFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean
  status: number
  headers?: { get(name: string): string | null }
  json(): Promise<unknown>
}>

// ── Wire shapes (small structural types per operation) ───────────────────────

interface GqlIssueRelation {
  id?: string
  type: string
  issue: { id?: string; identifier: string; state?: { type: string } | null } | null
}

interface PageInfo {
  hasNextPage: boolean
  endCursor: string | null
}
interface RelationOwner {
  inverseRelations?: { nodes: GqlIssueRelation[]; pageInfo?: PageInfo }
}
interface DependencyIssue extends RelationOwner {
  id?: string
  identifier: string
  state: { type: string } | null
}
interface Connection<T> {
  nodes: T[]
  pageInfo: PageInfo
}

interface GqlIssue {
  team?: { key: string }
  parent?: {
    id: string
    identifier: string
    team?: { key: string }
    labels: { nodes: Array<{ name: string }>; pageInfo?: PageInfo }
  } | null
  id?: string
  identifier: string
  title: string
  description: string | null
  url: string
  state: { name: string; type: string } | null
  labels: { nodes: Array<{ name: string }>; pageInfo?: PageInfo }
  comments?: Connection<{ body: string; createdAt: string; user: { name: string } | null }>
  /** Relations where THIS issue is the `relatedIssue` side. A relation
   * `{issue: A, relatedIssue: B, type: "blocks"}` reads "A blocks B", so an
   * issue's blockers are its inverse `blocks` relations, and the blocker is
   * each relation's `issue`. Relation ids are required by the delete API. */
  inverseRelations?: { nodes: GqlIssueRelation[]; pageInfo?: PageInfo }
}

/**
 * Linear's workflow state types (the `state.type` taxonomy):
 * `backlog | unstarted | started | completed | canceled`. Resolution is
 * provider-owned (§13) — a blocker is done when Linear says the work is
 * finished, either by completion or by cancelation. Any unrecognized type
 * fails CLOSED (unresolved): a dependency we cannot interpret must hold the
 * ticket and show up in the dispatcher's diagnostics, never wave it through.
 */
const RESOLVED_STATE_TYPES = new Set(['completed', 'canceled'])

/** Native inverse `blocks` relations for one blocked issue. */
function blockerRelationsOf(issue: RelationOwner): GqlIssueRelation[] {
  return (issue.inverseRelations?.nodes ?? []).filter(
    (relation) => relation.type === 'blocks' && relation.issue !== null,
  )
}

/** The identifiers blocking `issue`; unrelated relation kinds are ignored. */
function blockersOf(issue: RelationOwner): string[] {
  return [...new Set(blockerRelationsOf(issue).map((relation) => relation.issue!.identifier))]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function blockerList(ids: string[]): string {
  return ids.length > 0 ? ids.map((id) => `"${id}"`).join(', ') : 'none'
}

/**
 * `issueCreate` and relation creation are separate Linear mutations. Once the
 * former succeeds, every failure must say that an issue now exists: otherwise
 * an operator can reasonably retry the command and create a duplicate. Keep
 * the original failure in both the message (the CLI prints only that) and the
 * structured cause (for programmatic callers).
 */
function blockerRecordingError(
  issue: GqlIssue,
  requested: string[],
  recorded: string[],
  cause: unknown,
  retryableById: boolean,
): Error {
  const recordedSet = new Set(recorded)
  const unrecorded = requested.filter((id) => !recordedSet.has(id))
  const guidance = retryableById
    ? 'Retry with the same idempotency key; Linear will adopt this ticket and reconcile only missing blockers. '
    : 'Do not rerun ticket creation; repair the blockers on the existing ticket. '
  return new Error(
    `linear create: ticket "${issue.identifier}" ${retryableById ? 'already exists' : 'was created'} at ${issue.url}, ` +
      'but its blockers were not all recorded. ' +
      `Blockers recorded: ${blockerList(recorded)}. ` +
      `Blockers not recorded: ${blockerList(unrecorded)}. ` +
      guidance +
      `Underlying failure: ${errorMessage(cause)}`,
    { cause },
  )
}

interface GqlIssueLabel {
  id: string
  name: string
}

interface GqlTeamInfo {
  teams: {
    nodes: Array<{
      id: string
      states: { nodes: Array<{ id: string; name: string }> }
      labels: { nodes: GqlIssueLabel[] }
    }>
  }
}

interface LinearTeamInfo {
  teamId: string
  stateIds: Map<string, string>
  labelIds: Map<string, string>
}

/** Direct issue reads and grooming retain the existing 250-relation window.
 * Dependency graph reads accumulate that window in smaller pages; ready
 * listings exhaust relations so they can safely report blocker completion. */
export const LINEAR_RELATION_PAGE_SIZE = 250

const METADATA_FIELDS =
  'team { key } parent { id identifier team { key } labels(first: 50) { nodes { name } pageInfo { hasNextPage endCursor } } }'

const ISSUE_FIELDS =
  `${METADATA_FIELDS} id identifier title description url state { name type } labels(first: 50) { nodes { name } pageInfo { hasNextPage endCursor } } ` +
  `inverseRelations(first: ${LINEAR_RELATION_PAGE_SIZE}) { nodes { id type issue { id identifier } } }`

// Linear computes complexity from requested bounds, not returned counts:
// https://linear.app/developers/rate-limiting. Scalars cost .1, objects 1.
// Dependency: 25 * (1.2 + 1.1 + 100 * 2.2 + 1.2) + wrappers < 5,600.
// Ready: 10 * (10 + 50 * 1.1 + 100 * 3.5 + 1.2) + wrappers < 4,200.
// Continuations: <=25 * (2 + 100 * 2.2 + 1.2) < 5,600, or
// <=10 * (2 + 100 * 3.5 + 1.2) < 3,600. Every shape stays below 8,000.
const DEPENDENCY_PAGE_SIZE = 25
const READY_PAGE_SIZE = 10
const RELATION_PAGE_SIZE = 100
const READY_LABEL_PAGE_SIZE = 50
const PAGE_INFO = 'pageInfo { hasNextPage endCursor }'
const DEPENDENCY_RELATIONS = 'type issue { identifier }'
const READY_RELATIONS = 'id type issue { id identifier state { type } }'
const relationFields = (ready: boolean) => (ready ? READY_RELATIONS : DEPENDENCY_RELATIONS)
const dependencyFields = `id identifier state { type } inverseRelations(first: ${RELATION_PAGE_SIZE}) { nodes { ${DEPENDENCY_RELATIONS} } ${PAGE_INFO} }`
const DEPENDENCY_QUERY = `query Dependencies($filter: IssueFilter!, $first: Int!, $after: String) { issues(filter: $filter, first: $first, after: $after, includeArchived: true) { nodes { ${dependencyFields} } ${PAGE_INFO} } }`
const DEPENDENCY_FALLBACK_QUERY = `query Dependency($id: String!) { issue(id: $id) { ${dependencyFields} } }`
const READY_FIELDS = `${METADATA_FIELDS} id identifier title description url state { name type } labels(first: ${READY_LABEL_PAGE_SIZE}) { nodes { name } ${PAGE_INFO} } inverseRelations(first: ${RELATION_PAGE_SIZE}) { nodes { ${READY_RELATIONS} } ${PAGE_INFO} }`
const LIST_READY_QUERY = `query ListReady($filter: IssueFilter!, $first: Int!, $after: String) { issues(filter: $filter, first: $first, after: $after) { nodes { ${READY_FIELDS} } ${PAGE_INFO} } }`

/** Refuse partial success and cursor loops on every connection independently. */
function nextCursor(info: PageInfo | undefined, seen: Set<string>): string | null {
  if (!info || typeof info.hasNextPage !== 'boolean') throw new Error('linear: missing pageInfo')
  if (!info.hasNextPage) return null
  const cursor = info.endCursor
  if (!cursor || seen.has(cursor)) throw new Error('linear: invalid or repeated pagination cursor')
  seen.add(cursor)
  return cursor
}

const DETAIL_FIELDS = `${METADATA_FIELDS} id identifier title description url state { name type } labels(first: 100) { nodes { name } ${PAGE_INFO} } inverseRelations(first: 100) { nodes { ${READY_RELATIONS} } ${PAGE_INFO} } comments(first: 100, includeArchived: true, orderBy: createdAt) { nodes { body createdAt user { name } } ${PAGE_INFO} }`
const GET_DETAIL_QUERY = `query GetIssue($id: String!) { issue(id: $id) { ${DETAIL_FIELDS} } }`
const GET_ISSUE_QUERY = `query GetIssue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`
const RESOLVE_ISSUE_QUERY = `query ResolveIssue($id: String!) { issue(id: $id) { id } }`
const ISSUE_STATE_QUERY = `query IssueState($id: String!) { issue(id: $id) { id state { name type } } }`
const TEAM_INFO_QUERY = `query TeamInfo($teamKey: String!) { teams(filter: { key: { eq: $teamKey } }) { nodes { id states { nodes { id name } } labels { nodes { id name } } } } }`
const EXACT_TEAM_LABEL_QUERY = `query ExactTeamLabel($teamId: String!, $name: String!) { team(id: $teamId) { labels(filter: { name: { eq: $name } }) { nodes { id name } } } }`
const CREATE_LABEL_MUTATION = `mutation CreateIssueLabel($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success issueLabel { id name } } }`
const UPDATE_STATE_MUTATION = `mutation UpdateState($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }`
const CREATE_COMMENT_MUTATION = `mutation CreateComment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }`
const CREATE_ISSUE_MUTATION = `mutation CreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } } }`
const UPDATE_ISSUE_MUTATION = `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`
const CREATE_RELATION_MUTATION = `mutation CreateRelation($issueId: String!, $relatedIssueId: String!) { issueRelationCreate(input: { issueId: $issueId, relatedIssueId: $relatedIssueId, type: blocks }) { success } }`
const DELETE_RELATION_MUTATION = `mutation DeleteRelation($id: String!) { issueRelationDelete(id: $id) { success } }`
const linearReservedIssueIdSchema = z.uuidv4()

type ReadQuery = <T>(
  operation: string,
  query: string,
  variables: Record<string, unknown>,
) => Promise<T>
class ExportRateLimit extends TicketSourceRateLimitError {
  constructor(
    resetAt: number,
    readonly exportReset?: number,
  ) {
    super('linear', resetAt)
  }
}

async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    const abort = () => {
      cleanup()
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

export class LinearTicketSource implements TicketSource {
  readonly name = 'linear'
  readonly integrationTree = true

  async readExportSnapshot(opts: ExportSnapshotOptions = {}): Promise<Ticket[]> {
    let completed = 0
    let total: number | undefined
    const progress = (resetAt?: number) => opts.progress?.({ completed, total, resetAt })
    const read: ReadQuery = async <T>(
      operation: string,
      query: string,
      variables: Record<string, unknown>,
    ): Promise<T> => {
      for (;;) {
        opts.signal?.throwIfAborted()
        try {
          return await this.gql<T>(operation, query, variables, opts.signal, true)
        } catch (error) {
          opts.signal?.throwIfAborted()
          if (
            !(error instanceof ExportRateLimit) ||
            error.exportReset === undefined ||
            error.exportReset <= this.now()
          )
            throw error
          progress(error.exportReset)
          while (this.now() < error.exportReset) {
            await this.sleep(Math.min(error.exportReset - this.now(), 2_147_483_647), opts.signal)
            opts.signal?.throwIfAborted()
          }
        }
      }
    }
    // Linear charges .1 per scalar and 1 per object, multiplied by bounds:
    // 20 * (15 metadata/wrappers + 2*25*1.1 labels + 25*3.5 relations
    // + 25*2.3 comments) + 250*1.1 inventory + wrappers < 5,000 points.
    // https://linear.app/developers/rate-limiting (query ceiling: 10,000).
    const detailFields = DETAIL_FIELDS.replaceAll('first: 100', 'first: 25').replaceAll(
      'first: 50',
      'first: 25',
    )
    const selection = `issues(filter: $filter, first: 20, after: $after, includeArchived: true) { nodes { ${detailFields} } ${PAGE_INFO} }`
    const inventory = `issues(filter: $filter, first: 250, after: $after, includeArchived: true) { nodes { id } ${PAGE_INFO} }`
    const filter = { team: { key: { eq: this.teamKey } } }
    const query = `query ExportSnapshot($filter: IssueFilter!, $after: String) { ${selection} inventory: ${inventory} }`
    progress()
    const first = await read<{
      issues: Connection<GqlIssue>
      inventory: Connection<{ id: string }>
    }>('export', query, { filter, after: null })
    const ids = new Set<string>()
    const collect = (page: Connection<{ id?: string }>) => {
      for (const issue of page.nodes) {
        if (!issue.id || ids.has(issue.id))
          throw new Error('linear: duplicate or missing export identity')
        ids.add(issue.id)
      }
    }
    collect(first.inventory)
    const inventorySeen = new Set<string>()
    let after = nextCursor(first.inventory.pageInfo, inventorySeen)
    while (after !== null) {
      const page = await read<{ issues: Connection<{ id: string }> }>(
        'exportInventory',
        `query ExportInventory($filter: IssueFilter!, $after: String) { ${inventory} }`,
        { filter, after },
      )
      collect(page.issues)
      after = nextCursor(page.issues.pageInfo, inventorySeen)
    }
    total = ids.size
    progress()
    const tickets: Ticket[] = []
    const seen = new Set<string>()
    let page = first.issues
    do {
      for (const issue of page.nodes) {
        if (!issue.id || !ids.delete(issue.id))
          throw new Error('linear: export identities disagree')
        tickets.push(await this.hydrateDetail(issue, issue.identifier, read))
        completed++
        progress()
      }
      after = nextCursor(page.pageInfo, seen)
      if (after !== null)
        page = (
          await read<{ issues: Connection<GqlIssue> }>(
            'export',
            `query ExportDetails($filter: IssueFilter!, $after: String) { ${selection} }`,
            { filter, after },
          )
        ).issues
    } while (after !== null)
    if (ids.size) throw new Error('linear: export identities disagree')
    return tickets
  }

  async listAll(): Promise<TicketListing> {
    return this.listReady({})
  }

  private readonly apiKey: string
  private readonly teamKey: string
  private readonly claimedState: string
  private readonly createState: string | undefined
  private readonly now: () => number
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  private cooldown?: TicketSourceRateLimitError
  private readonly fetchFn: LinearFetch

  /** identifier → Linear UUID, cached per instance. */
  private readonly issueIds = new Map<string, string>()
  /** One team query serves state ids, label ids, and the team id. */
  private teamInfo?: LinearTeamInfo
  private teamInfoLoad?: Promise<LinearTeamInfo>
  /** Exact label name → the one same-instance registry write in progress. */
  private readonly pendingLabelCreates = new Map<string, Promise<string>>()

  constructor(opts: {
    apiKey: string
    teamKey: string
    fetchFn?: LinearFetch
    now?: () => number
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
    /** Workflow state claim() moves the issue to (claim-before-launch, §12). */
    claimedState?: string
    /** Workflow state create() files new issues into; absent = Linear's team
     * default (whatever the team's default state is, e.g. Backlog). */
    createState?: string
  }) {
    this.now = opts.now ?? Date.now
    this.sleep = opts.sleep ?? abortableSleep
    this.apiKey = opts.apiKey
    this.teamKey = opts.teamKey
    this.claimedState = opts.claimedState ?? 'In Progress'
    this.createState = opts.createState
    this.fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init))
  }

  /** Exact team workflow names in provider order, used by trusted grooming UIs. */
  async workflowStateNames(): Promise<string[]> {
    return [...(await this.getTeamInfo('workflow states')).stateIds.keys()]
  }

  /** The Linear user a `readyAssignee` value names: `me` is the API key's
   * owner, anything else is an email. Null when no user matches. */
  async resolveAssignee(
    assignee: string,
  ): Promise<{ id: string; name: string; email: string } | null> {
    if (assignee === 'me') {
      const data = await this.gql<{ viewer: { id: string; name: string; email: string } | null }>(
        'resolveAssignee',
        'query Viewer { viewer { id name email } }',
        {},
      )
      return data.viewer ?? null
    }
    const data = await this.gql<{
      users: { nodes: { id: string; name: string; email: string }[] }
    }>(
      'resolveAssignee',
      'query UserByEmail($email: String!) { users(filter: { email: { eq: $email } }) { nodes { id name email } } }',
      { email: assignee },
    )
    return data.users.nodes[0] ?? null
  }

  async listReady(criteria: {
    labels?: string[]
    state?: string
    assignee?: string
  }): Promise<TicketListing> {
    const filter: Record<string, unknown> = {
      team: { key: { eq: this.teamKey } },
    }
    if (criteria.assignee !== undefined) {
      // An unassigned issue matches neither predicate, so it is never ready.
      filter.assignee =
        criteria.assignee === 'me' ? { isMe: { eq: true } } : { email: { eq: criteria.assignee } }
    }
    if (criteria.state !== undefined) {
      filter.state = { name: { eq: criteria.state } }
    }
    if (criteria.labels && criteria.labels.length > 0) {
      // and-of-somes: every requested label must be present.
      filter.and = criteria.labels.map((label) => ({
        labels: { some: { name: { eq: label } } },
      }))
    }
    const tickets: Ticket[] = []
    const seen = new Set<string>()
    let after: string | null = null
    do {
      const data: { issues: Connection<GqlIssue> } = await this.gql(
        'listReady',
        Object.values(criteria).every((value) => value === undefined)
          ? LIST_READY_QUERY.replace('after: $after)', 'after: $after, includeArchived: true)')
          : LIST_READY_QUERY,
        {
          filter,
          first: READY_PAGE_SIZE,
          after,
        },
      )
      await this.completeRelations(data.issues.nodes, true)
      for (const issue of data.issues.nodes) {
        await this.completeMetadata(issue)
        const relations = issue.inverseRelations!.nodes
        tickets.push({
          ...this.toTicket(issue),
          blockersResolved: relations.every(
            (relation) =>
              relation.type !== 'blocks' ||
              (!!relation.issue?.identifier &&
                RESOLVED_STATE_TYPES.has(relation.issue.state?.type ?? '')),
          ),
        })
      }
      after = nextCursor(data.issues.pageInfo, seen)
    } while (after !== null)
    return { tickets, diagnostics: [] }
  }

  async get(id: string): Promise<Ticket | null> {
    return this.readTicket(id, false)
  }

  /** Metadata validation stays within the configured team without narrowing
   * ordinary identifier/UUID reads, which can inspect workspace issues. */
  private validateTree(id: string | undefined, patch: TicketDraft | TicketUpdate) {
    return validateTicketTree(
      {
        name: this.name,
        get: (ticketId) => this.readTicket(ticketId, true),
        listAll: () => this.listAll(),
      },
      id,
      patch,
    )
  }

  private async readTicket(id: string, requireTeam: boolean): Promise<Ticket | null> {
    let data: { issue: GqlIssue | null }
    try {
      data = await this.gql<{ issue: GqlIssue | null }>('get', GET_DETAIL_QUERY, { id })
    } catch (error) {
      // Linear's `issue(id:)` field is non-null in the live schema: an unknown
      // identifier arrives as INPUT_ERROR / Entity not found rather than the
      // nullable-looking canned `{ issue: null }` shape.
      if (isEntityNotFound(error)) return null
      throw error
    }
    if (!data.issue) return null
    const issue = data.issue
    if (issue.id) {
      this.issueIds.set(id, issue.id)
      this.issueIds.set(issue.identifier, issue.id)
    }
    if (requireTeam && issue.team && issue.team.key !== this.teamKey)
      throw new Error(`target ${id} is in a different source/team (${issue.team.key})`)
    return this.hydrateDetail(issue, id)
  }

  private async hydrateDetail(
    issue: GqlIssue,
    id: string,
    read: ReadQuery = this.gql.bind(this),
  ): Promise<Ticket> {
    await this.completeMetadata(issue, false, read)
    // Detail reads exhaust labels and relations independently of dispatch bounds.
    const labels: Array<{ name: string }> = [...issue.labels.nodes]
    const labelSeen = new Set<string>()
    let labelAfter = nextCursor(issue.labels.pageInfo, labelSeen)
    while (labelAfter !== null) {
      const page: { issue: { labels: Connection<{ name: string }> } } = await read(
        'getLabels',
        `query TicketLabels($id: String!, $after: String) { issue(id: $id) { labels(first: 100, after: $after) { nodes { name } ${PAGE_INFO} } } }`,
        { id: issue.id ?? id, after: labelAfter },
      )
      labels.push(...page.issue.labels.nodes)
      labelAfter = nextCursor(page.issue.labels.pageInfo, labelSeen)
    }
    issue.labels = { nodes: labels }
    await this.completeRelations([issue], true, read)
    const mapComment = (c: { body: string; createdAt: string; user: { name: string } | null }) => ({
      body: c.body,
      createdAt: c.createdAt,
      ...(c.user ? { author: c.user.name } : {}),
    })
    const comments: import('../types').TicketComment[] = (issue.comments?.nodes ?? []).map(
      mapComment,
    )
    const seen = new Set<string>()
    let after = nextCursor(issue.comments?.pageInfo, seen)
    while (after !== null) {
      const page: {
        issue: {
          comments: Connection<{ body: string; createdAt: string; user: { name: string } | null }>
        }
      } = await read(
        'getComments',
        `query TicketComments($id: String!, $after: String) { issue(id: $id) { comments(first: 100, after: $after, includeArchived: true, orderBy: createdAt) { nodes { body createdAt user { name } } ${PAGE_INFO} } } }`,
        { id: issue.id ?? id, after },
      )
      comments.push(
        ...page.issue.comments.nodes.map((c) => ({
          body: c.body,
          createdAt: c.createdAt,
          ...(c.user ? { author: c.user.name } : {}),
        })),
      )
      after = nextCursor(page.issue.comments.pageInfo, seen)
    }
    comments.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    return { ...this.toTicket(issue), comments }
  }

  /**
   * Claim-before-launch (SPEC §12): refuse if the issue already sits in the
   * claimed state or Linear classifies it as terminal, else move it there.
   * The check-then-update pair is not transactional — a concurrent writer
   * could claim between the two calls — which is acceptable because the
   * dispatcher is the single writer (§12); the preflight still prevents claim
   * from serving as an implicit reopen operation.
   */
  async claim(id: string): Promise<boolean> {
    let data: {
      issue: { id: string; state: { name: string; type: string } | null } | null
    }
    try {
      data = await this.gql<{
        issue: { id: string; state: { name: string; type: string } | null } | null
      }>('claim', ISSUE_STATE_QUERY, { id })
    } catch (error) {
      if (isEntityNotFound(error)) return false
      throw error
    }
    if (!data.issue) return false
    if (
      data.issue.state?.name === this.claimedState ||
      RESOLVED_STATE_TYPES.has(data.issue.state?.type ?? '')
    ) {
      return false
    }
    this.issueIds.set(id, data.issue.id)
    await this.updateState('claim', data.issue.id, this.claimedState)
    return true
  }

  async comment(id: string, body: string): Promise<void> {
    const issueId = await this.resolveIssueId('comment', id)
    const data = await this.gql<{ commentCreate: { success: boolean } }>(
      'comment',
      CREATE_COMMENT_MUTATION,
      { issueId, body },
    )
    if (!data.commentCreate.success) {
      throw new Error(`linear comment: commentCreate failed for "${id}"`)
    }
  }

  async transition(id: string, state: string): Promise<void> {
    const issueId = await this.resolveIssueId('transition', id)
    await this.updateState('transition', issueId, state)
  }

  async create(draft: TicketDraft, opts: TicketCreateOptions = {}): Promise<Ticket> {
    if (opts.requestedId !== undefined) throw new Error('linear does not support requested ids')
    const reservedId = opts.idempotencyKey
    if (reservedId !== undefined && !linearReservedIssueIdSchema.safeParse(reservedId).success) {
      throw new Error('linear create: idempotency key must be a UUID v4')
    }
    const canonicalTarget =
      draft.target == null && draft.kind === undefined
        ? draft.target
        : await this.validateTree(reservedId, draft)
    const labels = this.effectiveLabels(draft.kind, draft.labels, [])
    const team = await this.getTeamInfo('create')
    const labelIds = await Promise.all(
      (labels ?? []).map((label) => this.ensureLabelId('create', label, team)),
    )
    const input: Record<string, unknown> = {
      teamId: team.teamId,
      title: draft.title,
      description: draft.body,
      labelIds,
    }
    const createState = opts.state ?? this.createState
    if (createState !== undefined) {
      const stateId = team.stateIds.get(createState)
      if (!stateId) {
        throw new Error(
          `linear create: no workflow state "${createState}" in team ` +
            `${this.teamKey} (known: ${[...team.stateIds.keys()].join(', ')})`,
        )
      }
      input.stateId = stateId
    }
    if (canonicalTarget != null)
      input.parentId = await this.resolveIssueId('create', canonicalTarget)
    if (reservedId !== undefined) input.id = reservedId

    let issue: GqlIssue | null = null
    let createError: unknown
    try {
      const data = await this.gql<{
        issueCreate: { success: boolean; issue: GqlIssue | null }
      }>('create', CREATE_ISSUE_MUTATION, { input })
      if (data.issueCreate.success && data.issueCreate.issue !== null) {
        issue = data.issueCreate.issue
      }
    } catch (error) {
      if (reservedId === undefined) throw error
      createError = error
    }

    if (issue === null && reservedId !== undefined) {
      // The create may have committed before the caller/store crashed, or a
      // prior attempt may have stopped while recording relations. Adopt the
      // exact reserved issue and send it through the same blocker completion
      // path as a fresh create.
      issue = await this.adoptCreatedIssue(reservedId)
    }
    if (issue === null) {
      if (createError !== undefined) throw createError
      throw new Error(`linear create: issueCreate failed for "${draft.title}"`)
    }

    await this.completeMetadata(issue)
    return this.completeCreateBlockers(issue, draft.blockedBy ?? [], reservedId !== undefined)
  }

  async update(id: string, patch: TicketUpdate): Promise<void> {
    const validated = validateTicketUpdate(patch)
    if (
      validated.kind !== undefined ||
      validated.target !== undefined ||
      validated.labels !== undefined
    ) {
      const current = await this.readTicket(id, true)
      if (!current) throw new Error(`linear update: unknown ticket ${id}`)
      validated.labels = this.effectiveLabels(validated.kind, validated.labels, current.labels)
      const effectiveKind = validated.labels?.includes('node')
        ? 'node'
        : validated.labels !== undefined
          ? 'work'
          : current.kind
      if (validated.target !== undefined || (current.kind === 'node' && effectiveKind === 'work'))
        validated.target = await this.validateTree(id, { ...validated, kind: effectiveKind })
    }
    const issueId = await this.resolveIssueId('update', id)
    const input: Record<string, unknown> = {}

    if (validated.target === null) input.parentId = null
    else if (validated.target !== undefined)
      input.parentId = await this.resolveIssueId('update', validated.target)
    if (validated.title !== undefined) input.title = validated.title
    if (validated.body !== undefined) input.description = validated.body
    if (validated.labels !== undefined) {
      if (validated.labels.length === 0) {
        input.labelIds = []
      } else {
        const team = await this.getTeamInfo('update')
        input.labelIds = await Promise.all(
          validated.labels.map((label) => this.ensureLabelId('update', label, team)),
        )
      }
    }

    const data = await this.gql<{ issueUpdate: { success: boolean } }>(
      'update',
      UPDATE_ISSUE_MUTATION,
      { id: issueId, input },
    )
    if (!data.issueUpdate.success) {
      throw new Error(`linear update: issueUpdate failed for "${id}"`)
    }
  }

  async addBlocker(id: string, blockerId: string): Promise<void> {
    const target = await this.lookupIssue('addBlocker', id)
    if (id === blockerId) {
      throw new Error(`linear addBlocker: ticket "${id}" cannot block itself`)
    }

    if (
      blockerRelationsOf(target).some(
        (relation) => relation.issue?.identifier === blockerId || relation.issue?.id === blockerId,
      )
    ) {
      return
    }

    const targetId = this.requiredIssueId('addBlocker', id, target)
    const blockerUuid = await this.resolveIssueId('addBlocker', blockerId)
    // Identifiers and UUIDs are both accepted by Linear's issue lookup. Catch
    // aliases that refer to the same issue, not only equal CLI strings.
    if (targetId === blockerUuid) {
      throw new Error(`linear addBlocker: ticket "${id}" cannot block itself`)
    }

    const data = await this.gql<{
      issueRelationCreate: { success: boolean }
    }>('addBlocker', CREATE_RELATION_MUTATION, {
      issueId: blockerUuid,
      relatedIssueId: targetId,
    })
    if (!data.issueRelationCreate.success) {
      throw new Error(
        `linear addBlocker: issueRelationCreate failed — "${blockerId}" was ` +
          `not recorded as blocking "${id}"`,
      )
    }
  }

  async removeBlocker(id: string, blockerId: string): Promise<void> {
    const target = await this.lookupIssue('removeBlocker', id)
    const matches = blockerRelationsOf(target).filter(
      (relation) => relation.issue?.identifier === blockerId || relation.issue?.id === blockerId,
    )
    if (matches.length === 0) return

    // Validate every deletion identity before the first mutation so a malformed
    // provider projection cannot produce an avoidable partial removal.
    const relationIds = matches.map((relation) => {
      if (relation.id === undefined) {
        throw new Error(
          `linear removeBlocker: relation for "${blockerId}" blocking "${id}" has no id`,
        )
      }
      return relation.id
    })
    for (const relationId of relationIds) {
      const data = await this.gql<{
        issueRelationDelete: { success: boolean }
      }>('removeBlocker', DELETE_RELATION_MUTATION, { id: relationId })
      if (!data.issueRelationDelete.success) {
        throw new Error(
          `linear removeBlocker: issueRelationDelete failed for relation "${relationId}" ` +
            `("${blockerId}" blocking "${id}")`,
        )
      }
    }
  }

  /** One request per team/UUID group per issue page, plus batched relation
   * continuation pages. No cache: workflow changes are visible next tick.
   * Filter schema: https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql */
  async dependencyStates(ids: string[]): Promise<DependencyState[]> {
    const groups = new Map<
      string,
      { filter: Record<string, unknown>; values: Set<string | number> }
    >()
    const lookups = new Map<string, string>()
    const fallback = new Set<string>()
    for (const id of ids) {
      const match = /^([A-Z][A-Z0-9-]*)-([1-9][0-9]*)$/.exec(id)
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
      const number = match ? Number(match[2]) : 0
      if (!uuid && !(match && Number.isSafeInteger(number))) {
        fallback.add(id)
        lookups.set(id, id)
        continue
      }
      const key = uuid ? 'uuid' : match![1]!
      const group = groups.get(key) ?? {
        filter: uuid ? {} : { team: { key: { eq: key } } },
        values: new Set<string | number>(),
      }
      group.values.add(uuid ? id.toLowerCase() : number)
      groups.set(key, group)
      lookups.set(id, uuid ? id.toLowerCase() : id)
    }
    const found = new Map<string, DependencyIssue>()
    for (const [key, group] of groups) {
      const filter = {
        ...group.filter,
        [key === 'uuid' ? 'id' : 'number']: { in: [...group.values] },
      }
      const seen = new Set<string>()
      let after: string | null = null
      do {
        const data: { issues: Connection<DependencyIssue> } = await this.gql(
          'dependencyStates',
          DEPENDENCY_QUERY,
          {
            filter,
            first: DEPENDENCY_PAGE_SIZE,
            after,
          },
        )
        await this.completeRelations(data.issues.nodes, false)
        for (const issue of data.issues.nodes) {
          found.set(issue.identifier, issue)
          if (issue.id) found.set(issue.id.toLowerCase(), issue)
        }
        after = nextCursor(data.issues.pageInfo, seen)
      } while (after !== null)
    }
    for (const id of fallback) {
      let data: { issue: DependencyIssue | null }
      try {
        data = await this.gql('dependencyStates', DEPENDENCY_FALLBACK_QUERY, { id })
      } catch (error) {
        if (isEntityNotFound(error)) continue
        throw error
      }
      if (data.issue) {
        await this.completeRelations([data.issue], false)
        found.set(id, data.issue)
      }
    }
    return ids.map((id) => {
      const issue = found.get(lookups.get(id)!)
      return {
        id,
        exists: !!issue,
        resolved: !!issue && RESOLVED_STATE_TYPES.has(issue.state?.type ?? ''),
        blockedBy: issue ? blockersOf(issue) : [],
      }
    })
  }

  /** Each alias owns a cursor. Graph reads retain the historic first 250
   * relations; listing reads exhaust relations, including blockers after 250. */
  private async completeRelations(
    issues: DependencyIssue[],
    ready: boolean,
    read: ReadQuery = this.gql.bind(this),
  ): Promise<void> {
    const pending = issues.map((issue) => ({
      issue,
      seen: new Set<string>(),
      after: null as string | null,
    }))
    for (const item of pending)
      item.after = nextCursor(item.issue.inverseRelations?.pageInfo, item.seen)
    for (;;) {
      const batch = pending.filter(
        (item) =>
          item.after !== null &&
          (ready || item.issue.inverseRelations!.nodes.length < LINEAR_RELATION_PAGE_SIZE),
      )
      if (batch.length === 0) return
      const definitions: string[] = []
      const selections: string[] = []
      const variables: Record<string, unknown> = {}
      batch.forEach((item, n) => {
        if (!item.issue.id) throw new Error('linear: relation continuation requires issue id')
        definitions.push(`$id${n}: String!, $first${n}: Int!, $after${n}: String!`)
        selections.push(
          `r${n}: issue(id: $id${n}) { inverseRelations(first: $first${n}, after: $after${n}) { nodes { ${relationFields(ready)} } ${PAGE_INFO} } }`,
        )
        variables[`id${n}`] = item.issue.id
        variables[`first${n}`] = ready
          ? RELATION_PAGE_SIZE
          : Math.min(
              RELATION_PAGE_SIZE,
              LINEAR_RELATION_PAGE_SIZE - item.issue.inverseRelations!.nodes.length,
            )
        variables[`after${n}`] = item.after
      })
      const data = await read<Record<string, RelationOwner | null>>(
        'relations',
        `query Relations(${definitions.join(', ')}) { ${selections.join(' ')} }`,
        variables,
      )
      batch.forEach((item, n) => {
        const connection = data[`r${n}`]?.inverseRelations
        const after = nextCursor(connection?.pageInfo, item.seen)
        if (!connection) throw new Error('linear: missing relation continuation')
        item.issue.inverseRelations!.nodes.push(...connection.nodes)
        item.after = after
      })
    }
  }

  private effectiveLabels(
    kind: TicketDraft['kind'],
    labels: string[] | undefined,
    existing: string[],
  ): string[] | undefined {
    if (kind !== undefined && kind !== 'work' && kind !== 'node')
      throw new Error('kind must be work or node')
    if (kind !== undefined && labels !== undefined && (kind === 'node') !== labels.includes('node'))
      throw new Error('conflicting kind and node label instructions')
    if (kind === undefined) return labels
    const result = (labels ?? existing).filter((label) => label !== 'node')
    if (kind === 'node') result.push('node')
    return result
  }

  private async completeMetadata(
    issue: GqlIssue,
    ownLabels = true,
    read: ReadQuery = this.gql.bind(this),
  ): Promise<void> {
    const complete = async (owner: {
      id?: string
      identifier: string
      labels: GqlIssue['labels']
    }): Promise<void> => {
      const seen = new Set<string>()
      let after = nextCursor(owner.labels.pageInfo, seen)
      const labels = [...owner.labels.nodes]
      while (after !== null) {
        const page: { issue: { labels: Connection<{ name: string }> } } = await read(
          'metadataLabels',
          `query TicketLabels($id: String!, $after: String) { issue(id: $id) { labels(first: 100, after: $after) { nodes { name } ${PAGE_INFO} } } }`,
          { id: owner.id ?? owner.identifier, after },
        )
        labels.push(...page.issue.labels.nodes)
        after = nextCursor(page.issue.labels.pageInfo, seen)
      }
      owner.labels = { nodes: labels }
    }
    if (ownLabels) await complete(issue)
    if (issue.parent) await complete(issue.parent)
  }

  // ── Plumbing ───────────────────────────────────────────────────────────────

  private async lookupIssue(operation: string, id: string): Promise<GqlIssue> {
    let data: { issue: GqlIssue | null }
    try {
      data = await this.gql<{ issue: GqlIssue | null }>(operation, GET_ISSUE_QUERY, { id })
    } catch (error) {
      if (isEntityNotFound(error)) {
        throw new Error(`linear ${operation}: unknown ticket "${id}"`)
      }
      throw error
    }
    if (data.issue === null) {
      throw new Error(`linear ${operation}: unknown ticket "${id}"`)
    }

    if (data.issue.id !== undefined) {
      this.issueIds.set(id, data.issue.id)
      this.issueIds.set(data.issue.identifier, data.issue.id)
      for (const relation of data.issue.inverseRelations?.nodes ?? []) {
        if (relation.issue?.id !== undefined) {
          this.issueIds.set(relation.issue.identifier, relation.issue.id)
        }
      }
    }
    return data.issue
  }

  private requiredIssueId(operation: string, requestedId: string, issue: GqlIssue): string {
    if (issue.id === undefined) {
      throw new Error(`linear ${operation}: ticket "${requestedId}" response has no issue id`)
    }
    return issue.id
  }

  /** `issueCreate` and relation writes are separate mutations. Both a fresh
   * response and a reserved-id adoption must leave this method only after all
   * requested blockers are present; retries skip relations already observed. */
  private async completeCreateBlockers(
    issue: GqlIssue,
    requestedIds: string[],
    retryableById: boolean,
  ): Promise<Ticket> {
    const requested = [...new Set(requestedIds)]
    if (requested.length === 0) return this.toTicket(issue)

    const existing = blockerRelationsOf(issue)
    const recorded = requested.filter((id) =>
      existing.some((relation) => relation.issue?.identifier === id || relation.issue?.id === id),
    )
    try {
      const createdId = issue.id
      if (createdId === undefined) {
        throw new Error('linear create: issueCreate returned no id — cannot record blockers')
      }
      this.issueIds.set(issue.identifier, createdId)
      for (const relation of existing) {
        if (relation.issue?.id !== undefined) {
          this.issueIds.set(relation.issue.identifier, relation.issue.id)
        }
      }
      for (const blockerId of requested) {
        if (recorded.includes(blockerId)) continue
        // Direction matters and is the inverse of how it reads aloud: the
        // BLOCKER is `issueId` and the new issue is `relatedIssueId`, because
        // Linear's `blocks` relation reads "issueId blocks relatedIssueId".
        const blockerUuid = await this.resolveIssueId('create', blockerId)
        const relation = await this.gql<{
          issueRelationCreate: { success: boolean }
        }>('create', CREATE_RELATION_MUTATION, {
          issueId: blockerUuid,
          relatedIssueId: createdId,
        })
        if (!relation.issueRelationCreate.success) {
          throw new Error(
            `linear create: issueRelationCreate failed — "${blockerId}" was ` +
              `not recorded as blocking "${issue.identifier}"`,
          )
        }
        recorded.push(blockerId)
      }
    } catch (error) {
      throw blockerRecordingError(issue, requested, recorded, error, retryableById)
    }

    // The issue projection predates newly created relations. Preserve native
    // existing blockers and report the requested set now known to be recorded.
    const blockedBy = [...new Set([...blockersOf(issue), ...requested])]
    const ticket = { ...this.toTicket(issue), ...(blockedBy.length > 0 ? { blockedBy } : {}) }
    return { ...ticket, revision: ticketRevision(ticket) }
  }

  private async adoptCreatedIssue(id: string): Promise<GqlIssue | null> {
    try {
      const adopted = await this.gql<{ issue: GqlIssue | null }>('create-adopt', GET_ISSUE_QUERY, {
        id,
      })
      return adopted.issue
    } catch {
      // Preserve the original create failure; an adoption probe is recovery,
      // not a reason to hide the operation that actually failed.
      return null
    }
  }

  private async gql<T>(
    operation: string,
    query: string,
    variables: Record<string, unknown>,
    signal?: AbortSignal,
    exportRead = false,
  ): Promise<T> {
    signal?.throwIfAborted()
    const exportReset =
      this.cooldown instanceof ExportRateLimit ? this.cooldown.exportReset : undefined
    const cooldownUntil =
      exportRead && exportReset !== undefined ? exportReset : this.cooldown?.resetAt
    if (this.cooldown && cooldownUntil !== undefined && this.now() < cooldownUntil)
      throw this.cooldown
    const response = await this.fetchFn(LINEAR_API_URL, {
      method: 'POST',
      signal,
      headers: {
        Authorization: this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    })
    signal?.throwIfAborted()
    const http = `linear ${operation}: HTTP ${response.status}`
    let raw: unknown
    try {
      raw = await response.json()
    } catch (error) {
      if (!response.ok) throw new Error(http)
      throw error
    }
    signal?.throwIfAborted()
    const payload = (raw !== null && typeof raw === 'object' ? raw : {}) as {
      data?: T | null
      errors?: GqlError[]
    }
    const errors = Array.isArray(payload.errors)
      ? payload.errors.filter((e) => e !== null && typeof e === 'object')
      : []
    if (errors.some((e) => e.extensions?.code === 'RATELIMITED')) {
      const now = this.now()
      const reset = Number(response.headers?.get('x-ratelimit-requests-reset'))
      // Missing, expired or unrepresentable provider dates get a bounded fallback.
      const resetAt =
        Number.isFinite(reset) && reset > now && reset > 0 && reset <= 8.64e15
          ? reset
          : now + 60_000
      const kinds = ['requests', 'complexity', 'endpoint-requests']
      const exhausted = kinds.filter((kind) => {
        const remaining = response.headers?.get(`x-ratelimit-${kind}-remaining`)
        return remaining?.trim() && Number.isFinite(Number(remaining)) && Number(remaining) <= 0
      })
      const resets = (exhausted.length ? exhausted : kinds).flatMap((kind) => {
        const value = response.headers?.get(`x-ratelimit-${kind}-reset`)
        const date = value?.trim() ? Number(value) : NaN
        return Number.isFinite(date) && date > now && date <= 8.64e15 ? [date] : []
      })
      this.cooldown = new ExportRateLimit(resetAt, resets.length ? Math.max(...resets) : undefined)
      throw this.cooldown
    }
    if (errors.length > 0) {
      const messages = errors
        .map((e) => `${e.extensions?.code ? `${e.extensions.code}: ` : ''}${e.message}`)
        .join('; ')
      throw new LinearGqlError(
        `${response.ok ? `linear ${operation}` : http}: GraphQL errors — ${messages}`,
        errors,
      )
    }
    if (!response.ok) throw new Error(http)
    if (payload.data === undefined || payload.data === null) {
      throw new Error(`linear ${operation}: response has no data`)
    }
    // An older in-flight success must not cancel a still-active cooldown.
    if (this.cooldown && this.now() >= this.cooldown.resetAt) this.cooldown = undefined
    return payload.data
  }

  private async resolveIssueId(operation: string, id: string): Promise<string> {
    const cached = this.issueIds.get(id)
    if (cached) return cached
    let data: { issue: { id: string } | null }
    try {
      data = await this.gql<{ issue: { id: string } | null }>(operation, RESOLVE_ISSUE_QUERY, {
        id,
      })
    } catch (error) {
      // Live Linear raises a GraphQL error for an unknown identifier rather
      // than returning null — surface this adapter's own actionable message
      // either way, instead of leaking `Entity not found: Issue`.
      if (isEntityNotFound(error)) {
        throw new Error(`linear ${operation}: unknown ticket "${id}"`)
      }
      throw error
    }
    if (!data.issue) {
      throw new Error(`linear ${operation}: unknown ticket "${id}"`)
    }
    this.issueIds.set(id, data.issue.id)
    return data.issue.id
  }

  /**
   * Resolve a provider label registry entry at the write boundary. Known ids
   * stay on the team cache's fast path; simultaneous requests on one adapter
   * share a mutation, while cross-instance races reconcile by exact name.
   */
  private async ensureLabelId(
    operation: string,
    label: string,
    team: LinearTeamInfo,
  ): Promise<string> {
    const known = team.labelIds.get(label)
    if (known !== undefined) return known

    const pending = this.pendingLabelCreates.get(label)
    if (pending !== undefined) return pending

    const creating = this.createLabel(operation, label, team)
    this.pendingLabelCreates.set(label, creating)
    try {
      return await creating
    } finally {
      if (this.pendingLabelCreates.get(label) === creating) {
        this.pendingLabelCreates.delete(label)
      }
    }
  }

  private async createLabel(
    operation: string,
    label: string,
    team: LinearTeamInfo,
  ): Promise<string> {
    try {
      const data = await this.gql<{
        issueLabelCreate: { success: boolean; issueLabel: GqlIssueLabel | null }
      }>(`${operation}-label`, CREATE_LABEL_MUTATION, {
        input: { name: label, teamId: team.teamId },
      })
      const created = data.issueLabelCreate.issueLabel
      if (!data.issueLabelCreate.success || created === null || created.name !== label) {
        throw new Error(`linear ${operation}: issueLabelCreate failed for "${label}"`)
      }
      team.labelIds.set(label, created.id)
      return created.id
    } catch (error) {
      // Another process may have won after our cached team-label snapshot.
      // Only an exact provider lookup can convert the failed mutation into a
      // success; otherwise retain the original mutation failure verbatim.
      const winner = await this.findExactTeamLabel(operation, label, team.teamId)
      if (winner !== null) {
        team.labelIds.set(label, winner.id)
        return winner.id
      }
      throw error
    }
  }

  private async findExactTeamLabel(
    operation: string,
    label: string,
    teamId: string,
  ): Promise<GqlIssueLabel | null> {
    try {
      const data = await this.gql<{
        team: { labels: { nodes: GqlIssueLabel[] } } | null
      }>(`${operation}-label-race`, EXACT_TEAM_LABEL_QUERY, { teamId, name: label })
      return data.team?.labels.nodes.find((candidate) => candidate.name === label) ?? null
    } catch {
      return null
    }
  }

  /** State/label ids by name and the team id — fetched once, cached. */
  private async getTeamInfo(operation: string): Promise<LinearTeamInfo> {
    if (this.teamInfo) return this.teamInfo
    if (this.teamInfoLoad === undefined) {
      this.teamInfoLoad = (async () => {
        const data = await this.gql<GqlTeamInfo>(operation, TEAM_INFO_QUERY, {
          teamKey: this.teamKey,
        })
        const team = data.teams.nodes[0]
        if (!team) {
          throw new Error(`linear ${operation}: no team with key "${this.teamKey}"`)
        }
        return {
          teamId: team.id,
          stateIds: new Map(team.states.nodes.map((state) => [state.name, state.id])),
          labelIds: new Map(team.labels.nodes.map((label) => [label.name, label.id])),
        }
      })()
    }

    const loading = this.teamInfoLoad
    try {
      this.teamInfo = await loading
      return this.teamInfo
    } finally {
      if (this.teamInfoLoad === loading) this.teamInfoLoad = undefined
    }
  }

  private async updateState(operation: string, issueId: string, stateName: string): Promise<void> {
    const team = await this.getTeamInfo(operation)
    const stateId = team.stateIds.get(stateName)
    if (!stateId) {
      throw new Error(
        `linear ${operation}: no workflow state "${stateName}" in team ` +
          `${this.teamKey} (known: ${[...team.stateIds.keys()].join(', ')})`,
      )
    }
    const data = await this.gql<{ issueUpdate: { success: boolean } }>(
      operation,
      UPDATE_STATE_MUTATION,
      { id: issueId, stateId },
    )
    if (!data.issueUpdate.success) {
      throw new Error(`linear ${operation}: issueUpdate to "${stateName}" failed`)
    }
  }

  private toTicket(issue: GqlIssue): Ticket {
    const blockedBy = blockersOf(issue)
    const kind = issue.labels.nodes.some((label) => label.name === 'node') ? 'node' : 'work'
    // Only same-team issue/parent pairs contribute an edge to this source.
    const target =
      issue.team?.key === this.teamKey &&
      issue.parent?.team?.key === this.teamKey &&
      issue.parent.labels.nodes.some((label) => label.name === 'node')
        ? issue.parent.identifier
        : undefined
    return {
      kind,
      ...(target !== undefined ? { target } : {}),
      revision: ticketRevision({
        kind,
        target,
        title: issue.title,
        body: issue.description ?? '',
        labels: issue.labels.nodes.map((label) => label.name),
        state: issue.state?.name,
        blockedBy,
      }),
      ref: {
        source: this.name,
        id: issue.identifier,
        url: issue.url,
        title: issue.title,
      },
      ...(issue.id !== undefined ? { creationKey: issue.id } : {}),
      title: issue.title,
      body: issue.description ?? '',
      state: issue.state?.name,
      resolved: RESOLVED_STATE_TYPES.has(issue.state?.type ?? ''),
      labels: issue.labels.nodes.map((label) => label.name),
      ...(blockedBy.length > 0 ? { blockedBy } : {}),
    }
  }
}
