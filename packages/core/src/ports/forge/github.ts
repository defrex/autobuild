/**
 * GitHubForge (SPEC §3.2): the Forge adapter for GitHub, speaking the GitHub
 * REST API through an injectable transport seam. All remote access is
 * kernel-side plumbing (SPEC §8.6 [D7]) — agents never touch the remote, so
 * forge credentials never enter the sandbox.
 *
 * The adapter never shells `gh` or reads a local checkout for its API calls:
 * the same adapter serves a checkout-bound dispatcher and a checkout-less
 * (`--repository`) one. The one deliberate exception is `pushBranch`, which
 * remains `git push` from the workspace — it is only ever called from
 * worktree-side terminals and contract fixtures; `vercel-sandbox` builds
 * publish through the sandbox's receive-pack proxy and the host never pushes.
 *
 * Native auto-merge is the one operation GitHub exposes only through its
 * GraphQL schema (no REST route exists), so its enable/disable mutations
 * travel over the same transport to `POST /graphql`.
 *
 * Repository coordinates (owner/name) resolve lazily and memoized: explicit
 * constructor option → `AB_REPOSITORY` (normalized) → `git remote get-url
 * origin` in `repoRoot` (checkout mode) → hard error at first use. In origin
 * mode the dispatcher exports `AB_REPOSITORY`, so no git call ever runs.
 */
import { z } from 'zod'
import { isValidGitBranchName, normalizeGitRemoteUrl } from '../../kernel/origin'
import {
  GitHubApiError,
  createGitHubFetchTransport,
  githubTokenFromEnv,
  restPlanLimitation,
  type GitHubRequest,
  type GitHubRequestOpts,
  type GitHubResponse,
} from './github-transport'
import {
  classifyAutoMergeEnable,
  mergeStateStatuses,
  type MergeGatePresence,
  type MergeStateStatus,
} from '../../kernel/auto-merge'
import type {
  AutoMergeDeferralReason,
  AutoMergeResult,
  ClosePrResult,
  PrAttachmentHosting,
  Forge,
  PrRef,
  PrState,
} from '../types'
import { GitHubPrAttachmentHosting } from './github-pr-attachments'

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

/** Same seam shape as the workspace module: argv array, cwd, no shell. */
export type Exec = (
  cmd: string[],
  opts: { cwd: string; signal?: AbortSignal },
) => Promise<ExecResult>

export const bunExec: Exec = async (cmd, opts) => {
  if (opts.signal?.aborted === true) {
    throw new Error(`forge command aborted before launch: ${cmd.join(' ')}`)
  }
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  })
  const abort = (): void => {
    try {
      proc.kill('SIGKILL')
    } catch {
      // A process that exited concurrently is already cancelled sufficiently.
    }
  }
  opts.signal?.addEventListener('abort', abort, { once: true })
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { stdout, stderr, exitCode }
  } finally {
    opts.signal?.removeEventListener('abort', abort)
  }
}

// ── Repository coordinates ───────────────────────────────────────────────────

export interface RepoCoordinates {
  owner: string
  name: string
}

/** Owner/name from an `owner/name` slug or any remote URL spelling. */
export function parseRepoCoordinates(input: string): RepoCoordinates | null {
  const normalized = normalizeGitRemoteUrl(input)
  try {
    const url = new URL(normalized)
    if (url.hostname !== '') {
      const parts = url.pathname.split('/').filter((part) => part !== '')
      if (parts.length === 2) return { owner: parts[0]!, name: parts[1]! }
      return null
    }
  } catch {
    // Slug fallback below.
  }
  const parts = normalized.split('/')
  if (parts.length === 2 && parts[0] !== '' && parts[1] !== '') {
    return { owner: parts[0]!, name: parts[1]! }
  }
  return null
}

// ── Response shapes ──────────────────────────────────────────────────────────
//
// REST responses are the forge's full objects, so shapes validate every field
// these methods rely on and pass unknown fields through — an added GitHub
// field cannot break a poll, but a changed relied-on field still fails loudly.

const restPrRef = z
  .object({
    number: z.number().int().positive(),
    html_url: z.string().min(1),
    head: z.object({ sha: z.string().min(1) }).passthrough(),
  })
  .passthrough()

const restPrState = z
  .object({
    state: z.enum(['open', 'closed']),
    merged: z.boolean(),
    mergeable: z.boolean().nullable(),
    merge_commit_sha: z.string().min(1).nullable(),
  })
  .passthrough()

