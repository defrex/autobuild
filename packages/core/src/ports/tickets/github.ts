/**
 * GitHub TicketSource (SPEC §3.2, §13): the issues of the forge repository
 * are the tickets. REST over the shared `GitHubRequest` transport seam, plus
 * GraphQL for bounded counts and the bounded reopen check, so tests run
 * offline against `FakeGitHubIssues`.
 *
 * States are `autobuild:<state>` labels and closing reasons (see
 * `github-issues.ts`); blockers are GitHub's native issue dependencies;
 * assets stay in the BuildStore through the generic CLI path; there are no
 * guarded writes, comment history, integration tree, export or import.
 *
 * Cost (CLAUDE.md "Store read cost is a correctness property", applied to
 * GitHub budget): the source holds no BuildStore handle. Recurring reads
 * (the ready listing, candidates' blockers and reopen checks, dependency
 * reads, `get`, the label registry) are conditional through a durable
 * validator store, so an unchanged repository answers a tick with 304s.
 * Counts are one fresh, bounded GraphQL request per call and are never
 * cached. Explicit history reads, the keyed-create scan, the claim read and
 * every write store nothing. A `readyAssignee` narrows the ready read itself
 * (its `assignee` query parameter); `"me"` costs one `GET /user` per
 * dispatcher start, sent by `prepareReadyAssignee` before the loop and never
 * during a tick.
 */
import { z } from 'zod'
import {
  GitHubApiError,
  githubRateLimitUntil,
  type GitHubRequest,
  type GitHubRequestOpts,
} from '../forge/github-transport'
import type {
  DependencyState,
  IssueLink,
  Ticket,
  TicketCreateOptions,
  TicketCriteria,
  TicketDraft,
  TicketListing,
  TicketSource,
  TicketStateCount,
  TicketStateInfo,
  TicketUpdate,
} from '../types'
import { TicketSourceRateLimitError } from '../types'
import {
  type CreationIntent,
  encodeCreationMarker,
  type GitHubIssue,
  githubIssueSchema,
  githubLabelSchema,
  githubTimelineNodeSchema,
  isClosedCompleted,
  isLinkLabel,
  isStateLabel,
  issueLinksOf,
  issueState,
  labelNames,
  lifecycleNames,
  linkLabel,
  linkLabelsFor,
  mergeIssueLinks,
  NOT_PLANNED_STATE,
  needsReopenCheck,
  parseIssueId,
  type ReopenVerdict,
  rejectedStateOf,
  reopenVerdict,
  representableState,
  splitCreationMarker,
  STATE_LABEL_PREFIX,
  stateLabel,
  stateLabelsOf,
  ticketLabelsOf,
  validCreationKey,
  writeForState,
} from './github-issues'
import { GITHUB_READY_ASSIGNEE } from '../../config/ready-assignee'
import { type GitHubValidatorStore, MemoryGitHubValidatorStore } from './github-validators'
import { normalizeIssueLinks } from './issue-links'
import { holdsState, type TicketLifecycle } from './lifecycle'
import { ticketRevision } from './revision'
import {
  matchStateNames,
  orderStates,
  resolveState,
  validateStateName,
  validateStatePurpose,
} from './states'
import { validateTicketUpdate } from './update'

const SOURCE = 'github ticket source'
const PAGE = '100'
/** A keyed create scans issues created since this long before the key's
 * reservation, which covers clock skew between the caller and GitHub. */
export const CREATION_SCAN_SKEW_MS = 10 * 60 * 1000
/** Timeline window of the reopen check; GitHub's connection maximum. */
export const REOPEN_WINDOW = 100
const LABEL_COLOR = 'ededed'
/** Repository roles GitHub lets set issue labels. */
const LABEL_ROLES = ['triage', 'push', 'maintain', 'admin']
const STATE_LABEL_DESCRIPTION = 'Autobuild ticket state'
const LINK_LABEL_DESCRIPTION = 'Autobuild issue link'
/** GitHub limits a label description to 100 characters. */
const LABEL_DESCRIPTION_MAX = 100

/** A keyed create reached the source without the key's reservation time. */
export class TicketCreationKeyReservationRequired extends Error {
  constructor() {
    super(
      'github create: a creation key requires idempotencyKeyReservedAt (the earliest time the key could first have been used)',
    )
    this.name = 'TicketCreationKeyReservationRequired'
  }
}

export interface GitHubTicketSourceOptions {
  transport: GitHubRequest
  repository: { owner: string; name: string }
  lifecycle: TicketLifecycle
  /** Labels every ready issue must also carry; `[]` removes the gate. */
  readyLabels: string[]
  validators?: GitHubValidatorStore
  now?: () => number
  /** Init validation: the reason no credential was found, if none was. */
  credentialMiss?: () => Promise<string | undefined>
}

interface Response {
  json: unknown
  link?: string
  etag?: string
}

interface Hydrated {
  ticket: Ticket
  /** False when the issue must be left out of listings (no resolved state). */
  listed: boolean
  diagnostics: string[]
  /** Listing-time fact: every blocker is in this repository and done. */
  blockersResolved: boolean
}

interface Blockers {
  ids: string[]
  resolved: boolean
  issues: GitHubIssue[]
}

function statusOf(error: unknown): number | undefined {
  const cause = error instanceof GitHubApiError ? error : (error as { cause?: unknown })?.cause
  return cause instanceof GitHubApiError ? cause.status : undefined
}

/** The API error's message and response body, for classifying a refusal. */
function apiDetail(error: unknown): string {
  const cause = error instanceof GitHubApiError ? error : (error as { cause?: unknown })?.cause
  if (!(cause instanceof GitHubApiError)) return message(error)
  return `${cause.message} ${JSON.stringify(cause.body ?? null)}`
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function nextPage(link: string | undefined): string | undefined {
  if (link === undefined) return undefined
  for (const part of link.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part)
    if (match) return new URL(match[1]!).searchParams.get('page') ?? undefined
  }
  return undefined
}

/** The issue read's ETag as a hydration option, so a reopen check keys its
 * verdict by this read instead of reading the issue again. */
function etagOf(read: { etag?: string }): { etag?: string } {
  return read.etag !== undefined ? { etag: read.etag } : {}
}

function blockerList(ids: string[]): string {
  return ids.length > 0 ? ids.map((id) => `"${id}"`).join(', ') : 'none'
}

/** Who the credential belongs to, as `prepareReadyAssignee` found it. */
type Viewer = { login: string } | { noUser: true } | { failed: string }

const NO_USER_ASSIGNEE =
  'github tickets: [tickets].readyAssignee = "me" but the GitHub credential has no user (a GitHub App installation token has none) — set readyAssignee to a GitHub username'

export class GitHubTicketSource implements TicketSource {
  readonly name = 'github'
  readonly issueLinks = true
  readonly readyAssignee = true

  private readonly transport: GitHubRequest
  private readonly owner: string
  private readonly repo: string
  private readonly lifecycle: TicketLifecycle
  private readonly readyLabels: string[]
  private readonly validators: GitHubValidatorStore
  private readonly now: () => number
  private readonly credentialMiss?: () => Promise<string | undefined>
  private cooldown?: TicketSourceRateLimitError
  /** Exact label name (lowercased) → the one registry write in progress. */
  private readonly pendingLabels = new Map<string, Promise<void>>()
  /** Labels this instance created or saw created, lowercased. */
  private readonly knownLabels = new Set<string>()
  /** The credential's owner, memoized for the instance's lifetime. */
  private viewer?: Viewer

