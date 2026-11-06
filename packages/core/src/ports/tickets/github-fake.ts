/**
 * In-memory GitHub Issues API for the `github` ticket source's seam tests.
 * Like `fake.ts`, it is a fixture module rather than a test file, so scenario
 * tests can drive a real `GitHubTicketSource` with no network.
 *
 * It serves the REST routes and the GraphQL queries the adapter sends, with
 * ETags (a hash of the response) and `If-None-Match` → 304, and counts every
 * request by route so budget tests can assert exact costs. It deliberately
 * serves no comment-history, REST issue-events or REST search route: any
 * adapter read of those fails a test with a 404. Identity routes answer for
 * the requesting credential: `GET user` returns its login (or 403 for a
 * credential with no user, `transportAs(null)`), and
 * `GET repos/{repo}/assignees/{login}` answers 204 for `assignable` logins.
 *
 * UI-style mutators simulate what people do on GitHub outside the adapter.
 */
import { createHash } from 'node:crypto'
import { GitHubApiError, type GitHubRequest, type GitHubResponse } from '../forge/github-transport'

interface FakeEvent {
  type: 'labeled' | 'unlabeled' | 'closed' | 'reopened'
  label?: string
}

interface FakeIssue {
  id: number
  number: number
  title: string
  body: string | null
  state: 'open' | 'closed'
  state_reason: string | null
  labels: string[]
  /** Assignee logins. */
  assignees: string[]
  created_at: string
  updated_at: string
  pull_request: boolean
  gone?: 'deleted' | 'transferred'
  /** Where a transferred issue went, as an `owner/repo#number` key. */
  movedTo?: string
  comments: number
  events: FakeEvent[]
  /** Blockers as `owner/repo#number` keys. */
  blockedBy: string[]
  /** State changes for the lagging search index: newest last. */
  history: Array<{ at: number; state: 'open' | 'closed'; state_reason: string | null }>
}

interface FakeLabel {
  name: string
  description: string | null
  color: string
}

export type FakeGitHubRequestKind =
  | 'repo'
  | 'list-issues'
  | 'create-issue'
  | 'get-issue'
  | 'patch-issue'
  | 'comment'
  | 'blocked-by-list'
  | 'blocked-by-add'
  | 'blocked-by-remove'
  | 'labels-list'
  | 'label-get'
  | 'label-create'
  | 'count'
  | 'timeline-reopen'
  | 'timeline-closed'
  | 'user'
  | 'assignee-check'
  | 'unknown'

export interface FakeGitHubRequestRecord {
  method: string
  path: string
  kind: FakeGitHubRequestKind
  status: number
  /** REST query parameters, as sent. */
  params?: Record<string, string>
  /** GraphQL only: the count query's requested fields. */
  fields?: string[]
  /** GraphQL only: the query text. */
  query?: string
}

export interface FakeGitHubOptions {
  owner?: string
  name?: string
  /** The fake's clock, for `created_at`, `updated_at` and search lag. */
  now?: () => number
  /** How far the `reason:completed` search index lags state changes. */
  searchLagMs?: number
  /** First issue number; 1001 keeps the contract's link numbers free. */
  firstNumber?: number
}

const API = 'https://api.github.com'

function etagOf(json: unknown, link: string | undefined): string {
  return `"${createHash('sha1')
    .update(JSON.stringify(json) + (link ?? ''))
    .digest('hex')}"`
}

export class FakeGitHubIssues {
  readonly owner: string
  readonly name: string
  readonly requests: FakeGitHubRequestRecord[] = []
  /** Issue comments posted through the API or the UI, by issue number. */
  readonly comments = new Map<number, string[]>()
  hasIssues = true
  permissions: Record<string, boolean> = { pull: true, push: true }
  /** When false, the token lacks Issues write: every REST write is refused. */
  issueWrites = true
  /** Simulates a token without push access: GitHub silently drops label
   * changes on issue create and edit. */
  dropLabels = false
  /** When false, UI labelling leaves `updated_at` untouched. */
  labelsBumpUpdatedAt = true
  searchLagMs: number
  /** The login `transport`'s credential belongs to; null has no user (an App
   * installation token). */
  viewer: string | null = 'fake-user'
  /** Logins (lowercased) that can be assigned issues in the repository. */
  readonly assignable = new Set<string>()