const restNativeAutoMerge = z
  .object({
    node_id: z.string().min(1),
    auto_merge: z.object({}).passthrough().nullable(),
  })
  .passthrough()

const restAutoMergeView = z
  .object({
    node_id: z.string().min(1),
    auto_merge: z.object({}).passthrough().nullable(),
    mergeable_state: z.string().min(1),
    head: z.object({ ref: z.string().min(1), sha: z.string().min(1) }).passthrough(),
    base: z.object({ ref: z.string().min(1) }).passthrough(),
  })
  .passthrough()

const restRepositoryAutoMerge = z.object({ allow_auto_merge: z.boolean() }).passthrough()

const restBranchHead = z
  .object({ commit: z.object({ sha: z.string().min(1) }).passthrough() })
  .passthrough()

const restRulesetRules = z.array(
  z
    .object({
      type: z.string().min(1),
      parameters: z.unknown().optional(),
    })
    .passthrough(),
)

// ── Ruleset gate classification (unchanged from the gh implementation) ───────

const pullRequestRuleParameters = z
  .object({
    required_approving_review_count: z.number().int().nonnegative(),
    require_code_owner_review: z.boolean(),
    require_last_push_approval: z.boolean(),
    required_review_thread_resolution: z.boolean(),
  })
  .passthrough()

const requiredStatusRuleParameters = z
  .object({ required_status_checks: z.array(z.unknown()) })
  .passthrough()
const requiredDeploymentsRuleParameters = z
  .object({ required_deployment_environments: z.array(z.string()) })
  .passthrough()
const requiredWorkflowsRuleParameters = z.object({ workflows: z.array(z.unknown()) }).passthrough()
const requiredCodeScanningRuleParameters = z
  .object({
    code_scanning_tools: z.array(z.unknown()).optional(),
    required_code_scanning_tools: z.array(z.unknown()).optional(),
  })
  .refine(
    (value) =>
      value.code_scanning_tools !== undefined || value.required_code_scanning_tools !== undefined,
    { message: 'a code-scanning tools array is required' },
  )
  .passthrough()
const mergeQueueRuleParameters = z.object({}).passthrough()

const STRUCTURAL_RULE_TYPES = new Set([
  'creation',
  'update',
  'deletion',
  'required_linear_history',
  'non_fast_forward',
  'commit_message_pattern',
  'commit_author_email_pattern',
  'committer_email_pattern',
  'branch_name_pattern',
  'tag_name_pattern',
  'file_path_restriction',
  'max_file_path_length',
  'file_extension_restriction',
  'max_file_size',
])

function parseRuleParameters<S extends z.ZodType>(
  schema: S,
  parameters: unknown,
  type: string,
): z.infer<S> {
  const parsed = schema.safeParse(parameters)
  if (!parsed.success) {
    throw new Error(`unexpected parameters for active GitHub ruleset rule ${type}: ${parsed.error}`)
  }
  return parsed.data
}

/** Whether any active repository/organization rule matching one branch
 * carries a real merge-blocking requirement. Unknown future types fail closed. */
export function rulesetsHaveMergeGate(rules: z.infer<typeof restRulesetRules>): boolean {
  let present = false
  for (const rule of rules) {
    switch (rule.type) {
      case 'merge_queue':
        parseRuleParameters(mergeQueueRuleParameters, rule.parameters, rule.type)
        present = true
        break
      case 'required_signatures':
        present = true
        break
      case 'required_status_checks': {
        const parameters = parseRuleParameters(
          requiredStatusRuleParameters,
          rule.parameters,
          rule.type,
        )
        present = parameters.required_status_checks.length > 0 || present
        break
      }
      case 'required_deployments': {
        const parameters = parseRuleParameters(
          requiredDeploymentsRuleParameters,
          rule.parameters,
          rule.type,
        )
        present = parameters.required_deployment_environments.length > 0 || present
        break
      }
      case 'workflows':
      case 'required_workflows': {
        const parameters = parseRuleParameters(
          requiredWorkflowsRuleParameters,
          rule.parameters,
          rule.type,
        )
        present = parameters.workflows.length > 0 || present
        break
      }
      case 'required_code_scanning':
      case 'code_scanning': {
        const parameters = parseRuleParameters(
          requiredCodeScanningRuleParameters,
          rule.parameters,
          rule.type,
        )
        const tools =
          parameters.code_scanning_tools ?? parameters.required_code_scanning_tools ?? []
        present = tools.length > 0 || present
        break
      }
      case 'pull_request': {
        const parameters = parseRuleParameters(
          pullRequestRuleParameters,
          rule.parameters,
          rule.type,
        )
        present =
          parameters.required_approving_review_count > 0 ||
          parameters.require_code_owner_review ||
          parameters.require_last_push_approval ||
          parameters.required_review_thread_resolution ||
          present
        break
      }
      default:
        if (!STRUCTURAL_RULE_TYPES.has(rule.type)) {
          throw new Error(
            `unknown active GitHub ruleset rule type ${JSON.stringify(rule.type)}; ` +
              'cannot prove the branch has no merge-blocking gate',
          )
        }
    }
  }
  return present
}