  constructor(opts: GitHubTicketSourceOptions) {
    for (const label of opts.readyLabels) {
      if (label.includes(','))
        throw new Error(`${SOURCE}: readyLabels entry "${label}" contains a comma`)
      if (isStateLabel(label) || isLinkLabel(label))
        throw new Error(
          `${SOURCE}: readyLabels entry "${label}" uses a reserved prefix (${STATE_LABEL_PREFIX} or autobuild-link:); states are configured with readyState`,
        )
    }
    this.transport = opts.transport
    this.owner = opts.repository.owner
    this.repo = opts.repository.name
    this.lifecycle = opts.lifecycle
    this.readyLabels = [...opts.readyLabels]
    this.validators = opts.validators ?? new MemoryGitHubValidatorStore()
    this.now = opts.now ?? Date.now
    if (opts.credentialMiss !== undefined) this.credentialMiss = opts.credentialMiss
  }

  private get fullName(): string {
    return `${this.owner}/${this.repo}`
  }

  private path(rest = ''): string {
    return `repos/${this.owner}/${this.repo}${rest}`
  }

  // ── Transport ─────────────────────────────────────────────────────────────

  /**
   * One request. A remembered GET sends the saved ETag and answers a 304 from
   * the saved JSON. 404 and 410 are `null` when `missing` is set. Rate limits
   * become a cooldown that refuses every request until the reset; nothing
   * ever falls back to a broader read.
   */
  private async request(
    operation: string,
    method: string,
    path: string,
    opts: {
      query?: Record<string, string>
      body?: unknown
      remember?: boolean
      missing?: boolean
    } = {},
  ): Promise<Response | null> {
    if (this.cooldown !== undefined) {
      if (this.now() < this.cooldown.resetAt) throw this.cooldown
      this.cooldown = undefined
    }
    const remember = opts.remember === true && method === 'GET'
    const key = remember
      ? `GET ${path}?${new URLSearchParams(
          Object.entries(opts.query ?? {}).sort(([a], [b]) => a.localeCompare(b)),
        ).toString()}`
      : undefined
    const saved = key === undefined ? undefined : await this.validators.get(key)
    const request: GitHubRequestOpts = {
      ...(opts.query !== undefined ? { query: opts.query } : {}),
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      ...(saved !== undefined ? { headers: { 'If-None-Match': saved.etag } } : {}),
    }
    let response: Awaited<ReturnType<GitHubRequest>>
    try {
      response = await this.transport(method, path, request)
    } catch (error) {
      this.rateLimited(error)
      const status = statusOf(error)
      if (opts.missing && (status === 404 || status === 410)) return null
      throw new Error(`github ${operation}: ${message(error)}`, { cause: error })
    }
    if (response.status === 304 && saved !== undefined && key !== undefined) {
      await this.validators.touch(key)
      return {
        json: saved.json,
        etag: saved.etag,
        ...(saved.link !== undefined ? { link: saved.link } : {}),
      }
    }
    const etag = response.headers.etag
    const link = response.headers.link
    if (key !== undefined && etag !== undefined)
      await this.validators.set(key, {
        etag,
        json: response.json,
        ...(link !== undefined ? { link } : {}),
      })
    return {
      json: response.json,
      ...(etag !== undefined ? { etag } : {}),
      ...(link !== undefined ? { link } : {}),
    }
  }

  private async must(
    operation: string,
    method: string,
    path: string,
    opts: { query?: Record<string, string>; body?: unknown; remember?: boolean } = {},
  ): Promise<Response> {
    return (await this.request(operation, method, path, opts)) as Response
  }

  /** Record and throw a documented rate limit; anything else returns. */
  private rateLimited(error: unknown): void {
    const resetAt = githubRateLimitUntil(error, this.now())
    if (resetAt === undefined) return
    this.cooldown = new TicketSourceRateLimitError('github', Date.parse(resetAt))
    throw this.cooldown
  }

