import { describe, expect, test } from 'bun:test'
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
  test('publishes HEAD to an explicit destination ref with no rewrite bypass (D1)', async () => {
    const calls: { cmd: string[]; cwd: string | undefined }[] = []
    const forge = new GitHubForge({
      transport: async () => ({ status: 200, headers: {} }),
      exec: async (cmd, opts) => {
        calls.push({ cmd, cwd: opts.cwd })
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    })
    await forge.pushBranch('/ws/build-1', 'ab/fix-login')
    expect(calls).toEqual([
      {
        cmd: ['git', 'push', '-u', 'origin', 'HEAD:refs/heads/ab/fix-login'],
        cwd: '/ws/build-1',
      },
    ])
    const argv = calls[0]!.cmd
    for (const forbidden of ['--force', '--force-with-lease', '--rebase']) {
      expect(argv).not.toContain(forbidden)
    }
  })

  test('a failed push surfaces the exact command and diagnostic', async () => {
    const forge = new GitHubForge({
      transport: async () => ({ status: 200, headers: {} }),
      exec: async () => ({
        stdout: '',
        stderr: '! [rejected] HEAD -> ab/fix-login (non-fast-forward)',
        exitCode: 1,
      }),
    })
    expect(
      await forge.pushBranch('/ws/build-1', 'ab/fix-login').catch((e: unknown) => e as Error),
    ).toMatchObject({ message: expect.stringContaining('non-fast-forward') })
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
      // closePr's `after` read revalidates the same ETag, but the
      // representation changed: a 200 reports closed and refreshes the entry.
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
    expect(calls[3]?.opts).toEqual({ headers: { 'If-None-Match': '"etag-before"' } })
    expect(await forge.getPrState('/repo', 42)).toEqual({ state: 'closed' })
    expect(calls.at(-1)?.opts).toEqual({ headers: { 'If-None-Match': '"etag-after"' } })
  })

  test('deletes an existing exact branch and treats a missing branch as clean', async () => {
    const existing = makeForge([{}, {}])
    await existing.forge.deleteBranch('/repo', 'ab/work')
    expect(paths(existing.calls)).toEqual([
      'GET repos/acme/app/git/ref/heads/ab/work',
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

    await expectUnproven(
      makeForge([{ status: 500, json: { message: 'network down' } }]).forge,
      'network down',
    )
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