  private readonly issues = new Map<number, FakeIssue>()
  private readonly foreign = new Map<string, FakeIssue & { repo: string }>()
  private readonly labels = new Map<string, FakeLabel>()
  private readonly clock: () => number
  private nextNumber: number
  private nextId = 900_000
  private failures: Array<{
    status: number
    headers: Record<string, string>
    body: unknown
    match?: (method: string, path: string) => boolean
  }> = []

  constructor(opts: FakeGitHubOptions = {}) {
    this.owner = opts.owner ?? 'acme'
    this.name = opts.name ?? 'widgets'
    this.clock = opts.now ?? Date.now
    this.searchLagMs = opts.searchLagMs ?? 0
    this.nextNumber = opts.firstNumber ?? 1001
  }

  get repository(): { owner: string; name: string } {
    return { owner: this.owner, name: this.name }
  }

  private get fullName(): string {
    return `${this.owner}/${this.name}`
  }

  // ── Assertions ────────────────────────────────────────────────────────────

  /** Requests that cost primary budget (everything but 304s). */
  get primary(): number {
    return this.requests.filter((request) => request.status !== 304).length
  }

  get notModified(): number {
    return this.requests.filter((request) => request.status === 304).length
  }

  count(kind: FakeGitHubRequestKind, filter?: (r: FakeGitHubRequestRecord) => boolean): number {
    return this.requests.filter((r) => r.kind === kind && (filter?.(r) ?? true)).length
  }

  graphqlRequests(): FakeGitHubRequestRecord[] {
    return this.requests.filter((r) => r.path === 'graphql')
  }

  writes(): FakeGitHubRequestRecord[] {
    return this.requests.filter((r) => r.method !== 'GET' && r.path !== 'graphql')
  }

  resetRequests(): void {
    this.requests.length = 0
  }

  issue(number: number): Readonly<FakeIssue> | undefined {
    return this.issues.get(number)
  }

  issueCount(): number {
    return [...this.issues.values()].filter((issue) => !issue.pull_request && !issue.gone).length
  }

  labelNames(): string[] {
    return [...this.labels.values()].map((label) => label.name)
  }

  label(name: string): FakeLabel | undefined {
    return this.labels.get(name.toLowerCase())
  }

  // ── Fault injection ───────────────────────────────────────────────────────

  /** Fail the next matching request (any request when `match` is absent). */
  failNext(
    status: number,
    headers: Record<string, string> = {},
    body: unknown = { message: `fake failure ${status}` },
    match?: (method: string, path: string) => boolean,
  ): void {
    this.failures.push({ status, headers, body, ...(match ? { match } : {}) })
  }

  // ── UI-style mutators (people acting on GitHub directly) ───────────────────

  /** File an issue the way a person does in the GitHub UI. */
  fileIssue(
    opts: {
      title?: string
      body?: string
      labels?: string[]
      state?: 'open' | 'closed'
      state_reason?: string | null
      assignees?: string[]
    } = {},
  ): number {
    const issue = this.insert(opts.title ?? 'Filed in the UI', opts.body ?? 'From the UI.', [])
    issue.assignees = [...(opts.assignees ?? [])]
    for (const label of opts.labels ?? []) this.uiAddLabel(issue.number, label)
    if (opts.state === 'closed')
      this.uiClose(issue.number, opts.state_reason === undefined ? 'completed' : opts.state_reason)
    return issue.number
  }

  openPullRequest(title = 'A pull request'): number {
    const issue = this.insert(title, 'PR body', [])
    issue.pull_request = true
    return issue.number
  }

  uiClose(number: number, reason: string | null = 'completed'): void {
    const issue = this.require(number)
    issue.state = 'closed'
    issue.state_reason = reason
    issue.events.push({ type: 'closed' })
    this.changed(issue, true)
  }

  uiReopen(number: number): void {
    const issue = this.require(number)
    issue.state = 'open'
    issue.state_reason = 'reopened'
    issue.events.push({ type: 'reopened' })
    this.changed(issue, true)
  }

