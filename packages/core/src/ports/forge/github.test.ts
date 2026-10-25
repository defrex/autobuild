import { temporaryDirectories as ownTempDirectories } from '../../testing/temp-directories'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  GitHubForge,
  MERGEABILITY_RETRY_DELAYS_MS,
  parseRepoCoordinates,
  rulesetsHaveMergeGate,
} from './github'
import {
  GitHubApiError,
  type GitHubRequest,
  type GitHubRequestOpts,
  type GitHubResponse,
} from './github-transport'

const mkdtemp = ownTempDirectories(afterEach)

interface ApiCall {
  method: string
  path: string
  opts?: GitHubRequestOpts
}

interface Scripted {
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
function makeTransport(responses: (Scripted | GitHubResponse)[] = []) {
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
 * never touches git). Retry delays are zero so no test sleeps; pass a longer
 * all-zero schedule to exercise the extended UNKNOWN re-query budget. */
function makeForge(
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

const paths = (calls: ApiCall[]): string[] => calls.map((call) => `${call.method} ${call.path}`)

const PR_REF = {
  number: 123,
  html_url: 'https://github.com/acme/app/pull/123',
  head: { sha: 'abc123def', ref: 'ab/fix-login' },
  base: { ref: 'main' },
}

describe('GitHubForge.pushBranch', () => {
  test('publishes a frozen SHA and independently confirms it before refreshing the cache', async () => {
    const calls: string[][] = []
    const sha = 'a'.repeat(40)
    let remote = ''
    const forge = new GitHubForge({
      exec: async (cmd) => {
        calls.push(cmd)
        if (cmd[1] === 'push') remote = `${sha}\trefs/heads/ab/fix-login\n`
        return { stdout: cmd[1] === 'ls-remote' ? remote : '', stderr: '', exitCode: 0 }
      },
    })
    await forge.pushBranch('/ws', 'ab/fix-login', sha)
    expect(calls.map((c) => c[1])).toEqual([
      'ls-remote',
      'push',
      'ls-remote',
      'cat-file',
      'update-ref',
    ])
    expect(calls[1]).toEqual(['git', 'push', 'origin', `${sha}:refs/heads/ab/fix-login`])
    expect(calls.at(-1)).toEqual(['git', 'update-ref', 'refs/heads/ab/fix-login', sha])
  })

  test('a failed push requires confirmation and surfaces its diagnostic', async () => {
    const forge = new GitHubForge({
      exec: async (cmd) => ({
        stdout: '',
        stderr: 'non-fast-forward',
        exitCode: cmd[1] === 'push' ? 1 : 0,
      }),
    })
    await expect(forge.pushBranch('/ws', 'ab/fix-login', 'a'.repeat(40))).rejects.toThrow(
      'non-fast-forward',
    )
  })
})

describe('GitHubForge.openPr', () => {
  const opts = {
    workspacePath: '/ws/build-1',
    head: 'ab/fix-login',
    base: 'main',
    title: 'Fix login',
    body: 'Line one\n\n"quoted" `backticks` $VARS\n',
  }

  test('probes by head, then creates with the body inline', async () => {
    const { forge, calls } = makeForge([{ json: [] }, { json: PR_REF }])
    await forge.openPr(opts)
    expect(calls[0]).toEqual({
      method: 'GET',
      path: 'repos/acme/app/pulls?head=acme%3Aab%2Ffix-login&base=main&state=open',
    })
    expect(calls[1]).toEqual({
      method: 'POST',
      path: 'repos/acme/app/pulls',
      opts: {
        body: { title: 'Fix login', head: 'ab/fix-login', base: 'main', body: opts.body },
      },
    })
  })

  test('adopts an existing open PR for the head branch instead of creating (§8.7 crash path)', async () => {
    const { forge, calls } = makeForge([{ json: [PR_REF] }])
    expect(await forge.openPr(opts)).toEqual({
      number: 123,
      url: 'https://github.com/acme/app/pull/123',
      headSha: 'abc123def',
    })
    expect(calls).toHaveLength(1)
  })

  test('a malformed probe result throws rather than blindly creating', async () => {
    const { forge } = makeForge([{ json: { surprise: true } }])
    await expect(forge.openPr(opts)).rejects.toThrow('unexpected GitHub response')
  })

  test('a create failure surfaces the API message', async () => {
    const { forge } = makeForge([
      { json: [] },
      { status: 422, json: { message: 'A pull request already exists' } },
      { json: [] },
    ])
    await expect(forge.openPr(opts)).rejects.toThrow('A pull request already exists')
  })
})

describe('GitHubForge.getPrState', () => {
  const stateJson = (
    state: string,
    mergeable: boolean | null = null,
    merge_commit_sha: string | null = null,
    merged = false,
  ) => ({ state, mergeable, merge_commit_sha, merged })

  test('polls one REST PR read', async () => {
    const { forge, calls } = makeForge([{ json: stateJson('closed') }])
    await forge.getPrState('/ws/build-1', 42)
    expect(calls).toEqual([{ method: 'GET', path: 'repos/acme/app/pulls/42' }])
  })

  test('OPEN + mergeable true/false/null map straight through', async () => {
    for (const mergeable of [true, false, null] as const) {
      const { forge } = makeForge([{ json: stateJson('open', mergeable) }])
      expect(await forge.getPrState('/ws/build-1', 42)).toEqual({
        state: 'open',
        mergeable,
      })
    }
  })

  test('merged → merged with the squash-commit sha', async () => {
    const { forge } = makeForge([{ json: stateJson('closed', null, 'squash-sha-99', true) }])
    expect(await forge.getPrState('/ws/build-1', 42)).toEqual({
      state: 'merged',
      sha: 'squash-sha-99',
    })
  })

  test('merged without a merge_commit_sha throws', async () => {
    const { forge } = makeForge([{ json: stateJson('closed', null, null, true) }])
    await expect(forge.getPrState('/ws/build-1', 42)).rejects.toThrow(
      'merged with no merge_commit_sha',
    )
  })

  test('closed → closed', async () => {
    const { forge } = makeForge([{ json: stateJson('closed') }])
    expect(await forge.getPrState('/ws/build-1', 42)).toEqual({ state: 'closed' })
  })

  test('a malformed state value throws rather than misreporting', async () => {
    const { forge } = makeForge([{ json: { state: 'DRAFT', merged: false } }])
    await expect(forge.getPrState('/ws/build-1', 42)).rejects.toThrow('unexpected GitHub response')
  })

  test('a 404 surfaces the API message', async () => {
    const { forge } = makeForge([{ status: 404, json: { message: 'Not Found' } }])
    await expect(forge.getPrState('/ws/build-1', 42)).rejects.toThrow('Not Found')
  })

  test.each([true, false])(
    'ordinary PR read exposes native auto-merge (%s), including ETag reuse',
    async (enabled) => {
      const { forge, calls } = makeForge([
        {
          json: { ...stateJson('open', true), auto_merge: enabled ? {} : null },
          headers: { etag: '"native"' },
        },
        { status: 304 },
      ])
      for (let poll = 0; poll < 2; poll++)
        expect(await forge.getPrState('/ws', 42)).toEqual({
          state: 'open',
          mergeable: true,
          nativeAutoMerge: enabled,
        })
      expect(calls).toHaveLength(2)
      expect(
        calls.every((call) => call.method === 'GET' && call.path === 'repos/acme/app/pulls/42'),
      ).toBe(true)
    },
  )

  test('a cached ETag revalidates: 304 returns the previous poll result unchanged', async () => {
    const { forge, calls } = makeForge([
      { json: stateJson('open', true), headers: { etag: '"etag-1"' } },
      { status: 304 },
    ])
    expect(await forge.getPrState('/ws/build-1', 42)).toEqual({ state: 'open', mergeable: true })
    expect(await forge.getPrState('/ws/build-1', 42)).toEqual({ state: 'open', mergeable: true })
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual({ method: 'GET', path: 'repos/acme/app/pulls/42' })
    expect(calls[1]).toEqual({
      method: 'GET',
      path: 'repos/acme/app/pulls/42',
      opts: { headers: { 'If-None-Match': '"etag-1"' } },
    })
  })

  test('a 200 refreshes the cached ETag and the next poll revalidates with the new one', async () => {
    const { forge, calls } = makeForge([
      { json: stateJson('open', true), headers: { etag: '"etag-1"' } },
      { json: stateJson('closed'), headers: { etag: '"etag-2"' } },
      { status: 304 },
    ])
    expect(await forge.getPrState('/ws/build-1', 42)).toEqual({ state: 'open', mergeable: true })
    expect(await forge.getPrState('/ws/build-1', 42)).toEqual({ state: 'closed' })
    expect(await forge.getPrState('/ws/build-1', 42)).toEqual({ state: 'closed' })
    expect(calls[2]?.opts).toEqual({ headers: { 'If-None-Match': '"etag-2"' } })
  })

  test('a 200 without an ETag header never sends a conditional header', async () => {
    const { forge, calls } = makeForge([
      { json: stateJson('open', true) },
      { json: stateJson('open', false) },
    ])
    expect(await forge.getPrState('/ws/build-1', 42)).toEqual({ state: 'open', mergeable: true })
    expect(await forge.getPrState('/ws/build-1', 42)).toEqual({ state: 'open', mergeable: false })
    expect(calls[0]?.opts).toBeUndefined()
    expect(calls[1]?.opts).toBeUndefined()
  })

  test('a 304 on a cached terminal merged result returns it exactly and retains the entry', async () => {
    const { forge, calls } = makeForge([
      { json: stateJson('closed', null, 'squash-sha-99', true), headers: { etag: '"etag-m"' } },
      { status: 304 },
      { status: 304 },
    ])
    expect(await forge.getPrState('/ws/build-1', 42)).toEqual({
      state: 'merged',
      sha: 'squash-sha-99',
    })
    expect(await forge.getPrState('/ws/build-1', 42)).toEqual({
      state: 'merged',
      sha: 'squash-sha-99',
    })
    expect(await forge.getPrState('/ws/build-1', 42)).toEqual({
      state: 'merged',
      sha: 'squash-sha-99',
    })
    expect(calls[1]?.opts).toEqual({ headers: { 'If-None-Match': '"etag-m"' } })
    expect(calls[2]?.opts).toEqual({ headers: { 'If-None-Match': '"etag-m"' } })
  })

  test('a terminal 200 with an ETag refreshes the cached entry like any other 200', async () => {
    const { forge, calls } = makeForge([
      { json: stateJson('open', true), headers: { etag: '"etag-open"' } },
      { json: stateJson('closed', null, 'squash-sha-1', true), headers: { etag: '"etag-merged"' } },
      { status: 304 },
    ])
    expect(await forge.getPrState('/ws/build-1', 42)).toEqual({ state: 'open', mergeable: true })
    expect(await forge.getPrState('/ws/build-1', 42)).toEqual({
      state: 'merged',
      sha: 'squash-sha-1',
    })
    expect(await forge.getPrState('/ws/build-1', 42)).toEqual({
      state: 'merged',
      sha: 'squash-sha-1',
    })
    expect(calls[2]?.opts).toEqual({ headers: { 'If-None-Match': '"etag-merged"' } })
  })

  test('past the capacity cap the oldest-inserted PR is evicted and polls unconditionally', async () => {
    const responses: Scripted[] = []
    for (let n = 1; n <= 513; n++) {
      responses.push({ json: stateJson('open', true), headers: { etag: `"etag-${n}"` } })
    }
    responses.push({ status: 304 }) // re-poll of PR 513 after the eviction
    const { forge, calls } = makeForge(responses)
    for (let n = 1; n <= 513; n++) {
      expect(await forge.getPrState('/ws/build-1', n)).toEqual({ state: 'open', mergeable: true })
    }
    // PR 1 was the oldest entry; inserting #513 evicted it, so its re-poll is
    // an ordinary unconditional poll.
    const evicted = calls.filter((call) => call.path === 'repos/acme/app/pulls/1')
    expect(evicted).toHaveLength(1)
    expect(evicted[0]?.opts).toBeUndefined()
    // The most recent entry survives and still revalidates.
    expect(await forge.getPrState('/ws/build-1', 513)).toEqual({ state: 'open', mergeable: true })
    expect(calls.at(-1)?.opts).toEqual({ headers: { 'If-None-Match': '"etag-513"' } })
  })

  test('PRs cache independently: alternating polls never send each other\u2019s ETags', async () => {
    const { forge, calls } = makeForge([
      { json: stateJson('open', true), headers: { etag: '"etag-a"' } },
      { json: stateJson('open', false), headers: { etag: '"etag-b"' } },
      { status: 304 },
      { status: 304 },
    ])
    await forge.getPrState('/ws/build-1', 1)
    await forge.getPrState('/ws/build-1', 2)
    await forge.getPrState('/ws/build-1', 1)
    await forge.getPrState('/ws/build-1', 2)
    expect(calls.map((call) => call.opts)).toEqual([
      undefined,
      undefined,
      { headers: { 'If-None-Match': '"etag-a"' } },
      { headers: { 'If-None-Match': '"etag-b"' } },
    ])
  })
})

describe('GitHubForge abort cleanup', () => {
  test('closes only an open PR and confirms authoritative closed state', async () => {
    const { forge, calls } = makeForge([
      { json: { state: 'open', merged: false, mergeable: null, merge_commit_sha: null } },
      {},
      { json: { state: 'closed', merged: false, mergeable: null, merge_commit_sha: null } },
    ])
    expect(await forge.closePr('/repo', 42)).toEqual({ state: 'closed' })
    expect(paths(calls)).toEqual([
      'GET repos/acme/app/pulls/42',
      'PATCH repos/acme/app/pulls/42',
      'GET repos/acme/app/pulls/42',
    ])
  })

  test('preserves a merge that races a failed close', async () => {
    const { forge } = makeForge([
      { json: { state: 'open', merged: false, mergeable: null, merge_commit_sha: null } },
      { status: 422, json: { message: 'PR already merged' } },
      { json: { state: 'closed', merged: true, mergeable: null, merge_commit_sha: 'landing' } },
    ])
    expect(await forge.closePr('/repo', 42)).toEqual({ state: 'merged', sha: 'landing' })
  })

  test('closePr re-reads through the ETag cache: 304 before the mutation, 200 after it', async () => {
    const { forge, calls } = makeForge([
      // Seeding poll: open, cached under "etag-before".
      {
        json: { state: 'open', merged: false, mergeable: null, merge_commit_sha: null },
        headers: { etag: '"etag-before"' },
      },
      // closePr's `before` read revalidates: still open, so 304 reuses the cache.
      { status: 304 },
      // The close mutation.
      {},
      // Mutation invalidates the validator before acknowledgement; a fresh
      // 200 reports closed and refreshes the entry.
      {
        json: { state: 'closed', merged: false, mergeable: null, merge_commit_sha: null },
        headers: { etag: '"etag-after"' },
      },
      // A follow-up poll revalidates with the refreshed ETag.
      { status: 304 },
    ])
    expect(await forge.getPrState('/repo', 42)).toEqual({ state: 'open', mergeable: null })
    expect(await forge.closePr('/repo', 42)).toEqual({ state: 'closed' })
    expect(paths(calls)).toEqual([
      'GET repos/acme/app/pulls/42',
      'GET repos/acme/app/pulls/42',
      'PATCH repos/acme/app/pulls/42',
      'GET repos/acme/app/pulls/42',
    ])
    expect(calls[0]?.opts).toBeUndefined()
    expect(calls[1]?.opts).toEqual({ headers: { 'If-None-Match': '"etag-before"' } })
    expect(calls[3]?.opts).toBeUndefined()
    expect(await forge.getPrState('/repo', 42)).toEqual({ state: 'closed' })
    expect(calls.at(-1)?.opts).toEqual({ headers: { 'If-None-Match': '"etag-after"' } })
  })

  test('deletes an existing exact branch and treats a missing branch as clean', async () => {
    const existing = makeForge([{}, {}])
    await existing.forge.deleteBranch('/repo', 'ab/work')
    expect(paths(existing.calls)).toEqual([
      'GET repos/acme/app/git/ref/heads/ab%2Fwork',
      'DELETE repos/acme/app/git/refs/heads/ab/work',
    ])

    const missing = makeForge([{ status: 404, json: { message: 'Not Found' } }])
    await missing.forge.deleteBranch('/repo', 'ab/work')
    expect(missing.calls).toHaveLength(1)

    const probeError = makeForge([{ status: 500, json: { message: 'boom' } }])
    await expect(probeError.forge.deleteBranch('/repo', 'ab/work')).rejects.toThrow('boom')
    expect(probeError.calls).toHaveLength(1)
  })

  test('rejects an invalid branch name before any API call', async () => {
    for (const invalid of ['../escape', 'a b', '-flag', 'ends.lock', 'x@{y', 'double//slash']) {
      const { forge, calls } = makeForge()
      await expect(forge.deleteBranch('/repo', invalid)).rejects.toThrow('rejected invalid ref')
      expect(calls).toHaveLength(0)
    }
  })
})

describe('rulesetsHaveMergeGate', () => {
  const pullRequestParameters = {
    required_approving_review_count: 0,
    dismiss_stale_reviews_on_push: false,
    require_code_owner_review: false,
    require_last_push_approval: false,
    required_review_thread_resolution: false,
  }

  test('known structural rules and a zero-requirement pull-request rule are not gates', () => {
    expect(
      rulesetsHaveMergeGate([
        { type: 'required_linear_history' },
        { type: 'non_fast_forward' },
        { type: 'pull_request', parameters: pullRequestParameters },
      ]),
    ).toBe(false)
  })

  test('every supported waiting-rule family is recognized as a gate', () => {
    const rules = [
      { type: 'merge_queue', parameters: {} },
      { type: 'required_signatures' },
      {
        type: 'required_status_checks',
        parameters: { required_status_checks: [{ context: 'ci' }] },
      },
      {
        type: 'required_deployments',
        parameters: { required_deployment_environments: ['production'] },
      },
      { type: 'workflows', parameters: { workflows: [{ path: 'ci.yml' }] } },
      {
        type: 'code_scanning',
        parameters: { code_scanning_tools: [{ tool: 'CodeQL' }] },
      },
      {
        type: 'pull_request',
        parameters: {
          ...pullRequestParameters,
          required_review_thread_resolution: true,
        },
      },
    ]
    expect(rulesetsHaveMergeGate(rules)).toBe(true)
  })
})

describe('GitHubForge.setAutoMerge', () => {
  const NODE_ID = 'PR_kwDOABC123'
  const prView = (mergeableState = 'clean', autoMerge: Record<string, unknown> | null = null) => ({
    json: {
      node_id: NODE_ID,
      auto_merge: autoMerge,
      mergeable_state: mergeableState,
      head: { ref: 'ab/fix-login', sha: 'head-42' },
      base: { ref: 'main' },
    },
  })
  const nativeState = (enabled: boolean) => ({
    json: {
      node_id: NODE_ID,
      auto_merge: enabled ? { merge_method: 'squash' } : null,
    },
  })
  /** Successful GraphQL mutation envelope (the mutated PR's node id back). */
  const graphqlApplied = (field: string) => ({
    json: { data: { [field]: { pullRequest: { id: NODE_ID } } } },
  })
  const graphqlFailed = (message: string) => ({
    json: { data: null, errors: [{ message }] },
  })
  const enableMutation = (calls: ApiCall[]): ApiCall | undefined =>
    calls.find(
      (call) =>
        call.method === 'POST' &&
        call.path === 'graphql' &&
        JSON.stringify(call.opts?.body).includes('enablePullRequestAutoMerge'),
    )
  const disableMutation = (calls: ApiCall[]): ApiCall | undefined =>
    calls.find(
      (call) =>
        call.method === 'POST' &&
        call.path === 'graphql' &&
        JSON.stringify(call.opts?.body).includes('disablePullRequestAutoMerge'),
    )
  const branchWith = (protection: unknown) => ({ json: { protection } })
  const fullProtection = {
    required_status_checks: null,
    required_pull_request_reviews: null,
    restrictions: null,
  }
  const ruleset = (rules: unknown[]) => ({ json: rules })
  const repositoryAutoMerge = (enabled: boolean) => ({ json: { allow_auto_merge: enabled } })

  test('clean plus a real gate uses native squash auto-merge', async () => {
    const { forge, calls } = makeForge([
      prView('clean'),
      branchWith({
        ...fullProtection,
        required_status_checks: { checks: [{ context: 'ci' }], contexts: [] },
      }),
      ruleset([]),
      repositoryAutoMerge(true),
      graphqlApplied('enablePullRequestAutoMerge'),
      nativeState(true),
    ])
    expect(await forge.setAutoMerge('/ws/build-1', 42, true)).toEqual({ kind: 'applied' })
    expect(paths(calls)).toEqual([
      'GET repos/acme/app/pulls/42',
      'GET repos/acme/app/branches/main',
      'GET repos/acme/app/rules/branches/main',
      'GET repos/acme/app',
      'POST graphql',
      'GET repos/acme/app/pulls/42',
    ])
    // Native auto-merge exists only in GitHub's GraphQL schema — the REST
    // pulls/{n}/auto-merge routes 404 — so the mutation must be the
    // enablePullRequestAutoMerge mutation with squash and the PR's node id.
    const mutation = enableMutation(calls)
    expect(mutation).toBeDefined()
    const body = mutation!.opts?.body as { query: string; variables: Record<string, unknown> }
    expect(body.query).toContain('enablePullRequestAutoMerge')
    expect(body.variables).toEqual({ pullRequestId: NODE_ID, mergeMethod: 'SQUASH' })
    expect(calls.some((call) => call.path.endsWith('/auto-merge'))).toBe(false)
  })

  test('a ruleset gate also retains native ownership', async () => {
    const { forge, calls } = makeForge([
      prView(),
      branchWith(fullProtection),
      ruleset([
        {
          type: 'required_status_checks',
          ruleset_source_type: 'Organization',
          parameters: { required_status_checks: [{ context: 'ci' }] },
        },
      ]),
      repositoryAutoMerge(true),
      graphqlApplied('enablePullRequestAutoMerge'),
      nativeState(true),
    ])
    expect(await forge.setAutoMerge('/ws/build-1', 42, true)).toEqual({ kind: 'applied' })
    expect(calls.at(-2)!.method).toBe('POST')
    expect(calls.at(-2)!.path).toBe('graphql')
  })

  test('a classic response lacking required_pull_request_reviews with a checks gate applies native auto-merge', async () => {
    // The evidence signature from PRs #308–#311: the aggregate branch-protection
    // response omits the reviews subsection entirely while a status-checks
    // requirement is present. Presence proof from the subsection that IS
    // rendered routes to native auto-merge instead of a generic deferral.
    const { forge, calls } = makeForge([
      prView(),
      branchWith({
        required_status_checks: { checks: [{ context: 'ci' }], contexts: [] },
        restrictions: null,
        // required_pull_request_reviews omitted entirely.
      }),
      ruleset([]),
      repositoryAutoMerge(true),
      graphqlApplied('enablePullRequestAutoMerge'),
      nativeState(true),
    ])
    expect(await forge.setAutoMerge('/ws/build-1', 42, true)).toEqual({ kind: 'applied' })
    expect(enableMutation(calls)).toBeDefined()
  })

  test('a proven ruleset gate settles presence when the classic response omits the reviews subsection', async () => {
    // The four-evidence case: the repository is governed by rulesets, GitHub
    // omits the classic reviews subsection in exactly that situation, and the
    // ruleset probe — the mechanism actually in effect — finds merge-blocking
    // rules. The gate must apply native auto-merge, not defer.
    const { forge, calls } = makeForge([
      prView(),
      branchWith({
        required_status_checks: null,
        restrictions: null,
        // required_pull_request_reviews omitted entirely.
      }),
      ruleset([
        {
          type: 'required_status_checks',
          parameters: { required_status_checks: [{ context: 'ci' }] },
        },
      ]),
      repositoryAutoMerge(true),
      graphqlApplied('enablePullRequestAutoMerge'),
      nativeState(true),
    ])
    expect(await forge.setAutoMerge('/ws/build-1', 42, true)).toEqual({ kind: 'applied' })
    expect(enableMutation(calls)).toBeDefined()
  })

  test('an incomplete classic response with no ruleset gate defers with a reason naming both facts', async () => {
    const { forge } = makeForge([
      prView(),
      branchWith({
        required_status_checks: null,
        restrictions: null,
        // required_pull_request_reviews omitted entirely.
      }),
      ruleset([]),
    ])
    const result = await forge.setAutoMerge('/ws/build-1', 42, true)
    expect(result).toMatchObject({ kind: 'deferred', reason: { code: 'unproven-gate-state' } })
    if (result.kind !== 'deferred') return
    // The generic 'could not be proven' summary must not stand alone: the
    // detail names the missing subsection AND what the ruleset probe saw.
    expect(result.reason?.detail).toMatch(/required_pull_request_reviews missing from response/)
    expect(result.reason?.detail).toContain("branch 'main' found no merge-blocking rules")
  })

  test('a classic response with only a rendered checks subsection proves gate presence', async () => {
    // Presence proof from one rendered subsection must not require the other
    // subsections to exist: reviews and restrictions are omitted entirely.
    const { forge } = makeForge([
      prView(),
      branchWith({
        required_status_checks: { checks: [{ context: 'ci' }], contexts: [] },
      }),
      ruleset([]),
      repositoryAutoMerge(true),
      graphqlApplied('enablePullRequestAutoMerge'),
      nativeState(true),
    ])
    expect(await forge.setAutoMerge('/ws/build-1', 42, true)).toEqual({ kind: 'applied' })
  })

  test('an unprotected branch as GitHub really renders it proves the classic gate absent', async () => {
    // GET /branches/{b} on an unprotected branch does not carry `protection: null`;
    // it carries `protected: false` plus a stub protection object.
    const unprotected = {
      json: {
        protected: false,
        protection: {
          enabled: false,
          required_status_checks: { checks: [], contexts: [], enforcement_level: 'off' },
        },
      },
    }
    const { forge } = makeForge([prView('clean'), unprotected, ruleset([])])
    expect(await forge.setAutoMerge('/ws/build-1', 42, true)).toEqual({
      kind: 'ungated',
      headSha: 'head-42',
    })
    const stubOnly = makeForge([
      prView('clean'),
      branchWith({ enabled: false, required_status_checks: { enforcement_level: 'off' } }),
      ruleset([]),
    ])
    expect(await stubOnly.forge.setAutoMerge('/ws/build-1', 42, true)).toEqual({
      kind: 'ungated',
      headSha: 'head-42',
    })
  })

  test('clean or unstable with two successful negative probes returns a guarded direct candidate', async () => {
    for (const state of ['clean', 'unstable'] as const) {
      const { forge, calls } = makeForge([prView(state), branchWith(fullProtection), ruleset([])])
      expect(await forge.setAutoMerge('/ws/build-1', 42, true)).toEqual({
        kind: 'ungated',
        headSha: 'head-42',
      })
      expect(calls.some((call) => call.path.includes('/merge') || call.method === 'PUT')).toBe(
        false,
      )
    }
  })

  test('a DIRTY merge state defers with a conflict-naming reason whatever the gate configuration', async () => {
    // DIRTY is a persistent, definite state — GitHub has computed merge
    // conflicts — so the deferral must name the conflict and its standard
    // recovery instead of the generic unproven-gate-state message. The
    // disposition is deferred for both gate configurations, so the reason
    // branch is shared; each leg proves gate presence/absence explicitly.
    // `branchWith(fullProtection)` (all three subsections null) proves classic
    // protection ABSENT via classifyClassicProtection's null fall-through,
    // combined with `ruleset([])` finding no merge-blocking rules.
    const conflictDetail = (baseRef: string) =>
      `GitHub reports mergeable_state 'DIRTY' for PR #42 — the head branch has ` +
      `merge conflicts with '${baseRef}'; update the branch or resolve the conflicts ` +
      'and the pending consent will be re-examined on a later tick. ' +
      'Native auto-merge was not enabled'
    const expectConflictDeferral = async (
      forge: GitHubForge,
      calls: ApiCall[],
      baseRef = 'main',
    ) => {
      const result = await forge.setAutoMerge('/ws/build-1', 42, true)
      expect(result).toEqual({
        kind: 'deferred',
        reason: { code: 'merge-conflicts', detail: conflictDetail(baseRef) },
      })
      // The deferral happens before any repository read or native mutation.
      expect(calls.some((call) => call.path === 'GET repos/acme/app')).toBe(false)
      expect(enableMutation(calls)).toBeUndefined()
    }

    // Gate absent (classic probe negative, no merge-blocking ruleset).
    const absent = makeForge([prView('dirty'), branchWith(fullProtection), ruleset([])])
    await expectConflictDeferral(absent.forge, absent.calls)

    // Gate present, proved by a non-null classic required_status_checks
    // subsection (the same shape the clean-gated native test uses).
    const classicPresent = makeForge([
      prView('dirty'),
      branchWith({
        ...fullProtection,
        required_status_checks: { checks: [{ context: 'ci' }], contexts: [] },
      }),
      ruleset([]),
    ])
    await expectConflictDeferral(classicPresent.forge, classicPresent.calls)

    // Gate present, proved through the ruleset probe (the same merge-blocking
    // ruleset shape the ruleset-gate native test uses).
    const rulesetPresent = makeForge([
      prView('dirty'),
      branchWith(fullProtection),
      ruleset([
        {
          type: 'required_status_checks',
          ruleset_source_type: 'Organization',
          parameters: { required_status_checks: [{ context: 'ci' }] },
        },
      ]),
    ])
    await expectConflictDeferral(rulesetPresent.forge, rulesetPresent.calls)

    // The contrast stays pinned: an unexplained BLOCKED still lands in the
    // generic unproven-gate-state family — only DIRTY got its own.
    const blocked = makeForge([prView('blocked'), branchWith(fullProtection), ruleset([])])
    expect(await blocked.forge.setAutoMerge('/ws/build-1', 42, true)).toMatchObject({
      kind: 'deferred',
      reason: { code: 'unproven-gate-state', detail: expect.stringContaining('BLOCKED') },
    })
  })

  test('ungated UNKNOWN re-queries mergeability, then defers with a transient-flavored reason', async () => {
    // mergeable_state 'unknown' means GitHub is still computing mergeability —
    // typically transient just after required checks finish. The gate waits
    // (bounded) and re-queries before concluding; when the state never
    // resolves, the deferral names the transient computation and retry count
    // instead of a generic unproven gate state.
    const { forge, calls } = makeForge([
      prView('unknown'),
      prView('unknown'),
      prView('unknown'),
      branchWith(fullProtection),
      ruleset([]),
    ])
    const result = await forge.setAutoMerge('/ws/build-1', 42, true)
    expect(result).toMatchObject({
      kind: 'deferred',
      reason: { code: 'mergeability-uncomputed' },
    })
    if (result.kind !== 'deferred') return
    expect(result.reason?.detail).toContain('still being computed')
    expect(result.reason?.detail).toContain('2 re-queries')
    expect(result.reason?.detail).toContain('PR #42')
    // Exactly the bounded reads: first inspection plus two re-queries, then
    // the usual one-pass gate probe (no probe duplication per re-query).
    expect(paths(calls).filter((path) => path === 'GET repos/acme/app/pulls/42')).toHaveLength(3)
    expect(paths(calls).filter((path) => path === 'GET repos/acme/app/branches/main')).toHaveLength(
      1,
    )
  })

  test('ungated UNKNOWN that resolves inside the retry window becomes a direct candidate', async () => {
    const { forge, calls } = makeForge([
      prView('unknown'),
      prView('clean'),
      branchWith(fullProtection),
      ruleset([]),
    ])
    expect(await forge.setAutoMerge('/ws/build-1', 42, true)).toEqual({
      kind: 'ungated',
      headSha: 'head-42',
    })
    expect(paths(calls).filter((path) => path === 'GET repos/acme/app/pulls/42')).toHaveLength(2)
    expect(paths(calls).filter((path) => path === 'GET repos/acme/app/branches/main')).toHaveLength(
      1,
    )
  })

  test('gated UNKNOWN that resolves inside the retry window enables native auto-merge', async () => {
    const { forge } = makeForge([
      prView('unknown'),
      prView('clean'),
      branchWith({
        ...fullProtection,
        required_status_checks: { checks: [{ context: 'ci' }], contexts: [] },
      }),
      ruleset([]),
      repositoryAutoMerge(true),
      graphqlApplied('enablePullRequestAutoMerge'),
      nativeState(true),
    ])
    expect(await forge.setAutoMerge('/ws/build-1', 42, true)).toEqual({ kind: 'applied' })
  })

  test('gated UNKNOWN that persists keeps its existing native-auto-merge classification', async () => {
    // Bounded re-queries exhaust with the state still UNKNOWN; a proved gate
    // makes UNKNOWN route to native exactly as before the re-query existed.
    const { forge, calls } = makeForge([
      prView('unknown'),
      prView('unknown'),
      prView('unknown'),
      branchWith({
        ...fullProtection,
        required_status_checks: { checks: [{ context: 'ci' }], contexts: [] },
      }),
      ruleset([]),
      repositoryAutoMerge(true),
      graphqlApplied('enablePullRequestAutoMerge'),
      nativeState(true),
    ])
    expect(await forge.setAutoMerge('/ws/build-1', 42, true)).toEqual({ kind: 'applied' })
    // Three inspection reads plus the post-mutation native confirmation read.
    expect(paths(calls).filter((path) => path === 'GET repos/acme/app/pulls/42')).toHaveLength(4)
  })

  test('native auto-merge appearing on a re-read is adopted without a mutation', async () => {
    // Another actor enabled native auto-merge while the gate was waiting out
    // the UNKNOWN computation: the idempotent auto_merge hit returns applied
    // with no enable mutation of our own.
    const { forge, calls } = makeForge([
      prView('unknown'),
      prView('clean', { mergeMethod: 'SQUASH' }),
    ])
    expect(await forge.setAutoMerge('/ws/build-1', 42, true)).toEqual({ kind: 'applied' })
    expect(calls.some((call) => call.path === 'graphql')).toBe(false)
  })

  test('the default re-query schedule is the extended 7-step ~30 s budget', () => {
    // AUT-392: the schedule exists as a named constant so retuning it is a
    // deliberate diff. More entries than the pre-AUT-392 two-step budget,
    // every wait positive (real backoff, no hot-loop), nondecreasing, and
    // exactly the documented ~30 s total.
    expect(MERGEABILITY_RETRY_DELAYS_MS.length).toBeGreaterThan(2)
    for (const delay of MERGEABILITY_RETRY_DELAYS_MS) expect(delay).toBeGreaterThan(0)
    expect([...MERGEABILITY_RETRY_DELAYS_MS].sort((a, b) => a - b)).toEqual([
      ...MERGEABILITY_RETRY_DELAYS_MS,
    ])
    expect(MERGEABILITY_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0)).toBe(30000)
  })

  test('extended-budget exhaustion defers with the transient-flavored reason after 7 re-queries', async () => {
    // The AUT-392 sizing: seven re-queries (plus the initial read = eight PR
    // reads) all still UNKNOWN, an ungated PR, so the bounded budget exhausts
    // and the deferral keeps the AUT-329 transient wording, now naming the
    // larger retry count. The gate probe still runs exactly once, after
    // settling — the re-query loop never duplicates it.
    const { forge, calls } = makeForge(
      [
        prView('unknown'),
        prView('unknown'),
        prView('unknown'),
        prView('unknown'),
        prView('unknown'),
        prView('unknown'),
        prView('unknown'),
        prView('unknown'),
        branchWith(fullProtection),
        ruleset([]),
      ],
      [0, 0, 0, 0, 0, 0, 0],
    )
    const result = await forge.setAutoMerge('/ws/build-1', 42, true)
    expect(result).toMatchObject({
      kind: 'deferred',
      reason: { code: 'mergeability-uncomputed' },
    })
    if (result.kind !== 'deferred') return
    expect(result.reason?.detail).toContain('still being computed')
    expect(result.reason?.detail).toContain('7 re-queries')
    expect(result.reason?.detail).toContain('over 0 ms')
    expect(result.reason?.detail).toContain('PR #42')
    expect(paths(calls).filter((path) => path === 'GET repos/acme/app/pulls/42')).toHaveLength(8)
    expect(paths(calls).filter((path) => path === 'GET repos/acme/app/branches/main')).toHaveLength(
      1,
    )
  })

  test('gated UNKNOWN resolving at the last extended slot applies consent inside the same tick', async () => {
    // Mergeability stays UNKNOWN through every re-query but the final one:
    // the eighth read is clean, so the gate applies native auto-merge in the
    // same tick instead of deferring. Eight inspection reads plus the
    // post-mutation native confirmation read.
    const { forge, calls } = makeForge(
      [
        prView('unknown'),
        prView('unknown'),
        prView('unknown'),
        prView('unknown'),
        prView('unknown'),
        prView('unknown'),
        prView('unknown'),
        prView('clean'),
        branchWith({
          ...fullProtection,
          required_status_checks: { checks: [{ context: 'ci' }], contexts: [] },
        }),
        ruleset([]),
        repositoryAutoMerge(true),
        graphqlApplied('enablePullRequestAutoMerge'),
        nativeState(true),
      ],
      [0, 0, 0, 0, 0, 0, 0],
    )
    expect(await forge.setAutoMerge('/ws/build-1', 42, true)).toEqual({ kind: 'applied' })
    expect(paths(calls).filter((path) => path === 'GET repos/acme/app/pulls/42')).toHaveLength(9)
  })

  test('ungated UNKNOWN resolving at the last extended slot becomes a direct candidate', async () => {
    // The ungated companion: the same late resolution routes to the direct
    // squash candidate instead of the mergeability-uncomputed deferral.
    const { forge, calls } = makeForge(
      [
        prView('unknown'),
        prView('unknown'),
        prView('unknown'),
        prView('unknown'),
        prView('unknown'),
        prView('unknown'),
        prView('unknown'),
        prView('clean'),
        branchWith(fullProtection),
        ruleset([]),
      ],
      [0, 0, 0, 0, 0, 0, 0],
    )
    expect(await forge.setAutoMerge('/ws/build-1', 42, true)).toEqual({
      kind: 'ungated',
      headSha: 'head-42',
    })
    expect(paths(calls).filter((path) => path === 'GET repos/acme/app/pulls/42')).toHaveLength(8)
    expect(paths(calls).filter((path) => path === 'GET repos/acme/app/branches/main')).toHaveLength(
      1,
    )
  })

  test('has_hooks is never treated as ungated and delegates to native auto-merge', async () => {
    const { forge } = makeForge([
      prView('has_hooks'),
      branchWith(fullProtection),
      ruleset([]),
      repositoryAutoMerge(true),
      graphqlApplied('enablePullRequestAutoMerge'),
      nativeState(true),
    ])
    expect(await forge.setAutoMerge('/ws/build-1', 42, true)).toEqual({ kind: 'applied' })
  })

  test('an unrecognized REST mergeable_state defers instead of merging directly', async () => {
    const { forge } = makeForge([prView('future_state'), branchWith(fullProtection), ruleset([])])
    expect(await forge.setAutoMerge('/ws/build-1', 42, true)).toMatchObject({
      kind: 'deferred',
      reason: { code: 'unproven-gate-state', detail: expect.stringContaining('future_state') },
    })
  })

  test('disabling inspects only native state, so future merge-state enums cannot block cancellation', async () => {
    const { forge, calls } = makeForge([
      nativeState(true),
      graphqlApplied('disablePullRequestAutoMerge'),
      nativeState(false),
    ])
    expect(await forge.setAutoMerge('/ws/build-1', 42, false)).toEqual({ kind: 'applied' })
    expect(paths(calls)).toEqual([
      'GET repos/acme/app/pulls/42',
      'POST graphql',
      'GET repos/acme/app/pulls/42',
    ])
    const mutation = disableMutation(calls)
    expect(mutation).toBeDefined()
    const body = mutation!.opts?.body as { query: string; variables: Record<string, unknown> }
    expect(body.query).toContain('disablePullRequestAutoMerge')
    expect(body.variables).toEqual({ pullRequestId: NODE_ID })
    expect(calls.some((call) => call.path.endsWith('/auto-merge'))).toBe(false)
  })

  test('a successful mutation without matching native projection stays deferred', async () => {
    const enable = makeForge([
      prView(),
      branchWith({
        ...fullProtection,
        required_status_checks: { checks: [], contexts: [] },
      }),
      ruleset([]),
      repositoryAutoMerge(true),
      graphqlApplied('enablePullRequestAutoMerge'),
      nativeState(false),
    ])
    expect(await enable.forge.setAutoMerge('/ws/build-1', 42, true)).toMatchObject({
      kind: 'deferred',
      reason: {
        code: 'unproven-gate-state',
        detail: expect.stringContaining('follow-up native read reports auto_merge unset'),
      },
    })

    const disable = makeForge([
      nativeState(true),
      graphqlApplied('disablePullRequestAutoMerge'),
      nativeState(true),
    ])
    expect(await disable.forge.setAutoMerge('/ws/build-1', 42, false)).toEqual({ kind: 'deferred' })
  })

  test('idempotent desired state only inspects the PR', async () => {
    for (const [enabled, response] of [
      [true, prView('unknown', { mergeMethod: 'SQUASH' })],
      [false, nativeState(false)],
    ] as const) {
      const { forge, calls } = makeForge([response])
      expect(await forge.setAutoMerge('/ws/build-1', 42, enabled)).toEqual({ kind: 'applied' })
      expect(calls).toHaveLength(1)
    }
  })

  test('probe, inspection, and native mutation failures become typed fail-closed deferrals', async () => {
    const expectUnproven = async (forge: GitHubForge, detail: string) => {
      expect(await forge.setAutoMerge('/ws/build-1', 42, true)).toMatchObject({
        kind: 'deferred',
        reason: { code: 'unproven-gate-state', detail: expect.stringContaining(detail) },
      })
    }

    await expect(
      makeForge([{ status: 500, json: { message: 'network down' } }]).forge.setAutoMerge(
        '/ws',
        42,
        true,
      ),
    ).rejects.toMatchObject({ details: { kind: 'transient' } })
    await expectUnproven(
      makeForge([
        prView(),
        branchWith({
          required_status_checks: null,
          required_pull_request_reviews: null,
          // restrictions omitted entirely — auth-scoped response, unprovable.
        }),
        ruleset([]),
      ]).forge,
      'restrictions missing',
    )
    await expectUnproven(
      makeForge([
        prView(),
        branchWith({
          ...fullProtection,
          required_status_checks: { checks: [{ context: 'ci' }], contexts: [] },
        }),
        ruleset([]),
        repositoryAutoMerge(true),
        { status: 403, json: { message: 'permission denied' } },
      ]).forge,
      'permission denied',
    )
  })

  test('the exact plan-limitation response plus classic absence proves the branch ungated', async () => {
    const planLimitation = {
      status: 403,
      json: {
        message: 'Upgrade to GitHub Pro or make this repository public to enable this feature.',
        documentation_url: 'https://docs.github.com/rest/repos/rules#get-rules-for-a-branch',
      },
    }
    const direct = makeForge([prView(), branchWith(fullProtection), planLimitation])
    expect(await direct.forge.setAutoMerge('/ws/build-1', 42, true)).toEqual({
      kind: 'ungated',
      headSha: 'head-42',
    })

    const unprovedClassic = makeForge([
      prView(),
      branchWith({ required_status_checks: null }),
      planLimitation,
    ])
    expect(await unprovedClassic.forge.setAutoMerge('/ws/build-1', 42, true)).toMatchObject({
      kind: 'deferred',
      reason: { code: 'github-plan-limitation' },
    })

    for (const nearMiss of [
      { ...planLimitation, json: { message: 'Resource not accessible by integration' } },
      { status: 500, json: { message: 'Server Error' } },
    ]) {
      const generic = makeForge([prView(), branchWith(fullProtection), nearMiss])
      if (nearMiss.status === 500) {
        await expect(generic.forge.setAutoMerge('/ws/build-1', 42, true)).rejects.toMatchObject({
          details: { kind: 'transient' },
        })
        continue
      }
      expect(await generic.forge.setAutoMerge('/ws/build-1', 42, true)).toMatchObject({
        kind: 'deferred',
        reason: { code: 'unproven-gate-state' },
      })
    }
  })

  test('a GraphQL-level mutation failure is not a success: enable defers, disable throws', async () => {
    // GitHub answers HTTP 200 with an errors array when the mutation itself
    // failed (e.g. the PR is not in a mergeable state); the envelope must
    // never be read as an acknowledgement.
    const enable = makeForge([
      prView(),
      branchWith({
        ...fullProtection,
        required_status_checks: { checks: [], contexts: [] },
      }),
      ruleset([]),
      repositoryAutoMerge(true),
      graphqlFailed('Pull request is not mergeable'),
    ])
    expect(await enable.forge.setAutoMerge('/ws/build-1', 42, true)).toMatchObject({
      kind: 'deferred',
      reason: {
        code: 'unproven-gate-state',
        detail: expect.stringContaining('Pull request is not mergeable'),
      },
    })

    const disable = makeForge([nativeState(true), graphqlFailed('Bad credentials')])
    await expect(disable.forge.setAutoMerge('/ws/build-1', 42, false)).rejects.toThrow(
      'GitHub GraphQL disablePullRequestAutoMerge failed: Bad credentials',
    )
  })

  test('repository-level auto-merge disablement is classified before mutation', async () => {
    const { forge, calls } = makeForge([
      prView(),
      branchWith({
        ...fullProtection,
        required_status_checks: { checks: [], contexts: [] },
      }),
      ruleset([]),
      repositoryAutoMerge(false),
    ])
    expect(await forge.setAutoMerge('/ws/build-1', 42, true)).toEqual({
      kind: 'deferred',
      reason: {
        code: 'repository-auto-merge-disabled',
        detail: 'GitHub reports allow_auto_merge=false; the PR was left open for a human',
      },
    })
    expect(calls.some((call) => call.path.endsWith('/auto-merge'))).toBe(false)

    const malformed = makeForge([
      prView(),
      branchWith({
        ...fullProtection,
        required_status_checks: { checks: [], contexts: [] },
      }),
      ruleset([]),
      { json: { allow_auto_merge: 'yes' } },
    ])
    expect(await malformed.forge.setAutoMerge('/ws/build-1', 42, true)).toMatchObject({
      kind: 'deferred',
      reason: { code: 'unproven-gate-state', detail: expect.stringContaining('allow_auto_merge') },
    })
    expect(malformed.calls.some((call) => call.path.endsWith('/auto-merge'))).toBe(false)
  })
})

describe('GitHubForge.squashMerge', () => {
  test('uses a head-guarded normal squash with no bypass or alternate merge mode', async () => {
    const { forge, calls } = makeForge()
    await forge.squashMerge('/ws/build-1', 42, 'head-42')
    expect(calls).toEqual([
      {
        method: 'PUT',
        path: 'repos/acme/app/pulls/42/merge',
        opts: { body: { merge_method: 'squash', sha: 'head-42' } },
      },
    ])
  })

  test('a moved head (409) remains a hard error', async () => {
    const { forge } = makeForge([
      { status: 409, json: { message: 'Pull Request is not mergeable' } },
    ])
    await expect(forge.squashMerge('/ws/build-1', 42, 'stale-head')).rejects.toThrow(
      'Pull Request is not mergeable',
    )
  })
})

describe('GitHubForge.commentOnPr', () => {
  test('posts the body inline to the issue-comments endpoint', async () => {
    const { forge, calls } = makeForge()
    await forge.commentOnPr('/ws/build-1', 42, '## Summary\n\nverdicts…\n')
    expect(calls).toEqual([
      {
        method: 'POST',
        path: 'repos/acme/app/issues/42/comments',
        opts: { body: { body: '## Summary\n\nverdicts…\n' } },
      },
    ])
  })

  test('nonzero status throws with the API message', async () => {
    const { forge } = makeForge([{ status: 404, json: { message: 'Not Found' } }])
    await expect(forge.commentOnPr('/ws/build-1', 42, 'body')).rejects.toThrow('Not Found')
  })
})

describe('GitHubForge optional capabilities', () => {
  test('remoteBranchSha reads the branch endpoint', async () => {
    const { forge, calls } = makeForge([
      { json: { commit: { sha: 'basesha1' }, protection: null } },
    ])
    expect(await forge.remoteBranchSha('main')).toBe('basesha1')
    expect(calls).toEqual([{ method: 'GET', path: 'repos/acme/app/branches/main' }])
  })

  test('remoteBranchSha throws a typed 404 when the branch is absent', async () => {
    const { forge } = makeForge([{ status: 404, json: { message: 'Branch not found' } }])
    const error = await forge
      .remoteBranchSha('ab/missing')
      .then(() => null)
      .catch((e: unknown) => e as GitHubApiError)
    expect(error).toBeInstanceOf(GitHubApiError)
    expect(error?.status).toBe(404)
  })

  test('readFile fetches raw bytes, optionally at a ref', async () => {
    const { forge, calls } = makeForge([
      { bytes: new TextEncoder().encode('baseBranch = "main"\n') },
      { bytes: new TextEncoder().encode('baseBranch = "dev"\n') },
    ])
    expect(await forge.readFile('autobuild.toml')).toBe('baseBranch = "main"\n')
    expect(await forge.readFile('autobuild.toml', 'dev')).toBe('baseBranch = "dev"\n')
    expect(calls[0]).toEqual({
      method: 'GET',
      path: 'repos/acme/app/contents/autobuild.toml',
      opts: { headers: { Accept: 'application/vnd.github.raw' } },
    })
    expect(calls[1]?.opts).toEqual({
      headers: { Accept: 'application/vnd.github.raw' },
      query: { ref: 'dev' },
    })
  })

  test('readFile throws when the path is absent', async () => {
    const { forge } = makeForge([{ status: 404, json: { message: 'Not Found' } }])
    await expect(forge.readFile('autobuild.toml')).rejects.toThrow('Not Found')
  })
})

describe('GitHubForge repository coordinates', () => {
  test('parses owner/name from slugs and every remote URL spelling', () => {
    expect(parseRepoCoordinates('acme/app')).toEqual({ owner: 'acme', name: 'app' })
    expect(parseRepoCoordinates('https://github.com/acme/app')).toEqual({
      owner: 'acme',
      name: 'app',
    })
    expect(parseRepoCoordinates('https://github.com/acme/app.git')).toEqual({
      owner: 'acme',
      name: 'app',
    })
    expect(parseRepoCoordinates('git@github.com:acme/app.git')).toEqual({
      owner: 'acme',
      name: 'app',
    })
    expect(parseRepoCoordinates('ssh://git@github.com/acme/app')).toEqual({
      owner: 'acme',
      name: 'app',
    })
    expect(parseRepoCoordinates('not a repository')).toBeNull()
  })

  test('without coordinates the first API call fails with an actionable error', async () => {
    const { transport } = makeTransport()
    const forge = new GitHubForge({ transport })
    await expect(forge.getPrState('/ws', 42)).rejects.toThrow(
      'could not resolve the repository owner/name',
    )
  })

  test('AB_REPOSITORY supplies coordinates when no explicit option is given', async () => {
    const { transport, calls } = makeTransport([
      { json: [{ ...PR_REF, head: { ...PR_REF.head, ref: 'ab/x' } }] },
    ])
    const forge = new GitHubForge({ transport, env: { AB_REPOSITORY: 'other/app' } })
    await forge.openPr({
      workspacePath: '/ws',
      head: 'ab/x',
      base: 'main',
      title: 't',
      body: 'b',
    })
    expect(calls[0]?.path).toContain('repos/other/app/')
  })

  test('checkout mode resolves coordinates from the origin remote', async () => {
    const gitCalls: string[][] = []
    const { transport, calls } = makeTransport([
      { json: { state: 'closed', merged: false, mergeable: null, merge_commit_sha: null } },
    ])
    const forge = new GitHubForge({
      transport,
      repoRoot: '/repo',
      exec: async (cmd, opts) => {
        gitCalls.push([...cmd])
        expect(opts.cwd).toBe('/repo')
        return { stdout: 'git@github.com:acme/app.git\n', stderr: '', exitCode: 0 }
      },
    })
    await forge.getPrState('/ws', 42)
    expect(gitCalls).toEqual([['git', 'remote', 'get-url', 'origin']])
    expect(calls[0]?.path).toBe('repos/acme/app/pulls/42')
  })
})

describe('GitHub marked summary upsert', () => {
  const marker = '<!-- autobuild-summary:v1:6162 -->'
  const body = `${marker}\nnew summary`
  test('creates once, rediscovers with a fresh adapter, edits, and skips unchanged', async () => {
    let comments: { id: number; body: string }[] = []
    const calls: ApiCall[] = []
    const transport: GitHubRequest = async (method, path, opts) => {
      calls.push({ method, path, opts })
      if (method === 'POST') comments.push({ id: 7, body: (opts!.body as { body: string }).body })
      if (method === 'PATCH') comments[0]!.body = (opts!.body as { body: string }).body
      return { status: 200, headers: {}, json: method === 'GET' ? structuredClone(comments) : {} }
    }
    const forge = () => new GitHubForge({ transport, repository: 'acme/app' })
    await forge().commentOnPr('/ws', 42, body)
    await forge().commentOnPr('/ws', 42, `${body} changed`)
    await forge().commentOnPr('/ws', 42, `${body} changed`)
    expect(comments).toEqual([{ id: 7, body: `${body} changed` }])
    expect(paths(calls)).toEqual([
      'GET repos/acme/app/issues/42/comments',
      'POST repos/acme/app/issues/42/comments',
      'GET repos/acme/app/issues/42/comments',
      'PATCH repos/acme/app/issues/comments/7',
      'GET repos/acme/app/issues/42/comments',
    ])
    comments = []
    await forge().commentOnPr('/ws', 42, body)
    expect(comments).toHaveLength(1)
  })

  test('scans all pages before editing or creating and keeps PR/build identities isolated', async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: 'unrelated' }))
    const { forge, calls } = makeForge([
      { json: page },
      { json: [{ id: 101, body: `${marker}\nold` }] },
      {},
    ])
    await forge.commentOnPr('/ws', 42, body)
    expect(calls[1]!.opts?.query).toEqual({ per_page: '100', page: '2' })
    expect(calls[2]).toMatchObject({
      method: 'PATCH',
      path: 'repos/acme/app/issues/comments/101',
      opts: { body: { body } },
    })
    const other = makeForge([
      { json: [{ id: 1, body: '<!-- autobuild-summary:v1:6364 -->\nother' }] },
      {},
    ])
    await other.forge.commentOnPr('/ws', 43, body)
    expect(paths(other.calls)).toEqual([
      'GET repos/acme/app/issues/43/comments',
      'POST repos/acme/app/issues/43/comments',
    ])
  })

  test('deletion during PATCH triggers one rescan and confirmed recreation', async () => {
    const { forge, calls } = makeForge([
      { json: [{ id: 7, body: `${marker}\nold` }] },
      { status: 404 },
      { json: [] },
      {},
    ])
    await forge.commentOnPr('/ws', 42, body)
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PATCH', 'GET', 'POST'])
  })

  for (const scenario of [
    [{ status: 500 }],
    [{ json: [{ id: 7, body: `${marker}\nold` }] }, { status: 403 }],
    [{ json: [{ id: '7', body: `${marker}\nold` }] }],
    [{ json: [{ id: 7.5, body: `${marker}\nold` }] }],
  ])
    test('discovery and edit failures never fall through to creation', async () => {
      const { forge, calls } = makeForge(scenario)
      await expect(forge.commentOnPr('/ws', 42, body)).rejects.toThrow()
      expect(calls.some((c) => c.method === 'POST')).toBe(false)
    })

  test('ambiguous successful POST is rediscovered on the next refresh', async () => {
    let persisted: string | undefined
    const methods: string[] = []
    const transport: GitHubRequest = async (method, _path, opts) => {
      methods.push(method)
      if (method === 'POST') {
        persisted = (opts!.body as { body: string }).body
        throw new Error('connection lost after POST')
      }
      return {
        status: 200,
        headers: {},
        json: persisted === undefined ? [] : [{ id: 7, body: persisted }],
      }
    }
    await expect(
      new GitHubForge({ transport, repository: 'acme/app' }).commentOnPr('/ws', 42, body),
    ).rejects.toThrow()
    await new GitHubForge({ transport, repository: 'acme/app' }).commentOnPr('/ws', 42, body)
    expect(methods).toEqual(['GET', 'POST', 'GET'])
  })
})