// ── Native auto-merge mutations (GraphQL) ────────────────────────────────────
//
// GitHub's REST API has no auto-merge route: PUT/DELETE
// /repos/{o}/{r}/pulls/{n}/auto-merge respond 404 (route-not-found) while
// adjacent PR routes on the same PR respond 401 without auth. `gh` itself
// drives native auto-merge through the GraphQL mutations below, so the forge
// does too — same transport seam, same token.

const ENABLE_AUTO_MERGE_MUTATION = `
  mutation ($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
    enablePullRequestAutoMerge(
      input: {pullRequestId: $pullRequestId, mergeMethod: $mergeMethod}
    ) {
      pullRequest { id }
    }
  }
`

const DISABLE_AUTO_MERGE_MUTATION = `
  mutation ($pullRequestId: ID!) {
    disablePullRequestAutoMerge(input: {pullRequestId: $pullRequestId}) {
      pullRequest { id }
    }
  }
`

/** A successful mutation payload: the mutated PR's node id. A null payload
 * (mutation executed but returned nothing) fails the strict parse. */
const autoMergeMutationPayload = z.object({
  pullRequest: z.object({ id: z.string().min(1) }),
})
const enableAutoMergeData = z.object({ enablePullRequestAutoMerge: autoMergeMutationPayload })
const disableAutoMergeData = z.object({ disablePullRequestAutoMerge: autoMergeMutationPayload })

// ── Classic branch protection (REST) ─────────────────────────────────────────
//
// The documented Branch-protection `protection` object (GET
// /repos/{o}/{r}/branches/{b}). Subsections are present-or-null; a subsection
// missing entirely from the response is UNPROVEN, not absent — the fail-closed
// posture the GraphQL probe had via its hard parse errors.

type ClassicGateResult = { kind: 'proved'; gate: boolean } | { kind: 'unproven'; detail: string }

function classifyClassicProtection(protection: unknown): ClassicGateResult {
  if (protection === null) return { kind: 'proved', gate: false }
  if (typeof protection !== 'object') {
    return { kind: 'unproven', detail: `protection is ${JSON.stringify(protection)}` }
  }
  const raw = protection as Record<string, unknown>
  // An unprotected branch is not rendered as `protection: null`: GitHub
  // answers `{ enabled: false, required_status_checks: { enforcement_level:
  // "off", ... } }` with the other subsections omitted. `enabled: false` is
  // the documented proof that classic protection is absent.
  if (raw.enabled === false) return { kind: 'proved', gate: false }
  // Every subsection this classifier reads must EXIST in the response, even
  // when unset (GitHub renders unset subsections as null). A response that
  // omits one is auth- or plan-scoped in a way we cannot prove.
  for (const subsection of [
    'required_status_checks',
    'required_pull_request_reviews',
    'restrictions',
  ] as const) {
    if (!(subsection in raw)) {
      return { kind: 'unproven', detail: `protection.${subsection} missing from response` }
    }
  }
  const statusChecks = raw.required_status_checks
  const reviews = raw.required_pull_request_reviews
  const restrictions = raw.restrictions
  if (statusChecks !== null && typeof statusChecks !== 'object') {
    return { kind: 'unproven', detail: 'required_status_checks is neither null nor an object' }
  }
  if (restrictions !== null && typeof restrictions !== 'object') {
    return { kind: 'unproven', detail: 'restrictions is neither null nor an object' }
  }
  if (statusChecks !== null) return { kind: 'proved', gate: true }
  if (restrictions !== null) return { kind: 'proved', gate: true }
  if (reviews === null) return { kind: 'proved', gate: false }
  if (typeof reviews !== 'object') {
    return {
      kind: 'unproven',
      detail: 'required_pull_request_reviews is neither null nor an object',
    }
  }
  const reviewFields = reviews as Record<string, unknown>
  for (const field of [
    'required_approving_review_count',
    'require_code_owner_reviews',
    'require_last_push_approval',
  ] as const) {
    if (!(field in reviewFields)) {
      return { kind: 'unproven', detail: `required_pull_request_reviews.${field} missing` }
    }
  }
  const count = reviewFields.required_approving_review_count
  const codeOwners = reviewFields.require_code_owner_reviews
  const lastPush = reviewFields.require_last_push_approval
  if (
    typeof count !== 'number' ||
    typeof codeOwners !== 'boolean' ||
    typeof lastPush !== 'boolean'
  ) {
    return {
      kind: 'unproven',
      detail: 'required_pull_request_reviews fields have unexpected types',
    }
  }
  return { kind: 'proved', gate: count > 0 || codeOwners || lastPush }
}

