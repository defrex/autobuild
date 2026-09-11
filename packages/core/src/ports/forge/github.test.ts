import { describe, expect, test } from 'bun:test'
import { GitHubForge, parseRepoCoordinates, rulesetsHaveMergeGate } from './github'
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
 * never touches git). */
function makeForge(responses: (Scripted | GitHubResponse)[] = []) {
  const { transport, calls } = makeTransport(responses)
  const forge = new GitHubForge({ transport, repository: 'acme/app' })
  return { forge, calls }
}

const paths = (calls: ApiCall[]): string[] => calls.map((call) => `${call.method} ${call.path}`)

const PR_REF = {
  number: 123,
  html_url: 'https://github.com/acme/app/pull/123',
  head: { sha: 'abc123def' },
}

describe('GitHubForge.pushBranch', () => {
  test('publishes HEAD to an explicit destination ref with no rewrite bypass (D1)', async () => {
    const calls: { cmd: string[]; cwd: string }[] = []
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
      path: 'repos/acme/app/pulls?head=acme%3Aab%2Ffix-login&state=open',
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

  test('ungated transient/conflict states defer, while an unexplained blocker fails closed with a reason', async () => {
    for (const state of ['unknown', 'dirty'] as const) {
      const { forge } = makeForge([prView(state), branchWith(fullProtection), ruleset([])])
      expect(await forge.setAutoMerge('/ws/build-1', 42, true)).toMatchObject({
        kind: 'deferred',
        reason: {
          code: 'unproven-gate-state',
          detail: expect.stringContaining(state.toUpperCase()),
        },
      })
    }
    const blocked = makeForge([prView('blocked'), branchWith(fullProtection), ruleset([])])
    expect(await blocked.forge.setAutoMerge('/ws/build-1', 42, true)).toMatchObject({
      kind: 'deferred',
      reason: { code: 'unproven-gate-state', detail: expect.stringContaining('BLOCKED') },
    })
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
    const { transport, calls } = makeTransport([{ json: [PR_REF] }])
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