  uiAddLabel(number: number, name: string): void {
    const issue = this.require(number)
    const label = this.ensureLabel(name)
    if (issue.labels.some((held) => held.toLowerCase() === label.name.toLowerCase())) return
    issue.labels.push(label.name)
    issue.events.push({ type: 'labeled', label: label.name })
    this.changed(issue, this.labelsBumpUpdatedAt)
  }

  uiRemoveLabel(number: number, name: string): void {
    const issue = this.require(number)
    const before = issue.labels.length
    issue.labels = issue.labels.filter((held) => held.toLowerCase() !== name.toLowerCase())
    if (issue.labels.length === before) return
    issue.events.push({ type: 'unlabeled', label: name })
    this.changed(issue, this.labelsBumpUpdatedAt)
  }

  /** Replace the issue's assignees. */
  uiAssign(number: number, ...logins: string[]): void {
    const issue = this.require(number)
    issue.assignees = [...logins]
    this.changed(issue, true)
  }

  uiEditTitle(number: number, title: string): void {
    const issue = this.require(number)
    issue.title = title
    this.changed(issue, true)
  }

  uiEditBody(number: number, body: string): void {
    const issue = this.require(number)
    issue.body = body
    this.changed(issue, true)
  }

  uiComment(number: number, body: string, count = 1): void {
    const issue = this.require(number)
    issue.comments += count
    const list = this.comments.get(number) ?? []
    for (let i = 0; i < count; i++) list.push(body)
    this.comments.set(number, list)
    this.changed(issue, true)
  }

  /** Grow an issue's label history with `count` additions of other labels. */
  addLabelEvents(number: number, count: number): void {
    const issue = this.require(number)
    for (let i = 0; i < count; i++) issue.events.push({ type: 'labeled', label: `noise-${i}` })
    this.changed(issue, true)
  }

  uiAddDependency(number: number, blocker: number): void {
    const issue = this.require(number)
    const key = `${this.fullName}#${blocker}`
    if (!issue.blockedBy.includes(key)) issue.blockedBy.push(key)
    this.changed(issue, true)
  }

  /** A blocker in another repository; returns its key. */
  addForeignDependency(
    number: number,
    repo: string,
    blocker: number,
    state: 'open' | 'closed' = 'closed',
  ): string {
    const issue = this.require(number)
    const key = `${repo}#${blocker}`
    if (!this.foreign.has(key)) {
      const at = new Date(this.clock()).toISOString()
      this.foreign.set(key, {
        repo,
        id: this.nextId++,
        number: blocker,
        title: `Foreign ${key}`,
        body: '',
        state,
        state_reason: state === 'closed' ? 'completed' : null,
        labels: [],
        assignees: [],
        created_at: at,
        updated_at: at,
        pull_request: false,
        comments: 0,
        events: [],
        blockedBy: [],
        history: [],
      })
    }
    issue.blockedBy.push(key)
    this.changed(issue, true)
    return key
  }

  deleteIssue(number: number): void {
    this.require(number).gone = 'deleted'
  }

  /**
   * Transfer issue `number` to `to` (an `owner/repo#number` key). GitHub
   * answers a GET of the old number with a 301 the transport follows, so
   * the fake serves the moved issue's body there; every other route 404s.
   */
  transferIssue(number: number, to = `${this.owner}/elsewhere#${number + 500}`): string {
    const issue = this.require(number)
    const [repo, moved] = to.split('#')
    issue.gone = 'transferred'
    issue.movedTo = to
    const { gone: _gone, movedTo: _movedTo, ...copy } = issue
    this.foreign.set(to, {
      ...copy,
      labels: [...issue.labels],
      blockedBy: [...issue.blockedBy],
      repo: repo!,
      number: Number(moved),
    })
    return to
  }

  deleteLabel(name: string): void {
    const label = this.labels.get(name.toLowerCase())
    if (!label) return
    this.labels.delete(name.toLowerCase())
    for (const issue of this.issues.values())
      issue.labels = issue.labels.filter((held) => held.toLowerCase() !== name.toLowerCase())
  }