/** REST `mergeable_state` → the kernel's canonical GraphQL-spelling enum.
 * The value sets differ in spelling only; unrecognized values throw so the
 * caller's fail-closed handling defers instead of ever mapping to DIRECT. */
function restMergeState(raw: string): MergeStateStatus {
  const mapped = (
    {
      behind: 'BEHIND',
      blocked: 'BLOCKED',
      clean: 'CLEAN',
      dirty: 'DIRTY',
      draft: 'DRAFT',
      has_hooks: 'HAS_HOOKS',
      unknown: 'UNKNOWN',
      unstable: 'UNSTABLE',
    } as Record<string, MergeStateStatus>
  )[raw]
  if (mapped === undefined) {
    throw new Error(
      `unknown GitHub mergeable_state ${JSON.stringify(raw)}; ` +
        `known states: ${mergeStateStatuses.join(', ')}`,
    )
  }
  return mapped
}

// ── Forge adapter ────────────────────────────────────────────────────────────

/** Hard cap on the janitor poll's per-PR ETag cache. One small entry per PR
 * ever polled in a dispatcher process lifetime makes hitting this in practice
 * implausible; the cap is hygiene, not a load-bearing bound. */
const PR_STATE_CACHE_CAP = 512

export class GitHubForge implements Forge {
  readonly name = 'github'
  readonly prAttachments: PrAttachmentHosting

  private readonly transport: GitHubRequest
  /** Only `pushBranch` still runs a local command (`git push` from the
   * workspace); every API operation goes through the transport. */
  private readonly exec: Exec
  private readonly explicitRepository?: string
  private readonly repoRoot?: string
  private readonly env: Readonly<Record<string, string | undefined>>
  private coordinates?: RepoCoordinates | null
  /** Per-PR ETag cache for the janitor poll, keyed `owner/name#number`.
   * Conditional revalidation per GitHub's documented best practices: every
   * REST response carries an `ETag`, and re-GETting with `If-None-Match`
   * answers 304 Not Modified — which does not count against the primary rate
   * limit — whenever the representation is unchanged. The cache lives only
   * for this adapter instance (the dispatcher constructs one forge and holds
   * it across janitor ticks), so a process restart is cache loss: exactly
   * today's first-poll behavior. Capped with oldest-inserted eviction; a miss
   * is an ordinary unconditional poll, so eviction is harmless by
   * construction. */
  private readonly prStateCache = new Map<string, { etag: string; state: PrState }>()

  constructor(
    opts: {
      transport?: GitHubRequest
      exec?: Exec
      token?: string
      repository?: string
      repoRoot?: string
      env?: Readonly<Record<string, string | undefined>>
    } = {},
  ) {
    this.exec = opts.exec ?? bunExec
    this.transport =
      opts.transport ??
      createGitHubFetchTransport({
        ...(opts.token !== undefined
          ? { token: opts.token }
          : { token: githubTokenFromEnv(opts.env ?? {}) }),
      })
    this.env = opts.env ?? {}
    if (opts.repository !== undefined && opts.repository !== '') {
      this.explicitRepository = opts.repository
    } else if (this.env.AB_REPOSITORY !== undefined && this.env.AB_REPOSITORY !== '') {
      this.explicitRepository = this.env.AB_REPOSITORY
    }
    this.repoRoot = opts.repoRoot
    this.prAttachments = new GitHubPrAttachmentHosting({ transport: this.transport })
  }

  /** Memoized owner/name. `null` means "could not prove coordinates" — the
   * caller decides whether that is fatal (direct calls) or a deferral
   * (auto-merge gate probes). */
  private async repoCoordinates(): Promise<RepoCoordinates | null> {
    this.coordinates ??= await this.resolveCoordinates()
    return this.coordinates
  }

