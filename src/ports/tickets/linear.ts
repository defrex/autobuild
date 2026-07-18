/**
 * Linear TicketSource (SPEC §3.2, §13): GraphQL over an injectable fetch, so
 * tests run offline against canned exchanges. Queries are deliberately
 * minimal — only the fields the Ticket shape needs — and responses are typed
 * as small structural types rather than a generated client.
 *
 * Policy (§13): initiation and outward projections only. Nothing here is
 * called mid-build; comments and transitions flow outward, and the build
 * never reads Linear again after dispatch imports the spec.
 */
import { z } from 'zod'
import type {
  DependencyState,
  Ticket,
  TicketCreateOptions,
  TicketDraft,
  TicketSource,
} from '../types'

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
   * each relation's `issue`. */
  inverseRelations?: {
    nodes: Array<{ type: string; issue: { identifier: string } | null }>
  }
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

/** The identifiers blocking `issue`: inverse relations of type `blocks`,
 * taking each relation's `issue` side. Relations of any other type
 * (`related`, `duplicate`, …) are not dependencies and are ignored. */
function blockersOf(issue: GqlIssue): string[] {
  const blockers = (issue.inverseRelations?.nodes ?? [])
    .filter((relation) => relation.type === 'blocks' && relation.issue !== null)
    .map((relation) => relation.issue!.identifier)
  return [...new Set(blockers)]
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

const ISSUE_FIELDS =
  'identifier title description url state { name type } labels { nodes { name } } ' +
  'inverseRelations { nodes { type issue { identifier } } }'

const LIST_READY_QUERY = `query ListReady($filter: IssueFilter!) { issues(filter: $filter) { nodes { ${ISSUE_FIELDS} } } }`
const GET_ISSUE_QUERY = `query GetIssue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`
const RESOLVE_ISSUE_QUERY = `query ResolveIssue($id: String!) { issue(id: $id) { id } }`
const ISSUE_STATE_QUERY = `query IssueState($id: String!) { issue(id: $id) { id state { name } } }`
const TEAM_INFO_QUERY = `query TeamInfo($teamKey: String!) { teams(filter: { key: { eq: $teamKey } }) { nodes { id states { nodes { id name } } labels { nodes { id name } } } } }`
const UPDATE_STATE_MUTATION = `mutation UpdateState($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }`
const CREATE_COMMENT_MUTATION = `mutation CreateComment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }`
const CREATE_ISSUE_MUTATION = `mutation CreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id ${ISSUE_FIELDS} } } }`
const CREATE_RELATION_MUTATION = `mutation CreateRelation($issueId: String!, $relatedIssueId: String!) { issueRelationCreate(input: { issueId: $issueId, relatedIssueId: $relatedIssueId, type: "blocks" }) { success } }`
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
    const data = await this.gql<{ issue: GqlIssue | null }>(
      'get',
      GET_ISSUE_QUERY,
      { id },
    )
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
      }
      // The create response predates the relations; report what we recorded.
      return { ...this.toTicket(issue), blockedBy }
    }
    return this.toTicket(issue)
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
