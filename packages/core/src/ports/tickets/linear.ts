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
  DependencyState,
  Ticket,
  TicketCreateOptions,
  TicketDraft,
  TicketListing,
  TicketSource,
  TicketUpdate,
} from '../types'
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
  init: { method: 'POST'; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

// ── Wire shapes (small structural types per operation) ───────────────────────

interface GqlIssueRelation {
  id?: string
  type: string
  issue: { id?: string; identifier: string } | null
}

interface GqlIssue {
  id?: string
  identifier: string
  title: string
  description: string | null
  url: string
  state: { name: string; type: string } | null
  labels: { nodes: Array<{ name: string }> }
  /** Relations where THIS issue is the `relatedIssue` side. A relation
   * `{issue: A, relatedIssue: B, type: "blocks"}` reads "A blocks B", so an
   * issue's blockers are its inverse `blocks` relations, and the blocker is
   * each relation's `issue`. Relation ids are required by the delete API. */
  inverseRelations?: { nodes: GqlIssueRelation[] }
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
function blockerRelationsOf(issue: GqlIssue): GqlIssueRelation[] {
  return (issue.inverseRelations?.nodes ?? []).filter(
    (relation) => relation.type === 'blocks' && relation.issue !== null,
  )
}

/** The identifiers blocking `issue`; unrelated relation kinds are ignored. */
function blockersOf(issue: GqlIssue): string[] {
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

/** Autobuild blocker sets are intentionally small, but Linear's implicit
 * connection default is only 50. Make the practical bound explicit so reads,
 * idempotency preflight, and deletion all see the same relation window. */
export const LINEAR_RELATION_PAGE_SIZE = 250

const ISSUE_FIELDS =
  'id identifier title description url state { name type } labels { nodes { name } } ' +
  `inverseRelations(first: ${LINEAR_RELATION_PAGE_SIZE}) { nodes { id type issue { id identifier } } }`

const LIST_READY_QUERY = `query ListReady($filter: IssueFilter!) { issues(filter: $filter) { nodes { ${ISSUE_FIELDS} } } }`
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

export class LinearTicketSource implements TicketSource {
  readonly name = 'linear'

  private readonly apiKey: string
  private readonly teamKey: string
  private readonly claimedState: string
  private readonly createState: string | undefined
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
    /** Workflow state claim() moves the issue to (claim-before-launch, §12). */
    claimedState?: string
    /** Workflow state create() files new issues into; absent = Linear's team
     * default (whatever the team's default state is, e.g. Backlog). */
    createState?: string
  }) {
    this.apiKey = opts.apiKey
    this.teamKey = opts.teamKey
    this.claimedState = opts.claimedState ?? 'In Progress'
    this.createState = opts.createState
    this.fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init))
  }

  async listReady(criteria: { labels?: string[]; state?: string }): Promise<TicketListing> {
    const filter: Record<string, unknown> = {
      team: { key: { eq: this.teamKey } },
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
    const data = await this.gql<{ issues: { nodes: GqlIssue[] } }>('listReady', LIST_READY_QUERY, {
      filter,
    })
    return {
      tickets: data.issues.nodes.map((issue) => this.toTicket(issue)),
      diagnostics: [],
    }
  }

  async get(id: string): Promise<Ticket | null> {
    let data: { issue: GqlIssue | null }
    try {
      data = await this.gql<{ issue: GqlIssue | null }>('get', GET_ISSUE_QUERY, { id })
    } catch (error) {
      // Linear's `issue(id:)` field is non-null in the live schema: an unknown
      // identifier arrives as INPUT_ERROR / Entity not found rather than the
      // nullable-looking canned `{ issue: null }` shape.
      if (isEntityNotFound(error)) return null
      throw error
    }
    return data.issue ? this.toTicket(data.issue) : null
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
    const reservedId = opts.idempotencyKey
    if (reservedId !== undefined && !linearReservedIssueIdSchema.safeParse(reservedId).success) {
      throw new Error('linear create: idempotency key must be a UUID v4')
    }
    const team = await this.getTeamInfo('create')
    const labelIds = await Promise.all(
      (draft.labels ?? []).map((label) => this.ensureLabelId('create', label, team)),
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

    return this.completeCreateBlockers(issue, draft.blockedBy ?? [], reservedId !== undefined)
  }

  async update(id: string, patch: TicketUpdate): Promise<void> {
    const validated = validateTicketUpdate(patch)
    const issueId = await this.resolveIssueId('update', id)
    const input: Record<string, unknown> = {}

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

  /**
   * Dependency nodes (§13). One query per id — Linear's `IssueFilter` has no
   * identifier-`in` filter, and the id sets here are small (the ready set's
   * blockers). Deliberately uncached: a blocker completing between ticks must
   * be visible on the very next pass, so only the identifier→UUID map (which
   * never changes) is cached.
   */
  async dependencyStates(ids: string[]): Promise<DependencyState[]> {
    const states: DependencyState[] = []
    for (const id of ids) {
      let data: { issue: GqlIssue | null }
      try {
        data = await this.gql<{ issue: GqlIssue | null }>('dependencyStates', GET_ISSUE_QUERY, {
          id,
        })
      } catch (error) {
        // An unknown identifier is a MISSING dependency, not a failed check:
        // the dispatcher must be able to say "AUT-99 does not exist" rather
        // than bailing out of the ticket's whole dependency evaluation.
        if (isEntityNotFound(error)) {
          states.push({ id, exists: false, resolved: false, blockedBy: [] })
          continue
        }
        throw error
      }
      if (!data.issue) {
        states.push({ id, exists: false, resolved: false, blockedBy: [] })
        continue
      }
      states.push({
        id,
        exists: true,
        resolved: RESOLVED_STATE_TYPES.has(data.issue.state?.type ?? ''),
        blockedBy: blockersOf(data.issue),
      })
    }
    return states
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
    return { ...this.toTicket(issue), ...(blockedBy.length > 0 ? { blockedBy } : {}) }
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
  ): Promise<T> {
    const response = await this.fetchFn(LINEAR_API_URL, {
      method: 'POST',
      headers: {
        Authorization: this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    })
    if (!response.ok) {
      throw new Error(`linear ${operation}: HTTP ${response.status}`)
    }
    const payload = (await response.json()) as {
      data?: T | null
      errors?: GqlError[]
    }
    if (payload.errors && payload.errors.length > 0) {
      const messages = payload.errors.map((e) => e.message).join('; ')
      throw new LinearGqlError(`linear ${operation}: GraphQL errors — ${messages}`, payload.errors)
    }
    if (payload.data === undefined || payload.data === null) {
      throw new Error(`linear ${operation}: response has no data`)
    }
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
    return {
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
      labels: issue.labels.nodes.map((label) => label.name),
      ...(blockedBy.length > 0 ? { blockedBy } : {}),
    }
  }
}