  private async resolveCoordinates(): Promise<RepoCoordinates | null> {
    if (this.explicitRepository !== undefined) return parseRepoCoordinates(this.explicitRepository)
    // Worktree/checkout mode only: the last-resort probe reads the checkout's
    // origin. Origin mode always exports AB_REPOSITORY, so this never runs.
    if (this.repoRoot !== undefined) {
      try {
        const result = await this.exec(['git', 'remote', 'get-url', 'origin'], {
          cwd: this.repoRoot,
          signal: undefined,
        })
        if (result.exitCode === 0) {
          const raw = result.stdout.trim()
          if (raw !== '') return parseRepoCoordinates(raw)
        }
      } catch {
        // Fall through to the error.
      }
    }
    return null
  }

  private requireCoordinates(): Promise<RepoCoordinates> {
    return this.repoCoordinates().then((coordinates) => {
      if (coordinates === null) {
        throw new Error(
          'GitHub forge could not resolve the repository owner/name — pass ' +
            "--repository <origin>, export AB_REPOSITORY, or set the checkout's origin remote",
        )
      }
      return coordinates
    })
  }

  private async request(
    method: string,
    path: string,
    opts?: GitHubRequestOpts,
  ): Promise<GitHubResponse> {
    return this.transport(method, path, opts)
  }

  private parse<T>(schema: z.ZodType<T>, response: GitHubResponse, operation: string): T {
    const parsed = schema.safeParse(response.json)
    if (!parsed.success) {
      throw new Error(`unexpected GitHub response for ${operation}: ${parsed.error.message}`)
    }
    return parsed.data
  }

  private async getJson<T>(
    schema: z.ZodType<T>,
    path: string,
    operation: string,
    opts?: GitHubRequestOpts,
  ): Promise<T> {
    return this.parse(schema, await this.request('GET', path, opts), operation)
  }

  /** One GraphQL operation over the shared transport: POST the document,
   * validate the envelope, and surface the API-level `errors` array as a
   * thrown error — GitHub answers HTTP 200 even when the mutation failed. */
  private async graphql<T>(
    operation: string,
    schema: z.ZodType<T>,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const response = await this.request('POST', 'graphql', { body: { query, variables } })
    const envelope = z
      .object({
        data: z.unknown().optional(),
        errors: z.array(z.object({ message: z.string() }).passthrough()).optional(),
      })
      .safeParse(response.json)
    if (!envelope.success) {
      throw new Error(
        `unexpected GitHub GraphQL envelope for ${operation}: ${envelope.error.message}`,
      )
    }
    const errors = envelope.data.errors
    if (errors !== undefined && errors.length > 0) {
      throw new Error(
        `GitHub GraphQL ${operation} failed: ${errors.map((e) => e.message).join('; ')}`,
      )
    }
    if (envelope.data.data === undefined || envelope.data.data === null) {
      throw new Error(`GitHub GraphQL ${operation} returned no data`)
    }
    const parsed = schema.safeParse(envelope.data.data)
    if (!parsed.success) {
      throw new Error(`unexpected GitHub GraphQL data for ${operation}: ${parsed.error.message}`)
    }
    return parsed.data
  }

  // ── Forge operations ───────────────────────────────────────────────────────

  /** [D1]: rebase is banned and branches are never rewritten — never force.
   * Only ever called from worktree-side terminals and contract fixtures. */
  async pushBranch(workspacePath: string, branch: string): Promise<void> {
    const result = await this.exec(['git', 'push', '-u', 'origin', `HEAD:refs/heads/${branch}`], {
      cwd: workspacePath,
      signal: undefined,
    })
    if (result.exitCode !== 0) {
      throw new Error(
        `forge command failed (exit ${result.exitCode}): git push -u origin HEAD:refs/heads/${branch}\n${result.stderr.trim()}`,
      )
    }
  }

