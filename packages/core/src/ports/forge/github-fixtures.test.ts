import { GitHubForge } from './github'
import {
  GitHubApiError,
  type GitHubRequest,
  type GitHubRequestOpts,
  type GitHubResponse,
} from './github-transport'

export interface ApiCall {
  method: string
  path: string
  opts?: GitHubRequestOpts
}

export interface Scripted {
  status?: number
  json?: unknown
  bytes?: Uint8Array
  /** Response headers (lowercased keys, e.g. `etag`). */
  headers?: Record<string, string>
}

/** Scripted transport: journals every call, replies from a queue (default
 * 200 `{}`), asserting method/path per operation. A scripted 304 mirrors the
 * real transport: the documented success of a conditional request, returned
 * rather than thrown, with no body. */
export function makeTransport(responses: (Scripted | GitHubResponse)[] = []) {
  const calls: ApiCall[] = []
  const queue = [...responses]
  const transport: GitHubRequest = async (method, path, opts) => {
    calls.push({ method, path, ...(opts !== undefined ? { opts } : {}) })
    const next = queue.shift() ?? {}
    const status = next.status ?? 200
    const headers = next.headers ?? {}
    if (status === 304) {
      return { status: 304, headers }
    }
    if (status >= 300) {
      throw new GitHubApiError(
        status,
        (next.json as { message?: string } | undefined)?.message ?? 'GitHub API error',
        next.json,
      )
    }
    return {
      status,
      headers,
      ...(next.json !== undefined ? { json: next.json } : {}),
      ...(next.bytes !== undefined ? { bytes: next.bytes } : {}),
    }
  }
  return { transport, calls }
}

/** A forge whose coordinates resolve from the explicit option (origin mode
 * never touches git). Zero-delay retries still yield to real timers; retry scenarios belong in
 * integration tests. Pass a longer all-zero schedule for the extended budget. */
export function makeForge(
  responses: (Scripted | GitHubResponse)[] = [],
  retryDelaysMs: number[] = [0, 0],
) {
  const { transport, calls } = makeTransport(responses)
  const forge = new GitHubForge({
    transport,
    repository: 'acme/app',
    mergeabilityRetryDelaysMs: retryDelaysMs,
  })
  return { forge, calls }
}

export const paths = (calls: ApiCall[]): string[] =>
  calls.map((call) => `${call.method} ${call.path}`)
export type FakeCommit = { sha: string; commit: { message: string } }
export interface FakeGitHub {
  pr: Record<string, unknown> & {
    head: { sha: string; ref: string }
    base: { ref: string; sha: string }
    auto_merge: Record<string, unknown> | null
  }
  repo: Record<string, unknown>
  commits: FakeCommit[]
  rules: unknown[]
  /** Classic protection requiring a status check: native auto-merge applies. */
  gated?: boolean
  /** How GitHub stores an enabled request's overrides (provider normalization). */
  armedAs: (title: string, message: string) => Record<string, unknown>
  afterDisable?: (fake: FakeGitHub) => void
  /** Further open PRs by number, answered like PR #42. */
  others?: Record<number, FakeGitHub['pr']>
  /** Runs before each PR read is answered, with the 1-based read count. */
  beforePrRead?: (fake: FakeGitHub, read: number) => void
  graphqlStatus?: number
  /** Refuse every GraphQL request as Claude Code's GitHub proxy does. */
  graphqlUnavailable?: boolean
  /** The base branch's merge-queue activity page, or an error status. */
  activity?: unknown[] | number
  /** Refuse the merge request with this status and message. */
  mergeError?: { status: number; message: string }
  /** A successful merge request closes the PR as merged. */
  mergeLands?: boolean
}

export const PROXY_REFUSAL =
  'GitHub GraphQL is not available from Claude Code sessions. Use the REST API instead.'

export const fakePr = (): FakeGitHub['pr'] => ({
  number: 42,
  state: 'open',
  merged: false,
  mergeable: true,
  merge_commit_sha: null,
  node_id: 'PR_42',
  title: 'Server title — unchanged',
  body: '* unusual bullet\n\nCo-authored-by: A <a@example.test>\n',
  commits: 2,
  mergeable_state: 'clean',
  head: { sha: 'head-42', ref: 'feature' },
  base: { ref: 'main', sha: 'base-1' },
  auto_merge: null,
})

/** A stateful REST GitHub for the landing path: conditional PR and
 * repository reads (ETag per representation), commit listing and compare
 * pagination, gate reads, the GraphQL auto-merge mutations, and the merge. */
