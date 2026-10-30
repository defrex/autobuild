import { gitOid } from '../../events/payloads'
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  classifyGitNetworkFailure,
  ForgeFailure,
  isForgeFailure,
  type ForgeRequestObserver,
} from '../forge-failure'
import {
  forgeRequestContext,
  guardedForgeRequest,
  ForgeRequestDeferred,
} from '../forge-request-context'
import { inspectGitHubReadiness } from './github-readiness'
import type { ForgeReadinessInput } from './readiness'
import { gitRewrite, publishBranch, remoteBranchHead, refreshBranchCache } from './git-rewrite'
import { historyContainsBuild, withBuildTrailer } from '../../kernel/build-identity'
import { NoCommitsBetweenBranchesError, type BuildLandingOptions } from '../types'
import { findSummaryMarker } from './summary-marker'
/**
 * GitHubForge (SPEC §3.2): the Forge adapter for GitHub, speaking the GitHub
 * REST API through an injectable transport seam. All remote access is
 * kernel-side plumbing (SPEC §8.6 [D7]) — agents never touch the remote, so
 * forge credentials never enter the sandbox.
 *
 * The adapter never routes API calls through `gh` or reads a local checkout
 * for them: the same adapter serves a checkout-bound dispatcher and a
 * checkout-less (`--repository`) one. Credentials come from `GITHUB_TOKEN` /
 * `GH_TOKEN`, falling back to the gh CLI's stored login (`gh auth token`) so
 * a local operator needs only `gh auth login`. The one deliberate subprocess
 * exception on the API side is that probe; `pushBranch` remains `git push`
 * from the workspace — it is only ever called from worktree-side terminals
 * and contract fixtures; `vercel-sandbox` builds publish through the
 * sandbox's receive-pack proxy. Integration-node plumbing uses a separate
 * trusted kernel Git transport, with credentials scoped to this repository.
 *
 * Native auto-merge is the one operation GitHub exposes only through its
 * GraphQL schema (no REST route exists), so its enable/disable mutations
 * travel over the same transport to `POST /graphql`.
 *
 * Repository coordinates (owner/name) resolve lazily and memoized: explicit
 * constructor option → `AB_REPOSITORY` (normalized) → `git remote get-url
 * origin` in `repoRoot` (checkout mode) → hard error at first use. In origin
 * mode the dispatcher exports `AB_REPOSITORY`, so coordinate discovery needs no Git call.
 */
import { z } from 'zod'
import { isValidGitBranchName, normalizeGitRemoteUrl } from '../../kernel/origin'
import type { Exec } from '../workspace/git-worktree'
import {
  GitHubApiError,
  classifyGitHubFailure,
  createGitHubFetchTransport,
  githubTokenSource,
  restPlanLimitation,
  type GitHubRequest,
  type GitHubTokenSource,
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

/** One subprocess seam for every forge command: argv array, optional cwd,
 * no shell. Git commands name their cwd; the gh credential probe needs none.
 * The contract is the workspace module's, re-exported so the forge and its
 * callers name one type. */
export type { Exec, ExecResult } from '../workspace/git-worktree'

export const bunExec: Exec = async (cmd, opts) => {
  if (opts.signal?.aborted === true) {
    throw new Error(`forge command aborted before launch: ${cmd.join(' ')}`)
  }
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    ...(opts.env === undefined ? {} : { env: { ...process.env, ...opts.env } }),
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
    auto_merge: z.object({}).passthrough().nullable().optional(),
    mergeable: z.boolean().nullable(),
    merge_commit_sha: z.string().min(1).nullable(),
    head: z
      .object({
        sha: z.string().min(1),
        ref: z.string().optional(),
        repo: z.object({ full_name: z.string() }).nullable().optional(),
      })
      .optional(),
  })
  .passthrough()
  .refine((view) => !view.merged || view.merge_commit_sha !== null, {
    message: 'GitHub reports PR merged with no merge_commit_sha',
  })

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

const nodeComparison = z.object({
  base_commit: z.object({ sha: z.string().min(1) }),
  ahead_by: z.number().int().nonnegative(),
  behind_by: z.number().int().nonnegative(),
})

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