  async openPr(opts: {
    workspacePath: string
    head: string
    base: string
    title: string
    body: string
    mergeMessage?: string
  }): Promise<PrRef> {
    // Idempotent by head branch (SPEC §8.7 crash paths): finalize's `ab done`
    // opens the PR BEFORE appending finalize.completed, so a crash or store
    // failure between the two makes the retry call openPr again. Adopting the
    // open PR instead of erroring on the duplicate makes the re-run a
    // harmless retry — the same rationale that makes push-before-event safe
    // for implement.
    const { owner, name } = await this.requireCoordinates()
    const repoPath = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
    const listed = await this.getJson(
      z.array(restPrRef),
      `${repoPath}/pulls?head=${encodeURIComponent(`${owner}:${opts.head}`)}&state=open`,
      'open PR probe',
    )
    const existing = listed[0]
    if (existing !== undefined) {
      return {
        number: existing.number,
        url: existing.html_url,
        headSha: existing.head.sha,
      }
    }
    const created = this.parse(
      restPrRef,
      await this.request('POST', `${repoPath}/pulls`, {
        body: { title: opts.title, head: opts.head, base: opts.base, body: opts.body },
      }),
      'PR create',
    )
    return { number: created.number, url: created.html_url, headSha: created.head.sha }
  }

