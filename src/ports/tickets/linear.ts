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
      (e) =>
        e.extensions?.code === 'INPUT_ERROR' &&
        /entity not found/i.test(e.message),
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
  return [
    ...new Set(
      blockerRelationsOf(issue).map((relation) => relation.issue!.identifier),
    ),
  ]
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
): Error {
  const recordedSet = new Set(recorded)
  const unrecorded = requested.filter((id) => !recordedSet.has(id))
  return new Error(
    `linear create: ticket "${issue.identifier}" was created at ${issue.url}, ` +
      'but its blockers were not all recorded. ' +
      `Blockers recorded: ${blockerList(recorded)}. ` +
      `Blockers not recorded: ${blockerList(unrecorded)}. ` +
      'Do not rerun ticket creation; repair the blockers on the existing ticket. ' +
      `Underlying failure: ${errorMessage(cause)}`,
    { cause },
  )
}

interface GqlTeamInfo {
  teams: {
    nodes: Array<{
      id: string
      states: { nodes: Array<{ id: string; name: string }> }
      labels: { nodes: Array<{ id: string; name: string }> }
    }>
  }
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
const ISSUE_STATE_QUERY = `query IssueState($id: String!) { issue(id: $id) { id state { name } } }`
const TEAM_INFO_QUERY = `query TeamInfo($teamKey: String!) { teams(filter: { key: { eq: $teamKey } }) { nodes { id states { nodes { id name } } labels { nodes { id name } } } } }`
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
  private teamInfo?: {
    teamId: string
    stateIds: Map<string, string>
    labelIds: Map<string, string>
  }

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

  async listReady(criteria: {
    labels?: string[]
    state?: string
  }): Promise<Ticket[]> {
    const filter: Record<string, unknown> = {
      team: { key: { eq: this.teamKey } },
    }
    if (criteria.state !== undefined) {
      filter['state'] = { name: { eq: criteria.state } }
    }
    if (criteria.labels && criteria.labels.length > 0) {
      // and-of-somes: every requested label must be present.
      filter['and'] = criteria.labels.map((label) => ({
        labels: { some: { name: { eq: label } } },
      }))
    }
    const data = await this.gql<{ issues: { nodes: GqlIssue[] } }>(
      'listReady',
      LIST_READY_QUERY,
      { filter },
    )
    return data.issues.nodes.map((issue) => this.toTicket(issue))
  }