describe('GitHub stable build identity', () => {
  const headline = 'Server title (#42) — unchanged'
  const body = '* unusual bullet\n\nCo-authored-by: A <a@example.test>\n'
  const canonical = `${body}Autobuild-Build: stable-build\n`
  const native = { commitHeadline: headline, commitBody: canonical, mergeMethod: 'SQUASH' }
  const message = (
    overrides: Record<string, unknown> = {},
    queue: { id: string } | null = null,
  ) => ({
    json: {
      data: {
        repository: {
          defaultBranchRef: { name: 'main' },
          mergeQueue: queue,
          pullRequest: {
            baseRefName: 'main',
            id: 'PR_42',
            headRefOid: 'head-42',
            state: 'OPEN',
            viewerMergeHeadlineText: headline,
            viewerMergeBodyText: body,
            autoMergeRequest: null,
            ...overrides,
          },
        },
      },
    },
  })
  const inspect = (enabled = true) => ({
    json: {
      node_id: 'PR_42',
      auto_merge: enabled ? {} : null,
      mergeable_state: 'clean',
      head: { ref: 'feature', sha: 'head-42' },
      base: { ref: 'main' },
    },
  })
  const gates = [
    { json: { protected: false } },
    { json: [{ type: 'required_signatures' }] },
    { json: { allow_auto_merge: true } },
  ]
  const applied = (name: string) => ({
    json: { data: { [name]: { pullRequest: { id: 'PR_42' } } } },
  })
  const mutations = (calls: ApiCall[]) =>
    calls.filter((c) => String((c.opts?.body as { query?: string })?.query).includes('mutation'))

  test.each([body, ''])(
    'direct squash preserves server headline/body with body %j',
    async (serverBody) => {
      const { forge, calls } = makeForge([message({ viewerMergeBodyText: serverBody }), {}])
      await forge.squashMerge('/missing-checkout', 42, 'head-42', { buildSlug: 'stable-build' })
      expect(calls[0]?.path).toBe('graphql')
      expect((calls[0]!.opts!.body as { query: string }).query).toContain(
        'viewerMergeHeadlineText(mergeType: SQUASH)',
      )
      expect(calls[1]?.opts?.body).toEqual({
        merge_method: 'squash',
        sha: 'head-42',
        commit_title: headline,
        commit_message: serverBody === '' ? 'Autobuild-Build: stable-build\n' : canonical,
      })
    },
  )
  test('direct head mismatch or invalid defaults never attempts a merge', async () => {
    for (const response of [
      message({ headRefOid: 'new-head' }),
      message({ viewerMergeBodyText: null }),
    ]) {
      const { forge, calls } = makeForge([response])
      await expect(
        forge.squashMerge('/absent', 42, 'head-42', { buildSlug: 'stable-build' }),
      ).rejects.toThrow()
      expect(calls).toHaveLength(1)
    }
  })
  test('native enable uses guarded typed message overrides and independently confirms them', async () => {
    const { forge, calls } = makeForge([
      message(),
      inspect(false),
      ...gates,
      applied('enablePullRequestAutoMerge'),
      message({ autoMergeRequest: native }),
    ])
    expect(await forge.setAutoMerge('/absent', 42, true, { buildSlug: 'stable-build' })).toEqual({
      kind: 'applied',
    })
    const mutation = mutations(calls)[0]?.opts?.body as { query: string; variables: unknown }
    expect(mutation.query).toContain('$expectedHeadOid: GitObjectID!')
    expect(mutation.query).toContain('$mergeMethod: PullRequestMergeMethod!')
    expect(mutation.variables).toEqual({
      pullRequestId: 'PR_42',
      mergeMethod: 'SQUASH',
      expectedHeadOid: 'head-42',
      commitHeadline: headline,
      commitBody: canonical,
    })
  })
  test('new adapter repairs stale defaults despite a correct trailer; unchanged defaults make no mutation', async () => {
    for (const oldRequest of [
      { ...native, commitHeadline: 'Old title' },
      { ...native, commitBody: 'Old body\n\nAutobuild-Build: stable-build\n' },
      { ...native, mergeMethod: 'MERGE' },
      null,
    ]) {
      const repair = oldRequest === null ? [] : [applied('disablePullRequestAutoMerge'), message()]
      const { forge, calls } = makeForge([
        message({ autoMergeRequest: oldRequest }),
        inspect(),
        ...gates,
        ...repair,
        applied('enablePullRequestAutoMerge'),
        message({ autoMergeRequest: native }),
      ])
      expect(await forge.setAutoMerge('/absent', 42, true, { buildSlug: 'stable-build' })).toEqual({
        kind: 'applied',
      })
      expect(mutations(calls)).toHaveLength(oldRequest === null ? 1 : 2)
    }
    const { forge, calls } = makeForge([message({ autoMergeRequest: native })])
    expect(await forge.setAutoMerge('/absent', 42, true, { buildSlug: 'stable-build' })).toEqual({
      kind: 'applied',
    })
    expect(mutations(calls)).toEqual([])
  })
  test.each([
    { commitHeadline: null, commitBody: null },
    { commitHeadline: null, commitBody: canonical },
    { commitHeadline: headline, commitBody: null },
  ])('legacy nullable native overrides are repaired once (%j)', async (overrides) => {
    const { forge, calls } = makeForge([
      message({ autoMergeRequest: { ...native, ...overrides } }),
      inspect(),
      ...gates,
      applied('disablePullRequestAutoMerge'),
      message(),
      applied('enablePullRequestAutoMerge'),
      message({ autoMergeRequest: native }),
      message({ autoMergeRequest: native }),
    ])
    expect(await forge.setAutoMerge('/absent', 42, true, { buildSlug: 'stable-build' })).toEqual({
      kind: 'applied',
    })
    const changes = mutations(calls)
    expect(
      changes.map((call) =>
        (call.opts!.body as { query: string }).query.includes('disablePullRequestAutoMerge')
          ? 'disable'
          : 'enable',
      ),
    ).toEqual(['disable', 'enable'])
    expect((changes[1]!.opts!.body as { variables: unknown }).variables).toEqual({
      pullRequestId: 'PR_42',
      mergeMethod: 'SQUASH',
      expectedHeadOid: 'head-42',
      commitHeadline: headline,
      commitBody: canonical,
    })
    const before = calls.length
    expect(await forge.setAutoMerge('/absent', 42, true, { buildSlug: 'stable-build' })).toEqual({
      kind: 'applied',
    })
    expect(calls).toHaveLength(before + 1)
    expect(mutations(calls)).toHaveLength(2)
  })

  test('nullable overrides after enable remain unconfirmed rather than being acknowledged', async () => {
    const { forge } = makeForge([
      message(),
      inspect(false),
      ...gates,
      applied('enablePullRequestAutoMerge'),
      message({ autoMergeRequest: { ...native, commitHeadline: null, commitBody: null } }),
    ])
    expect(
      await forge.setAutoMerge('/absent', 42, true, { buildSlug: 'stable-build' }),
    ).toMatchObject({
      kind: 'deferred',
      reason: { code: 'unproven-gate-state', detail: expect.stringContaining('not confirmed') },
    })
  })

  test('cancellation during repair prevents re-enable', async () => {
    let guards = 0
    const { forge, calls } = makeForge([
      message({ autoMergeRequest: { ...native, commitBody: 'old' } }),
      inspect(),
      ...gates,
      applied('disablePullRequestAutoMerge'),
      message(),
    ])
    expect(
      await forge.setAutoMerge('/absent', 42, true, {
        buildSlug: 'stable-build',
        canApply: async () => ++guards === 1,
      }),
    ).toEqual({ kind: 'deferred' })
    expect(mutations(calls)).toHaveLength(1)
    expect(JSON.stringify(mutations(calls))).toContain('disablePullRequestAutoMerge')
  })
  test.each(['new-head', 'head-42'])(
    'head race or merged PR after disable never re-enables (%s)',
    async (head) => {
      const { forge, calls } = makeForge([
        message({ autoMergeRequest: { ...native, commitBody: 'old' } }),
        inspect(),
        ...gates,
        applied('disablePullRequestAutoMerge'),
        message({ headRefOid: head, state: head === 'head-42' ? 'MERGED' : 'OPEN' }),
      ])
      expect(await forge.setAutoMerge('/absent', 42, true, { buildSlug: 'stable-build' })).toEqual({
        kind: 'deferred',
      })
      expect(mutations(calls)).toHaveLength(1)
    },
  )
  test('head movement during resolution and failed repair cannot acknowledge', async () => {
    const changed = makeForge([message({ headRefOid: 'new-head' }), inspect(), ...gates])
    expect(
      await changed.forge.setAutoMerge('/absent', 42, true, { buildSlug: 'stable-build' }),
    ).toEqual({ kind: 'deferred' })
    expect(mutations(changed.calls)).toEqual([])
    const failed = makeForge([
      message({ autoMergeRequest: { ...native, commitBody: 'old' } }),
      inspect(),
      ...gates,
      { status: 403, json: { message: 'repair denied' } },
    ])
    expect(
      await failed.forge.setAutoMerge('/absent', 42, true, { buildSlug: 'stable-build' }),
    ).toMatchObject({ kind: 'deferred', reason: { code: 'unproven-gate-state' } })
  })
  test('merge queues defer identity-aware landing without bypass or mutation', async () => {
    const { forge, calls } = makeForge([
      message(),
      inspect(),
      { json: { protected: false } },
      { json: [{ type: 'merge_queue', parameters: {} }] },
    ])
    expect(
      await forge.setAutoMerge('/absent', 42, true, { buildSlug: 'stable-build' }),
    ).toMatchObject({
      kind: 'deferred',
      reason: { code: 'unproven-gate-state', detail: expect.stringContaining('merge queues') },
    })
    expect(mutations(calls)).toEqual([])
  })
  test('provider trimming a final newline confirms enable and stays a single-query no-op on later polls', async () => {
    const trimmed = { ...native, commitBody: canonical.trimEnd() }
    const { forge, calls } = makeForge([
      message(),
      inspect(false),
      ...gates,
      applied('enablePullRequestAutoMerge'),
      message({ autoMergeRequest: trimmed }),
      message({ autoMergeRequest: trimmed }),
    ])
    const canApply = async () => true
    expect(
      await forge.setAutoMerge('/absent', 42, true, { buildSlug: 'stable-build', canApply }),
    ).toEqual({ kind: 'applied' })
    const before = calls.length
    expect(
      await forge.setAutoMerge('/absent', 42, true, {
        buildSlug: 'stable-build',
        canApply: async () => {
          throw new Error('quiet poll refreshed consent')
        },
      }),
    ).toEqual({ kind: 'applied' })
    expect(calls.slice(before).map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST graphql',
    ])
    expect(mutations(calls)).toHaveLength(1)
  })

  test('classic protection queues defer native and direct landings, even with an existing matching request', async () => {
    for (const request of [null, native]) {
      const { forge, calls } = makeForge([
        message({ autoMergeRequest: request }, { id: 'classic-queue' }),
      ])
      expect(
        await forge.setAutoMerge('/absent', 42, true, { buildSlug: 'stable-build' }),
      ).toMatchObject({
        kind: 'deferred',
        reason: { code: 'unproven-gate-state', detail: expect.stringContaining('merge queues') },
      })
      expect(calls).toHaveLength(1)
      expect((calls[0]!.opts!.body as { query: string }).query).toContain(
        'mergeQueue(branch: $branch)',
      )
      expect(mutations(calls)).toHaveLength(0)
    }
    const { forge, calls } = makeForge([message({}, { id: 'classic-queue' })])
    await expect(
      forge.squashMerge('/absent', 42, 'head-42', { buildSlug: 'stable-build' }),
    ).rejects.toThrow('merge queues')
    expect(calls).toHaveLength(1)
  })

  test('queue inspection follows the actual PR base rather than a default or stale hint', async () => {
    const { forge, calls } = makeForge([
      message({ baseRefName: 'release', autoMergeRequest: native }),
      message({ baseRefName: 'release', autoMergeRequest: native }, { id: 'release-queue' }),
    ])
    expect(
      await forge.setAutoMerge('/absent', 42, true, {
        buildSlug: 'stable-build',
        baseBranch: 'main',
      }),
    ).toMatchObject({ kind: 'deferred' })
    expect((calls[1]!.opts!.body as { variables: { branch: string } }).variables.branch).toBe(
      'release',
    )
    expect(mutations(calls)).toHaveLength(0)
  })

  test('a verified nondefault branch hint keeps unchanged maintenance to one query', async () => {
    const { forge, calls } = makeForge([
      message({ baseRefName: 'release', autoMergeRequest: native }),
    ])
    expect(
      await forge.setAutoMerge('/absent', 42, true, {
        buildSlug: 'stable-build',
        baseBranch: 'release',
      }),
    ).toEqual({ kind: 'applied' })
    expect(calls).toHaveLength(1)
    expect((calls[0]!.opts!.body as { variables: { branch: string } }).variables.branch).toBe(
      'release',
    )
  })

  test('retargeting during repair never enables with obsolete gate inspection', async () => {
    const { forge, calls } = makeForge([
      message({ autoMergeRequest: { ...native, commitBody: 'old' } }),
      inspect(),
      ...gates,
      applied('disablePullRequestAutoMerge'),
      message({ baseRefName: 'release' }),
      message({ baseRefName: 'release' }),
    ])
    expect(await forge.setAutoMerge('/absent', 42, true, { buildSlug: 'stable-build' })).toEqual({
      kind: 'deferred',
    })
    expect(mutations(calls)).toHaveLength(1)
  })

  test('unknown queue evidence fails closed', async () => {
    const response = message({ autoMergeRequest: native })
    const unknown = {
      ...response,
      json: { data: { repository: { ...response.json.data.repository, mergeQueue: undefined } } },
    }
    const { forge, calls } = makeForge([unknown])
    expect(
      await forge.setAutoMerge('/absent', 42, true, { buildSlug: 'stable-build' }),
    ).toMatchObject({ kind: 'deferred', reason: { code: 'unproven-gate-state' } })
    expect(calls).toHaveLength(1)
  })

  test('commit evidence and paginated reachable history are checkout-less and uncached', async () => {
    const prose = { commit: { message: 'Mention Autobuild-Build: stable-build' } }
    const { forge, calls } = makeForge([
      { json: { commit: { message: canonical } } },
      { json: Array.from({ length: 100 }, () => prose) },
      { json: [{ commit: { message: canonical } }] },
      { json: [{ commit: { message: 'Autobuild-Build: stable-build-long' } }] },
      { status: 404, json: { message: 'missing branch' } },
    ])
    expect(await forge.readCommitMessage('/absent', 'rewritten')).toBe(canonical)
    expect(await forge.containsBuild('/absent', 'feature', 'stable-build')).toBe(true)
    expect(calls[2]?.opts?.query).toEqual({ sha: 'feature', per_page: '100', page: '2' })
    expect(await forge.containsBuild('/absent', 'feature', 'stable-build')).toBe(false)
    await expect(forge.containsBuild('/absent', 'missing', 'stable-build')).rejects.toThrow()
    await expect(forge.containsBuild('/absent', '--all', 'stable-build')).rejects.toThrow()
  })
})

