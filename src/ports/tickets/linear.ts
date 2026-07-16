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
import type { Ticket, TicketDraft, TicketSource } from '../types'

export const LINEAR_API_URL = 'https://api.linear.app/graphql'

/** The narrow slice of fetch this adapter needs — injectable for tests. */
export type LinearFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

// ── Wire shapes (small structural types per operation) ───────────────────────

interface GqlIssue {
  identifier: string
  title: string
  description: string | null
  url: string
  state: { name: string } | null
  labels: { nodes: Array<{ name: string }> }
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
  'identifier title description url state { name } labels { nodes { name } }'

const LIST_READY_QUERY = `query ListReady($filter: IssueFilter!) { issues(filter: $filter) { nodes { ${ISSUE_FIELDS} } } }`
const GET_ISSUE_QUERY = `query GetIssue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`
const RESOLVE_ISSUE_QUERY = `query ResolveIssue($id: String!) { issue(id: $id) { id } }`
const ISSUE_STATE_QUERY = `query IssueState($id: String!) { issue(id: $id) { id state { name } } }`
const TEAM_INFO_QUERY = `query TeamInfo($teamKey: String!) { teams(filter: { key: { eq: $teamKey } }) { nodes { id states { nodes { id name } } labels { nodes { id name } } } } }`
const UPDATE_STATE_MUTATION = `mutation UpdateState($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }`
const CREATE_COMMENT_MUTATION = `mutation CreateComment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }`
const CREATE_ISSUE_MUTATION = `mutation CreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } } }`

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

  async create(draft: TicketDraft): Promise<Ticket> {
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
    if (this.createState !== undefined) {
      const stateId = team.stateIds.get(this.createState)
      if (!stateId) {
        throw new Error(
          `linear create: no workflow state "${this.createState}" in team ` +
            `${this.teamKey} (known: ${[...team.stateIds.keys()].join(', ')})`,
        )
      }
      input['stateId'] = stateId
    }
    const data = await this.gql<{
      issueCreate: { success: boolean; issue: GqlIssue | null }
    }>('create', CREATE_ISSUE_MUTATION, { input })
    if (!data.issueCreate.success || !data.issueCreate.issue) {
      throw new Error(`linear create: issueCreate failed for "${draft.title}"`)
    }
    return this.toTicket(data.issueCreate.issue)
  }

  // ── Plumbing ───────────────────────────────────────────────────────────────

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
      errors?: Array<{ message: string }>
    }
    if (payload.errors && payload.errors.length > 0) {
      const messages = payload.errors.map((e) => e.message).join('; ')
      throw new Error(`linear ${operation}: GraphQL errors — ${messages}`)
    }
    if (payload.data === undefined || payload.data === null) {
      throw new Error(`linear ${operation}: response has no data`)
    }
    return payload.data
  }

  private async resolveIssueId(operation: string, id: string): Promise<string> {
    const cached = this.issueIds.get(id)
    if (cached) return cached
    const data = await this.gql<{ issue: { id: string } | null }>(
      operation,
      RESOLVE_ISSUE_QUERY,
      { id },
    )
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
    }
  }
}