// Constraints on writes must not be bypassed by a privileged direct landing.
const CONTROLLED_WRITE_RULE_TYPES = new Set([
  'update',
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

const SQUASH_MESSAGE_QUERY = `
  query ($owner: String!, $name: String!, $number: Int!, $branch: String) {
    repository(owner: $owner, name: $name) {
      defaultBranchRef { name }
      mergeQueue(branch: $branch) { id }
      pullRequest(number: $number) {
        id headRefOid state baseRefName
        viewerMergeHeadlineText(mergeType: SQUASH)
        viewerMergeBodyText(mergeType: SQUASH)
        autoMergeRequest { commitHeadline commitBody mergeMethod }
      }
    }
  }
`
const squashMessageData = z.object({
  repository: z.object({
    defaultBranchRef: z.object({ name: z.string().min(1) }).nullable(),
    mergeQueue: z.object({ id: z.string().min(1) }).nullable(),
    pullRequest: z.object({
      baseRefName: z.string().min(1),
      id: z.string().min(1),
      headRefOid: z.string().min(1),
      state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
      viewerMergeHeadlineText: z.string(),
      viewerMergeBodyText: z.string(),
      autoMergeRequest: z
        .object({
          // Legacy native requests leave overrides unset; GitHub returns null.
          commitHeadline: z.string().nullable(),
          commitBody: z.string().nullable(),
          mergeMethod: z.string(),
        })
        .nullable(),
    }),
  }),
})
const ENABLE_IDENTITY_AUTO_MERGE_MUTATION = `
  mutation ($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!,
            $expectedHeadOid: GitObjectID!, $commitHeadline: String!, $commitBody: String!) {
    enablePullRequestAutoMerge(input: {pullRequestId: $pullRequestId, mergeMethod: $mergeMethod,
      expectedHeadOid: $expectedHeadOid, commitHeadline: $commitHeadline, commitBody: $commitBody}) {
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

const requiredStatusChecksKey = 'required_status_checks'
const reviewsKey = 'required_pull_request_reviews'
const restrictionsKey = 'restrictions'

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
  const statusChecks = raw.required_status_checks
  const reviews = raw.required_pull_request_reviews
  const restrictions = raw.restrictions
  // Type-validate every subsection that IS present: GitHub renders unset
  // subsections as null, so anything else here is a shape this classifier
  // cannot read. Malformed-but-present never proves presence or absence.
  if (statusChecks !== undefined && statusChecks !== null && typeof statusChecks !== 'object') {
    return { kind: 'unproven', detail: 'required_status_checks is neither null nor an object' }
  }
  if (restrictions !== undefined && restrictions !== null && typeof restrictions !== 'object') {
    return { kind: 'unproven', detail: 'restrictions is neither null nor an object' }
  }
  if (reviews !== undefined && reviews !== null && typeof reviews !== 'object') {
    return {
      kind: 'unproven',
      detail: 'required_pull_request_reviews is neither null nor an object',
    }
  }
  // Presence proofs — one subsection that demonstrably carries a requirement
  // settles presence regardless of what the response did with the others.
  if (statusChecks !== undefined && statusChecks !== null) {
    return { kind: 'proved', gate: true }
  }
  if (restrictions !== undefined && restrictions !== null) {
    return { kind: 'proved', gate: true }
  }
  // Absence proofs — to conclude "no gate" every subsection that could carry
  // one must have been rendered; a missing subsection is auth- or plan-scoped
  // in a way we cannot prove, so each names itself precisely.
  if (!(requiredStatusChecksKey in raw)) {
    return {
      kind: 'unproven',
      detail: 'protection.required_status_checks missing from response',
    }
  }
  if (!(restrictionsKey in raw)) {
    return { kind: 'unproven', detail: 'protection.restrictions missing from response' }
  }
  if (!(reviewsKey in raw)) {
    return {
      kind: 'unproven',
      detail:
        'protection.required_pull_request_reviews missing from response; ' +
        'a classic reviews requirement could not be ruled out',
    }
  }
  if (reviews === null) return { kind: 'proved', gate: false }
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Bounded UNKNOWN re-query schedule: 7 re-queries, ~30 s of nondecreasing
 * backoff capped at 6 s steps. Sized after AUT-392 — the prior
 * two-re-query/2 s budget (`[500, 1500]`) was exhausted by a live occurrence
 * (build `give-repo-scoped`, PR #352) while GitHub was still computing
 * mergeability after required checks completed. Single-occurrence evidence,
 * so this is a deliberate sizing bet, not a measured latency distribution;
 * the unchanged pendingAutoMerge tick backstop remains behind it for waits a
 * single tick cannot absorb. */
export const MERGEABILITY_RETRY_DELAYS_MS = [1000, 2000, 4000, 5000, 6000, 6000, 6000]

/** Bounded validated HTTP representations; eviction falls back to fresh GETs. */
const REPRESENTATION_CACHE_CAP = 512

export class GitHubForge implements Forge {
  get rewrite() {
    return gitRewrite(
      async (cmd, opts) => {
        if (cmd.includes('push')) this.invalidateReads()
        return this.exec(cmd, opts)
      },
      false,
      (ref, sha) => this.createArchive(ref, sha),
    )
  }
  get kernelRewrite() {
    return gitRewrite(this.kernelExec, false, (ref, sha) => this.createArchive(ref, sha))
  }
  /** Credentials exist only in the trusted subprocess environment, never in
   * argv, repository config, remote URLs, or the resolving agent's environment. */
  readonly kernelExec: Exec = async (cmd, opts) => {
    if (cmd.includes('push')) this.invalidateReads()
    const repo = await this.repoCoordinates()
    if (!repo) throw new Error('kernel Git requires explicit GitHub repository coordinates')
    const credential = typeof this.token === 'function' ? await this.token() : this.token
    const token = typeof credential === 'string' ? credential : credential?.token
    if (!token) throw new Error('kernel Git requires a GitHub token')
    const encoded = Buffer.from(`x-access-token:${token}`).toString('base64')
    const url = `https://github.com/${repo.owner}/${repo.name}`
    const redact = (value: string) =>
      value.replaceAll(token, '[redacted]').replaceAll(encoded, '[redacted]')
    try {
      const result = await this.exec(cmd, {
        ...opts,
        env: {
          ...opts.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_CONFIG_COUNT: '7',
          GIT_CONFIG_KEY_0: 'http.extraHeader',
          GIT_CONFIG_VALUE_0: '',
          GIT_CONFIG_KEY_1: 'http.https://github.com/.extraHeader',
          GIT_CONFIG_VALUE_1: '',
          GIT_CONFIG_KEY_2: `http.${url}.extraHeader`,
          GIT_CONFIG_VALUE_2: '',
          GIT_CONFIG_KEY_3: `http.${url}.git.extraHeader`,
          GIT_CONFIG_VALUE_3: '',
          GIT_CONFIG_KEY_4: `http.${url}.extraHeader`,
          GIT_CONFIG_VALUE_4: `Authorization: Basic ${encoded}`,
          GIT_CONFIG_KEY_5: `http.${url}.git.extraHeader`,
          GIT_CONFIG_VALUE_5: `Authorization: Basic ${encoded}`,
          GIT_CONFIG_KEY_6: 'credential.helper',
          GIT_CONFIG_VALUE_6: '',
        },
      })
      const safe = { ...result, stdout: redact(result.stdout), stderr: redact(result.stderr) }
      if (
        result.exitCode !== 0 &&
        cmd.some((arg) => ['push', 'fetch', 'ls-remote'].includes(arg))
      ) {
        const original = new Error(safe.stderr || safe.stdout)
        const classified = classifyGitNetworkFailure(original)
        if (classified !== original) throw classified
      }
      return safe
    } catch (error) {
      if (error instanceof ForgeRequestDeferred) throw error
      const classified = cmd.some((arg) => ['push', 'fetch', 'ls-remote'].includes(arg))
        ? classifyGitNetworkFailure(error)
        : error
      if (isForgeFailure(classified))
        throw new ForgeFailure(redact(classified.message), classified.details)
      throw new Error(redact(error instanceof Error ? error.message : String(error)))
    }
  }
  readonly name = 'github'
  readonly prAttachments: PrAttachmentHosting

  private readonly transport: GitHubRequest
  /** Subprocess seam for workspace pushes and trusted kernel Git operations;
   * every API operation goes through the HTTP transport. */
  private readonly exec: Exec
  private readonly token: GitHubTokenSource
  private readonly explicitRepository?: string
  private readonly repoRoot?: string
  private readonly env: Readonly<Record<string, string | undefined>>
  private coordinates?: RepoCoordinates | null
  private readonly representations = new Map<string, { etag: string; value: unknown }>()
  private readonly reads = new AsyncLocalStorage<Map<string, Promise<unknown>>>()

  private readonly activeScopes = new Set<Map<string, Promise<unknown>>>()
  private readEpoch = 0

  async withReadScope<T>(work: () => Promise<T>): Promise<T> {
    const scope = new Map<string, Promise<unknown>>()
    this.activeScopes.add(scope)
    try {
      return await this.reads.run(scope, work)
    } finally {
      scope.clear()
      this.activeScopes.delete(scope)
    }
  }

  private memo<T>(key: string, work: () => Promise<T>): Promise<T> {
    const scope = this.reads.getStore()
    if (!scope || !this.activeScopes.has(scope)) return work()
    const existing = scope.get(key)
    if (existing) return existing as Promise<T>
    const result = Promise.resolve().then(work)
    scope.set(key, result)
    return result
  }

  private invalidateReads(): void {
    this.readEpoch++
    for (const scope of this.activeScopes) scope.clear()
    this.representations.clear()
  }

  /** These reads all use GET with the transport's fixed JSON representation
   * headers. The full repository-qualified path (including query, if any)
   * is therefore the exact resource key; raw/file/readiness reads stay separate.
   * Only validated representations receive validators. */
  private async revalidate<T>(schema: z.ZodType<T>, path: string, operation: string): Promise<T> {
    return this.memo(`http:${path}`, () => this.revalidateResource(schema, path, operation))
  }

  private async revalidateResource<T>(
    schema: z.ZodType<T>,
    path: string,
    operation: string,
  ): Promise<T> {
    const epoch = this.readEpoch
    const cached = this.representations.get(path)
    try {
      const response = await this.request(
        'GET',
        path,
        cached ? { headers: { 'If-None-Match': cached.etag } } : undefined,
      )
      if (response.status === 304) {
        if (!cached) throw new Error(`unsolicited GitHub 304 for ${operation}`)
        return cached.value as T
      }
      const value = this.parse(schema, response, operation)
      if (epoch !== this.readEpoch) return value
      this.representations.delete(path)
      if (response.headers.etag)
        this.representations.set(path, { etag: response.headers.etag, value })
      while (this.representations.size > REPRESENTATION_CACHE_CAP) {
        this.representations.delete(this.representations.keys().next().value!)
      }
      return value
    } catch (error) {
      if (epoch === this.readEpoch) this.representations.delete(path)
      throw error
    }
  }

  /** Bounded waits between mergeability re-queries on the UNKNOWN path. */
  private readonly mergeabilityRetryDelaysMs: number[]

  private readonly now: () => number

  constructor(
    opts: {
      now?: () => number
      transport?: GitHubRequest
      exec?: Exec
      /** Literal token, or a resolver. Absent: the adapter resolves
       * `GITHUB_TOKEN`, `GH_TOKEN`, then the gh CLI login lazily through its
       * own exec seam. */
      token?: GitHubTokenSource
      repository?: string
      repoRoot?: string
      env?: Readonly<Record<string, string | undefined>>
      /** Bounded waits between mergeability re-queries when GitHub reports
       * `mergeable_state: 'unknown'` (mergeability still being computed).
       * Defaults to `MERGEABILITY_RETRY_DELAYS_MS` (7 re-queries, ~30 s);
       * tests inject `[0, 0]` or all-zero schedules so no test sleeps. */
      mergeabilityRetryDelaysMs?: number[]
    } = {},
  ) {
    this.now = opts.now ?? Date.now
    this.exec = opts.exec ?? bunExec
    this.env = opts.env ?? {}
    this.token = opts.token !== undefined ? opts.token : githubTokenSource(this.env, this.exec)
    // Credential order: explicit token → GITHUB_TOKEN/GH_TOKEN → the gh CLI's
    // stored login, probed lazily through this adapter's exec seam on the
    // first request. A request that still goes out anonymously carries the
    // miss reason in its error, so nothing is probed at construction time.
    const transport = opts.transport ?? createGitHubFetchTransport({ token: this.token })
    this.transport = async (...args) =>
      guardedForgeRequest(async () => {
        const context = forgeRequestContext()
        let outcome: 'restPrimary' | 'restNotModified' | 'graphql' | undefined
        if (args[1] === 'graphql') outcome = 'graphql'
        try {
          const response = await transport(...args)
          outcome ??= response.status === 304 ? 'restNotModified' : 'restPrimary'
          return response
        } catch (error) {
          if (error instanceof GitHubApiError) outcome ??= 'restPrimary'
          throw classifyGitHubFailure(error, this.now())
        } finally {
          for (const observer of this.requestObservers)
            observer({ ...context, ...(outcome ? { outcome } : {}) })
        }
      })
    if (opts.repository !== undefined && opts.repository !== '') {
      this.explicitRepository = opts.repository
    } else if (this.env.AB_REPOSITORY !== undefined && this.env.AB_REPOSITORY !== '') {
      this.explicitRepository = this.env.AB_REPOSITORY
    }
    this.repoRoot = opts.repoRoot
    this.mergeabilityRetryDelaysMs = opts.mergeabilityRetryDelaysMs ?? MERGEABILITY_RETRY_DELAYS_MS
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

  private readonly requestObservers = new Set<ForgeRequestObserver>()
  observeRequests(observer: ForgeRequestObserver): () => void {
    this.requestObservers.add(observer)
    return () => {
      this.requestObservers.delete(observer)
    }
  }

  private async request(
    method: string,
    path: string,
    opts?: GitHubRequestOpts,
  ): Promise<GitHubResponse> {
    if (method !== 'GET' && path !== 'graphql') this.invalidateReads()
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
    if (/^\s*mutation\b/.test(query)) this.invalidateReads()
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
      throw classifyGitHubFailure(
        new GitHubApiError(
          response.status,
          `GitHub GraphQL ${operation} failed: ${errors.map((e) => e.message).join('; ')}`,
          response.json,
          response.headers,
        ),
        this.now(),
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

  /** Ordinary phase publication extends history; reconcile uses the separate guarded rewrite capability.
   * Only ever called from worktree-side terminals and contract fixtures. */
  async confirmPublication(workspacePath: string, branch: string, sha: string): Promise<boolean> {
    this.invalidateReads()
    if ((await remoteBranchHead(this.exec, workspacePath, branch)) !== sha) return false
    await refreshBranchCache(this.exec, workspacePath, branch, sha)
    return true
  }

  async pushBranch(workspacePath: string, branch: string, sha?: string): Promise<void> {
    this.invalidateReads()
    await publishBranch(this.exec, workspacePath, branch, sha)
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
    const probe = async () => {
      const listed = await this.getJson(
        z.array(
          restPrRef.extend({
            head: z.object({ sha: z.string().min(1), ref: z.string().min(1) }),
            base: z.object({ ref: z.string().min(1) }),
          }),
        ),
        `${repoPath}/pulls?head=${encodeURIComponent(`${owner}:${opts.head}`)}&base=${encodeURIComponent(opts.base)}&state=open`,
        'open PR probe',
      )
      const existing = listed.find((pr) => pr.head.ref === opts.head && pr.base.ref === opts.base)
      if (existing === undefined) return undefined
      return { number: existing.number, url: existing.html_url, headSha: existing.head.sha }
    }
    const existing = await probe()
    if (existing) return existing
    try {
      const created = this.parse(
        restPrRef,
        await this.request('POST', `${repoPath}/pulls`, {
          body: { title: opts.title, head: opts.head, base: opts.base, body: opts.body },
        }),
        'PR create',
      )
      return { number: created.number, url: created.html_url, headSha: created.head.sha }
    } catch (error) {
      if (isForgeFailure(error) || error instanceof ForgeRequestDeferred) throw error
      if (error instanceof GitHubApiError && error.status === 422) {
        const raced = await probe()
        if (raced) return raced
        const validation = z
          .object({
            errors: z.array(z.object({ message: z.string().optional() }).passthrough()).optional(),
          })
          .passthrough()
          .safeParse(error.body)
        const noCommits = validation.success
          ? validation.data.errors?.find((item) => /no commits between/i.test(item.message ?? ''))
          : undefined
        if (noCommits?.message) throw new NoCommitsBetweenBranchesError(noCommits.message)
      }
      throw error
    }
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
    const view = await this.prView(number, prPath)
    let state: PrState
    if (view.merged) {
      // §15.7 [D1]: pr.merged records the squash commit as the landing
      // point — a merged PR without one is unusable, not mappable.
      if (view.merge_commit_sha === null) {
        throw new Error(`GitHub reports PR #${number} merged with no merge_commit_sha`)
      }
      state = {
        state: 'merged',
        sha: view.merge_commit_sha,
        ...(view.head ? { headSha: view.head.sha } : {}),
      }
    } else {
      switch (view.state) {
        case 'closed':
          state = { state: 'closed' }
          break
        case 'open':
          state = {
            state: 'open',
            mergeable: view.mergeable,
            ...(view.auto_merge !== undefined ? { nativeAutoMerge: view.auto_merge !== null } : {}),
          }
      }
    }
    return state
  }

  private prView(number: number, path: string) {
    return this.memo(`pr:${number}`, () => this.revalidate(restPrState, path, `PR #${number} poll`))
  }

  async primeNodeReads(input: {
    workspacePath: string
    parent: string
    head: string
    prNumber?: number
  }): Promise<void> {
    const scope = this.reads.getStore()
    if (!scope || !this.activeScopes.has(scope)) return
    const epoch = this.readEpoch
    const { owner, name } = await this.requireCoordinates()
    const root = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
    let headSha: string
    let parentSha: string
    let ahead: number
    if (input.prNumber !== undefined) {
      const view = await this.prView(input.prNumber, `${root}/pulls/${input.prNumber}`)
      if (view.merged || view.state === 'closed') return
      if (
        view.head?.ref !== input.head ||
        view.head.repo?.full_name.toLowerCase() !== `${owner}/${name}`.toLowerCase()
      )
        return
      headSha = view.head.sha
      const comparison = await this.revalidate(
        nodeComparison,
        `${root}/compare/${encodeURIComponent(input.parent)}...${encodeURIComponent(headSha)}`,
        'node observation',
      )
      parentSha = comparison.base_commit.sha
      ahead = comparison.ahead_by
    } else {
      parentSha = await this.remoteBranchSha(input.parent)
      const comparison = await this.revalidate(
        nodeComparison,
        `${root}/compare/${encodeURIComponent(input.head)}...${encodeURIComponent(parentSha)}`,
        'node observation',
      )
      headSha = comparison.base_commit.sha
      ahead = comparison.behind_by
    }
    if (epoch !== this.readEpoch) return this.primeNodeReads(input)
    if (!this.activeScopes.has(scope)) return
    scope.set(`branch:${input.parent}`, Promise.resolve(parentSha))
    scope.set(`branch:${input.head}`, Promise.resolve(headSha))
    scope.set(
      `compare:${input.parent}:${input.head}`,
      Promise.resolve({ parentSha, headSha, ahead }),
    )
  }

  async mergeLinearStack(
    _workspacePath: string,
    number: number,
    expectedHead: string,
  ): Promise<string> {
    const { owner, name } = await this.requireCoordinates()
    const response = await this.request(
      'PUT',
      `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}/merge`,
      { body: { sha: expectedHead, merge_method: 'rebase' } },
    )
    const result = this.parse(
      z.object({ merged: z.literal(true), sha: z.string().min(1), message: z.string() }),
      response,
      'linear stack merge',
    )
    return result.sha
  }
  async inspectReadiness(input: ForgeReadinessInput) {
    const { owner, name } = await this.requireCoordinates()
    return inspectGitHubReadiness({ request: this.request.bind(this), owner, name, input })
  }

  async inspectMergeFreshness(branch: string): Promise<{ fenced: boolean; evidence: string[] }> {
    const evidence: string[] = []
    try {
      const { owner, name } = await this.requireCoordinates()
      const response = await this.request(
        'GET',
        `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches/${encodeURIComponent(branch)}/protection`,
      )
      const protection = z
        .object({
          enforce_admins: z.object({ enabled: z.boolean() }),
          required_status_checks: z
            .object({
              strict: z.boolean(),
              contexts: z.array(z.string()).optional(),
              checks: z.array(z.object({ context: z.string() })).optional(),
            })
            .nullable(),
        })
        .parse(response.json)
      const checks = protection.required_status_checks
      if (
        protection.enforce_admins.enabled &&
        checks?.strict &&
        (checks.contexts?.length ?? 0) + (checks.checks?.length ?? 0) > 0
      )
        return {
          fenced: true,
          evidence: [
            `Classic protection on ${branch} requires current branches and nonempty checks, including administrators.`,
          ],
        }
      evidence.push('Classic protection does not prove enforced freshness for all merge actors.')
    } catch {
      evidence.push('Classic freshness protection could not be inspected authoritatively.')
    }
    try {
      const { owner, name } = await this.requireCoordinates()
      const root = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
      const ruleSchema = z.object({
        type: z.string(),
        ruleset_id: z.number().int().positive().optional(),
        parameters: z.unknown().optional(),
      })
      const rules: z.infer<typeof ruleSchema>[] = []
      for (let page = 1; ; page++) {
        const response = await this.request(
          'GET',
          `${root}/rules/branches/${encodeURIComponent(branch)}`,
          { query: { per_page: '100', page: String(page) } },
        )
        const batch = z.array(ruleSchema).parse(response.json)
        rules.push(...batch)
        if (batch.length < 100) break
      }
      for (const rule of rules) {
        if (rule.type !== 'required_status_checks' || !rule.ruleset_id) continue
        const parameters = z
          .object({
            strict_required_status_checks_policy: z.boolean(),
            required_status_checks: z.array(z.object({ context: z.string() })),
          })
          .safeParse(rule.parameters)
        if (
          !parameters.success ||
          !parameters.data.strict_required_status_checks_policy ||
          !parameters.data.required_status_checks.length
        )
          continue
        // Repository ruleset reads include inherited organization rulesets.
        // Omitted bypass data is uncertainty, never proof of an empty list.
        const response = await this.request('GET', `${root}/rulesets/${rule.ruleset_id}`, {
          query: { includes_parents: 'true' },
        })
        const ruleset = z
          .object({ enforcement: z.literal('active'), bypass_actors: z.array(z.unknown()) })
          .parse(response.json)
        if (!ruleset.bypass_actors.length)
          return {
            fenced: true,
            evidence: [
              `Effective ruleset ${rule.ruleset_id} requires current branches and nonempty checks with no bypass actors.`,
            ],
          }
      }
      evidence.push('Effective rules do not prove strict freshness without bypass actors.')
    } catch {
      evidence.push(
        'Effective freshness rules or bypass permissions could not be inspected completely.',
      )
    }
    return { fenced: false, evidence }
  }

  async retargetPr(workspacePath: string, number: number, base: string): Promise<void> {
    const before = await this.inspectLandingPr(workspacePath, number)
    if (!before.open) throw new Error(`PR #${number} is no longer open`)
    if (before.base === base) return
    const { owner, name } = await this.requireCoordinates()
    const response = await this.request(
      'PATCH',
      `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}`,
      { body: { base } },
    )
    const pr = this.parse(
      z.object({
        number: z.number().int(),
        state: z.string(),
        merged: z.boolean(),
        base: z.object({ ref: z.string() }),
        head: z.object({ ref: z.string(), sha: z.string() }),
      }),
      response,
      `retarget PR #${number}`,
    )
    if (
      response.status !== 200 ||
      pr.number !== number ||
      pr.state !== 'open' ||
      pr.merged ||
      pr.base.ref !== base ||
      pr.head.ref !== before.head ||
      pr.head.sha !== before.headSha
    )
      throw new Error(`PR #${number} retarget acknowledgement disagrees with requested base/head`)
    this.invalidateReads()
  }

  async inspectLandingPr(_workspacePath: string, number: number) {
    const { owner, name } = await this.requireCoordinates()
    const response = await this.request(
      'GET',
      `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}`,
    )
    const schema = z.object({
      state: z.enum(['open', 'closed']),
      merged: z.boolean(),
      draft: z.boolean(),
      base: z.object({ ref: z.string() }),
      head: z.object({ ref: z.string(), sha: z.string() }),
    })
    const pr = this.parse(schema, response, `node merge PR #${number}`)
    return {
      base: pr.base.ref,
      head: pr.head.ref,
      headSha: pr.head.sha,
      open: pr.state === 'open' && !pr.merged && !pr.draft,
    }
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
      if (isForgeFailure(error) || error instanceof ForgeRequestDeferred) throw error
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
      await this.request('GET', `${repoPath}/git/ref/heads/${encodeURIComponent(branch)}`)
    } catch (error) {
      if (isForgeFailure(error) || error instanceof ForgeRequestDeferred) throw error
      if (error instanceof GitHubApiError && error.status === 404) return // idempotent
      throw error
    }
    try {
      await this.request('DELETE', `${repoPath}/git/refs/heads/${branch}`)
    } catch (error) {
      if (isForgeFailure(error) || error instanceof ForgeRequestDeferred) throw error
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

  async inspectLandingGate(branch: string): Promise<import('../types').LandingGateInspection> {
    const result = await this.mergeGatePresence(branch, false, true)
    if (result.kind === 'deferred') return { kind: 'unproven', reason: result.reason.detail }
    return result.presence === 'absent'
      ? { kind: 'proved-ungated' }
      : { kind: 'gated', reason: `Branch ${branch} has merge-blocking protection or rules` }
  }

  /** Probe both GitHub gate systems for the PR's exact base branch. The one
   * non-success ruleset response that proves absence is GitHub's documented
   * account-plan limitation; even then classic protection must independently
   * parse successfully. Every other uncertainty is returned as a typed,
   * fail-closed deferral rather than escaping into finalize or the janitor. */
  private async mergeGatePresence(
    baseRefName: string,
    requireIdentity = false,
    controlledLanding = false,
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
    const branchPath = `${repoPath}/branches/${encodeURIComponent(baseRefName)}`

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
        classicGate =
          classic.gate ||
          (controlledLanding &&
            typeof protection === 'object' &&
            protection !== null &&
            'required_pull_request_reviews' in protection &&
            protection.required_pull_request_reviews !== null)
      }
    } catch (error) {
      if (isForgeFailure(error) || error instanceof ForgeRequestDeferred) throw error
      classicError = errorMessage(error)
    }

    let rulesetGate = false
    let planLimited = false
    let rulesPagesRead = 0
    try {
      const parsed: import('zod').infer<typeof restRulesetRules> = []
      // Exhaust effective rules, including organization rules. A truncated
      // first page cannot prove absence, even for a bypass-capable token.
      for (let page = 1; ; page++) {
        if (page > 1000) throw new Error('ruleset pagination did not terminate')
        const rules = await this.request(
          'GET',
          `${repoPath}/rules/branches/${encodeURIComponent(baseRefName)}`,
          { query: { per_page: '100', page: String(page) } },
        )
        if (rules.status !== 200) throw new Error('incomplete ruleset response')
        const batch = this.parse(restRulesetRules, rules, 'ruleset probe')
        rulesPagesRead++
        parsed.push(...batch)
        const more = rules.headers.link?.includes('rel="next"') === true
        if (batch.length < 100 && !more) break
        if (batch.length === 0) throw new Error('incomplete ruleset pagination')
      }
      if (requireIdentity && parsed.some((rule) => rule.type === 'merge_queue')) {
        return unproven(
          'GitHub merge queues ignore squash message overrides; merge through a human or change the queue policy to preserve Autobuild-Build identity',
        )
      }
      rulesetGate =
        rulesetsHaveMergeGate(parsed) ||
        (controlledLanding &&
          parsed.some(
            (rule) => rule.type === 'pull_request' || CONTROLLED_WRITE_RULE_TYPES.has(rule.type),
          ))
    } catch (error) {
      if (isForgeFailure(error) || error instanceof ForgeRequestDeferred) throw error
      if (
        rulesPagesRead === 0 &&
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
      // The classic response was incomplete, but a ruleset probe that
      // succeeded and found merge-blocking rules proves the branch is gated
      // no matter what the classic response hid — native auto-merge is the
      // correct application either way.
      if (rulesetGate) return { kind: 'proved', presence: 'present' }
      return unproven(
        `GitHub auto-merge classic branch-protection probe failed: ${classicError ?? 'unknown failure'}; ` +
          `the ruleset probe for branch '${baseRefName}' found no merge-blocking rules, ` +
          'so a classic reviews requirement could not be ruled out',
      )
    }
    return {
      kind: 'proved',
      presence: classicGate || rulesetGate ? 'present' : 'absent',
    }
  }

  /**
   * Enable-path PR inspection with bounded mergeability re-query. GitHub's
   * `mergeable_state: 'unknown'` means mergeability is still being computed —
   * transient, commonly observed just after required checks finish — so the
   * same view is re-GET after short waits before concluding, stopping early if
   * native auto-merge appears applied (another actor enabled it; the caller
   * acknowledges adoption without a mutation). Unknown *unrecognized* state
   * strings still throw into the caller's fail-closed handling — only the
   * mapped UNKNOWN value re-queries.
   */
  private async inspectAutoMergeView(
    repoPath: string,
    number: number,
  ): Promise<{
    view: z.infer<typeof restAutoMergeView>
    mergeState: MergeStateStatus
    requeries: number
    waitedMs: number
  }> {
    const view = await this.getJson(
      restAutoMergeView,
      `${repoPath}/pulls/${number}`,
      `PR #${number} auto-merge inspection`,
    )
    let current = view
    let requeries = 0
    let waitedMs = 0
    while (
      current.auto_merge === null &&
      restMergeState(current.mergeable_state) === 'UNKNOWN' &&
      requeries < this.mergeabilityRetryDelaysMs.length
    ) {
      const delay = this.mergeabilityRetryDelaysMs[requeries] ?? 0
      await sleep(delay)
      waitedMs += delay
      requeries += 1
      current = await this.getJson(
        restAutoMergeView,
        `${repoPath}/pulls/${number}`,
        `PR #${number} auto-merge inspection`,
      )
    }
    return {
      view: current,
      mergeState: restMergeState(current.mergeable_state),
      requeries,
      waitedMs,
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
    options?: BuildLandingOptions,
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
      // A matching native request needs only this authoritative read, even
      // after a dispatcher restart. Consent is refreshed only before mutations.
      const message =
        options === undefined ? undefined : await this.squashMessage(number, options.baseBranch)
      if (message !== undefined && options !== undefined) {
        if (message.state !== 'OPEN') return { kind: 'deferred' }
        if (this.identityMessageMatches(message, options.buildSlug)) return { kind: 'applied' }
      }
      const { view, mergeState, requeries, waitedMs } = await this.inspectAutoMergeView(
        repoPath,
        number,
      )
      if (view.auto_merge !== null && options === undefined) return { kind: 'applied' }
      if (
        message !== undefined &&
        (message.headRefOid !== view.head.sha || message.baseRefName !== view.base.ref)
      )
        return { kind: 'deferred' }

      const gate = await this.mergeGatePresence(view.base.ref, options !== undefined)
      if (gate.kind === 'deferred') return gate
      const disposition =
        view.auto_merge !== null && options !== undefined && mergeState !== 'DIRTY'
          ? { kind: 'native' as const }
          : classifyAutoMergeEnable(mergeState, gate.presence)
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
          if (options !== undefined)
            return await this.applyIdentityAutoMerge(number, view.head.sha, options, message!)
          await this.graphql(
            'enablePullRequestAutoMerge',
            enableAutoMergeData,
            ENABLE_AUTO_MERGE_MUTATION,
            { pullRequestId: view.node_id, mergeMethod: 'SQUASH' },
          )
          return (await this.nativeAutoMergeView(number)).enabled
            ? { kind: 'applied' }
            : {
                kind: 'deferred',
                reason: {
                  code: 'unproven-gate-state',
                  detail:
                    'enablePullRequestAutoMerge was accepted but the follow-up native read ' +
                    `reports auto_merge unset for PR #${number}`,
                },
              }
        }
        case 'direct':
          return { kind: 'ungated', headSha: view.head.sha }
        case 'deferred':
          if (mergeState === 'UNKNOWN') {
            // Not a persistent indeterminacy: mergeability was still being
            // computed (transient) after the bounded re-queries. pendingAutoMerge
            // keeps the consent pending, so a later janitor tick retries.
            return {
              kind: 'deferred',
              reason: {
                code: 'mergeability-uncomputed',
                detail:
                  `GitHub reported mergeable_state 'UNKNOWN' for PR #${number} — mergeability ` +
                  `was still being computed (transient) after ${requeries} re-quer${requeries === 1 ? 'y' : 'ies'} ` +
                  `over ${waitedMs} ms; native auto-merge was not enabled`,
              },
            }
          }
          if (mergeState === 'DIRTY') {
            // A persistent, definite state: GitHub has computed merge
            // conflicts with the base branch, so native auto-merge cannot be
            // enabled against it. The recovery is updating the branch or
            // resolving the conflicts — not gate-state investigation — and
            // pendingAutoMerge keeps the consent pending so a later janitor
            // tick re-examines it once the conflict is resolved.
            return {
              kind: 'deferred',
              reason: {
                code: 'merge-conflicts',
                detail:
                  `GitHub reports mergeable_state 'DIRTY' for PR #${number} — the head branch has ` +
                  `merge conflicts with '${view.base.ref}'; update the branch or resolve the conflicts ` +
                  'and the pending consent will be re-examined on a later tick. ' +
                  'Native auto-merge was not enabled',
              },
            }
          }
          return {
            kind: 'deferred',
            reason: {
              code: 'unproven-gate-state',
              detail: `GitHub reports mergeable_state '${mergeState}' for PR #${number}; native auto-merge was not enabled`,
            },
          }
        case 'error':
          throw new Error(disposition.reason)
      }
    } catch (error) {
      if (isForgeFailure(error) || error instanceof ForgeRequestDeferred) throw error
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

  private async squashMessage(number: number, branch?: string) {
    const { owner, name } = await this.requireCoordinates()
    // The default branch is the usual base. A supplied hint covers other bases
    // in one query; always verify it against the PR, including after retargeting.
    for (let attempt = 0; attempt < 2; attempt++) {
      const data = await this.graphql('squashMessage', squashMessageData, SQUASH_MESSAGE_QUERY, {
        owner,
        name,
        number,
        branch: branch ?? null,
      })
      const message = data.repository.pullRequest
      const inspectedBranch = branch ?? data.repository.defaultBranchRef?.name
      if (inspectedBranch !== message.baseRefName) {
        branch = message.baseRefName
        continue
      }
      if (data.repository.mergeQueue !== null) {
        throw new Error(
          'GitHub merge queues ignore squash message overrides; merge through a human or change the queue policy to preserve Autobuild-Build identity',
        )
      }
      return message
    }
    throw new Error(
      'GitHub PR base changed during squash-message and merge-queue inspection; retry',
    )
  }

  private identityMessageMatches(
    view: z.infer<typeof squashMessageData>['repository']['pullRequest'],
    buildSlug: string,
  ): boolean {
    return (
      view.autoMergeRequest !== null &&
      view.autoMergeRequest.mergeMethod === 'SQUASH' &&
      view.autoMergeRequest.commitBody !== null &&
      view.autoMergeRequest.commitHeadline === view.viewerMergeHeadlineText &&
      view.autoMergeRequest.commitBody.trimEnd() ===
        withBuildTrailer(view.viewerMergeBodyText, buildSlug).trimEnd()
    )
  }

  private async applyIdentityAutoMerge(
    number: number,
    expectedHead: string,
    options: BuildLandingOptions,
    message: z.infer<typeof squashMessageData>['repository']['pullRequest'],
  ): Promise<AutoMergeResult> {
    const expectedBase = message.baseRefName
    const matches = (view: typeof message): boolean =>
      this.identityMessageMatches(view, options.buildSlug)
    if (message.state !== 'OPEN' || message.headRefOid !== expectedHead) return { kind: 'deferred' }
    if (matches(message)) return { kind: 'applied' }
    if (options.canApply !== undefined && !(await options.canApply())) return { kind: 'deferred' }
    if (message.autoMergeRequest !== null) {
      await this.graphql(
        'disablePullRequestAutoMerge',
        disableAutoMergeData,
        DISABLE_AUTO_MERGE_MUTATION,
        { pullRequestId: message.id },
      )
      message = await this.squashMessage(number, message.baseRefName)
      if (
        message.state !== 'OPEN' ||
        message.headRefOid !== expectedHead ||
        message.baseRefName !== expectedBase ||
        message.autoMergeRequest !== null
      )
        return { kind: 'deferred' }
    }
    if (options.canApply !== undefined && !(await options.canApply())) return { kind: 'deferred' }
    await this.graphql(
      'enablePullRequestAutoMerge',
      enableAutoMergeData,
      ENABLE_IDENTITY_AUTO_MERGE_MUTATION,
      {
        pullRequestId: message.id,
        mergeMethod: 'SQUASH',
        expectedHeadOid: message.headRefOid,
        commitHeadline: message.viewerMergeHeadlineText,
        commitBody: withBuildTrailer(message.viewerMergeBodyText, options.buildSlug),
      },
    )
    const after = await this.squashMessage(number, message.baseRefName)
    return after.state === 'OPEN' &&
      after.headRefOid === message.headRefOid &&
      after.baseRefName === expectedBase &&
      matches(after)
      ? { kind: 'applied' }
      : {
          kind: 'deferred',
          reason: {
            code: 'unproven-gate-state',
            detail: 'Native squash message was not confirmed; retry provider inspection',
          },
        }
  }

  async readCommitMessage(_workspacePath: string, sha: string): Promise<string> {
    const { owner, name } = await this.requireCoordinates()
    const view = await this.getJson(
      z.object({ commit: z.object({ message: z.string() }) }),
      `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits/${encodeURIComponent(sha)}`,
      'merged commit message',
    )
    return view.commit.message
  }

  async containsBuild(_workspacePath: string, branch: string, buildSlug: string): Promise<boolean> {
    if (!isValidGitBranchName(branch)) throw new Error('invalid branch')
    const { owner, name } = await this.requireCoordinates()
    const forge = this
    async function* messages() {
      for (let page = 1; ; page++) {
        const response = await forge.request(
          'GET',
          `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits`,
          {
            query: { sha: branch, per_page: '100', page: String(page) },
          },
        )
        const commits = z
          .array(z.object({ commit: z.object({ message: z.string() }) }))
          .parse(response.json)
        for (const commit of commits) yield commit.commit.message
        if (commits.length < 100) return
      }
    }
    return historyContainsBuild(messages(), buildSlug)
  }

  /** Normal guarded squash — no admin, force, rebase, or native-auto flag.
   * A 409 (head moved) surfaces as a hard error, preserving the contract's
   * moved-head rejection. */
  async squashMerge(
    _workspacePath: string,
    number: number,
    expectedHeadSha: string,
    options?: BuildLandingOptions,
  ): Promise<void> {
    const { owner, name } = await this.requireCoordinates()
    const message =
      options === undefined ? undefined : await this.squashMessage(number, options.baseBranch)
    if (
      message !== undefined &&
      (message.state !== 'OPEN' || message.headRefOid !== expectedHeadSha)
    ) {
      throw new Error('GitHub squash message head changed; retry inspection')
    }
    await this.request(
      'PUT',
      `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}/merge`,
      {
        body: {
          merge_method: 'squash',
          sha: expectedHeadSha,
          ...(message !== undefined && options !== undefined
            ? {
                commit_title: message.viewerMergeHeadlineText,
                commit_message: withBuildTrailer(message.viewerMergeBodyText, options.buildSlug),
              }
            : {}),
        },
      },
    )
  }

  /** The build's summary comment (SPEC §7.5) — links into the store. */
  async commentOnPr(_workspacePath: string, number: number, body: string): Promise<void> {
    const { owner, name } = await this.requireCoordinates()
    const root = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
    const collection = `${root}/issues/${number}/comments`
    const marker = findSummaryMarker(body)
    if (marker !== undefined) {
      const schema = z.array(z.object({ id: z.number().int().positive(), body: z.string() }))
      // A failed discovery never authorizes creation. Re-scan once if an edit
      // races deletion; an uncertain POST is rediscovered on the next phase.
      for (let scan = 0; scan < 2; scan++) {
        let match: { id: number; body: string } | undefined
        for (let page = 1; ; page++) {
          const response = await this.request('GET', collection, {
            query: { per_page: '100', page: String(page) },
          })
          const comments = schema.parse(response.json)
          match ??= comments.find((comment) => findSummaryMarker(comment.body) === marker)
          if (comments.length < 100) break
        }
        if (match === undefined) break
        if (match.body === body) return
        try {
          await this.request('PATCH', `${root}/issues/comments/${match.id}`, { body: { body } })
          return
        } catch (error) {
          if (isForgeFailure(error) || error instanceof ForgeRequestDeferred) throw error
          if (!(error instanceof GitHubApiError) || error.status !== 404 || scan !== 0) throw error
        }
      }
    }
    await this.request('POST', collection, { body: { body } })
  }

  // ── Optional capabilities (checkout-less dispatcher) ──────────────────────

  /** Current tip of a remote branch. Throws (including 404) when the branch
   * does not exist; the provider seam maps that to `undefined`. */
  private async nodeRef(branch: string): Promise<string> {
    if (!isValidGitBranchName(branch)) throw new Error('invalid node branch')
    const { owner, name } = await this.requireCoordinates()
    return this.memo(`branch:${branch}`, async () => {
      const result = await this.revalidate(
        z.object({ object: z.object({ sha: z.string().min(1) }) }),
        `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/ref/heads/${encodeURIComponent(branch)}`,
        'node ref',
      )
      return result.object.sha
    })
  }

  private async compareShas(parentSha: string, headSha: string) {
    return this.memo(`comparison:${parentSha}:${headSha}`, async () => {
      const { owner, name } = await this.requireCoordinates()
      return this.revalidate(
        z.object({
          ahead_by: z.number().int().nonnegative(),
          behind_by: z.number().int().nonnegative(),
          status: z.enum(['ahead', 'behind', 'diverged', 'identical']).optional(),
        }),
        `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/compare/${encodeURIComponent(parentSha)}...${encodeURIComponent(headSha)}`,
        'commit comparison',
      )
    })
  }

  async isCommitAncestor(ancestor: string, descendant: string): Promise<boolean> {
    if (!gitOid.safeParse(ancestor).success || !gitOid.safeParse(descendant).success)
      throw new Error('invalid ancestry OID')
    const result = await this.compareShas(ancestor, descendant)
    if (result.status === undefined) throw new Error('commit comparison omitted ancestry status')
    return result.status === 'ahead' || result.status === 'identical'
  }

  private async createArchive(ref: string, sha: string): Promise<void> {
    const { owner, name } = await this.requireCoordinates()
    this.parse(
      z.object({
        ref: z.literal(ref),
        object: z.object({ sha: z.literal(sha), type: z.literal('commit') }),
      }),
      await this.request(
        'POST',
        `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/refs`,
        { body: { ref, sha } },
      ),
      'archive create',
    )
  }

  async createNodeBranch(branch: string, sha: string): Promise<string> {
    if (!isValidGitBranchName(branch)) throw new Error('invalid node branch')
    const { owner, name } = await this.requireCoordinates()
    const adopt = async () => {
      const head = await this.nodeRef(branch)
      if ((await this.compareShas(sha, head)).behind_by !== 0)
        throw new Error(`node branch collision: ${branch} does not contain opening commit ${sha}`)
      return head
    }
    try {
      return await adopt()
    } catch (error) {
      if (isForgeFailure(error) || error instanceof ForgeRequestDeferred) throw error
      if (!(error instanceof GitHubApiError && error.status === 404)) throw error
    }
    try {
      const result = this.parse(
        z.object({
          ref: z.literal(`refs/heads/${branch}`),
          object: z.object({ sha: z.literal(sha) }),
        }),
        await this.request(
          'POST',
          `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/refs`,
          { body: { ref: `refs/heads/${branch}`, sha } },
        ),
        'node branch create',
      )
      return result.object.sha
    } catch (error) {
      if (isForgeFailure(error) || error instanceof ForgeRequestDeferred) throw error
      if (!(error instanceof GitHubApiError && error.status === 422)) throw error
      return adopt()
    }
  }

  async compareBranches(parent: string, head: string) {
    return this.memo(`compare:${parent}:${head}`, async () => {
      const parentSha = await this.nodeRef(parent)
      const headSha = await this.nodeRef(head)
      return { parentSha, headSha, ahead: (await this.compareShas(parentSha, headSha)).ahead_by }
    })
  }

  async remoteBranchSha(branch: string): Promise<string> {
    const { owner, name } = await this.requireCoordinates()
    return this.memo(`branch:${branch}`, async () => {
      const branchHead = await this.revalidate(
        restBranchHead,
        `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches/${encodeURIComponent(branch)}`,
        `remote branch ${branch}`,
      )
      return branchHead.commit.sha
    })
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