describe('GitHub integration refs', () => {
  test('creates exact ref at frozen SHA after authoritative absence', async () => {
    const { forge, calls } = makeForge([
      { status: 404 },
      { json: { ref: 'refs/heads/ab-node/n', object: { sha: 'opening' } } },
    ])
    expect(await forge.createNodeBranch('ab-node/n', 'opening')).toBe('opening')
    expect(calls[1]).toEqual({
      method: 'POST',
      path: 'repos/acme/app/git/refs',
      opts: { body: { ref: 'refs/heads/ab-node/n', sha: 'opening' } },
    })
  })
  test('adopts an advanced ref without resetting and rejects unrelated history', async () => {
    const { forge, calls } = makeForge([
      { json: { object: { sha: 'advanced' } } },
      { json: { ahead_by: 2, behind_by: 0 } },
    ])
    expect(await forge.createNodeBranch('ab-node/n', 'opening')).toBe('advanced')
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
    const bad = makeForge([
      { json: { object: { sha: 'unrelated' } } },
      { json: { ahead_by: 2, behind_by: 1 } },
    ])
    await expect(bad.forge.createNodeBranch('ab-node/n', 'opening')).rejects.toThrow('collision')
  })
  test('compares sampled exact SHAs and uses ahead count with parent-only movement', async () => {
    const { forge, calls } = makeForge([
      { json: { object: { sha: 'parent' } } },
      { json: { object: { sha: 'node' } } },
      { json: { ahead_by: 0, behind_by: 4 } },
    ])
    expect(await forge.compareBranches('main', 'ab-node/n')).toEqual({
      parentSha: 'parent',
      headSha: 'node',
      ahead: 0,
    })
    expect(calls[2]?.path).toBe('repos/acme/app/compare/parent...node')
  })
})