  /** Janitor poll (SPEC §15.7): merged / closed / mergeability for one PR.
   * With a cached ETag the read revalidates via `If-None-Match`: a 304 Not
   * Modified returns the cached previous result — the same result the previous
   * poll produced — and a 200 refreshes the cached ETag alongside the parsed
   * state (terminal `merged`/`closed` results included, uniformly). Without a
   * cached ETag (first poll, cache loss) or when the provider omits an `ETag`
   * response header, this is byte-for-byte the unconditional poll: 304
   * handling only ever applies to requests that carry conditional headers. */
  async getPrState(_workspacePath: string, number: number): Promise<PrState> {
    const { owner, name } = await this.requireCoordinates()
    const prPath = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}`
    const cacheKey = `${owner}/${name}#${number}`
    const cached = this.prStateCache.get(cacheKey)
    const response =
      cached !== undefined
        ? await this.request('GET', prPath, { headers: { 'If-None-Match': cached.etag } })
        : await this.request('GET', prPath)
    if (response.status === 304 && cached !== undefined) {
      return cached.state
    }
    const view = this.parse(restPrState, response, `PR #${number} poll`)
    let state: PrState
    if (view.merged) {
      // §15.7 [D1]: pr.merged records the squash commit as the landing
      // point — a merged PR without one is unusable, not mappable.
      if (view.merge_commit_sha === null) {
        throw new Error(`GitHub reports PR #${number} merged with no merge_commit_sha`)
      }
      state = { state: 'merged', sha: view.merge_commit_sha }
    } else {
      switch (view.state) {
        case 'closed':
          state = { state: 'closed' }
          break
        case 'open':
          state = { state: 'open', mergeable: view.mergeable }
      }
    }
    const etag = response.headers.etag
    if (etag === undefined || etag === '') {
      // No revalidation token on this 200: drop any stale entry so a future
      // poll can never replay it against a changed representation.
      this.prStateCache.delete(cacheKey)
    } else {
      this.prStateCache.set(cacheKey, { etag, state })
      // Hard capacity cap with oldest-inserted eviction (JS Map iteration
      // order). The just-inserted entry is newest, so it survives.
      while (this.prStateCache.size > PR_STATE_CACHE_CAP) {
        const oldest = this.prStateCache.keys().next()
        if (oldest.done === true) break
        this.prStateCache.delete(oldest.value)
      }
    }
    return state
  }

  async closePr(workspacePath: string, number: number): Promise<ClosePrResult> {
    const before = await this.getPrState(workspacePath, number)
    if (before.state === 'merged' || before.state === 'closed') return before

    const { owner, name } = await this.requireCoordinates()
    const prPath = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}`
    let closeError: unknown
    try {
      await this.request('PATCH', prPath, { body: { state: 'closed' } })
    } catch (error) {
      closeError = error
    }
    // Re-read even after a mutation failure: GitHub may have merged the PR in
    // the inspection-to-close race, and merged state must never be overwritten.
    const after = await this.getPrState(workspacePath, number)
    if (after.state === 'merged' || after.state === 'closed') return after
    if (closeError !== undefined) throw closeError
    throw new Error(`GitHub PR #${number} remained open after the close request`)
  }

  async deleteBranch(_workspacePath: string, branch: string): Promise<void> {
    const ref = `refs/heads/${branch}`
    if (!isValidGitBranchName(branch)) {
      throw new Error(`GitHub branch cleanup rejected invalid ref ${ref}`)
    }
    const { owner, name } = await this.requireCoordinates()
    const repoPath = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
    try {
      await this.request('GET', `${repoPath}/git/ref/heads/${branch}`)
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return // idempotent
      throw error
    }
    try {
      await this.request('DELETE', `${repoPath}/git/refs/heads/${branch}`)
    } catch (error) {
      // A probe/delete race (branch deleted elsewhere) is still a success.
      if (error instanceof GitHubApiError && error.status === 404) return
      throw error
    }
  }

  /** Read the provider's projected native desired state, plus the PR's node
   * id — the GraphQL mutations key on the node id, not the PR number.
   * Mutations are not acknowledgements: only an independent follow-up
   * observation can make an `applied` result durable. */
  private async nativeAutoMergeView(number: number): Promise<{ enabled: boolean; nodeId: string }> {
    const { owner, name } = await this.requireCoordinates()
    const view = await this.getJson(
      restNativeAutoMerge,
      `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}`,
      `PR #${number} native auto-merge read`,
    )
    return { enabled: view.auto_merge !== null, nodeId: view.node_id }
  }

  /** Probe both GitHub gate systems for the PR's exact base branch. The one
   * non-success ruleset response that proves absence is GitHub's documented
   * account-plan limitation; even then classic protection must independently
   * parse successfully. Every other uncertainty is returned as a typed,
   * fail-closed deferral rather than escaping into finalize or the janitor. */
  private async mergeGatePresence(
    baseRefName: string,
  ): Promise<
    | { kind: 'proved'; presence: MergeGatePresence }
    | { kind: 'deferred'; reason: AutoMergeDeferralReason }
  > {
    const unproven = (detail: string) =>
      ({
        kind: 'deferred',
        reason: { code: 'unproven-gate-state', detail },
      }) as const
    const errorMessage = (error: unknown): string =>
      error instanceof Error ? error.message : String(error)

    const coordinates = await this.repoCoordinates()
    if (coordinates === null) {
      return unproven(
        'GitHub auto-merge gate repository inspection failed: could not resolve the repository owner/name',
      )
    }
    const { owner, name } = coordinates
    const repoPath = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
    const branchPath = `${repoPath}/branches/${baseRefName}`

    let classicGate: boolean | undefined
    let classicError: string | undefined
    try {
      const branch = await this.request('GET', branchPath)
      const view = branch.json as Record<string, unknown> | undefined
      if (view?.protected === false) {
        // The branch view's own flag proves classic protection absent even
        // when the nested protection object is the unprotected stub.
        classicGate = false
      } else {
        const protection = view?.protection
        if (protection === undefined) {
          throw new Error('branch response carries no protection object')
        }
        const classic = classifyClassicProtection(protection)
        if (classic.kind === 'unproven') throw new Error(classic.detail)
        classicGate = classic.gate
      }
    } catch (error) {
      classicError = errorMessage(error)
    }

    let rulesetGate = false
    let planLimited = false
    try {
      const rules = await this.request('GET', `${repoPath}/rules/branches/${baseRefName}`)
      rulesetGate = rulesetsHaveMergeGate(this.parse(restRulesetRules, rules, 'ruleset probe'))
    } catch (error) {
      if (
        error instanceof GitHubApiError &&
        error.status === 403 &&
        restPlanLimitation.safeParse(error.body).success
      ) {
        planLimited = true
      } else {
        return unproven(`GitHub auto-merge ruleset probe failed: ${errorMessage(error)}`)
      }
    }

    if (planLimited) {
      if (classicGate === undefined) {
        return {
          kind: 'deferred',
          reason: {
            code: 'github-plan-limitation',
            detail:
              'GitHub returned its documented rulesets plan-limitation response, but classic ' +
              `branch protection could not be proven absent: ${classicError ?? 'unknown failure'}`,
          },
        }
      }
      return { kind: 'proved', presence: classicGate ? 'present' : 'absent' }
    }

    if (classicGate === undefined) {
      return unproven(
        `GitHub auto-merge classic branch-protection probe failed: ${classicError ?? 'unknown failure'}`,
      )
    }
    return {
      kind: 'proved',
      presence: classicGate || rulesetGate ? 'present' : 'absent',
    }
  }

  /**
   * Reconcile native auto-merge state. A native idempotent hit is acknowledged
   * immediately. Otherwise enabling is classified from authoritative gate
   * existence plus the complete current merge-state enum; only a proved
   * ungated stable PR is returned as a direct candidate. A successful mutation
   * is confirmed with a second native-state read before returning `applied`.
   */
  async setAutoMerge(
    _workspacePath: string,
    number: number,
    enabled: boolean,
  ): Promise<AutoMergeResult> {
    // Cancellation must remain usable when GitHub adds a merge-state enum:
    // inspect only the fields disabling actually needs. The mutation itself
    // sits outside the enable path's catch on purpose — a failed cancellation
    // is a hard janitor-tick error (as `gh pr merge --disable-auto` was
    // before), never a silent deferral of live consent revocation.
    if (!enabled) {
      const native = await this.nativeAutoMergeView(number)
      if (!native.enabled) {
        return { kind: 'applied' }
      }
      await this.graphql(
        'disablePullRequestAutoMerge',
        disableAutoMergeData,
        DISABLE_AUTO_MERGE_MUTATION,
        { pullRequestId: native.nodeId },
      )
      return (await this.nativeAutoMergeView(number)).enabled
        ? { kind: 'deferred' }
        : { kind: 'applied' }
    }

    try {
      const { owner, name } = await this.requireCoordinates()
      const repoPath = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
      const view = await this.getJson(
        restAutoMergeView,
        `${repoPath}/pulls/${number}`,
        `PR #${number} auto-merge inspection`,
      )
      if (view.auto_merge !== null) return { kind: 'applied' }

      const mergeState = restMergeState(view.mergeable_state)
      const gate = await this.mergeGatePresence(view.base.ref)
      if (gate.kind === 'deferred') return gate
      const disposition = classifyAutoMergeEnable(mergeState, gate.presence)
      switch (disposition.kind) {
        case 'native': {
          const repository = await this.getJson(
            restRepositoryAutoMerge,
            repoPath,
            'repository auto-merge read',
          )
          if (!repository.allow_auto_merge) {
            return {
              kind: 'deferred',
              reason: {
                code: 'repository-auto-merge-disabled',
                detail: 'GitHub reports allow_auto_merge=false; the PR was left open for a human',
              },
            }
          }
          await this.graphql(
            'enablePullRequestAutoMerge',
            enableAutoMergeData,
            ENABLE_AUTO_MERGE_MUTATION,
            { pullRequestId: view.node_id, mergeMethod: 'SQUASH' },
          )
          return (await this.nativeAutoMergeView(number)).enabled
            ? { kind: 'applied' }
            : { kind: 'deferred' }
        }
        case 'direct':
          return { kind: 'ungated', headSha: view.head.sha }
        case 'deferred':
          return { kind: 'deferred' }
        case 'error':
          throw new Error(disposition.reason)
      }
    } catch (error) {
      return {
        kind: 'deferred',
        reason: {
          code: 'unproven-gate-state',
          detail:
            'GitHub auto-merge gate inspection or native application failed: ' +
            (error instanceof Error ? error.message : String(error)),
        },
      }
    }
  }

  /** Normal guarded squash — no admin, force, rebase, or native-auto flag.
   * A 409 (head moved) surfaces as a hard error, preserving the contract's
   * moved-head rejection. */
  async squashMerge(
    _workspacePath: string,
    number: number,
    expectedHeadSha: string,
  ): Promise<void> {
    const { owner, name } = await this.requireCoordinates()
    await this.request(
      'PUT',
      `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}/merge`,
      {
        body: { merge_method: 'squash', sha: expectedHeadSha },
      },
    )
  }

  /** The build's summary comment (SPEC §7.5) — links into the store. */
  async commentOnPr(_workspacePath: string, number: number, body: string): Promise<void> {
    const { owner, name } = await this.requireCoordinates()
    await this.request(
      'POST',
      `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}/comments`,
      { body: { body } },
    )
  }

  // ── Optional capabilities (checkout-less dispatcher) ──────────────────────

  /** Current tip of a remote branch. Throws (including 404) when the branch
   * does not exist; the provider seam maps that to `undefined`. */
  async remoteBranchSha(branch: string): Promise<string> {
    const { owner, name } = await this.requireCoordinates()
    const branchHead = await this.getJson(
      restBranchHead,
      `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches/${branch}`,
      `remote branch ${branch}`,
    )
    return branchHead.commit.sha
  }

  /** Raw file bytes from the repository. Ref omitted → the repository's
   * default branch. Throws (including 404) when the path does not exist. */
  async readFile(path: string, ref?: string): Promise<string> {
    const { owner, name } = await this.requireCoordinates()
    const query = ref !== undefined ? { ref } : undefined
    const response = await this.request(
      'GET',
      `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${path}`,
      {
        headers: { Accept: 'application/vnd.github.raw' },
        ...(query !== undefined ? { query } : {}),
      },
    )
    if (response.bytes === undefined) {
      throw new Error(`GitHub contents read of ${path} returned no raw bytes`)
    }
    return new TextDecoder().decode(response.bytes)
  }
}