export function fakeGitHub(
  overrides: Partial<FakeGitHub> = {},
  config: { now?: () => number } = {},
) {
  const fake: FakeGitHub = {
    pr: fakePr(),
    repo: {
      allow_auto_merge: true,
      squash_merge_commit_title: 'PR_TITLE',
      squash_merge_commit_message: 'PR_BODY',
    },
    commits: [
      { sha: 'head-41', commit: { message: 'First commit\n\nFirst body' } },
      { sha: 'head-42', commit: { message: 'Second commit' } },
    ],
    rules: [],
    armedAs: (title, message) => ({
      merge_method: 'squash',
      commit_title: title,
      commit_message: message,
    }),
    ...overrides,
  }
  const calls: ApiCall[] = []
  let prReads = 0
  const conditional = (value: unknown, opts?: GitHubRequestOpts): GitHubResponse => {
    const etag = `"${Bun.hash(JSON.stringify(value)).toString(16)}"`
    if (opts?.headers?.['If-None-Match'] === etag) return { status: 304, headers: { etag } }
    return { status: 200, headers: { etag }, json: structuredClone(value) }
  }
  const page = <T>(items: T[], opts?: GitHubRequestOpts): T[] => {
    const size = Number(opts?.query?.per_page ?? '30')
    const index = Number(opts?.query?.page ?? '1') - 1
    return items.slice(index * size, (index + 1) * size)
  }
  const transport: GitHubRequest = async (method, path, opts) => {
    calls.push({ method, path, ...(opts !== undefined ? { opts } : {}) })
    const route = `${method} ${path}`
    if (route === 'GET repos/acme/app/pulls/42') {
      fake.beforePrRead?.(fake, ++prReads)
      return conditional(fake.pr, opts)
    }
    const other = /^repos\/acme\/app\/pulls\/(\d+)$/.exec(path)?.[1]
    if (method === 'GET' && other !== undefined && fake.others?.[Number(other)])
      return conditional(fake.others[Number(other)], opts)
    if (route === 'GET repos/acme/app') return conditional(fake.repo, opts)
    if (route === 'GET repos/acme/app/pulls/42/commits')
      return { status: 200, headers: {}, json: page(fake.commits, opts) }
    if (path.startsWith('repos/acme/app/compare/'))
      return {
        status: 200,
        headers: {},
        json: { total_commits: fake.commits.length, commits: page(fake.commits, opts) },
      }
    if (path.startsWith('repos/acme/app/branches/'))
      return {
        status: 200,
        headers: {},
        json: fake.gated
          ? {
              protected: true,
              protection: {
                required_status_checks: { checks: [{ context: 'ci' }], contexts: [] },
                required_pull_request_reviews: null,
                restrictions: null,
              },
            }
          : { protected: false },
      }
    if (path.startsWith('repos/acme/app/rules/branches/'))
      return { status: 200, headers: {}, json: fake.rules }
    if (route === 'GET repos/acme/app/activity') {
      if (typeof fake.activity === 'number')
        throw new GitHubApiError(fake.activity, 'activity unavailable')
      return { status: 200, headers: {}, json: fake.activity ?? [] }
    }
    if (route === 'PUT repos/acme/app/pulls/42/merge') {
      if (fake.mergeError !== undefined)
        throw new GitHubApiError(fake.mergeError.status, fake.mergeError.message, {
          message: fake.mergeError.message,
        })
      if (fake.mergeLands)
        fake.pr = { ...fake.pr, state: 'closed', merged: true, merge_commit_sha: 'squash-42' }
      return { status: 200, headers: {}, json: {} }
    }
    if (route === 'POST graphql') {
      if (fake.graphqlStatus !== undefined)
        throw new GitHubApiError(fake.graphqlStatus, 'mutation denied')
      if (fake.graphqlUnavailable)
        throw new GitHubApiError(403, PROXY_REFUSAL, { message: PROXY_REFUSAL })
      if ((opts!.body as { query: string }).query.includes('rateLimit'))
        return { status: 200, headers: {}, json: { data: { rateLimit: { cost: 1 } } } }
      const { query, variables } = opts!.body as {
        query: string
        variables: { commitHeadline: string; commitBody: string }
      }
      const field = query.includes('disablePullRequestAutoMerge')
        ? 'disablePullRequestAutoMerge'
        : 'enablePullRequestAutoMerge'
      if (field === 'disablePullRequestAutoMerge') {
        fake.pr.auto_merge = null
        fake.afterDisable?.(fake)
      } else fake.pr.auto_merge = fake.armedAs(variables.commitHeadline, variables.commitBody)
      return {
        status: 200,
        headers: {},
        json: { data: { [field]: { pullRequest: { id: 'PR_42' } } } },
      }
    }
    throw new Error(`unscripted GitHub request ${route}`)
  }
  const forge = new GitHubForge({
    transport,
    repository: 'acme/app',
    mergeabilityRetryDelaysMs: [0, 0],
    ...(config.now !== undefined ? { now: config.now } : {}),
  })
  return { forge, calls, fake, transport }
}

export const isProbe = (call: ApiCall) =>
  call.path === 'graphql' && (call.opts!.body as { query: string }).query.includes('rateLimit')
/** GraphQL mutations, excluding the availability probe. */
export const graphqlCalls = (calls: ApiCall[]) =>
  calls.filter((call) => call.path === 'graphql' && !isProbe(call))