test('GitHub no-commits classification reads nested validation messages only', async () => {
  const opts = {
    workspacePath: '/ws',
    head: 'ab-node/x',
    base: 'main',
    title: 'Node',
    body: 'Integration',
  }
  const body = {
    message: 'Validation Failed',
    errors: [
      { resource: 'PullRequest', code: 'custom', message: 'No commits between main and ab-node/x' },
    ],
  }
  const empty = makeForge([{ json: [] }, { status: 422, json: body }, { json: [] }])
  await expect(empty.forge.openPr(opts)).rejects.toMatchObject({
    name: 'NoCommitsBetweenBranchesError',
  })
  const unrelated = makeForge([
    { json: [] },
    {
      status: 422,
      json: {
        message: 'Validation Failed',
        errors: [{ resource: 'PullRequest', code: 'custom', message: 'base is invalid' }],
      },
    },
    { json: [] },
  ])
  await expect(unrelated.forge.openPr(opts)).rejects.toBeInstanceOf(GitHubApiError)
})

describe('GitHubForge.inspectLandingGate', () => {
  test('proves an exact node branch ungated using only reads', async () => {
    const { forge, calls } = makeForge([{ json: { protected: false } }, { json: [] }])
    expect(await forge.inspectLandingGate('ab-node/a')).toEqual({ kind: 'proved-ungated' })
    expect(paths(calls)).toEqual([
      'GET repos/acme/app/branches/ab-node%2Fa',
      'GET repos/acme/app/rules/branches/ab-node%2Fa',
    ])
    expect(calls[1]?.opts?.query).toEqual({ per_page: '100', page: '1' })
  })

  for (const rule of [
    ...[
      'update',
      'file_path_restriction',
      'max_file_size',
      'commit_message_pattern',
      'commit_author_email_pattern',
      'committer_email_pattern',
      'branch_name_pattern',
      'tag_name_pattern',
      'max_file_path_length',
      'file_extension_restriction',
    ].map((type) => ({ type })),
    { type: 'merge_queue', parameters: {} },
    {
      type: 'pull_request',
      parameters: {
        required_approving_review_count: 1,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: false,
      },
    },
    { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci' }] } },
  ]) {
    test(`refuses ${rule.type} without a mutation or bypass probe`, async () => {
      const { forge, calls } = makeForge([{ json: { protected: false } }, { json: [rule] }])
      expect(await forge.inspectLandingGate('ab-node/a')).toMatchObject({ kind: 'gated' })
      expect(calls.every((call) => call.method === 'GET')).toBe(true)
    })
  }

  test('a gate on a later rules page prevents a false ungated proof', async () => {
    const { forge, calls } = makeForge([
      { json: { protected: false } },
      { json: Array.from({ length: 100 }, () => ({ type: 'required_linear_history' })) },
      { json: [{ type: 'merge_queue', parameters: {} }] },
    ])
    expect(await forge.inspectLandingGate('ab-node/a')).toMatchObject({ kind: 'gated' })
    expect(calls[2]?.opts?.query).toEqual({ per_page: '100', page: '2' })
  })

  test('follows a provider next link even on a short page', async () => {
    const { forge, calls } = makeForge([
      { json: { protected: false } },
      { json: [{ type: 'required_linear_history' }], headers: { link: '<next>; rel="next"' } },
      { json: [{ type: 'merge_queue', parameters: {} }] },
    ])
    expect(await forge.inspectLandingGate('ab-node/a')).toMatchObject({ kind: 'gated' })
    expect(calls).toHaveLength(3)
  })

  test('a failed later page leaves policy unproven', async () => {
    const { forge, calls } = makeForge([
      { json: { protected: false } },
      { json: Array.from({ length: 100 }, () => ({ type: 'required_linear_history' })) },
      { status: 403, json: { message: 'Forbidden' } },
    ])
    expect(await forge.inspectLandingGate('ab-node/a')).toMatchObject({ kind: 'unproven' })
    expect(calls.every((call) => call.method === 'GET')).toBe(true)
  })

  test('a plan-limitation error after a partial page cannot prove absence', async () => {
    const { forge } = makeForge([
      { json: { protected: false } },
      { json: Array.from({ length: 100 }, () => ({ type: 'required_linear_history' })) },
      {
        status: 403,
        json: {
          message: 'Upgrade to GitHub Pro or make this repository public to enable this feature.',
          documentation_url: 'https://docs.github.com/rest/repos/rules#get-rules-for-a-branch',
        },
      },
    ])
    expect(await forge.inspectLandingGate('ab-node/a')).toMatchObject({ kind: 'unproven' })
  })

  test('a zero-review pull-request requirement still blocks controlled pushes', async () => {
    const { forge } = makeForge([
      { json: { protected: false } },
      {
        json: [
          {
            type: 'pull_request',
            parameters: {
              required_approving_review_count: 0,
              require_code_owner_review: false,
              require_last_push_approval: false,
              required_review_thread_resolution: false,
            },
          },
        ],
      },
    ])
    expect(await forge.inspectLandingGate('ab-node/a')).toMatchObject({ kind: 'gated' })
  })

  test('classic pull-request protection blocks controlled pushes even with zero reviews', async () => {
    const { forge } = makeForge([
      {
        json: {
          protected: true,
          protection: {
            required_status_checks: null,
            restrictions: null,
            required_pull_request_reviews: {
              required_approving_review_count: 0,
              require_code_owner_reviews: false,
              require_last_push_approval: false,
            },
          },
        },
      },
      { json: [] },
    ])
    expect(await forge.inspectLandingGate('ab-node/a')).toMatchObject({ kind: 'gated' })
  })

  test('unreadable classic protection with no effective rule remains unproven', async () => {
    const { forge } = makeForge([{ status: 403 }, { json: [] }])
    expect(await forge.inspectLandingGate('ab-node/a')).toMatchObject({ kind: 'unproven' })
  })
})

test('node landing PR inspection refreshes exact base/head through a read-only request', async () => {
  const { forge, calls } = makeForge([
    {
      json: {
        ...PR_REF,
        state: 'open',
        merged: false,
        draft: false,
        base: { ref: 'ab-node/target' },
      },
    },
  ])
  expect(await forge.inspectLandingPr('/work', 123)).toEqual({
    base: 'ab-node/target',
    head: 'ab/fix-login',
    headSha: 'abc123def',
    open: true,
  })
  expect(paths(calls)).toEqual(['GET repos/acme/app/pulls/123'])
})

test('node push acknowledgement comments with the landed SHA and closes an unacknowledged review', async () => {
  const { acknowledgeNodeLanding } = await import('../../kernel/node-landing')
  const open = { merged: false, state: 'open', mergeable: true, merge_commit_sha: null }
  const { forge, calls } = makeForge([
    { json: open },
    { json: {} },
    { json: open },
    { json: {} },
    { json: { ...open, state: 'closed' } },
  ])
  await acknowledgeNodeLanding(forge, '/work', 123, 'a'.repeat(40))
  expect(paths(calls)).toEqual([
    'GET repos/acme/app/pulls/123',
    'POST repos/acme/app/issues/123/comments',
    'GET repos/acme/app/pulls/123',
    'PATCH repos/acme/app/pulls/123',
    'GET repos/acme/app/pulls/123',
  ])
  expect(calls[1]?.opts?.body).toEqual({ body: expect.stringContaining('a'.repeat(40)) })
  expect(calls[3]?.opts?.body).toEqual({ state: 'closed' })
})

test('node push acknowledgement observes a merged review and tolerates provider failure', async () => {
  const { acknowledgeNodeLanding } = await import('../../kernel/node-landing')
  const merged = makeForge([
    { json: { merged: true, state: 'closed', mergeable: true, merge_commit_sha: 'a'.repeat(40) } },
  ])
  await acknowledgeNodeLanding(merged.forge, '/work', 123, 'a'.repeat(40))
  expect(paths(merged.calls)).toEqual(['GET repos/acme/app/pulls/123'])
  const unavailable = makeForge([{ status: 503 }])
  await expect(
    acknowledgeNodeLanding(unavailable.forge, '/work', 123, 'a'.repeat(40)),
  ).resolves.toBeUndefined()
  expect(paths(unavailable.calls)).toEqual(['GET repos/acme/app/pulls/123'])
})

describe('trusted kernel Git credentials', () => {
  test('clears inherited host and repository authorization headers without editing config', async () => {
    const { rm } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const root = await mkdtemp(join(tmpdir(), 'kernel-headers-'))
    const initialized = Bun.spawn(['git', 'init', '-q', root], { stdout: 'pipe', stderr: 'pipe' })
    expect(await initialized.exited).toBe(0)
    const config = join(root, '.git', 'config')
    const before =
      '[http "https://github.com/"]\nextraHeader = Authorization: Basic stale-host\n' +
      '[http "https://github.com/acme/private"]\nextraHeader = Authorization: Basic stale-repo\n' +
      '[http "https://github.com/acme/private.git"]\nextraHeader = Authorization: Basic stale-dotgit\n'
    await Bun.write(config, before)
    try {
      const forge = new GitHubForge({ repository: 'acme/private', token: 'fresh-token' })
      for (const url of [
        'https://github.com/acme/private',
        'https://github.com/acme/private.git',
      ]) {
        const result = await forge.kernelExec(
          ['git', 'config', '--get-urlmatch', 'http.extraHeader', url],
          {
            cwd: root,
            env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
          },
        )
        expect(result.exitCode).toBe(0)
        expect(
          result.stdout.split('\n').filter((line) => line.startsWith('Authorization:')),
        ).toEqual(['Authorization: Basic [redacted]'])
        expect(result.stdout).not.toContain('stale-')
      }
      expect(await Bun.file(config).text()).toBe(before)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('real Git receives scoped ephemeral headers for normalized and .git origins', async () => {
    const { tmpdir } = await import('node:os')
    const forge = new GitHubForge({ repository: 'acme/private', token: 'kernel-secret' })
    for (const url of ['https://github.com/acme/private', 'https://github.com/acme/private.git']) {
      const result = await forge.kernelExec(
        ['git', 'config', '--get-urlmatch', 'http.extraHeader', url],
        {
          cwd: tmpdir(),
          env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
        },
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe('Authorization: Basic [redacted]')
    }
    for (const url of ['https://github.com/acme/other', 'https://elsewhere.invalid/acme/private']) {
      const result = await forge.kernelExec(
        ['git', 'config', '--get-urlmatch', 'http.extraHeader', url],
        {
          cwd: tmpdir(),
          env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
        },
      )
      expect(result.stdout.trim()).toBe('')
    }
  })
  test('scopes ephemeral credentials to the repository and redacts transport diagnostics', async () => {
    const token = 'kernel-secret'
    const encoded = Buffer.from(`x-access-token:${token}`).toString('base64')
    const cmd = ['git', 'clone', '--bare', 'https://github.com/acme/private', '/tmp/repo.git']
    const forge = new GitHubForge({
      repository: 'acme/private',
      token,
      exec: async (argv, opts) => {
        expect(argv).toEqual(cmd)
        expect(opts.env).toMatchObject({
          GIT_TERMINAL_PROMPT: '0',
          GIT_CONFIG_COUNT: '7',
          GIT_CONFIG_KEY_0: 'http.extraHeader',
          GIT_CONFIG_VALUE_0: '',
          GIT_CONFIG_KEY_1: 'http.https://github.com/.extraHeader',
          GIT_CONFIG_VALUE_1: '',
          GIT_CONFIG_KEY_2: 'http.https://github.com/acme/private.extraHeader',
          GIT_CONFIG_VALUE_2: '',
          GIT_CONFIG_KEY_3: 'http.https://github.com/acme/private.git.extraHeader',
          GIT_CONFIG_VALUE_3: '',
          GIT_CONFIG_KEY_4: 'http.https://github.com/acme/private.extraHeader',
          GIT_CONFIG_VALUE_4: `Authorization: Basic ${encoded}`,
          GIT_CONFIG_KEY_5: 'http.https://github.com/acme/private.git.extraHeader',
          GIT_CONFIG_VALUE_5: `Authorization: Basic ${encoded}`,
          GIT_CONFIG_KEY_6: 'credential.helper',
          GIT_CONFIG_VALUE_6: '',
        })
        return { stdout: token, stderr: encoded, exitCode: 128 }
      },
    })
    expect(await forge.kernelExec(cmd, { cwd: '/tmp' })).toEqual({
      stdout: '[redacted]',
      stderr: '[redacted]',
      exitCode: 128,
    })
  })

  test('fails before spawning when no token is available and redacts thrown failures', async () => {
    let spawned = false
    const forge = new GitHubForge({
      repository: 'acme/private',
      token: async () => undefined,
      exec: async () => {
        spawned = true
        throw new Error('unexpected spawn')
      },
    })
    await expect(forge.kernelExec(['git', 'clone'], {})).rejects.toThrow('requires a GitHub token')
    expect(spawned).toBe(false)
    const failing = new GitHubForge({
      repository: 'acme/private',
      token: 'secret-token',
      exec: async () => {
        throw new Error('failed with secret-token')
      },
    })
    await expect(failing.kernelExec(['git', 'fetch'], {})).rejects.toThrow('failed with [redacted]')
  })
})

describe('integration stack merge', () => {
  test('uses rebase with exact head and validates merged success', async () => {
    const { transport, calls } = makeTransport([
      { json: { merged: true, sha: 'landed', message: 'merged' } },
    ])
    const forge = new GitHubForge({ transport, env: { AB_REPOSITORY: 'owner/repo' } })
    expect(await forge.mergeLinearStack('/unused', 7, 'verified')).toBe('landed')
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      path: 'repos/owner/repo/pulls/7/merge',
      opts: { body: { merge_method: 'rebase', sha: 'verified' } },
    })
  })
  test('merged false never acknowledges landing or falls back', async () => {
    const { transport, calls } = makeTransport([
      { json: { merged: false, sha: 'none', message: 'rejected' } },
    ])
    const forge = new GitHubForge({ transport, env: { AB_REPOSITORY: 'owner/repo' } })
    await expect(forge.mergeLinearStack('/unused', 7, 'verified')).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })
  test.each([true, false])('strict checks require admin enforcement (%s)', async (enforced) => {
    const { transport } = makeTransport([
      {
        json: {
          enforce_admins: { enabled: enforced },
          required_status_checks: { strict: true, contexts: ['ci'] },
        },
      },
    ])
    const forge = new GitHubForge({ transport, env: { AB_REPOSITORY: 'owner/repo' } })
    expect((await forge.inspectMergeFreshness('main')).fenced).toBe(enforced)
  })
  test('strict with zero checks remains unfenced', async () => {
    const { transport } = makeTransport([
      {
        json: {
          enforce_admins: { enabled: true },
          required_status_checks: { strict: true, contexts: [], checks: [] },
        },
      },
    ])
    const forge = new GitHubForge({ transport, env: { AB_REPOSITORY: 'owner/repo' } })
    expect((await forge.inspectMergeFreshness('main')).fenced).toBe(false)
  })
})

describe('node PR retargeting', () => {
  const view = (base: string, state = 'open') => ({
    number: 7,
    state,
    merged: false,
    draft: false,
    base: { ref: base },
    head: { ref: 'ab-node/move', sha: 'head' },
  })
  test('PATCH sends a branch name and validates the returned review identity/base/head', async () => {
    const { forge, calls } = makeForge([{ json: view('old') }, { json: view('new') }])
    await forge.retargetPr('.', 7, 'new')
    expect(calls.at(-1)).toMatchObject({
      method: 'PATCH',
      path: 'repos/acme/app/pulls/7',
      opts: { body: { base: 'new' } },
    })
  })
  test('retry adopts an already changed base without a second PATCH', async () => {
    const { forge, calls } = makeForge([{ json: view('new') }])
    await forge.retargetPr('.', 7, 'new')
    expect(calls).toHaveLength(1)
  })
  test('wrong base and closed reviews never acknowledge retargeting', async () => {
    await expect(
      makeForge([{ json: view('old') }, { json: view('wrong') }]).forge.retargetPr('.', 7, 'new'),
    ).rejects.toThrow('acknowledgement')
    await expect(
      makeForge([{ json: view('old', 'closed') }]).forge.retargetPr('.', 7, 'new'),
    ).rejects.toThrow('no longer open')
  })
  for (const status of [403, 422])
    test(`propagates provider ${status} refusals`, async () => {
      await expect(
        makeForge([
          { json: view('old') },
          { status, json: { message: 'refused' } },
        ]).forge.retargetPr('.', 7, 'new'),
      ).rejects.toThrow('refused')
    })
})

test('GraphQL HTTP-200 rate errors survive native landing convenience catches', async () => {
  const now = Date.parse('2026-10-20T00:00:00Z')
  const forge = new GitHubForge({
    repository: 'acme/app',
    now: () => now,
    transport: async (_method, path): Promise<GitHubResponse> =>
      path !== 'graphql'
        ? { status: 200, headers: {}, json: { node_id: 'PR_123', auto_merge: {} } }
        : {
            status: 200,
            headers: {
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset': String((now + 120_000) / 1000),
            },
            json: { errors: [{ message: 'API rate limit exceeded', type: 'RATE_LIMITED' }] },
          },
  })
  await expect(forge.setAutoMerge('/ws', 1, false)).rejects.toMatchObject({
    forgeFailure: 'autobuild.forge-failure.v1',
    details: { kind: 'rate-limited', resetAt: '2026-10-20T00:02:00.000Z' },
  })
})

test('wire observers count failed requests and retain concurrent build context', async () => {
  const { withForgeRequestContext } = await import('../forge-request-context')
  const seen: (string | undefined)[] = []
  const forge = new GitHubForge({
    repository: 'acme/app',
    transport: async (_method, path) => {
      await Promise.resolve()
      if (path.endsWith('/2')) throw new GitHubApiError(503, 'unavailable')
      return {
        status: 200,
        headers: {},
        json: { state: 'open', merged: false, mergeable: true, merge_commit_sha: null },
      }
    },
  })
  const stop = forge.observeRequests((ctx) => seen.push(ctx.build))
  await Promise.allSettled([
    withForgeRequestContext({ build: 'a' }, () => forge.getPrState('/ws', 1)),
    withForgeRequestContext({ build: 'b' }, () => forge.getPrState('/ws', 2)),
  ])
  expect(seen.sort()).toEqual(['a', 'b'])
  stop()
  await forge.getPrState('/ws', 1)
  expect(seen).toHaveLength(2)
})

test('a cooldown established between wire calls remains a scheduling deferral', async () => {
  const { withForgeRequestGate, ForgeRequestDeferred } = await import('../forge-request-context')
  const deferred = new ForgeRequestDeferred('another process recorded cooldown')
  let calls = 0
  const forge = new GitHubForge({
    repository: 'acme/app',
    transport: async () => {
      calls++
      return { status: 200, headers: {}, json: {} }
    },
  })
  await expect(
    withForgeRequestGate(
      {
        before: async () => {
          throw deferred
        },
        failed: async () => {},
      },
      () => forge.setAutoMerge('/ws', 1, true),
    ),
  ).rejects.toBe(deferred)
  expect(calls).toBe(0)
})

describe('tick observations', () => {
  const pr = {
    state: 'open',
    merged: false,
    mergeable: true,
    merge_commit_sha: null,
    head: { sha: 'node-sha', ref: 'ab/node', repo: { full_name: 'acme/app' } },
  }
  const comparison = { base_commit: { sha: 'parent-sha' }, ahead_by: 2, behind_by: 1 }

  test.each([true, false])(
    'node priming shares all stages and revalidates three ticks (PR=%s)',
    async (hasPr) => {
      const first = hasPr ? pr : { commit: { sha: 'parent-sha' } }
      const compared = hasPr
        ? comparison
        : { base_commit: { sha: 'node-sha' }, ahead_by: 1, behind_by: 2 }
      const { forge, calls } = makeForge([
        { json: first, headers: { etag: 'first' } },
        { json: compared, headers: { etag: 'compare' } },
        { status: 304 },
        { status: 304 },
        { status: 304 },
        { status: 304 },
      ])
      const outcomes: string[] = []
      forge.observeRequests((ctx) => outcomes.push(ctx.outcome!))
      for (let tick = 0; tick < 3; tick++) {
        await forge.withReadScope(async () => {
          await forge.primeNodeReads({
            workspacePath: '/ws',
            parent: 'main',
            head: 'ab/node',
            ...(hasPr ? { prNumber: 1 } : {}),
          })
          if (hasPr)
            expect(await forge.getPrState('/ws', 1)).toEqual({ state: 'open', mergeable: true })
          expect(await forge.remoteBranchSha('main')).toBe('parent-sha')
          expect(await forge.remoteBranchSha('ab/node')).toBe('node-sha')
          const results = await Promise.all([
            forge.compareBranches('main', 'ab/node'),
            forge.compareBranches('main', 'ab/node'),
          ])
          for (const result of results)
            expect(result).toEqual({ parentSha: 'parent-sha', headSha: 'node-sha', ahead: 2 })
        })
        expect(calls).toHaveLength((tick + 1) * 2)
      }
      expect(calls.slice(2).map((c) => c.opts?.headers?.['If-None-Match'])).toEqual([
        'first',
        'compare',
        'first',
        'compare',
      ])
      expect(outcomes).toEqual(['restPrimary', 'restPrimary', ...Array(4).fill('restNotModified')])
      expect(calls[1]!.path).toContain(hasPr ? 'main...node-sha' : 'ab%2Fnode...parent-sha')
    },
  )

  test('concurrent reads share promises; separate scopes and outside operations do not', async () => {
    let calls = 0
    const forge = new GitHubForge({
      repository: 'acme/app',
      transport: async () => {
        calls++
        await Promise.resolve()
        return { status: 200, headers: {}, json: { commit: { sha: String(calls) } } }
      },
    })
    await Promise.all(
      [1, 2].map(() =>
        forge.withReadScope(async () => {
          const results = await Promise.all([
            forge.remoteBranchSha('main'),
            forge.remoteBranchSha('main'),
          ])
          expect(results[0]).toBe(results[1])
        }),
      ),
    )
    expect(calls).toBe(2)
    await forge.remoteBranchSha('main')
    expect(calls).toBe(3)
    await expect(
      forge.withReadScope(async () => {
        await forge.remoteBranchSha('main')
        throw new Error('stop')
      }),
    ).rejects.toThrow('stop')
    await forge.withReadScope(() => forge.remoteBranchSha('main'))
    expect(calls).toBe(5)
  })

  test('failed and malformed reads drop validators and retry next scope', async () => {
    const { forge, calls } = makeForge([
      { json: { commit: { sha: 'old' } }, headers: { etag: 'old' } },
      { json: { commit: {} }, headers: { etag: 'bad' } },
      { json: { commit: { sha: 'new' } } },
      { status: 304 },
    ])
    expect(await forge.remoteBranchSha('main')).toBe('old')
    await expect(forge.withReadScope(() => forge.remoteBranchSha('main'))).rejects.toThrow(
      'unexpected GitHub',
    )
    expect(await forge.withReadScope(() => forge.remoteBranchSha('main'))).toBe('new')
    expect(calls[2]!.opts).toBeUndefined()
    await expect(forge.remoteBranchSha('main')).rejects.toThrow('unsolicited')
  })

  test('uncertain mutation invalidates memoized facts and validators before readback', async () => {
    const { forge, calls } = makeForge([
      { json: { commit: { sha: 'before' } }, headers: { etag: 'before' } },
      { status: 500 },
      { json: { commit: { sha: 'after' } } },
    ])
    await forge.withReadScope(async () => {
      expect(await forge.remoteBranchSha('main')).toBe('before')
      await expect(forge.commentOnPr('/ws', 1, 'comment')).rejects.toThrow()
      expect(await forge.remoteBranchSha('main')).toBe('after')
    })
    expect(calls[2]!.opts).toBeUndefined()
  })

  test('foreign PR heads cannot seed expected branch identity', async () => {
    const { forge, calls } = makeForge([
      { json: { ...pr, head: { ...pr.head, repo: { full_name: 'foreign/app' } } } },
      { json: { commit: { sha: 'actual' } } },
    ])
    await forge.withReadScope(async () => {
      await forge.primeNodeReads({
        workspacePath: '/ws',
        parent: 'main',
        head: 'ab/node',
        prNumber: 1,
      })
      expect(await forge.remoteBranchSha('ab/node')).toBe('actual')
    })
    expect(calls).toHaveLength(2)
  })
})

test('branch and exact-ref facts share across builds, with conditional ref and comparison reads', async () => {
  const { withForgeRequestContext } = await import('../forge-request-context')
  const { forge, calls } = makeForge([
    { json: { object: { sha: 'parent' } }, headers: { etag: 'parent' } },
    { json: { object: { sha: 'node' } }, headers: { etag: 'node' } },
    { json: { ahead_by: 1, behind_by: 0 }, headers: { etag: 'distance' } },
    { status: 304 },
    { status: 304 },
    { status: 304 },
  ])
  const attribution: (string | undefined)[] = []
  forge.observeRequests((ctx) => attribution.push(ctx.build))
  for (let tick = 0; tick < 2; tick++)
    await forge.withReadScope(async () => {
      await withForgeRequestContext({ build: 'first' }, () =>
        forge.compareBranches('main', 'ab/node'),
      )
      await withForgeRequestContext({ build: 'second' }, async () => {
        expect(await forge.remoteBranchSha('main')).toBe('parent')
        expect(await forge.remoteBranchSha('ab/node')).toBe('node')
        await forge.compareBranches('main', 'ab/node')
      })
    })
  expect(calls).toHaveLength(6)
  expect(attribution).toEqual(Array(6).fill('first'))
  expect(calls.slice(3).map((c) => c.opts?.headers?.['If-None-Match'])).toEqual([
    'parent',
    'node',
    'distance',
  ])
})

test.each([
  [0, 0],
  [2, 0],
  [0, 3],
  [2, 3],
])('forward/reverse node comparison normalizes distances (%s,%s)', async (ahead, behind) => {
  for (const hasPr of [true, false]) {
    const { forge } = makeForge([
      {
        json: hasPr
          ? {
              state: 'open',
              merged: false,
              mergeable: true,
              merge_commit_sha: null,
              head: { ref: 'node', sha: 'head', repo: { full_name: 'acme/app' } },
            }
          : { commit: { sha: 'parent' } },
      },
      {
        json: {
          base_commit: { sha: hasPr ? 'parent' : 'head' },
          ahead_by: hasPr ? ahead : behind,
          behind_by: hasPr ? behind : ahead,
        },
      },
    ])
    await forge.withReadScope(async () => {
      await forge.primeNodeReads({
        workspacePath: '/ws',
        parent: 'main',
        head: 'node',
        ...(hasPr ? { prNumber: 1 } : {}),
      })
      expect(await forge.compareBranches('main', 'node')).toEqual({
        parentSha: 'parent',
        headSha: 'head',
        ahead,
      })
    })
  }
})

test('wire outcomes distinguish REST HTTP errors, 304, GraphQL errors and network failures', async () => {
  let attempt = 0
  const forge = new GitHubForge({
    repository: 'acme/app',
    transport: async (_method, path) => {
      attempt++
      if (attempt === 1)
        return { status: 200, headers: { etag: 'branch' }, json: { commit: { sha: 'one' } } }
      if (attempt === 2) return { status: 304, headers: {} as Record<string, string> }
      if (path === 'graphql') throw new Error('network down')
      if (attempt === 3) throw new GitHubApiError(500, 'failed')
      throw new Error('network down')
    },
  })
  const outcomes: (string | undefined)[] = []
  forge.observeRequests((ctx) => outcomes.push(ctx.outcome))
  await forge.remoteBranchSha('main')
  await forge.remoteBranchSha('main')
  await expect(forge.remoteBranchSha('main')).rejects.toThrow()
  await expect(forge.remoteBranchSha('main')).rejects.toThrow()
  await expect(forge.setAutoMerge('/ws', 1, true, { buildSlug: 'build' })).resolves.toMatchObject({
    kind: 'deferred',
  })
  expect(outcomes).toEqual(['restPrimary', 'restNotModified', 'restPrimary', undefined, 'graphql'])
})

test.each(['pushBranch', 'rewrite', 'kernelRewrite'] as const)(
  'Git publication invalidates observations before %s readback',
  async (kind) => {
    let reads = 0
    let published = false
    const forge = new GitHubForge({
      repository: 'acme/app',
      token: 'test-token',
      exec: async (cmd) => {
        if (cmd.includes('push')) published = true
        return {
          stdout: cmd.includes('ls-remote')
            ? `${(published ? 'b' : 'a').repeat(40)}\trefs/heads/ab/work\n`
            : '',
          stderr: '',
          exitCode: 0,
        }
      },
      transport: async (_method, _path, opts) => {
        reads++
        expect(opts?.headers?.['If-None-Match']).toBeUndefined()
        return {
          status: 200,
          headers: { etag: String(reads) },
          json: { commit: { sha: String(reads) } },
        }
      },
    })
    await forge.withReadScope(async () => {
      expect(await forge.remoteBranchSha('ab/work')).toBe('1')
      if (kind === 'pushBranch') await forge.pushBranch('/ws', 'ab/work', 'b'.repeat(40))
      else
        await forge[kind].replace({
          workspacePath: '/ws',
          branch: 'ab/work',
          expected: 'a'.repeat(40),
          sha: 'b'.repeat(40),
        })
      expect(await forge.remoteBranchSha('ab/work')).toBe('2')
    })
  },
)

test('GraphQL query variables containing mutation do not invalidate an observation epoch', async () => {
  let branches = 0
  const forge = new GitHubForge({
    repository: 'acme/app',
    transport: async (_method, path) => {
      if (path === 'graphql') throw new Error('query unavailable')
      branches++
      return { status: 200, headers: {}, json: { commit: { sha: 'head' } } }
    },
  })
  await forge.withReadScope(async () => {
    await forge.remoteBranchSha('mutation-branch')
    await forge.setAutoMerge('/ws', 1, true, { buildSlug: 'test', baseBranch: 'mutation-branch' })
    await forge.remoteBranchSha('mutation-branch')
  })
  expect(branches).toBe(1)
})

test('trusted Git transient diagnostics are typed after credential redaction', async () => {
  const { isForgeFailure } = await import('../forge-failure')
  for (const thrown of [false, true]) {
    const forge = new GitHubForge({
      repository: 'acme/private',
      token: 'secret-token',
      exec: async () => {
        const message = 'HTTP 503 Service Unavailable secret-token'
        if (thrown) throw new Error(message)
        return { exitCode: 128, stdout: '', stderr: message }
      },
    })
    let failure: unknown
    try {
      await forge.kernelExec(['git', 'fetch', 'origin'], {})
    } catch (error) {
      failure = error
    }
    expect(isForgeFailure(failure)).toBe(true)
    expect((failure as Error).message).toContain('[redacted]')
    expect((failure as Error).message).not.toContain('secret-token')
  }
})