  async get(id: string): Promise<Ticket | null> {
    let data: { issue: GqlIssue | null }
    try {
      data = await this.gql<{ issue: GqlIssue | null }>(
        'get',
        GET_ISSUE_QUERY,
        { id },
      )
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
   * claimed state, else move it there. The check-then-update pair is not
   * transactional — a concurrent writer could claim between the two calls —
   * which is acceptable because the dispatcher is the single writer (§12);
   * the guard defends against re-dispatching an already-claimed ticket.
   */
  async claim(id: string): Promise<boolean> {
    const data = await this.gql<{
      issue: { id: string; state: { name: string } | null } | null
    }>('claim', ISSUE_STATE_QUERY, { id })
    if (!data.issue) return false
    if (data.issue.state?.name === this.claimedState) return false
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

  async create(
    draft: TicketDraft,
    opts: TicketCreateOptions = {},
  ): Promise<Ticket> {
    const reservedId = opts.idempotencyKey
    if (
      reservedId !== undefined &&
      !linearReservedIssueIdSchema.safeParse(reservedId).success
    ) {
      throw new Error('linear create: idempotency key must be a UUID v4')
    }
    const team = await this.getTeamInfo('create')
    const labelIds = (draft.labels ?? []).map((label) => {
      const labelId = team.labelIds.get(label)
      if (!labelId) {
        throw new Error(
          `linear create: no label "${label}" in team ${this.teamKey} ` +
            `(known: ${[...team.labelIds.keys()].join(', ') || 'none'})`,
        )
      }
      return labelId
    })
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
      input['stateId'] = stateId
    }
    if (reservedId !== undefined) input['id'] = reservedId

    let data: { issueCreate: { success: boolean; issue: GqlIssue | null } }
    try {
      data = await this.gql<{
        issueCreate: { success: boolean; issue: GqlIssue | null }
      }>('create', CREATE_ISSUE_MUTATION, { input })
    } catch (error) {
      if (reservedId === undefined) throw error
      // The create may have committed before the caller/store crashed. Query
      // the durably reserved UUID and adopt it; if it is absent, preserve the
      // original error rather than hiding a real outage.
      const adopted = await this.adoptCreatedIssue(reservedId)
      if (adopted !== null) return adopted
      throw error
    }
    if (!data.issueCreate.success || !data.issueCreate.issue) {
      if (reservedId !== undefined) {
        const adopted = await this.adoptCreatedIssue(reservedId)
        if (adopted !== null) return adopted
      }
      throw new Error(`linear create: issueCreate failed for "${draft.title}"`)
    }
    const issue = data.issueCreate.issue
    const blockedBy = [...new Set(draft.blockedBy ?? [])]
    if (blockedBy.length > 0) {
      const recorded: string[] = []
      try {
        const createdId = issue.id
        if (createdId === undefined) {
          throw new Error(
            'linear create: issueCreate returned no id — cannot record blockers',
          )
        }
        this.issueIds.set(issue.identifier, createdId)
        for (const blockerId of blockedBy) {
          // Direction matters and is the inverse of how it reads aloud: the
          // BLOCKER is `issueId` and the new issue is `relatedIssueId`, because
          // Linear's `blocks` relation reads "issueId blocks relatedIssueId".
          // Transposing these silently records the exact opposite relationship.
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
        throw blockerRecordingError(issue, blockedBy, recorded, error)
      }
      // The create response predates the relations; report what we recorded.
      return { ...this.toTicket(issue), blockedBy }
    }
    return this.toTicket(issue)
  }

  async update(id: string, patch: TicketUpdate): Promise<void> {
    const validated = validateTicketUpdate(patch)
    const issueId = await this.resolveIssueId('update', id)
    const input: Record<string, unknown> = {}

    if (validated.title !== undefined) input['title'] = validated.title
    if (validated.body !== undefined) input['description'] = validated.body
    if (validated.labels !== undefined) {
      if (validated.labels.length === 0) {
        input['labelIds'] = []
      } else {
        const team = await this.getTeamInfo('update')
        input['labelIds'] = validated.labels.map((label) => {
          const labelId = team.labelIds.get(label)
          if (!labelId) {
            throw new Error(
              `linear update: no label "${label}" in team ${this.teamKey} ` +
                `(known: ${[...team.labelIds.keys()].join(', ') || 'none'})`,
            )
          }
          return labelId
        })
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
        (relation) =>
          relation.issue?.identifier === blockerId ||
          relation.issue?.id === blockerId,
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
      (relation) =>
        relation.issue?.identifier === blockerId ||
        relation.issue?.id === blockerId,
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
        data = await this.gql<{ issue: GqlIssue | null }>(
          'dependencyStates',
          GET_ISSUE_QUERY,
          { id },
        )
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
      data = await this.gql<{ issue: GqlIssue | null }>(
        operation,
        GET_ISSUE_QUERY,
        { id },
      )
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

  private requiredIssueId(
    operation: string,
    requestedId: string,
    issue: GqlIssue,
  ): string {
    if (issue.id === undefined) {
      throw new Error(
        `linear ${operation}: ticket "${requestedId}" response has no issue id`,
      )
    }
    return issue.id
  }

  private async adoptCreatedIssue(id: string): Promise<Ticket | null> {
    try {
      const adopted = await this.gql<{ issue: GqlIssue | null }>(
        'create-adopt',
        GET_ISSUE_QUERY,
        { id },
      )
      return adopted.issue ? this.toTicket(adopted.issue) : null
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
      throw new LinearGqlError(
        `linear ${operation}: GraphQL errors — ${messages}`,
        payload.errors,
      )
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
      data = await this.gql<{ issue: { id: string } | null }>(
        operation,
        RESOLVE_ISSUE_QUERY,
        { id },
      )
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

  /** State/label ids by name and the team id — fetched once, cached. */
  private async getTeamInfo(operation: string): Promise<{
    teamId: string
    stateIds: Map<string, string>
    labelIds: Map<string, string>
  }> {
    if (this.teamInfo) return this.teamInfo
    const data = await this.gql<GqlTeamInfo>(operation, TEAM_INFO_QUERY, {
      teamKey: this.teamKey,
    })
    const team = data.teams.nodes[0]
    if (!team) {
      throw new Error(`linear ${operation}: no team with key "${this.teamKey}"`)
    }
    this.teamInfo = {
      teamId: team.id,
      stateIds: new Map(team.states.nodes.map((s) => [s.name, s.id])),
      labelIds: new Map(team.labels.nodes.map((l) => [l.name, l.id])),
    }
    return this.teamInfo
  }

  private async updateState(
    operation: string,
    issueId: string,
    stateName: string,
  ): Promise<void> {
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
      title: issue.title,
      body: issue.description ?? '',
      state: issue.state?.name,
      labels: issue.labels.nodes.map((label) => label.name),
      ...(blockedBy.length > 0 ? { blockedBy } : {}),
    }
  }
}