  /** Bulk-create plain issues with no events (budget tests). */
  seedIssues(
    count: number,
    opts: { labels?: string[]; state?: 'open' | 'closed'; state_reason?: string | null } = {},
  ): number[] {
    const numbers: number[] = []
    for (let i = 0; i < count; i++) {
      const issue = this.insert(`Seeded ${i}`, 'Seeded body.', [])
      for (const name of opts.labels ?? []) issue.labels.push(this.ensureLabel(name).name)
      if (opts.state === 'closed') {
        issue.state = 'closed'
        issue.state_reason = opts.state_reason === undefined ? 'completed' : opts.state_reason
        issue.history.push({
          at: this.clock(),
          state: 'closed',
          state_reason: issue.state_reason,
        })
      }
      numbers.push(issue.number)
    }
    return numbers
  }

  // ── Transport ─────────────────────────────────────────────────────────────

  readonly transport: GitHubRequest = (method, rawPath, opts) =>
    this.serve(this.viewer, method, rawPath, opts)

  /** A transport authenticated as `login` (null: a credential with no user),
   * over the same repository state. */
  transportAs(login: string | null): GitHubRequest {
    return (method, rawPath, opts) => this.serve(login, method, rawPath, opts)
  }

  private async serve(
    identity: string | null,
    method: string,
    rawPath: string,
    opts: Parameters<GitHubRequest>[2] = {},
  ): Promise<GitHubResponse> {
    const path = rawPath.replace(/^https:\/\/api\.github\.com\//, '').replace(/^\/+/, '')
    const record: FakeGitHubRequestRecord = {
      method,
      path,
      kind: 'unknown',
      status: 0,
      ...(opts.query !== undefined ? { params: { ...opts.query } } : {}),
    }
    this.requests.push(record)
    const failure = this.failures.findIndex((f) => f.match?.(method, path) ?? true)
    if (failure >= 0) {
      const [hit] = this.failures.splice(failure, 1)
      record.kind = this.classify(method, path, opts.body)
      record.status = hit!.status
      throw new GitHubApiError(
        hit!.status,
        (hit!.body as { message?: string })?.message ?? `fake failure ${hit!.status}`,
        hit!.body,
        hit!.headers,
      )
    }
    try {
      const result = this.route(identity, method, path, opts.query ?? {}, opts.body, record)
      if (method === 'GET' && result.status === 204) {
        record.status = 204
        return { status: 204, headers: {} }
      }
      if (method === 'GET') {
        const etag = etagOf(result.json, result.link)
        const sent = opts.headers?.['If-None-Match'] ?? opts.headers?.['if-none-match']
        if (sent === etag) {
          record.status = 304
          return { status: 304, headers: { etag } }
        }
        record.status = 200
        return {
          status: 200,
          headers: { etag, ...(result.link ? { link: result.link } : {}) },
          json: result.json,
        }
      }
      record.status = result.status ?? 200
      return { status: record.status, headers: {}, json: result.json }
    } catch (error) {
      if (error instanceof GitHubApiError) record.status = error.status
      throw error
    }
  }

  private classify(method: string, path: string, body: unknown): FakeGitHubRequestKind {
    if (path === 'graphql') {
      const query = (body as { query?: string })?.query ?? ''
      if (query.includes('REOPENED_EVENT')) return 'timeline-reopen'
      if (query.includes('CLOSED_EVENT')) return 'timeline-closed'
      return 'count'
    }
    const prefix = `repos/${this.fullName}`
    const rest = path.startsWith(prefix) ? path.slice(prefix.length) : path
    if (path === 'user') return 'user'
    if (rest === '') return 'repo'
    if (/^\/assignees\/[^/]+$/.test(rest)) return 'assignee-check'
    if (rest === '/issues') return method === 'POST' ? 'create-issue' : 'list-issues'
    if (/^\/issues\/\d+$/.test(rest)) return method === 'PATCH' ? 'patch-issue' : 'get-issue'
    if (/^\/issues\/\d+\/comments$/.test(rest)) return 'comment'
    if (/^\/issues\/\d+\/dependencies\/blocked_by$/.test(rest))
      return method === 'POST' ? 'blocked-by-add' : 'blocked-by-list'
    if (/^\/issues\/\d+\/dependencies\/blocked_by\/\d+$/.test(rest)) return 'blocked-by-remove'
    if (rest === '/labels') return method === 'POST' ? 'label-create' : 'labels-list'
    if (/^\/labels\/[^/]+$/.test(rest)) return 'label-get'
    return 'unknown'
  }

  private route(
    identity: string | null,
    method: string,
    path: string,
    query: Record<string, string>,
    body: unknown,
    record: FakeGitHubRequestRecord,
  ): { json: unknown; link?: string; status?: number } {
    record.kind = this.classify(method, path, body)
    if (path === 'graphql' && method === 'POST') return this.graphql(body, record)
    if (path === 'user' && method === 'GET') {
      if (identity === null) throw new GitHubApiError(403, 'Resource not accessible by integration')
      return { json: { login: identity } }
    }
    const prefix = `repos/${this.fullName}`
    if (!path.startsWith(prefix)) throw this.notFound()
    const rest = path.slice(prefix.length)
    const assigneePath = /^\/assignees\/([^/]+)$/.exec(rest)
    if (assigneePath && method === 'GET') {
      if (!this.assignable.has(decodeURIComponent(assigneePath[1]!).toLowerCase()))
        throw this.notFound()
      return { json: undefined, status: 204 }
    }
    if (!this.issueWrites && method !== 'GET')
      throw new GitHubApiError(403, 'Resource not accessible by personal access token')
    if (rest === '' && method === 'GET')
      return {
        json: {
          full_name: this.fullName,
          has_issues: this.hasIssues,
          permissions: this.permissions,
        },
      }
    if (!this.hasIssues && rest.startsWith('/issues'))
      throw new GitHubApiError(410, 'Issues are disabled for this repo', {
        message: 'Issues are disabled for this repo',
      })
    if (rest === '/issues' && method === 'GET') return this.listIssues(query)
    if (rest === '/issues' && method === 'POST') return this.createIssue(body)
    if (rest === '/labels' && method === 'GET')
      return this.page([...this.labels.values()], query, rest)
    if (rest === '/labels' && method === 'POST') return this.createLabel(body)
    const labelPath = /^\/labels\/([^/]+)$/.exec(rest)
    if (labelPath && method === 'GET') {
      // GitHub matches the name case-insensitively.
      const label = this.labels.get(decodeURIComponent(labelPath[1]!).toLowerCase())
      if (label === undefined) throw this.notFound()
      return { json: label }
    }
    let match = /^\/issues\/(\d+)$/.exec(rest)
    if (match) {
      const moved = this.issues.get(Number(match[1]))?.movedTo
      if (moved !== undefined && method === 'GET')
        return { json: this.json(this.foreign.get(moved)!) }
      const issue = this.live(Number(match[1]))
      if (method === 'GET') return { json: this.json(issue) }
      if (method === 'PATCH') return { json: this.patchIssue(issue, body) }
    }
    match = /^\/issues\/(\d+)\/comments$/.exec(rest)
    if (match && method === 'POST') {
      const issue = this.live(Number(match[1]))
      const text = (body as { body?: string })?.body ?? ''
      issue.comments++
      this.comments.set(issue.number, [...(this.comments.get(issue.number) ?? []), text])
      this.changed(issue, true)
      return { json: { id: this.nextId++, body: text }, status: 201 }
    }
    match = /^\/issues\/(\d+)\/dependencies\/blocked_by$/.exec(rest)
    if (match) {
      const issue = this.live(Number(match[1]))
      if (method === 'GET')
        return this.page(
          issue.blockedBy.map((key) => this.json(this.byKey(key)!)),
          query,
          rest,
          true,
        )
      if (method === 'POST') {
        const id = (body as { issue_id?: number })?.issue_id
        const blocker = this.byId(id)
        if (!blocker) throw this.notFound()
        const key = this.keyOf(blocker)
        if (issue.blockedBy.includes(key))
          throw new GitHubApiError(422, 'Validation Failed', {
            message: 'Validation Failed',
            errors: [{ message: 'Issue dependency already exists' }],
          })
        issue.blockedBy.push(key)
        this.changed(issue, true)
        return { json: this.json(blocker), status: 201 }
      }
    }
    match = /^\/issues\/(\d+)\/dependencies\/blocked_by\/(\d+)$/.exec(rest)
    if (match && method === 'DELETE') {
      const issue = this.live(Number(match[1]))
      const blocker = this.byId(Number(match[2]))
      if (!blocker || !issue.blockedBy.includes(this.keyOf(blocker))) throw this.notFound()
      issue.blockedBy = issue.blockedBy.filter((key) => key !== this.keyOf(blocker))
      this.changed(issue, true)
      return { json: this.json(blocker) }
    }
    throw this.notFound()
  }

  // ── REST helpers ──────────────────────────────────────────────────────────

  private listIssues(query: Record<string, string>): { json: unknown; link?: string } {
    const state = query.state ?? 'open'
    const wanted = (query.labels ?? '')
      .split(',')
      .map((label) => label.trim().toLowerCase())
      .filter((label) => label !== '')
    const assignee = query.assignee?.toLowerCase()
    const assigned = (issue: FakeIssue) =>
      assignee === undefined ||
      (assignee === 'none'
        ? issue.assignees.length === 0
        : assignee === '*'
          ? issue.assignees.length > 0
          : issue.assignees.some((login) => login.toLowerCase() === assignee))
    let issues = [...this.issues.values()].filter(
      (issue) =>
        !issue.gone &&
        (state === 'all' || issue.state === state) &&
        wanted.every((label) => issue.labels.some((held) => held.toLowerCase() === label)) &&
        assigned(issue),
    )
    const sort = query.sort ?? 'created'
    const key = (issue: FakeIssue) =>
      sort === 'updated' ? `${issue.updated_at}#${issue.number}` : issue.number
    issues.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
    if ((query.direction ?? 'desc') === 'desc') issues = issues.reverse()
    return this.page(
      issues.map((issue) => this.json(issue)),
      query,
      '/issues',
    )
  }

  private page<T>(
    items: T[],
    query: Record<string, string>,
    rest: string,
    _dependencies = false,
  ): { json: T[]; link?: string } {
    const perPage = Math.min(Number(query.per_page ?? 30), 100)
    const page = Number(query.page ?? 1)
    const slice = items.slice((page - 1) * perPage, page * perPage)
    if (page * perPage >= items.length) return { json: slice }
    const next = new URLSearchParams({ ...query, page: String(page + 1) })
    return {
      json: slice,
      link: `<${API}/repos/${this.fullName}${rest}?${next.toString()}>; rel="next"`,
    }
  }

  private createIssue(body: unknown): { json: unknown; status: number } {
    const input = body as { title?: string; body?: string; labels?: string[] }
    if (!input?.title) throw new GitHubApiError(422, 'Validation Failed', { message: 'title' })
    const issue = this.insert(input.title, input.body ?? null, [])
    if (!this.dropLabels)
      for (const name of input.labels ?? []) {
        const label = this.ensureLabel(name)
        if (!issue.labels.includes(label.name)) {
          issue.labels.push(label.name)
          issue.events.push({ type: 'labeled', label: label.name })
        }
      }
    return { json: this.json(issue), status: 201 }
  }

  private patchIssue(issue: FakeIssue, body: unknown): unknown {
    const input = body as {
      title?: string
      body?: string
      labels?: string[]
      state?: 'open' | 'closed'
      state_reason?: string | null
    }
    if (input.title !== undefined) issue.title = input.title
    if (input.body !== undefined) issue.body = input.body
    if (input.labels !== undefined && !this.dropLabels) {
      const next = input.labels.map((name) => this.ensureLabel(name).name)
      for (const name of issue.labels)
        if (!next.includes(name)) issue.events.push({ type: 'unlabeled', label: name })
      for (const name of next)
        if (!issue.labels.includes(name)) issue.events.push({ type: 'labeled', label: name })
      issue.labels = [...new Set(next)]
    }
    let stateChanged = false
    if (input.state !== undefined && input.state !== issue.state) {
      stateChanged = true
      issue.state = input.state
      if (input.state === 'closed') {
        issue.state_reason = input.state_reason ?? 'completed'
        issue.events.push({ type: 'closed' })
      } else {
        issue.state_reason = 'reopened'
        issue.events.push({ type: 'reopened' })
      }
    }
    // GitHub documents state_reason as ignored unless the state changes.
    this.changed(issue, true, stateChanged)
    return this.json(issue)
  }

  private createLabel(body: unknown): { json: unknown; status: number } {
    const input = body as { name?: string; description?: string; color?: string }
    if (!this.permissions.push)
      throw new GitHubApiError(403, 'Resource not accessible by integration')
    if (!input?.name) throw new GitHubApiError(422, 'Validation Failed', { message: 'name' })
    if (input.name.length > 50)
      throw new GitHubApiError(422, 'Validation Failed', { message: 'name is too long' })
    if (this.labels.has(input.name.toLowerCase()))
      throw new GitHubApiError(422, 'Validation Failed', {
        message: 'Validation Failed',
        errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }],
      })
    const label = {
      name: input.name,
      description: input.description ?? null,
      color: input.color ?? 'ededed',
    }
    this.labels.set(input.name.toLowerCase(), label)
    return { json: label, status: 201 }
  }

  // ── GraphQL ───────────────────────────────────────────────────────────────

  private graphql(body: unknown, record: FakeGitHubRequestRecord): { json: unknown } {
    const { query = '', variables = {} } = (body ?? {}) as {
      query?: string
      variables?: Record<string, unknown>
    }
    record.query = query
    if (variables.owner !== this.owner || variables.name !== this.name)
      return { json: { data: { repository: null } } }
    if (record.kind === 'timeline-reopen' || record.kind === 'timeline-closed') {
      const issue = this.issues.get(Number(variables.number))
      if (!issue || issue.gone) return { json: { data: { repository: { issue: null } } } }
      if (record.kind === 'timeline-closed')
        return {
          json: {
            data: {
              repository: {
                issue: {
                  timelineItems: {
                    totalCount: issue.events.filter((e) => e.type === 'closed').length,
                  },
                },
              },
            },
          },
        }
      const last = Number(/last:\s*(\d+)/.exec(query)?.[1] ?? 100)
      const nodes = issue.events
        .filter((e) => e.type === 'labeled' || e.type === 'reopened')
        .slice(-last)
        .map((e) =>
          e.type === 'reopened'
            ? { __typename: 'ReopenedEvent' }
            : { __typename: 'LabeledEvent', label: { name: e.label } },
        )
      return { json: { data: { repository: { issue: { timelineItems: { nodes } } } } } }
    }
    // State counts: database-backed connection totals plus one search.
    const fields: string[] = []
    const repository: Record<string, unknown> = {}
    const data: Record<string, unknown> = { repository }
    const live = [...this.issues.values()].filter((issue) => !issue.pull_request && !issue.gone)
    if (/open:\s*issues\(states:\s*OPEN\)/.test(query)) {
      fields.push('open')
      repository.open = { totalCount: live.filter((issue) => issue.state === 'open').length }
    }
    if (/closed:\s*issues\(states:\s*CLOSED\)/.test(query)) {
      fields.push('closed')
      repository.closed = { totalCount: live.filter((issue) => issue.state === 'closed').length }
    }
    if (/labels\(query:/.test(query)) {
      fields.push('labels')
      const search = String(/labels\(query:\s*"([^"]*)"/.exec(query)?.[1] ?? '').toLowerCase()
      const matching = [...this.labels.values()].filter((label) =>
        label.name.toLowerCase().includes(search),
      )
      const after =
        variables.labelsAfter === null || variables.labelsAfter === undefined
          ? 0
          : Number(variables.labelsAfter)
      const slice = matching.slice(after, after + 100)
      repository.labels = {
        nodes: slice.map((label) => ({
          name: label.name,
          description: label.description,
          issues: {
            totalCount: live.filter(
              (issue) =>
                issue.state === 'open' &&
                issue.labels.some((held) => held.toLowerCase() === label.name.toLowerCase()),
            ).length,
          },
        })),
        pageInfo: {
          hasNextPage: after + 100 < matching.length,
          endCursor: String(after + slice.length),
        },
      }
    }
    if (/completed:\s*search\(/.test(query)) {
      fields.push('search')
      const searchQuery = String(variables.search ?? '')
      if (
        !/\breason:completed\b/.test(searchQuery) ||
        /reason:(duplicate|"not planned")/.test(searchQuery)
      )
        throw new GitHubApiError(422, `fake: unsupported search ${searchQuery}`)
      const asOf = this.clock() - this.searchLagMs
      data.completed = {
        issueCount: live.filter((issue) => {
          const indexed = [...issue.history].reverse().find((entry) => entry.at <= asOf)
          // The fake follows the conservative assumption that a null
          // (legacy) close reason does not match `reason:completed`.
          return indexed?.state === 'closed' && indexed.state_reason === 'completed'
        }).length,
      }
    }
    record.fields = fields
    return { json: { data } }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private insert(title: string, body: string | null, labels: string[]): FakeIssue {
    const at = new Date(this.clock()).toISOString()
    const issue: FakeIssue = {
      id: this.nextId++,
      number: this.nextNumber++,
      title,
      body,
      state: 'open',
      state_reason: null,
      labels,
      assignees: [],
      created_at: at,
      updated_at: at,
      pull_request: false,
      comments: 0,
      events: [],
      blockedBy: [],
      history: [{ at: this.clock(), state: 'open', state_reason: null }],
    }
    this.issues.set(issue.number, issue)
    return issue
  }

  private ensureLabel(name: string): FakeLabel {
    const known = this.labels.get(name.toLowerCase())
    if (known) return known
    const label = { name, description: null, color: 'ededed' }
    this.labels.set(name.toLowerCase(), label)
    return label
  }

  private changed(issue: FakeIssue, bump: boolean, stateChanged = true): void {
    if (bump) issue.updated_at = new Date(this.clock()).toISOString()
    if (stateChanged) {
      const last = issue.history.at(-1)
      if (last?.state !== issue.state || last.state_reason !== issue.state_reason)
        issue.history.push({
          at: this.clock(),
          state: issue.state,
          state_reason: issue.state_reason,
        })
    }
  }

  private require(number: number): FakeIssue {
    const issue = this.issues.get(number)
    if (!issue) throw new Error(`fake github: no issue #${number}`)
    return issue
  }

  private live(number: number): FakeIssue {
    const issue = this.issues.get(number)
    if (!issue || issue.gone === 'transferred') throw this.notFound()
    if (issue.gone === 'deleted') throw new GitHubApiError(410, 'This issue was deleted')
    return issue
  }

  private keyOf(issue: FakeIssue): string {
    const repo = (issue as { repo?: string }).repo ?? this.fullName
    return `${repo}#${issue.number}`
  }

  private byKey(key: string): FakeIssue | undefined {
    if (this.foreign.has(key)) return this.foreign.get(key)
    const [repo, number] = key.split('#')
    return repo === this.fullName ? this.issues.get(Number(number)) : undefined
  }

  private byId(id: number | undefined): FakeIssue | undefined {
    for (const issue of this.issues.values()) if (issue.id === id && !issue.gone) return issue
    for (const issue of this.foreign.values()) if (issue.id === id) return issue
    return undefined
  }

  private json(issue: FakeIssue): Record<string, unknown> {
    const repo = (issue as { repo?: string }).repo ?? this.fullName
    return {
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      html_url: `https://github.com/${repo}/${issue.pull_request ? 'pull' : 'issues'}/${issue.number}`,
      repository_url: `${API}/repos/${repo}`,
      state: issue.state,
      state_reason: issue.state_reason,
      labels: issue.labels.map((name) => ({ name })),
      assignees: issue.assignees.map((login) => ({ login })),
      comments: issue.comments,
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      ...(issue.pull_request
        ? { pull_request: { url: `${API}/repos/${repo}/pulls/${issue.number}` } }
        : {}),
      issue_dependencies_summary: {
        blocked_by: issue.blockedBy.length,
        blocking: 0,
        total_blocked_by: issue.blockedBy.length,
        total_blocking: 0,
      },
    }
  }

  private notFound(): GitHubApiError {
    return new GitHubApiError(404, 'Not Found', { message: 'Not Found' })
  }
}