  private async graphql<T>(
    operation: string,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const response = await this.must(operation, 'POST', 'graphql', { body: { query, variables } })
    const payload = (response.json ?? {}) as {
      data?: T | null
      errors?: Array<{ message?: string; type?: string }>
    }
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      const failure = new GitHubApiError(
        200,
        payload.errors.map((e) => e.message ?? 'GraphQL error').join('; '),
        payload,
      )
      this.rateLimited(failure)
      throw new Error(`github ${operation}: GraphQL errors — ${failure.message}`, {
        cause: failure,
      })
    }
    if (payload.data === undefined || payload.data === null)
      throw new Error(`github ${operation}: response has no data`)
    return payload.data
  }

  private parseIssue(operation: string, json: unknown): GitHubIssue {
    const parsed = githubIssueSchema.safeParse(json)
    if (!parsed.success)
      throw new Error(`github ${operation}: unexpected issue shape — ${parsed.error.message}`)
    return parsed.data
  }

  private async readIssue(
    operation: string,
    number: number,
    remember: boolean,
  ): Promise<{ issue: GitHubIssue; etag?: string } | null> {
    const response = await this.request(operation, 'GET', this.path(`/issues/${number}`), {
      remember,
      missing: true,
    })
    if (response === null) return null
    const issue = this.parseIssue(operation, response.json)
    if (issue.pull_request !== undefined) return null
    // A transferred issue answers 301 and the transport follows it, so the
    // body can be another repository's issue under another number. It is no
    // longer a ticket here: callers see an unknown ticket and write nothing.
    if (!this.isLocalIssue(issue, number)) return null
    return { issue, ...(response.etag !== undefined ? { etag: response.etag } : {}) }
  }

  /** Every issue a listing query matches, in GitHub order, PRs skipped. */
  private async listIssues(
    operation: string,
    query: Record<string, string>,
    remember: boolean,
  ): Promise<GitHubIssue[]> {
    const issues: GitHubIssue[] = []
    let page: string | undefined = '1'
    while (page !== undefined) {
      const response = await this.must(operation, 'GET', this.path('/issues'), {
        query: { ...query, per_page: PAGE, page },
        remember,
      })
      for (const json of z.array(z.unknown()).parse(response.json)) {
        const issue = this.parseIssue(operation, json)
        if (issue.pull_request === undefined) issues.push(issue)
      }
      page = nextPage(response.link)
    }
    return issues
  }

  private async patchIssue(
    operation: string,
    number: number,
    body: Record<string, unknown>,
  ): Promise<GitHubIssue> {
    const response = await this.request(operation, 'PATCH', this.path(`/issues/${number}`), {
      body,
      missing: true,
    })
    if (response === null) throw new Error(`github ${operation}: unknown ticket "${number}"`)
    const issue = this.parseIssue(operation, response.json)
    // Without push access GitHub answers a label change with success and
    // keeps the old labels, so a write is applied only if they came back.
    if (Array.isArray(body.labels)) {
      const wanted = new Set((body.labels as string[]).map((name) => name.toLowerCase()))
      const held = new Set(labelNames(issue).map((name) => name.toLowerCase()))
      if (wanted.size !== held.size || [...wanted].some((name) => !held.has(name)))
        throw new Error(
          `github ${operation}: token lacks push access; label changes were dropped on #${number} (${issue.html_url})`,
        )
    }
    return issue
  }

  // ── Labels ────────────────────────────────────────────────────────────────

  /** The repository's labels through the remembered conditional read. Grows
   * with label count, so only explicit state discovery and the unknown-state
   * refusal call it; recurring writes look labels up by exact name. */
  private async labelRegistry(): Promise<Array<{ name: string; description?: string }>> {
    const labels: Array<{ name: string; description?: string }> = []
    let page: string | undefined = '1'
    while (page !== undefined) {
      const response = await this.must('labels', 'GET', this.path('/labels'), {
        query: { per_page: PAGE, page },
        remember: true,
      })
      for (const json of z.array(z.unknown()).parse(response.json)) {
        const label = githubLabelSchema.parse(json)
        labels.push({
          name: label.name,
          ...(label.description ? { description: label.description } : {}),
        })
      }
      page = nextPage(response.link)
    }
    for (const label of labels) this.knownLabels.add(label.name.toLowerCase())
    return labels
  }

  /** One label by exact name (GitHub matches it ignoring case), or `null`. */
  private async readLabel(
    operation: string,
    name: string,
    remember: boolean,
  ): Promise<{ name: string } | null> {
    const response = await this.request(
      operation,
      'GET',
      this.path(`/labels/${encodeURIComponent(name)}`),
      { remember, missing: true },
    )
    if (response === null) return null
    const label = githubLabelSchema.parse(response.json)
    this.knownLabels.add(label.name.toLowerCase())
    return { name: label.name }
  }

  /** Create every missing label, one exact lookup each; the registry is never
   * listed, so the cost follows the names asked for, not the label count. */
  private async ensureLabels(operation: string, names: readonly string[]): Promise<void> {
    const missing = [...new Set(names.map((name) => name.toLowerCase()))]
      .filter((key) => !this.knownLabels.has(key))
      .map((key) => names.find((name) => name.toLowerCase() === key)!)
    await Promise.all(
      missing.map(async (name) => {
        if ((await this.readLabel(operation, name, true)) === null)
          await this.createLabel(operation, name)
      }),
    )
  }

  private createLabel(operation: string, name: string, description?: string): Promise<void> {
    const key = name.toLowerCase()
    const pending = this.pendingLabels.get(key)
    if (pending !== undefined) return pending
    const write = (async () => {
      try {
        await this.must(operation, 'POST', this.path('/labels'), {
          body: {
            name,
            color: LABEL_COLOR,
            description:
              description ??
              (isStateLabel(name)
                ? STATE_LABEL_DESCRIPTION
                : isLinkLabel(name)
                  ? LINK_LABEL_DESCRIPTION
                  : ''),
          },
        })
      } catch (error) {
        // A 422 is success only when the label now reads back: someone else
        // created it between the lookup and the write.
        if (statusOf(error) !== 422 || (await this.readLabel(operation, name, false)) === null)
          throw error
      }
      this.knownLabels.add(key)
    })()
    this.pendingLabels.set(key, write)
    return write.finally(() => this.pendingLabels.delete(key))
  }

  private refuseManagedLabels(operation: string, labels: readonly string[]): void {
    const managed = labels.filter((label) => isStateLabel(label) || isLinkLabel(label))
    if (managed.length > 0)
      throw new Error(
        `github ${operation}: ${managed.map((label) => `"${label}"`).join(', ')} ${managed.length === 1 ? 'is a' : 'are'} managed label${managed.length === 1 ? '' : 's'}; move tickets with \`ab ticket move\` and set links with --issues — nothing was written`,
      )
  }

  // ── State names ───────────────────────────────────────────────────────────

  /** Count-free state names: the configured lifecycle, `not-planned` without
   * a rejected role, then every `autobuild:` label from the remembered label
   * registry. Never sends GraphQL or search. */
  private async stateNames(): Promise<string[]> {
    const names = this.configuredStates()
    for (const label of await this.labelRegistry()) {
      if (!isStateLabel(label.name)) continue
      const name = label.name.slice(STATE_LABEL_PREFIX.length)
      if (!names.some((known) => holdsState(known, name))) names.push(name)
    }
    return names
  }

  private configuredStates(): string[] {
    const names = lifecycleNames(this.lifecycle)
    if (this.lifecycle.rejected === undefined) names.push(NOT_PLANNED_STATE)
    return names
  }

  /** Resolve a write's target state without listing the label registry: a
   * configured state matches by name, any other by one exact label lookup.
   * Only an unknown state lists the registry, to name the known states. */
  private async resolveTarget(operation: string, state: string): Promise<string> {
    const configured = this.configuredStates()
    if (configured.some((known) => holdsState(known, state)))
      return resolveState(state, configured, SOURCE)
    const label = state === '' ? null : await this.readLabel(operation, stateLabel(state), true)
    if (label !== null && isStateLabel(label.name))
      return label.name.slice(STATE_LABEL_PREFIX.length)
    return resolveState(state, await this.stateNames(), SOURCE)
  }

  private lifecycleOrder(): string[] {
    return [
      this.lifecycle.triage,
      this.lifecycle.ready,
      this.lifecycle.doing,
      this.lifecycle.done,
      ...(this.lifecycle.backlog !== undefined ? [this.lifecycle.backlog] : []),
      rejectedStateOf(this.lifecycle),
    ]
  }

  // ── Hydration ─────────────────────────────────────────────────────────────

  /** One bounded GraphQL timeline read decides whether a reopened issue's
   * state label predates the reopen; the verdict is saved keyed by the
   * issue's ETag, so an unchanged issue never asks again. */
  private async reopenCheck(
    issue: GitHubIssue,
    remember: boolean,
    etag?: string,
  ): Promise<ReopenVerdict> {
    let tag = etag
    if (tag === undefined) {
      const read = await this.request('reopen check', 'GET', this.path(`/issues/${issue.number}`), {
        remember,
        missing: true,
      })
      tag = read?.etag
    }
    const key = `reopen-verdict:${issue.number}`
    const saved = tag === undefined ? undefined : await this.validators.get(key)
    if (
      saved !== undefined &&
      saved.etag === tag &&
      (saved.json === 'fresh' || saved.json === 'stale' || saved.json === 'undecidable')
    ) {
      await this.validators.touch(key)
      return saved.json
    }
    const data = await this.graphql<{
      repository: { issue: { timelineItems: { nodes: unknown[] } } | null } | null
    }>(
      'reopen check',
      `query ReopenCheck($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { timelineItems(last: ${REOPEN_WINDOW}, itemTypes: [REOPENED_EVENT, LABELED_EVENT]) { nodes { __typename ... on LabeledEvent { label { name } } } } } } }`,
      { owner: this.owner, name: this.repo, number: issue.number },
    )
    const nodes = z
      .array(githubTimelineNodeSchema)
      .parse(data.repository?.issue?.timelineItems.nodes ?? [])
    const verdict = reopenVerdict(nodes, stateLabelsOf(issue)[0]!)
    if (tag !== undefined && remember) await this.validators.set(key, { etag: tag, json: verdict })
    return verdict
  }

  /** Strip a stale pre-reopen state label. Best-effort: only a rate limit
   * fails the read. */
  private async heal(issue: GitHubIssue): Promise<void> {
    try {
      await this.patchIssue('heal', issue.number, {
        labels: labelNames(issue).filter((name) => !isStateLabel(name)),
      })
    } catch (error) {
      if (error instanceof TicketSourceRateLimitError) throw error
    }
  }

  private async blockers(issue: GitHubIssue, remember: boolean): Promise<Blockers> {
    const summary = issue.issue_dependencies_summary
    const total = summary?.total_blocked_by ?? summary?.blocked_by
    if (total === 0) return { ids: [], resolved: true, issues: [] }
    const issues: GitHubIssue[] = []
    let page: string | undefined = '1'
    while (page !== undefined) {
      const response = await this.must(
        'blockers',
        'GET',
        this.path(`/issues/${issue.number}/dependencies/blocked_by`),
        { query: { per_page: PAGE, page }, remember },
      )
      for (const json of z.array(z.unknown()).parse(response.json))
        issues.push(this.parseIssue('blockers', json))
      page = nextPage(response.link)
    }
    const ids: string[] = []
    let resolved = true
    for (const blocker of issues) {
      const repo = this.repositoryOf(blocker)
      const local = repo === undefined || repo.toLowerCase() === this.fullName.toLowerCase()
      ids.push(local ? String(blocker.number) : `${repo}#${blocker.number}`)
      if (!local || !isClosedCompleted(blocker)) resolved = false
    }
    return { ids: [...new Set(ids)], resolved, issues }
  }

  /** Whether `issue` is issue `number` of the configured repository. */
  private isLocalIssue(issue: GitHubIssue, number: number): boolean {
    if (issue.number !== number) return false
    const repo = this.repositoryOf(issue)
    return repo === undefined || repo.toLowerCase() === this.fullName.toLowerCase()
  }

  private repositoryOf(issue: GitHubIssue): string | undefined {
    const match = /\/repos\/([^/]+\/[^/]+)$/.exec(issue.repository_url ?? '')
    return match?.[1]
  }

  private async hydrate(
    issue: GitHubIssue,
    opts: { remember: boolean; etag?: string },
  ): Promise<Hydrated> {
    const diagnostics: string[] = []
    const n = issue.number
    const links = issueLinksOf(issue)
    for (const name of links.invalid)
      diagnostics.push(
        `github #${n}: ignoring malformed issue link label "${name}" — expected autobuild-link:closes #<n> or autobuild-link:refs #<n>`,
      )
    let current = issue
    let state: string | undefined
    const read = issueState(issue, this.lifecycle)
    if ('malformed' in read) {
      diagnostics.push(
        `github #${n}: has ${read.malformed.length} state labels (${read.malformed.join(', ')}); a ticket holds one state — remove all but one`,
      )
    } else {
      state = read.state
      if (needsReopenCheck(issue)) {
        const verdict = await this.reopenCheck(issue, opts.remember, opts.etag)
        if (verdict === 'stale') {
          await this.heal(issue)
          current = {
            ...issue,
            labels: labelNames(issue).filter((name) => !isStateLabel(name)),
          }
          state = this.lifecycle.triage
        } else if (verdict === 'undecidable') {
          diagnostics.push(
            `github #${n}: reopened with ${stateLabelsOf(issue)[0]}, but neither the reopen nor that label's event is among its last ${REOPEN_WINDOW} label or reopen events; remove and re-add the label`,
          )
          state = undefined
        }
      }
    }
    const blockers = await this.blockers(issue, opts.remember)
    return {
      ticket: this.toTicket(current, state, blockers.ids, links.links),
      listed: state !== undefined,
      diagnostics,
      blockersResolved: blockers.resolved,
    }
  }

  private toTicket(
    issue: GitHubIssue,
    state: string | undefined,
    blockedBy: string[],
    issueLinks: IssueLink[],
  ): Ticket {
    const { body, marker } = splitCreationMarker(issue.body)
    const ticket: Ticket = {
      kind: 'work',
      revision: '',
      ref: { source: this.name, id: String(issue.number), url: issue.html_url, title: issue.title },
      ...(marker !== undefined ? { creationKey: marker.key } : {}),
      title: issue.title,
      body,
      ...(state !== undefined ? { state } : {}),
      resolved: state !== undefined && isClosedCompleted(issue),
      labels: ticketLabelsOf(issue),
      ...(blockedBy.length > 0 ? { blockedBy } : {}),
      issueLinks,
    }
    ticket.revision = ticketRevision(ticket)
    return ticket
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  async get(id: string): Promise<Ticket | null> {
    const number = parseIssueId(id)
    if (number === null) return null
    const read = await this.readIssue('get', number, true)
    if (read === null) return null
    return (await this.hydrate(read.issue, { remember: true, ...etagOf(read) })).ticket
  }

  async listAll(): Promise<TicketListing> {
    return this.listing(
      await this.listIssues('listAll', { state: 'all' }, false),
      () => true,
      false,
    )
  }

  async listReady(criteria: TicketCriteria): Promise<TicketListing> {
    const labels = criteria.labels ?? []
    for (const label of labels)
      if (label.includes(',')) throw new Error(`${SOURCE}: label "${label}" contains a comma`)
    const login =
      criteria.assignee !== undefined ? await this.assigneeLogin(criteria.assignee) : undefined
    const labelQuery = (extra: string[] = []): Record<string, string> => {
      const all = [...extra, ...labels]
      return {
        ...(all.length > 0 ? { labels: all.join(',') } : {}),
        ...(login !== undefined ? { assignee: login } : {}),
      }
    }
    // GitHub narrows the read server-side; the explicit membership check
    // keeps "ready when the user is one of several assignees" independent of
    // that, and drops issues before hydration reads their blockers.
    const listIssues = async (
      operation: string,
      query: Record<string, string>,
      remember: boolean,
    ): Promise<GitHubIssue[]> => {
      const issues = await this.listIssues(operation, query, remember)
      if (login === undefined) return issues
      const wanted = login.toLowerCase()
      return issues.filter((issue) =>
        (issue.assignees ?? []).some((assignee) => assignee.login.toLowerCase() === wanted),
      )
    }
    if (criteria.state === undefined)
      return this.listing(
        await listIssues('list', { state: 'all', ...labelQuery() }, false),
        () => true,
        false,
      )
    const wanted = criteria.state
    const holds = (ticket: Ticket) => holdsState(ticket.state, wanted)
    if (
      holdsState(wanted, this.lifecycle.done) ||
      holdsState(wanted, rejectedStateOf(this.lifecycle))
    )
      return this.listing(
        await listIssues('list', { state: 'closed', ...labelQuery() }, false),
        holds,
        false,
      )
    if (holdsState(wanted, this.lifecycle.triage))
      return this.listing(
        await listIssues('list', { state: 'open', ...labelQuery() }, false),
        holds,
        false,
      )
    // A label state: the ready listing is the recurring dispatcher read, so
    // it alone is remembered, oldest first for a stable order.
    const recurring = holdsState(wanted, this.lifecycle.ready)
    return this.listing(
      await listIssues(
        'listReady',
        {
          state: 'open',
          sort: 'created',
          direction: 'asc',
          ...labelQuery([stateLabel(wanted)]),
        },
        recurring,
      ),
      holds,
      recurring,
    )
  }

  private async listing(
    issues: GitHubIssue[],
    keep: (ticket: Ticket) => boolean,
    remember: boolean,
  ): Promise<TicketListing> {
    const tickets: Ticket[] = []
    const diagnostics: string[] = []
    for (const issue of issues) {
      const hydrated = await this.hydrate(issue, { remember })
      diagnostics.push(...hydrated.diagnostics)
      if (!hydrated.listed || !keep(hydrated.ticket)) continue
      tickets.push({ ...hydrated.ticket, blockersResolved: hydrated.blockersResolved })
    }
    return { tickets, diagnostics }
  }

  async dependencyStates(ids: string[]): Promise<DependencyState[]> {
    const results: DependencyState[] = []
    for (const id of ids) {
      const foreign = /^([^/\s#]+\/[^/\s#]+)#([1-9][0-9]*)$/.exec(id)
      if (foreign && foreign[1]!.toLowerCase() !== this.fullName.toLowerCase()) {
        // GitHub allows cross-repository dependencies; they never resolve here.
        results.push({ id, exists: true, resolved: false, blockedBy: [] })
        continue
      }
      const number = foreign ? Number(foreign[2]) : parseIssueId(id)
      const read = number === null ? null : await this.readIssue('dependencyStates', number, true)
      if (read === null) {
        results.push({ id, exists: false, resolved: false, blockedBy: [] })
        continue
      }
      const { ticket } = await this.hydrate(read.issue, { remember: true, ...etagOf(read) })
      results.push({
        id,
        exists: true,
        resolved: ticket.resolved,
        ...(ticket.state !== undefined ? { state: ticket.state } : {}),
        blockedBy: ticket.blockedBy ?? [],
      })
    }
    return results
  }

  // ── Claim and projections ─────────────────────────────────────────────────

  /**
   * Claim-before-launch (SPEC §12): a fresh, unconditional read re-checks the
   * issue is open, in the ready state and carries every ready label; then the
   * ready label becomes the claimed one. The pair is not transactional, which
   * the single-writer dispatcher (§12) makes acceptable.
   */
  async claim(id: string): Promise<boolean> {
    const number = parseIssueId(id)
    if (number === null) return false
    const read = await this.readIssue('claim', number, false)
    if (read === null) return false
    const { issue } = read
    if (issue.state !== 'open') return false
    const current = issueState(issue, this.lifecycle)
    if ('malformed' in current || !holdsState(current.state, this.lifecycle.ready)) return false
    const labels = ticketLabelsOf(issue).map((label) => label.toLowerCase())
    if (!this.readyLabels.every((label) => labels.includes(label.toLowerCase()))) return false
    if (needsReopenCheck(issue)) {
      const verdict = await this.reopenCheck(issue, true, read.etag)
      if (verdict === 'stale') await this.heal(issue)
      if (verdict !== 'fresh') return false
    }
    await this.ensureLabels('claim', [stateLabel(this.lifecycle.doing)])
    await this.patchIssue('claim', number, {
      labels: [
        ...labelNames(issue).filter((name) => !isStateLabel(name)),
        stateLabel(this.lifecycle.doing),
      ],
    })
    return true
  }

  async comment(id: string, body: string): Promise<void> {
    const number = parseIssueId(id)
    const response =
      number === null
        ? null
        : await this.request('comment', 'POST', this.path(`/issues/${number}/comments`), {
            body: { body },
            missing: true,
          })
    if (response === null) throw new Error(`github comment: unknown ticket "${id}"`)
  }

  async transition(id: string, state: string): Promise<void> {
    const number = parseIssueId(id)
    if (number === null) throw new Error(`github transition: unknown ticket "${id}"`)
    const target = await this.resolveTarget('transition', state)
    const read = await this.readIssue('transition', number, false)
    if (read === null) throw new Error(`github transition: unknown ticket "${id}"`)
    await this.applyState('transition', read.issue, target)
  }

  /**
   * Put an issue in `state`. Reopening into a label state strips state labels
   * on the reopen and adds the target label in a second write, so a `labeled`
   * event always follows the `reopened` one and the label reads as fresh.
   */
  private async applyState(operation: string, issue: GitHubIssue, state: string): Promise<void> {
    const write = writeForState(state, this.lifecycle, labelNames(issue))
    const target = write.labels.filter(isStateLabel)
    await this.ensureLabels(operation, target)
    if (write.state === 'closed') {
      // GitHub ignores state_reason unless the state changes, so a closed
      // issue whose completion differs from the target's is reopened first.
      const completed = write.state_reason === 'completed'
      if (issue.state === 'closed' && isClosedCompleted(issue) !== completed)
        await this.patchIssue(operation, issue.number, {
          state: 'open',
          labels: write.labels,
        })
      await this.patchIssue(operation, issue.number, {
        state: 'closed',
        state_reason: write.state_reason,
        labels: write.labels,
      })
      return
    }
    const kept = write.labels.filter((name) => !isStateLabel(name))
    const reopening = issue.state === 'closed'
    const relabel =
      issue.state === 'open' &&
      needsReopenCheck(issue) &&
      target.some((name) =>
        stateLabelsOf(issue).some((held) => held.toLowerCase() === name.toLowerCase()),
      )
    if (reopening || relabel) {
      await this.patchIssue(operation, issue.number, {
        ...(reopening ? { state: 'open' } : {}),
        labels: kept,
      })
      if (target.length > 0)
        await this.patchIssue(operation, issue.number, { labels: write.labels })
      return
    }
    const before = labelNames(issue)
      .map((name) => name.toLowerCase())
      .sort()
    const after = write.labels.map((name) => name.toLowerCase()).sort()
    if (before.join('\n') === after.join('\n')) return
    await this.patchIssue(operation, issue.number, { labels: write.labels })
  }

  // ── Create ────────────────────────────────────────────────────────────────

  async create(draft: TicketDraft, opts: TicketCreateOptions = {}): Promise<Ticket> {
    if (opts.requestedId !== undefined) throw new Error('github does not support requested ids')
    if (draft.kind === 'node' || (draft.target !== undefined && draft.target !== null))
      throw new Error(`${this.name} ticket source does not support kind/target writes`)
    const labels = draft.labels ?? []
    this.refuseManagedLabels('create', labels)
    const links = mergeIssueLinks(normalizeIssueLinks(draft.issueLinks ?? []))
    const blockedBy = [...new Set(draft.blockedBy ?? [])]
    for (const blocker of blockedBy)
      if (parseIssueId(blocker) === null)
        throw new Error(
          `github create: blocker "${blocker}" is not an issue number in ${this.fullName} — nothing was written`,
        )
    const key = opts.idempotencyKey
    let reservedAt: number | undefined
    if (key !== undefined) {
      if (!validCreationKey(key))
        throw new Error(
          `github create: creation key "${key}" must be 1-200 letters, digits, dots, colons, underscores or hyphens`,
        )
      reservedAt =
        opts.idempotencyKeyReservedAt === undefined
          ? Number.NaN
          : Date.parse(opts.idempotencyKeyReservedAt)
      if (!Number.isFinite(reservedAt)) throw new TicketCreationKeyReservationRequired()
    }
    const state = await this.resolveTarget('create', opts.state ?? this.lifecycle.create)
    const write = writeForState(state, this.lifecycle, [...labels, ...links.map(linkLabel)])
    if (key !== undefined && reservedAt !== undefined) {
      const adopted = await this.findByCreationKey(key, reservedAt)
      if (adopted !== undefined) return this.adopt(adopted, blockedBy)
    }
    // A closing create state opens the issue without a state label and
    // closes it as a follow-up.
    const initial = write.labels
    await this.ensureLabels('create', initial)
    const intent: CreationIntent = { state, issueLinks: links, blockedBy }
    const response = await this.must('create', 'POST', this.path('/issues'), {
      body: {
        title: draft.title,
        body: key === undefined ? draft.body : encodeCreationMarker(draft.body, key, intent),
        labels: initial,
      },
    })
    const issue = this.parseIssue('create', response.json)
    const held = labelNames(issue).map((name) => name.toLowerCase())
    if (!initial.every((name) => held.includes(name.toLowerCase())))
      throw new Error(
        `github create: token lacks push access; labels were dropped on #${issue.number} (${issue.html_url})`,
      )
    return this.finishCreate(issue, intent, key, false)
  }

  /** Issues created since the key's reservation (less clock skew), newest
   * first, through the consistent list endpoint; search lags writes. */
  private async findByCreationKey(
    key: string,
    reservedAt: number,
  ): Promise<GitHubIssue | undefined> {
    const floor = reservedAt - CREATION_SCAN_SKEW_MS
    let page: string | undefined = '1'
    while (page !== undefined) {
      const response = await this.must('create', 'GET', this.path('/issues'), {
        query: {
          state: 'all',
          sort: 'created',
          direction: 'desc',
          per_page: PAGE,
          page,
        },
      })
      for (const json of z.array(z.unknown()).parse(response.json)) {
        const issue = this.parseIssue('create', json)
        if (issue.pull_request !== undefined) continue
        if (issue.created_at !== undefined && Date.parse(issue.created_at) < floor) return undefined
        if (splitCreationMarker(issue.body).marker?.key === key) return issue
      }
      page = nextPage(response.link)
    }
    return undefined
  }

  /** A retry found the issue its key opened. A pending marker finishes the
   * first attempt's recorded intent; a plain one reconciles only missing
   * blockers from this retry, as Linear does. */
  private async adopt(issue: GitHubIssue, retryBlockers: string[]): Promise<Ticket> {
    const marker = splitCreationMarker(issue.body).marker!
    if (marker.pending !== undefined)
      return this.finishCreate(issue, marker.pending, marker.key, true)
    if (retryBlockers.length > 0) await this.recordBlockers(issue, retryBlockers, true, true)
    return this.fresh('create', issue.number)
  }

  /**
   * The create's follow-ups, shared by a first attempt and a recovery so both
   * run the same idempotent steps: the closure, any missing link labels, the
   * blockers, then the marker rewritten to its plain (complete) form.
   */
  private async finishCreate(
    issue: GitHubIssue,
    intent: CreationIntent,
    key: string | undefined,
    adopting: boolean,
  ): Promise<Ticket> {
    let current = issue
    const write = intent.state === '' ? undefined : writeForState(intent.state, this.lifecycle, [])
    if (write?.state === 'closed' && current.state === 'open') {
      // A recovery never undoes a person's reopen: close only an issue that
      // has never been closed.
      const neverClosed = !adopting || (await this.closedEvents(current.number)) === 0
      if (neverClosed)
        current = await this.patchIssue('create', current.number, {
          state: 'closed',
          state_reason: write.state_reason,
          labels: labelNames(current).filter((name) => !isStateLabel(name)),
        })
    }
    if (adopting) {
      const wanted = linkLabelsFor(current.number, intent.issueLinks)
      const held = labelNames(current)
      const missing = wanted.filter(
        (name) => !held.some((label) => label.toLowerCase() === name.toLowerCase()),
      )
      if (missing.length > 0) {
        await this.ensureLabels('create', missing)
        current = await this.patchIssue('create', current.number, { labels: [...held, ...missing] })
      }
    }
    if (intent.blockedBy.length > 0)
      await this.recordBlockers(current, intent.blockedBy, adopting, key !== undefined)
    if (key !== undefined) {
      const { body } = splitCreationMarker(current.body)
      await this.patchIssue('create', current.number, { body: encodeCreationMarker(body, key) })
    }
    return this.fresh('create', current.number)
  }

  private async closedEvents(number: number): Promise<number> {
    const data = await this.graphql<{
      repository: { issue: { timelineItems: { totalCount: number } } | null } | null
    }>(
      'create',
      'query ClosedEvents($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { timelineItems(itemTypes: [CLOSED_EVENT], first: 1) { totalCount } } } }',
      { owner: this.owner, name: this.repo, number },
    )
    return data.repository?.issue?.timelineItems.totalCount ?? 0
  }

  /** Record blockers on a created issue. Every failure says the issue exists,
   * and which blockers were and were not recorded, so a retry adopts it
   * rather than duplicating it. */
  private async recordBlockers(
    issue: GitHubIssue,
    requested: string[],
    readExisting: boolean,
    retryableByKey: boolean,
  ): Promise<void> {
    const recorded: string[] = []
    try {
      if (readExisting) recorded.push(...(await this.blockers(issue, false)).ids)
      for (const blocker of requested) {
        if (recorded.includes(blocker)) continue
        await this.postBlocker('create', issue.number, blocker)
        recorded.push(blocker)
      }
    } catch (error) {
      if (error instanceof TicketSourceRateLimitError && recorded.length === 0 && !retryableByKey)
        throw error
      const unrecorded = requested.filter((id) => !recorded.includes(id))
      throw new Error(
        `github create: ticket "${issue.number}" ${retryableByKey ? 'already exists' : 'was created'} at ${issue.html_url}, ` +
          'but its blockers were not all recorded. ' +
          `Blockers recorded: ${blockerList(requested.filter((id) => recorded.includes(id)))}. ` +
          `Blockers not recorded: ${blockerList(unrecorded)}. ` +
          (retryableByKey
            ? 'Retry with the same creation key; GitHub will adopt this ticket and finish only what is missing. '
            : 'Do not rerun ticket creation; repair the blockers on the existing ticket. ') +
          `Underlying failure: ${message(error)}`,
        { cause: error },
      )
    }
  }

  private async fresh(operation: string, number: number): Promise<Ticket> {
    const read = await this.readIssue(operation, number, false)
    if (read === null) throw new Error(`github ${operation}: issue #${number} disappeared`)
    return (await this.hydrate(read.issue, { remember: false })).ticket
  }

  // ── Grooming writes ───────────────────────────────────────────────────────

  async update(id: string, patch: TicketUpdate): Promise<void> {
    const validated = validateTicketUpdate(patch)
    if (validated.kind !== undefined || validated.target !== undefined)
      throw new Error(`${this.name} ticket source does not support kind/target writes`)
    const number = parseIssueId(id)
    if (number === null) throw new Error(`github update: unknown ticket "${id}"`)
    if (validated.labels !== undefined) this.refuseManagedLabels('update', validated.labels)
    const links =
      validated.issueLinks === undefined ? undefined : mergeIssueLinks(validated.issueLinks)
    if (links?.some((link) => link.issue === number && link.intent === 'refs'))
      throw new Error(
        `github update: ticket "${id}" is issue #${number}, which it always closes; it cannot also only refer to it — nothing was written`,
      )
    const read = await this.readIssue('update', number, false)
    if (read === null) throw new Error(`github update: unknown ticket "${id}"`)
    const { issue } = read
    const held = labelNames(issue)
    const body: Record<string, unknown> = {}
    if (validated.title !== undefined) body.title = validated.title
    if (validated.body !== undefined) {
      const { body: stored } = splitCreationMarker(issue.body)
      const marker = (issue.body ?? '').slice(stored.length)
      body.body = validated.body + marker
    }
    if (validated.labels !== undefined || links !== undefined) {
      const labels = [
        ...(validated.labels ?? held.filter((name) => !isStateLabel(name) && !isLinkLabel(name))),
        ...held.filter(isStateLabel),
        ...(links === undefined ? held.filter(isLinkLabel) : linkLabelsFor(number, links)),
      ]
      await this.ensureLabels('update', labels)
      body.labels = [...new Set(labels)]
    }
    await this.patchIssue('update', number, body)
  }

  async addBlocker(id: string, blockerId: string): Promise<void> {
    const number = parseIssueId(id)
    const target = number === null ? null : await this.readIssue('addBlocker', number, false)
    if (target === null) throw new Error(`github addBlocker: unknown ticket "${id}"`)
    const blocker = parseIssueId(blockerId)
    if (blocker === number || id === blockerId)
      throw new Error(`github addBlocker: ticket "${id}" cannot block itself`)
    if (blocker === null)
      throw new Error(
        `github addBlocker: unknown blocker "${blockerId}" — blockers are issue numbers in ${this.fullName}; add cross-repository dependencies on GitHub`,
      )
    const existing = await this.blockers(target.issue, false)
    if (existing.ids.includes(String(blocker))) return
    await this.postBlocker('addBlocker', number!, String(blocker))
  }

  private async postBlocker(operation: string, number: number, blockerId: string): Promise<void> {
    const blockerNumber = parseIssueId(blockerId)
    const blocker =
      blockerNumber === null ? null : await this.readIssue(operation, blockerNumber, false)
    if (blocker === null) throw new Error(`github ${operation}: unknown blocker "${blockerId}"`)
    if (blocker.issue.number === number)
      throw new Error(`github ${operation}: ticket "${number}" cannot block itself`)
    try {
      await this.must(operation, 'POST', this.path(`/issues/${number}/dependencies/blocked_by`), {
        body: { issue_id: blocker.issue.id },
      })
    } catch (error) {
      // GitHub answers 422 both for an existing dependency and for a refused
      // one; only the edge itself, read back, says the retry already holds.
      if (statusOf(error) !== 422) throw error
      if (!(await this.holdsBlocker(operation, number, blocker.issue.id))) throw error
    }
  }

  /** Whether issue `number` is blocked by the issue with database id `id`,
   * read unconditionally from the dependency list. */
  private async holdsBlocker(operation: string, number: number, id: number): Promise<boolean> {
    let page: string | undefined = '1'
    while (page !== undefined) {
      const response = await this.must(
        operation,
        'GET',
        this.path(`/issues/${number}/dependencies/blocked_by`),
        { query: { per_page: PAGE, page } },
      )
      for (const json of z.array(z.unknown()).parse(response.json))
        if (this.parseIssue(operation, json).id === id) return true
      page = nextPage(response.link)
    }
    return false
  }

  async removeBlocker(id: string, blockerId: string): Promise<void> {
    const number = parseIssueId(id)
    const target = number === null ? null : await this.readIssue('removeBlocker', number, false)
    if (target === null) throw new Error(`github removeBlocker: unknown ticket "${id}"`)
    const existing = await this.blockers(target.issue, false)
    const index = existing.ids.indexOf(
      parseIssueId(blockerId) === null ? blockerId : String(parseIssueId(blockerId)),
    )
    if (index < 0) return
    const blocker = existing.issues[index]!
    try {
      await this.must(
        'removeBlocker',
        'DELETE',
        this.path(`/issues/${number}/dependencies/blocked_by/${blocker.id}`),
      )
    } catch (error) {
      if (statusOf(error) !== 404) throw error
    }
  }

  // ── States and counts ─────────────────────────────────────────────────────

  async listStates(): Promise<TicketStateInfo[]> {
    const counts = await this.readCounts({ open: true, closed: true, labels: true })
    const names = [...counts.names]
    const ordered = orderStates(names, this.lifecycleOrder())
    return ordered.map((name) => ({
      name,
      tickets: counts.count(name),
      ...(counts.about.get(name) !== undefined ? { about: counts.about.get(name)! } : {}),
    }))
  }

  async countStates(names: readonly string[]): Promise<TicketStateCount[]> {
    const rejected = rejectedStateOf(this.lifecycle)
    const closedOnly = names.every(
      (name) => holdsState(name, this.lifecycle.done) || holdsState(name, rejected),
    )
    const triage = names.some((name) => holdsState(name, this.lifecycle.triage))
    const closed = names.some(
      (name) => holdsState(name, this.lifecycle.done) || holdsState(name, rejected),
    )
    if (names.length === 0) return []
    const counts = await this.readCounts({ open: triage, closed, labels: !closedOnly })
    return matchStateNames(names, counts.names).map((name) => ({
      name,
      tickets: counts.count(name),
    }))
  }

  /**
   * One fresh GraphQL request (plus one per further 100 `autobuild:` labels)
   * whose fields are bounded counts: open and closed totals, each state
   * label's open count, and one documented `reason:completed` search. Never
   * cached, never reads issue rows.
   */
  private async readCounts(want: { open: boolean; closed: boolean; labels: boolean }): Promise<{
    names: string[]
    about: Map<string, string>
    count: (name: string) => number
  }> {
    const labelField = (after: boolean) =>
      `labels(query: "${STATE_LABEL_PREFIX}", first: 100${after ? ', after: $labelsAfter' : ''}) { nodes { name description issues(states: OPEN) { totalCount } } pageInfo { hasNextPage endCursor } }`
    const fields = [
      ...(want.open ? ['open: issues(states: OPEN) { totalCount }'] : []),
      ...(want.closed ? ['closed: issues(states: CLOSED) { totalCount }'] : []),
      ...(want.labels ? [labelField(false)] : []),
    ]
    const search = `repo:${this.fullName} is:issue is:closed reason:completed`
    type CountData = {
      repository: {
        open?: { totalCount: number }
        closed?: { totalCount: number }
        labels?: {
          nodes: Array<{
            name: string
            description?: string | null
            issues: { totalCount: number }
          }>
          pageInfo: { hasNextPage: boolean; endCursor: string | null }
        }
      } | null
      completed?: { issueCount: number }
    }
    const data = await this.graphql<CountData>(
      'counts',
      `query StateCounts($owner: String!, $name: String!${want.closed ? ', $search: String!' : ''}) { repository(owner: $owner, name: $name) { ${fields.join(' ')} }${want.closed ? ' completed: search(type: ISSUE, query: $search) { issueCount }' : ''} }`,
      { owner: this.owner, name: this.repo, ...(want.closed ? { search } : {}) },
    )
    if (data.repository === null)
      throw new Error(`github counts: repository ${this.fullName} is not readable`)
    const labelNodes = [...(data.repository.labels?.nodes ?? [])]
    let pageInfo = data.repository.labels?.pageInfo
    while (pageInfo?.hasNextPage && pageInfo.endCursor) {
      const more = await this.graphql<CountData>(
        'counts',
        `query StateLabelCounts($owner: String!, $name: String!, $labelsAfter: String) { repository(owner: $owner, name: $name) { ${labelField(true)} } }`,
        { owner: this.owner, name: this.repo, labelsAfter: pageInfo.endCursor },
      )
      labelNodes.push(...(more.repository?.labels?.nodes ?? []))
      pageInfo = more.repository?.labels?.pageInfo
    }
    const rejected = rejectedStateOf(this.lifecycle)
    const names = lifecycleNames(this.lifecycle)
    if (this.lifecycle.rejected === undefined) names.push(NOT_PLANNED_STATE)
    const labelCounts = new Map<string, number>()
    const about = new Map<string, string>()
    for (const node of labelNodes) {
      // `labels(query:)` also matches names merely containing the prefix.
      if (!isStateLabel(node.name)) continue
      const suffix = node.name.slice(STATE_LABEL_PREFIX.length)
      const name = names.find((known) => holdsState(known, suffix)) ?? suffix
      if (!names.includes(name)) names.push(name)
      labelCounts.set(name, (labelCounts.get(name) ?? 0) + node.issues.totalCount)
      if (node.description) about.set(name, node.description)
    }
    const completed = data.completed?.issueCount ?? 0
    const closedTotal = data.repository.closed?.totalCount ?? 0
    const openTotal = data.repository.open?.totalCount ?? 0
    const count = (name: string): number => {
      if (holdsState(name, this.lifecycle.done)) return completed
      if (holdsState(name, rejected)) return Math.max(0, closedTotal - completed)
      if (holdsState(name, this.lifecycle.triage)) {
        let labelled = 0
        for (const [state, tickets] of labelCounts)
          if (!holdsState(state, this.lifecycle.triage)) labelled += tickets
        return Math.max(0, openTotal - labelled)
      }
      return labelCounts.get(name) ?? 0
    }
    return { names, about, count }
  }

  async addState(
    name: string,
    opts: { about?: string } = {},
  ): Promise<{ state: TicketStateInfo; created: boolean }> {
    validateStateName(name, SOURCE)
    if (!representableState(name))
      throw new Error(
        `${SOURCE}: "${stateLabel(name)}" is a label Autobuild itself applies, so "${name}" cannot be a state`,
      )
    const about = validateStatePurpose(opts.about, SOURCE)
    if (about !== undefined && about.length > LABEL_DESCRIPTION_MAX)
      throw new Error(
        `${SOURCE}: a state purpose is at most ${LABEL_DESCRIPTION_MAX} characters (GitHub's label description limit)`,
      )
    const clash = (await this.stateNames()).find((known) => holdsState(known, name))
    if (clash !== undefined)
      throw new Error(
        `${SOURCE}: state "${name}" already exists as "${clash}" — state names are unique ignoring letter case`,
      )
    try {
      await this.must('addState', 'POST', this.path('/labels'), {
        body: { name: stateLabel(name), color: LABEL_COLOR, description: about ?? '' },
      })
    } catch (error) {
      if (statusOf(error) === 422)
        throw new Error(`${SOURCE}: state "${name}" already exists`, { cause: error })
      throw error
    }
    this.knownLabels.add(stateLabel(name).toLowerCase())
    return { state: { name, tickets: 0, ...(about !== undefined ? { about } : {}) }, created: true }
  }

  // ── Ready assignee ────────────────────────────────────────────────────────

  /** The credential's owner: one `GET /user`. A credential with no user
   * (an App installation token) answers 401, 403 or 404. */
  private async readViewer(): Promise<Viewer> {
    let response: Response | null
    try {
      response = await this.request('readyAssignee', 'GET', 'user', { missing: true })
    } catch (error) {
      const status = statusOf(error)
      if (status === 401 || status === 403) return { noUser: true }
      throw error
    }
    if (response === null) return { noUser: true }
    return { login: z.object({ login: z.string() }).passthrough().parse(response.json).login }
  }

  /** Dispatcher startup, before the loop: resolve the credential's owner once,
   * so neither a tick nor a reload ever sends `GET /user`. */
  async prepareReadyAssignee(): Promise<void> {
    if (this.viewer !== undefined && !('failed' in this.viewer)) return
    try {
      this.viewer = await this.readViewer()
    } catch (error) {
      this.viewer = { failed: message(error) }
      throw error
    }
  }

  readyAssigneeRefusal(value: string): string | undefined {
    if (!GITHUB_READY_ASSIGNEE.accepts(value)) return GITHUB_READY_ASSIGNEE.message
    if (value !== 'me') return undefined
    if (this.viewer === undefined || 'failed' in this.viewer)
      return `github tickets: [tickets].readyAssignee = "me" but the GitHub credential owner could not be resolved at dispatcher startup (${
        this.viewer === undefined ? 'not prepared' : this.viewer.failed
      }); restart dispatch to enable readyAssignee = "me"`
    return 'noUser' in this.viewer ? NO_USER_ASSIGNEE : undefined
  }

  /** The login a `readyAssignee` value names. An unprepared one-shot surface
   * (`ab ticket list`, init validation) resolves `"me"` once, lazily. */
  private async assigneeLogin(value: string): Promise<string> {
    if (value !== 'me') return value
    if (this.viewer === undefined || 'failed' in this.viewer) this.viewer = await this.readViewer()
    if ('noUser' in this.viewer) throw new Error(NO_USER_ASSIGNEE)
    return (this.viewer as { login: string }).login
  }

  async describeReadyAssignee(value: string): Promise<string> {
    if (value === 'me') await this.prepareReadyAssignee()
    const refusal = this.readyAssigneeRefusal(value)
    if (refusal !== undefined) throw new Error(refusal)
    const login = await this.assigneeLogin(value)
    const check = await this.request(
      'readyAssignee',
      'GET',
      this.path(`/assignees/${encodeURIComponent(login)}`),
      { missing: true },
    )
    if (check === null)
      throw new Error(
        `github tickets: [tickets].readyAssignee "${login}" cannot be assigned issues in ${this.fullName} — use a GitHub username with access to the repository, or "me"`,
      )
    return `${value} → @${login}`
  }

  // ── Init validation ───────────────────────────────────────────────────────

  /** One specific message per access problem, for `ab init --validate`. */
  async validateAccess(): Promise<void> {
    const miss = await this.credentialMiss?.()
    if (miss !== undefined) throw new Error(`github tickets: no GitHub token — ${miss}`)
    let repository: Response | null
    try {
      repository = await this.request('validate', 'GET', this.path(), { missing: true })
    } catch (error) {
      if (statusOf(error) === 401 || statusOf(error) === 403)
        throw new Error(`github tickets: token cannot read ${this.fullName} — ${message(error)}`)
      throw error
    }
    if (repository === null) throw new Error(`github tickets: token cannot read ${this.fullName}`)
    const info = z
      .object({
        has_issues: z.boolean().optional(),
        permissions: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough()
      .parse(repository.json)
    if (info.has_issues === false)
      throw new Error(`github tickets: issues are disabled on ${this.fullName}`)
    try {
      await this.request('validate', 'GET', this.path('/issues'), { query: { per_page: '1' } })
    } catch (error) {
      const status = statusOf(error)
      if (status === 403 || status === 404 || status === 410)
        throw new Error(
          `github tickets: token cannot read the issues of ${this.fullName} — ${message(error)}`,
        )
      throw error
    }
    // Repository push access says nothing about a fine-grained or App token's
    // Issues permission, so probe issue creation itself with no title: GitHub
    // authorizes before it validates, so a writer is refused for the missing
    // title (422) and nothing is created, while a reader is refused (403/404).
    const readOnly = new Error(
      `github tickets: token cannot write the issues of ${this.fullName} — grant Issues: read and write`,
    )
    try {
      await this.must('validate', 'POST', this.path('/issues'), { body: {} })
    } catch (error) {
      const status = statusOf(error)
      if (status === 403 || status === 404) throw readOnly
      if (status === 422 && /title/i.test(apiDetail(error))) {
        this.assertLabelRole(info.permissions)
        return
      }
      throw new Error(
        `github tickets: could not confirm the token can write the issues of ${this.fullName} — ${message(error)}`,
        { cause: error },
      )
    }
    throw new Error(
      `github tickets: could not confirm the token can write the issues of ${this.fullName} — GitHub accepted an issue without a title`,
    )
  }

  // GitHub silently drops label changes from a user below triage, and ticket
  // states are labels. App tokens report no user permissions; their Issues
  // permission alone governs labels, which the write probe checks.
  private assertLabelRole(roles: Record<string, unknown> | undefined): void {
    if (roles !== undefined && !LABEL_ROLES.some((role) => roles[role] === true))
      throw new Error(
        `github tickets: token cannot set labels on ${this.fullName} — GitHub silently drops label changes without triage or push access; grant the token's user write (or triage) access`,
      )
  }
}
