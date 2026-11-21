import { temporaryDirectories as ownTempDirectories } from '../../testing/temp-directories'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  GITHUB_GRAPHQL_RECHECK_MS,
  GitHubForge,
  MERGEABILITY_RETRY_DELAYS_MS,
  parseRepoCoordinates,
  refusedArchiveFallback,
  rulesetsHaveMergeGate,
} from './github'
import { FakeForge } from './fake'
import { LocalGitForge } from './local-git'
import {
  GitHubApiError,
  type GitHubRequest,
  type GitHubRequestOpts,
  type GitHubResponse,
} from './github-transport'
import { ForgeFailure, isForgeFailure, isForgeRejection } from '../forge-failure'
import { ForgeRequestDeferred } from '../forge-request-context'
import { isForgeMergeQueueRejection, NoCommitsBetweenBranchesError } from '../types'

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

  test('composes issue keywords into the created title and body with the repository identity', async () => {
    const { forge, calls } = makeForge([{ json: [] }, { json: PR_REF }])
    expect(forge.closesIssues).toBe(true)
    await forge.openPr({
      ...opts,
      title: 'Fixes acme/app#824: login',
      body: 'This fixes #824 and closes other/repo#824.\n\nFixes: #820\n',
      issueLinks: [
        { issue: 820, intent: 'closes' },
        { issue: 824, intent: 'refs' },
      ],
    })
    expect(calls[1]?.opts?.body).toEqual({
      title: 'Refs acme/app#824: login',
      head: 'ab/fix-login',
      base: 'main',
      body: 'This refs #824 and closes other/repo#824.\n\nCloses #820\nRefs #824\n',
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

  describe('adopting with issue links converges the keyword lines', () => {
    const refsOnly = [
      { issue: 820, intent: 'refs' as const },
      { issue: 824, intent: 'refs' as const },
    ]
    const pr = (title: string, body: string | null) => ({
      json: { number: 123, state: 'open', merged: false, title, body },
    })
    const converged = pr('Refs #820: login', 'Body.\n\nRefs #820\nRefs #824')

    test('a stale title and body are PATCHed once and confirmed by readback', async () => {
      const { forge, calls } = makeForge([
        { json: [PR_REF] },
        pr('Fix #820: login', 'Body.\n\nCloses #820\nCloses #824'),
        { json: {} },
        converged,
      ])
      expect((await forge.openPr({ ...opts, issueLinks: refsOnly })).number).toBe(123)
      expect(paths(calls)).toEqual([
        'GET repos/acme/app/pulls?head=acme%3Aab%2Ffix-login&base=main&state=open',
        'GET repos/acme/app/pulls/123',
        'PATCH repos/acme/app/pulls/123',
        'GET repos/acme/app/pulls/123',
      ])
      expect(calls[2]?.opts?.body).toEqual({
        title: 'Refs #820: login',
        body: 'Body.\n\nRefs #820\nRefs #824',
      })
    })

    test('an already converged PR makes no PATCH (retry or re-finalize)', async () => {
      const { forge, calls } = makeForge([{ json: [PR_REF] }, converged, converged])
      await forge.openPr({ ...opts, issueLinks: refsOnly })
      expect(paths(calls)).toEqual([
        'GET repos/acme/app/pulls?head=acme%3Aab%2Ffix-login&base=main&state=open',
        'GET repos/acme/app/pulls/123',
        'GET repos/acme/app/pulls/123',
      ])
    })

    test('only the body differing PATCHes only the body', async () => {
      const { forge, calls } = makeForge([
        { json: [PR_REF] },
        pr('Refs #820: login', 'Body.'),
        { json: {} },
        converged,
      ])
      await forge.openPr({ ...opts, issueLinks: refsOnly })
      expect(calls[2]?.opts?.body).toEqual({ body: 'Body.\n\nRefs #820\nRefs #824' })
    })

    test('a raced 422 adoption converges the same way', async () => {
      const { forge, calls } = makeForge([
        { json: [] },
        { status: 422, json: { message: 'A pull request already exists' } },
        { json: [PR_REF] },
        pr('Fix #820: login', 'Body.'),
        { json: {} },
        converged,
      ])
      expect((await forge.openPr({ ...opts, issueLinks: refsOnly })).number).toBe(123)
      expect(paths(calls).slice(3)).toEqual([
        'GET repos/acme/app/pulls/123',
        'PATCH repos/acme/app/pulls/123',
        'GET repos/acme/app/pulls/123',
      ])
      expect(calls[4]?.opts?.body).toEqual({
        title: 'Refs #820: login',
        body: 'Body.\n\nRefs #820\nRefs #824',
      })
    })

    test('a title readback that disagrees throws', async () => {
      const stale = pr('Fix #820: login', 'Body.\n\nRefs #820\nRefs #824')
      const { forge } = makeForge([{ json: [PR_REF] }, stale, { json: {} }, stale])
      await expect(forge.openPr({ ...opts, issueLinks: refsOnly })).rejects.toThrow(
        'title readback disagrees',
      )
    })
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

describe('GitHubForge.inspectHeadChecks', () => {
  const sha = 'c'.repeat(40)
  const runsPath = `repos/acme/app/commits/${sha}/check-runs?filter=latest&per_page=100`
  const statusPath = `repos/acme/app/commits/${sha}/status?per_page=100`
  const runs = (...entries: { name: string; status?: string; conclusion: string | null }[]) => ({
    total_count: entries.length,
    check_runs: entries.map((entry) => ({
      status: 'completed',
      html_url: `https://github.com/acme/app/runs/${entry.name}`,
      ...entry,
    })),
  })
  const statuses = (...entries: { context: string; state: string }[]) => ({
    state: 'pending',
    sha,
    total_count: entries.length,
    statuses: entries.map((entry) => ({ target_url: null, ...entry })),
  })
  /** The two reads run in parallel; answer each by path. */
  function routed(byPath: Record<string, Scripted[]>) {
    const calls: { path: string; opts?: unknown }[] = []
    const transport: GitHubRequest = async (_method, path, opts) => {
      calls.push({ path, ...(opts === undefined ? {} : { opts }) })
      const next = byPath[path]?.shift()
      if (!next) throw new Error(`unscripted ${path}`)
      const status = next.status ?? 200
      const headers = next.headers ?? {}
      if (status === 304) return { status, headers }
      if (status >= 300)
        throw new GitHubApiError(
          status,
          (next.json as { message?: string } | undefined)?.message ?? 'GitHub API error',
          next.json,
        )
      return { status, headers, json: next.json }
    }
    return { forge: new GitHubForge({ transport, repository: 'acme/app' }), calls }
  }

  test('a failing check run and an error status both report, with the run url', async () => {
    const { forge, calls } = routed({
      [runsPath]: [
        {
          json: runs(
            { name: 'unit', conclusion: 'failure' },
            { name: 'lint', conclusion: 'success' },
          ),
        },
      ],
      [statusPath]: [{ json: statuses({ context: 'ci/deploy', state: 'error' }) }],
    })
    expect(await forge.inspectHeadChecks('/ws', sha)).toEqual({
      kind: 'known',
      pending: false,
      failing: [
        {
          name: 'unit',
          source: 'check-run',
          conclusion: 'failure',
          url: 'https://github.com/acme/app/runs/unit',
        },
        { name: 'ci/deploy', source: 'status', conclusion: 'error' },
      ],
    })
    expect(calls.map((call) => call.path).sort()).toEqual([runsPath, statusPath].sort())
  })

  test('the latest-run filter lets a green re-run pass', async () => {
    const { forge } = routed({
      [runsPath]: [{ json: runs({ name: 'unit', conclusion: 'success' }) }],
      [statusPath]: [{ json: statuses() }],
    })
    expect(await forge.inspectHeadChecks('/ws', sha)).toEqual({
      kind: 'known',
      pending: false,
      failing: [],
    })
  })

  test('an unchanged head revalidates both reads with If-None-Match and reuses them on 304', async () => {
    const { forge, calls } = routed({
      [runsPath]: [
        { json: runs({ name: 'unit', conclusion: 'failure' }), headers: { etag: '"runs"' } },
        { status: 304 },
      ],
      [statusPath]: [{ json: statuses(), headers: { etag: '"status"' } }, { status: 304 }],
    })
    const first = await forge.inspectHeadChecks('/ws', sha)
    expect(await forge.inspectHeadChecks('/ws', sha)).toEqual(first)
    expect(
      calls
        .slice(2)
        .map((call) => call.opts)
        .sort(),
    ).toEqual(
      [
        { headers: { 'If-None-Match': '"runs"' } },
        { headers: { 'If-None-Match': '"status"' } },
      ].sort(),
    )
  })

  test('a forbidden read throws for the caller to treat as unknown', async () => {
    const { forge } = routed({
      [runsPath]: [{ status: 403, json: { message: 'Resource not accessible by integration' } }],
      [statusPath]: [{ json: statuses() }],
    })
    await expect(forge.inspectHeadChecks('/ws', sha)).rejects.toThrow()
  })

  test('a truncated listing with no visible failure is unknown', async () => {
    const { forge } = routed({
      [runsPath]: [
        { json: { ...runs({ name: 'unit', conclusion: 'success' }), total_count: 150 } },
      ],
      [statusPath]: [{ json: statuses() }],
    })
    expect(await forge.inspectHeadChecks('/ws', sha)).toEqual({
      kind: 'unknown',
      reason: 'truncated',
    })
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

  test('remoteBranchExists reads the exact ref and treats only 404 as absence', async () => {
    const { forge, calls } = makeForge([
      { json: { ref: 'refs/heads/ab/work', object: { sha: 'abc' } } },
      { status: 404, json: { message: 'Not Found' } },
      { status: 500, json: { message: 'Server Error' } },
    ])
    expect(await forge.remoteBranchExists('ab/work')).toBe(true)
    expect(calls).toEqual([{ method: 'GET', path: 'repos/acme/app/git/ref/heads/ab%2Fwork' }])
    expect(await forge.remoteBranchExists('ab/gone')).toBe(false)
    await expect(forge.remoteBranchExists('ab/broken')).rejects.toThrow()
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

type FakeCommit = { sha: string; commit: { message: string } }
interface FakeGitHub {
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

const PROXY_REFUSAL =
  'GitHub GraphQL is not available from Claude Code sessions. Use the REST API instead.'

const fakePr = (): FakeGitHub['pr'] => ({
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
function fakeGitHub(overrides: Partial<FakeGitHub> = {}, config: { now?: () => number } = {}) {
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

const isProbe = (call: ApiCall) =>
  call.path === 'graphql' && (call.opts!.body as { query: string }).query.includes('rateLimit')
/** GraphQL mutations; the availability probe is counted by {@link probeCalls}. */
const graphqlCalls = (calls: ApiCall[]) =>
  calls.filter((call) => call.path === 'graphql' && !isProbe(call))
const probeCalls = (calls: ApiCall[]) => calls.filter(isProbe)
const mutationKinds = (calls: ApiCall[]) =>
  graphqlCalls(calls).map((call) =>
    (call.opts!.body as { query: string }).query.includes('disablePullRequestAutoMerge')
      ? 'disable'
      : 'enable',
  )
const mergeCalls = (calls: ApiCall[]) => calls.filter((call) => call.method === 'PUT')

describe('GitHub stable build identity', () => {
  const headline = 'Server title — unchanged (#42)'
  const body = '* unusual bullet\n\nCo-authored-by: A <a@example.test>\n'
  const canonical = `${body}Autobuild-Build: stable-build\n`
  const identity = { buildSlug: 'stable-build' }
  const armed = (title: string | null = headline, message: string | null = canonical) => ({
    merge_method: 'squash',
    commit_title: title,
    commit_message: message,
  })
  const enableVariables = (calls: ApiCall[]) =>
    (
      graphqlCalls(calls).find((call) =>
        (call.opts!.body as { query: string }).query.includes('$expectedHeadOid'),
      )!.opts!.body as { variables: unknown }
    ).variables

  test.each([
    ['PR_TITLE', 'PR_BODY', 2, headline, canonical],
    ['PR_TITLE', 'BLANK', 2, headline, 'Autobuild-Build: stable-build\n'],
    [
      'PR_TITLE',
      'COMMIT_MESSAGES',
      2,
      headline,
      '* First commit\n\nFirst body\n\n* Second commit\n\nAutobuild-Build: stable-build\n',
    ],
    ['COMMIT_OR_PR_TITLE', 'PR_BODY', 2, headline, canonical],
    ['COMMIT_OR_PR_TITLE', 'PR_BODY', 1, 'Second commit (#42)', canonical],
    ['COMMIT_OR_PR_TITLE', 'BLANK', 1, 'Second commit (#42)', 'Autobuild-Build: stable-build\n'],
    [
      'COMMIT_OR_PR_TITLE',
      'COMMIT_MESSAGES',
      1,
      'Second commit (#42)',
      'Autobuild-Build: stable-build\n',
    ],
    [
      'COMMIT_OR_PR_TITLE',
      'COMMIT_MESSAGES',
      2,
      headline,
      '* First commit\n\nFirst body\n\n* Second commit\n\nAutobuild-Build: stable-build\n',
    ],
  ])(
    'ungated direct squash lands the %s / %s derivation (%i commits) with no GraphQL',
    async (title, message, count, landedTitle, landedMessage) => {
      const { forge, calls, fake } = fakeGitHub()
      fake.repo.squash_merge_commit_title = title
      fake.repo.squash_merge_commit_message = message
      if (count === 1) fake.commits = fake.commits.slice(1)
      fake.pr.commits = count
      await forge.withReadScope(async () => {
        expect(await forge.getPrState('/ws', 42)).toMatchObject({ state: 'open' })
        const result = await forge.setAutoMerge('/ws', 42, true, {
          ...identity,
          baseBranch: 'main',
        })
        expect(result).toEqual({ kind: 'ungated', headSha: 'head-42' })
        await forge.squashMerge('/ws', 42, 'head-42', { ...identity, baseBranch: 'main' })
      })
      expect(mergeCalls(calls).map((call) => call.opts?.body)).toEqual([
        {
          merge_method: 'squash',
          sha: 'head-42',
          commit_title: landedTitle,
          commit_message: landedMessage,
        },
      ])
      expect(graphqlCalls(calls)).toEqual([])
      // The direct squash re-checks the gate the enable inspection read.
      expect(calls.filter((call) => call.path.includes('/rules/branches/'))).toHaveLength(1)
    },
  )

  describe('with issue links', () => {
    const issueLinks = [
      { issue: 820, intent: 'closes' as const },
      { issue: 824, intent: 'refs' as const },
    ]
    const options = { buildSlug: 'stable-build', issueLinks }
    const composedHeadline = 'Refs #824 (#42)'
    const composedBody =
      '* refs acme/app#824 in a commit subject\n\nCloses #820\nRefs #824\n\nCo-authored-by: A <a@example.test>\nAutobuild-Build: stable-build\n'
    const linked = () => {
      const github = fakeGitHub()
      github.fake.pr.title = 'Fixes #824'
      github.fake.pr.body =
        '* fixes acme/app#824 in a commit subject\n\nCo-authored-by: A <a@example.test>\n'
      return github
    }

    test('direct squash lands neutralized text and the keyword paragraph before trailers', async () => {
      const { forge, calls } = linked()
      await forge.squashMerge('/absent', 42, 'head-42', options)
      expect(mergeCalls(calls)[0]?.opts?.body).toEqual({
        merge_method: 'squash',
        sha: 'head-42',
        commit_title: composedHeadline,
        commit_message: composedBody,
      })
    })

    test('native enable writes the same composition and an applied request makes no mutation', async () => {
      const { forge, calls, fake } = linked()
      fake.pr.mergeable_state = 'blocked'
      fake.gated = true
      expect(await forge.setAutoMerge('/absent', 42, true, options)).toEqual({ kind: 'applied' })
      expect(enableVariables(calls)).toEqual({
        pullRequestId: 'PR_42',
        mergeMethod: 'SQUASH',
        expectedHeadOid: 'head-42',
        commitHeadline: composedHeadline,
        commitBody: composedBody,
      })
      const before = graphqlCalls(calls).length
      expect(await forge.setAutoMerge('/absent', 42, true, options)).toEqual({ kind: 'applied' })
      expect(graphqlCalls(calls)).toHaveLength(before)
    })
  })

  test.each([
    ['moved head', (pr: FakeGitHub['pr']) => (pr.head = { ...pr.head, sha: 'new-head' })],
    ['closed', (pr: FakeGitHub['pr']) => (pr.state = 'closed')],
    [
      'merged',
      (pr: FakeGitHub['pr']) => {
        pr.state = 'closed'
        pr.merged = true
        pr.merge_commit_sha = 'merged-sha'
      },
    ],
    ['retargeted base', (pr: FakeGitHub['pr']) => (pr.base = { ...pr.base, ref: 'release' })],
  ])('a %s refuses direct squash and defers native', async (_name, change) => {
    const direct = fakeGitHub()
    change(direct.fake.pr)
    await expect(
      direct.forge.squashMerge('/absent', 42, 'head-42', { ...identity, baseBranch: 'main' }),
    ).rejects.toThrow()
    expect(mergeCalls(direct.calls)).toEqual([])
    // Native landing takes no expected head; its head race is the next test.
    if (_name === 'moved head') return
    const native = fakeGitHub()
    change(native.fake.pr)
    native.fake.pr.mergeable_state = 'blocked'
    native.fake.gated = true
    expect(
      await native.forge.setAutoMerge('/absent', 42, true, { ...identity, baseBranch: 'main' }),
    ).toMatchObject({ kind: 'deferred' })
    expect(graphqlCalls(native.calls)).toEqual([])
  })

  test('a head that moves during the mergeability re-query never enables', async () => {
    const { forge, calls } = fakeGitHub({
      gated: true,
      beforePrRead: (fake, read) => {
        fake.pr.mergeable_state = read === 1 ? 'unknown' : 'blocked'
        if (read > 1) fake.pr.head = { ...fake.pr.head, sha: 'new-head' }
      },
    })
    expect(await forge.setAutoMerge('/absent', 42, true, identity)).toEqual({ kind: 'deferred' })
    expect(graphqlCalls(calls)).toEqual([])
  })

  test('native enable uses guarded typed message overrides and confirms them by a fresh REST readback', async () => {
    const { forge, calls, fake } = fakeGitHub()
    fake.pr.mergeable_state = 'blocked'
    fake.gated = true
    expect(await forge.setAutoMerge('/absent', 42, true, identity)).toEqual({ kind: 'applied' })
    const mutation = graphqlCalls(calls)[0]!.opts!.body as { query: string }
    expect(mutation.query).toContain('$expectedHeadOid: GitObjectID!')
    expect(mutation.query).toContain('$mergeMethod: PullRequestMergeMethod!')
    expect(enableVariables(calls)).toEqual({
      pullRequestId: 'PR_42',
      mergeMethod: 'SQUASH',
      expectedHeadOid: 'head-42',
      commitHeadline: headline,
      commitBody: canonical,
    })
    const readback = calls.slice(calls.indexOf(graphqlCalls(calls)[0]!) + 1)[0]!
    expect(`${readback.method} ${readback.path}`).toBe('GET repos/acme/app/pulls/42')
    expect(readback.opts?.headers?.['If-None-Match']).toBeUndefined()
  })

  test.each([
    ['unset overrides', armed(null, null)],
    ['unset title', armed(null)],
    ['unset message', armed(headline, null)],
    ['an old GraphQL-derived title', armed('Server title — unchanged (#42) — old')],
    ['an old GraphQL-derived body', armed(headline, 'Old body\n\nAutobuild-Build: stable-build\n')],
    ['a merge method', { ...armed(), merge_method: 'merge' }],
  ])('a legacy request with %s is repaired once and then settles', async (_name, request) => {
    const { forge, calls, fake } = fakeGitHub()
    fake.pr.auto_merge = request
    expect(await forge.setAutoMerge('/absent', 42, true, identity)).toEqual({ kind: 'applied' })
    expect(mutationKinds(calls)).toEqual(['disable', 'enable'])
    expect(await forge.setAutoMerge('/absent', 42, true, identity)).toEqual({ kind: 'applied' })
    expect(mutationKinds(calls)).toEqual(['disable', 'enable'])
  })

  test.each([
    [
      'trims the final newline',
      (title: string, message: string) => armed(title, message.trimEnd()),
    ],
    [
      'stores CRLF',
      (title: string, message: string) => armed(title, message.replaceAll('\n', '\r\n')),
    ],
  ])('a provider that %s settles without oscillating across ticks', async (_name, armedAs) => {
    const { forge, calls, fake } = fakeGitHub({ armedAs })
    fake.pr.auto_merge = armed('Old title (#42)')
    for (let tick = 0; tick < 3; tick++)
      await forge.withReadScope(async () => {
        await forge.getPrState('/ws', 42)
        expect(
          await forge.setAutoMerge('/absent', 42, true, {
            ...identity,
            baseBranch: 'main',
            canApply: async () => {
              if (tick > 0) throw new Error('quiet poll refreshed consent')
              return true
            },
          }),
        ).toEqual({ kind: 'applied' })
      })
    expect(mutationKinds(calls)).toEqual(['disable', 'enable'])
  })

  test('unset overrides after enable remain unconfirmed rather than being acknowledged', async () => {
    const { forge, fake } = fakeGitHub({ armedAs: () => armed(null, null) })
    fake.pr.mergeable_state = 'blocked'
    fake.gated = true
    expect(await forge.setAutoMerge('/absent', 42, true, identity)).toMatchObject({
      kind: 'deferred',
      reason: { code: 'unproven-gate-state', detail: expect.stringContaining('not confirmed') },
    })
  })

  test('cancellation during repair prevents re-enable', async () => {
    let guards = 0
    const { forge, calls, fake } = fakeGitHub()
    fake.pr.auto_merge = armed(headline, 'old')
    expect(
      await forge.setAutoMerge('/absent', 42, true, {
        ...identity,
        canApply: async () => ++guards === 1,
      }),
    ).toEqual({ kind: 'deferred' })
    expect(mutationKinds(calls)).toEqual(['disable'])
  })

  test.each([
    ['a head race', (fake: FakeGitHub) => (fake.pr.head = { ...fake.pr.head, sha: 'new-head' })],
    [
      'a merge',
      (fake: FakeGitHub) => {
        fake.pr.state = 'closed'
        fake.pr.merged = true
        fake.pr.merge_commit_sha = 'merged-sha'
      },
    ],
    ['a retarget', (fake: FakeGitHub) => (fake.pr.base = { ...fake.pr.base, ref: 'release' })],
  ])('%s after disable never re-enables', async (_name, afterDisable) => {
    const { forge, calls, fake } = fakeGitHub({ afterDisable })
    fake.pr.auto_merge = armed(headline, 'old')
    expect(await forge.setAutoMerge('/absent', 42, true, identity)).toEqual({ kind: 'deferred' })
    expect(mutationKinds(calls)).toEqual(['disable'])
  })

  test('a failed repair cannot acknowledge', async () => {
    const { forge, fake } = fakeGitHub({ graphqlStatus: 403 })
    fake.pr.auto_merge = armed(headline, 'old')
    expect(await forge.setAutoMerge('/absent', 42, true, identity)).toMatchObject({
      kind: 'deferred',
      reason: { code: 'unproven-gate-state' },
    })
  })

  test('merge queues defer enable and repair and refuse direct squash; a matching quiet poll stays applied', async () => {
    const queue = [{ type: 'merge_queue', parameters: {} }]
    for (const request of [null, armed(headline, 'old')]) {
      const { forge, calls, fake } = fakeGitHub({ rules: queue })
      fake.pr.auto_merge = request
      fake.pr.mergeable_state = 'blocked'
      fake.gated = true
      expect(await forge.setAutoMerge('/absent', 42, true, identity)).toMatchObject({
        kind: 'deferred',
        reason: { code: 'unproven-gate-state', detail: expect.stringContaining('merge queues') },
      })
      expect(graphqlCalls(calls)).toEqual([])
    }
    const direct = fakeGitHub({ rules: queue })
    await expect(direct.forge.squashMerge('/absent', 42, 'head-42', identity)).rejects.toThrow(
      'merge queues',
    )
    expect(mergeCalls(direct.calls)).toEqual([])
    // By design the quiet poll of an already-matching request does not read
    // rules; every mutating path above does.
    const quiet = fakeGitHub({ rules: queue })
    quiet.fake.pr.auto_merge = armed()
    expect(await quiet.forge.setAutoMerge('/absent', 42, true, identity)).toEqual({
      kind: 'applied',
    })
    expect(quiet.calls.some((call) => call.path.includes('/rules/'))).toBe(false)
  })

  test.each(['squash_merge_commit_title', 'squash_merge_commit_message'])(
    'a repository response without %s fails closed',
    async (field) => {
      const native = fakeGitHub()
      delete native.fake.repo[field]
      native.fake.pr.mergeable_state = 'blocked'
      native.fake.gated = true
      expect(await native.forge.setAutoMerge('/absent', 42, true, identity)).toMatchObject({
        kind: 'deferred',
        reason: { code: 'unproven-gate-state', detail: expect.stringContaining('contents:write') },
      })
      expect(graphqlCalls(native.calls)).toEqual([])
      const direct = fakeGitHub()
      delete direct.fake.repo[field]
      await expect(direct.forge.squashMerge('/absent', 42, 'head-42', identity)).rejects.toThrow(
        field,
      )
      expect(mergeCalls(direct.calls)).toEqual([])
    },
  )

  test('a commit list that does not end at the PR head never merges', async () => {
    const { forge, calls, fake } = fakeGitHub()
    fake.repo.squash_merge_commit_message = 'COMMIT_MESSAGES'
    fake.commits = [fake.commits[0]!, { sha: 'other', commit: { message: 'Other' } }]
    await expect(forge.squashMerge('/absent', 42, 'head-42', identity)).rejects.toThrow('retry')
    expect(mergeCalls(calls)).toEqual([])
  })

  describe('commit-set cache', () => {
    const commitReads = (calls: ApiCall[]) =>
      calls.filter((call) => call.path === 'repos/acme/app/pulls/42/commits').length
    const tick = (forge: GitHubForge) =>
      forge.withReadScope(async () => {
        await forge.getPrState('/ws', 42)
        return forge.setAutoMerge('/absent', 42, true, { ...identity, baseBranch: 'main' })
      })

    test.each([true, false])(
      'a base advance that absorbs a commit invalidates the cache (base sha moves: %s)',
      async (baseShaMoves) => {
        const { forge, calls, fake } = fakeGitHub()
        fake.repo.squash_merge_commit_title = 'COMMIT_OR_PR_TITLE'
        fake.repo.squash_merge_commit_message = 'COMMIT_MESSAGES'
        fake.pr.auto_merge = armed(
          headline,
          '* First commit\n\nFirst body\n\n* Second commit\n\nAutobuild-Build: stable-build\n',
        )
        expect(await tick(forge)).toEqual({ kind: 'applied' })
        expect(commitReads(calls)).toBe(1)
        expect(await tick(forge)).toEqual({ kind: 'applied' })
        expect(commitReads(calls)).toBe(1)
        // Another PR merged the first commit into main.
        fake.commits = fake.commits.slice(1)
        fake.pr.commits = 1
        if (baseShaMoves) fake.pr.base = { ...fake.pr.base, sha: 'base-2' }
        expect(await tick(forge)).toEqual({ kind: 'applied' })
        expect(commitReads(calls)).toBe(2)
        expect(mutationKinds(calls)).toEqual(['disable', 'enable'])
        expect(enableVariables(calls)).toMatchObject({
          commitHeadline: 'Second commit (#42)',
          commitBody: 'Autobuild-Build: stable-build\n',
        })
      },
    )
  })

  describe('more than 250 commits', () => {
    const many = Array.from({ length: 251 }, (_, index) => ({
      sha: index === 250 ? 'head-42' : `c${index}`,
      commit: { message: `Commit ${index}` },
    }))
    const large = () => {
      const github = fakeGitHub()
      github.fake.commits = many.map((commit) => structuredClone(commit))
      github.fake.pr.commits = 251
      github.fake.repo.squash_merge_commit_message = 'COMMIT_MESSAGES'
      return github
    }

    test('pages the compare through every commit and caches the result', async () => {
      const { forge, calls } = large()
      await forge.squashMerge('/absent', 42, 'head-42', identity)
      expect(calls.some((call) => call.path.endsWith('/pulls/42/commits'))).toBe(false)
      const compares = calls.filter((call) => call.path.includes('/compare/'))
      expect(compares.map((call) => call.path)).toEqual(
        Array(3).fill('repos/acme/app/compare/main...head-42'),
      )
      expect(compares.map((call) => call.opts?.query)).toEqual(
        [1, 2, 3].map((page) => ({ per_page: '100', page: String(page) })),
      )
      expect(mergeCalls(calls)[0]?.opts?.body).toMatchObject({
        commit_message: `${many.map((c) => `* ${c.commit.message}`).join('\n\n')}\n\nAutobuild-Build: stable-build\n`,
      })
      await forge.squashMerge('/absent', 42, 'head-42', identity)
      expect(calls.filter((call) => call.path.includes('/compare/'))).toHaveLength(3)
    })

    test.each([
      ['total disagrees with the PR', (fake: FakeGitHub) => (fake.pr.commits = 252)],
      ['a short page', (fake: FakeGitHub) => fake.commits.splice(150, 1)],
      [
        'a missing head',
        (fake: FakeGitHub) => (fake.commits[250] = { sha: 'c250', commit: { message: 'x' } }),
      ],
    ])('%s fails closed', async (_name, change) => {
      const direct = large()
      change(direct.fake)
      if (_name === 'a short page') direct.fake.pr.commits = 251
      await expect(direct.forge.squashMerge('/absent', 42, 'head-42', identity)).rejects.toThrow(
        'retry',
      )
      expect(mergeCalls(direct.calls)).toEqual([])
      const native = large()
      change(native.fake)
      native.fake.pr.mergeable_state = 'blocked'
      native.fake.gated = true
      expect(await native.forge.setAutoMerge('/absent', 42, true, identity)).toMatchObject({
        kind: 'deferred',
        reason: { code: 'unproven-gate-state' },
      })
      expect(graphqlCalls(native.calls)).toEqual([])
    })

    test('a total that changes between pages fails closed', async () => {
      const { forge, calls, fake } = large()
      let pages = 0
      const real = fake.commits
      Object.defineProperty(fake, 'commits', {
        get: () => (++pages > 1 && pages < 5 ? [...real, real[0]!] : real),
      })
      await expect(forge.squashMerge('/absent', 42, 'head-42', identity)).rejects.toThrow('retry')
      expect(mergeCalls(calls)).toEqual([])
    })
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
  const noCommits = await empty.forge.openPr(opts).catch((error: unknown) => error)
  expect(noCommits).toBeInstanceOf(NoCommitsBetweenBranchesError)
  expect(noCommits).toMatchObject({
    name: 'NoCommitsBetweenBranchesError',
    message: 'No commits between main and ab-node/x',
    forge: 'GitHub',
    status: 422,
    forgeMessage: 'Validation Failed: No commits between main and ab-node/x',
  })
  expect(isForgeRejection(noCommits)).toBe(true)
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
  await expect(unrelated.forge.openPr(opts)).rejects.toMatchObject({
    name: 'ForgeRejection',
    forge: 'GitHub',
    status: 422,
    forgeMessage: 'Validation Failed: base is invalid',
  })
})

test('GitHub PR-create client errors are forge rejections; transient and rate limits are not', async () => {
  const opts = {
    workspacePath: '/ws',
    head: 'ab/x',
    base: 'main',
    title: 'Leaf',
    body: 'Body',
  }
  const forbidden = makeForge([
    { json: [] },
    { status: 403, json: { message: 'Resource not accessible by integration' } },
  ])
  const rejected = await forbidden.forge.openPr(opts).catch((error: unknown) => error)
  expect(isForgeRejection(rejected)).toBe(true)
  expect(isForgeFailure(rejected)).toBe(false)
  expect(rejected).toMatchObject({
    status: 403,
    forgeMessage: 'Resource not accessible by integration',
  })
  // A non-422 rejection makes no adoption probe after the create.
  expect(forbidden.calls.map((call) => call.method)).toEqual(['GET', 'POST'])

  const unavailable = makeForge([{ json: [] }, { status: 502, json: { message: 'Bad Gateway' } }])
  const transient = await unavailable.forge.openPr(opts).catch((error: unknown) => error)
  expect(isForgeRejection(transient)).toBe(false)
  expect(transient).toMatchObject({ details: { kind: 'transient' } })

  const limited = makeForge([
    { json: [] },
    {
      status: 403,
      json: { message: 'API rate limit exceeded' },
      headers: {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 600),
      },
    },
  ])
  const rateLimited = await limited.forge.openPr(opts).catch((error: unknown) => error)
  expect(isForgeRejection(rateLimited)).toBe(false)
  expect(rateLimited).toMatchObject({ details: { kind: 'rate-limited' } })

  const raced = makeForge([
    { json: [] },
    { status: 422, json: { message: 'Validation Failed' } },
    { json: [{ ...PR_REF, head: { sha: 'abc123def', ref: 'ab/x' } }] },
  ])
  expect(await raced.forge.openPr(opts)).toMatchObject({ number: 123 })
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

describe('GitHubForge.updatePrIssueLinks', () => {
  const view = (body: string | null, over: Record<string, unknown> = {}) => ({
    json: { number: 7, state: 'open', merged: false, title: 'Integration: N', body, ...over },
  })
  const links = [
    { issue: 5, intent: 'refs' as const },
    { issue: 820, intent: 'closes' as const },
  ]
  const composed = 'Integration build n.\n\nRefs #5\nCloses #820'

  test('an ordinary open, unmerged PR gets the keyword block and a confirmed readback', async () => {
    const { forge, calls } = makeForge([view('Integration build n.'), { json: {} }, view(composed)])
    await forge.updatePrIssueLinks('.', 7, links)
    expect(paths(calls)).toEqual([
      'GET repos/acme/app/pulls/7',
      'PATCH repos/acme/app/pulls/7',
      'GET repos/acme/app/pulls/7',
    ])
    expect(calls[1]?.opts?.body).toEqual({ body: composed })
  })

  test('a null body receives only the keyword block', async () => {
    const { forge, calls } = makeForge([view(null), { json: {} }, view('Refs #5\nCloses #820')])
    await forge.updatePrIssueLinks('.', 7, links)
    expect(calls[1]?.opts?.body).toEqual({ body: 'Refs #5\nCloses #820' })
  })

  test('prose survives, a stale Closes flips to Refs and a qualified closing reference is neutralized', async () => {
    const before = 'Fixes acme/app#5 eventually.\r\n\r\nCloses #5\r\nCloses #820\r\n'
    const after = 'Refs acme/app#5 eventually.\n\nRefs #5\nCloses #820\n'
    const { forge, calls } = makeForge([view(before), { json: {} }, view(after)])
    await forge.updatePrIssueLinks('.', 7, links)
    expect(calls[1]?.opts?.body).toEqual({ body: after })
  })

  test('an already composed body, CRLF or trailing whitespace makes no PATCH', async () => {
    const crlf = `${composed.replace(/\n/g, '\r\n')}\r\n  `
    const { forge, calls } = makeForge([view(crlf), view(crlf)])
    await forge.updatePrIssueLinks('.', 7, links)
    expect(paths(calls)).toEqual(['GET repos/acme/app/pulls/7', 'GET repos/acme/app/pulls/7'])
  })

  test('closed and merged PRs refuse before any PATCH', async () => {
    for (const over of [{ state: 'closed' }, { state: 'closed', merged: true }, { merged: true }]) {
      const { forge, calls } = makeForge([view('x', over)])
      await expect(forge.updatePrIssueLinks('.', 7, links)).rejects.toThrow('is not open')
      expect(paths(calls)).toEqual(['GET repos/acme/app/pulls/7'])
    }
  })

  test('a readback that disagrees throws', async () => {
    const { forge } = makeForge([view('x'), { json: {} }, view('x')])
    await expect(forge.updatePrIssueLinks('.', 7, links)).rejects.toThrow('readback disagrees')
  })

  test('a closing title reference to a linked refs issue is neutralized', async () => {
    const title = 'Integration: N fixes #5'
    const neutral = 'Integration: N refs #5'
    const { forge, calls } = makeForge([
      view(composed, { title }),
      { json: {} },
      view(composed, { title: neutral }),
    ])
    await forge.updatePrIssueLinks('.', 7, links)
    expect(calls[1]?.opts?.body).toEqual({ title: neutral })
  })

  test('a title readback that disagrees throws', async () => {
    const title = 'Integration: N fixes #5'
    const { forge } = makeForge([
      view(composed, { title }),
      { json: {} },
      view(composed, { title }),
    ])
    await expect(forge.updatePrIssueLinks('.', 7, links)).rejects.toThrow(
      'title readback disagrees',
    )
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
            expect(await forge.getPrState('/ws', 1)).toEqual({
              state: 'open',
              mergeable: true,
              headSha: 'node-sha',
            })
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

  // Criterion: a pending landing whose PR has not changed costs no more per
  // tick than before. The pre-change baseline was 2 requests per build per
  // tick: the conditional PR poll plus one GraphQL squash-message query.
  test('an armed matching landing revalidates with two conditional REST reads per quiet tick', async () => {
    const { forge, calls, fake } = fakeGitHub()
    fake.repo.squash_merge_commit_title = 'COMMIT_OR_PR_TITLE'
    fake.repo.squash_merge_commit_message = 'COMMIT_MESSAGES'
    fake.pr.auto_merge = {
      merge_method: 'squash',
      commit_title: 'Server title — unchanged (#42)',
      commit_message:
        '* First commit\n\nFirst body\n\n* Second commit\n\nAutobuild-Build: stable-build\n',
    }
    const outcomes: (string | undefined)[] = []
    forge.observeRequests((ctx) => outcomes.push(ctx.outcome))
    const perTick: ApiCall[][] = []
    for (let tick = 0; tick < 3; tick++) {
      const before = calls.length
      await forge.withReadScope(async () => {
        expect(await forge.getPrState('/ws', 42)).toMatchObject({ nativeAutoMerge: true })
        expect(
          await forge.setAutoMerge('/ws', 42, true, {
            buildSlug: 'stable-build',
            baseBranch: 'main',
          }),
        ).toEqual({ kind: 'applied' })
      })
      perTick.push(calls.slice(before))
    }
    expect(perTick[0]!.map((call) => call.path)).toEqual([
      'repos/acme/app/pulls/42',
      'repos/acme/app',
      'repos/acme/app/pulls/42/commits',
    ])
    for (const quiet of perTick.slice(1)) {
      expect(quiet.map((call) => call.path)).toEqual(['repos/acme/app/pulls/42', 'repos/acme/app'])
      for (const call of quiet) expect(call.opts?.headers?.['If-None-Match']).toBeDefined()
    }
    expect(outcomes.slice(3)).toEqual(Array(4).fill('restNotModified'))
    expect(outcomes).not.toContain('graphql')
  })

  test('builds in one tick share the repository settings read', async () => {
    const { forge, calls, fake } = fakeGitHub()
    const matching = {
      merge_method: 'squash',
      commit_title: 'Server title — unchanged (#42)',
      commit_message: `${fake.pr.body}Autobuild-Build: stable-build\n`,
    }
    fake.pr.auto_merge = matching
    fake.others = {
      43: {
        ...structuredClone(fake.pr),
        number: 43,
        node_id: 'PR_43',
        auto_merge: { ...matching, commit_title: 'Server title — unchanged (#43)' },
      },
    }
    for (let tick = 0; tick < 2; tick++) {
      const before = calls.length
      await forge.withReadScope(async () => {
        for (const number of [42, 43]) {
          await forge.getPrState('/ws', number)
          expect(
            await forge.setAutoMerge('/ws', number, true, {
              buildSlug: 'stable-build',
              baseBranch: 'main',
            }),
          ).toEqual({ kind: 'applied' })
        }
      })
      expect(calls.slice(before).map((call) => call.path)).toEqual([
        'repos/acme/app/pulls/42',
        'repos/acme/app',
        'repos/acme/app/pulls/43',
      ])
    }
    expect(graphqlCalls(calls)).toEqual([])
  })

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
      if (path.endsWith('/pulls/1'))
        return {
          status: 200,
          headers: {} as Record<string, string>,
          json: { node_id: 'PR_1', auto_merge: {} },
        }
      throw new Error('network down')
    },
  })
  const outcomes: (string | undefined)[] = []
  forge.observeRequests((ctx) => outcomes.push(ctx.outcome))
  await forge.remoteBranchSha('main')
  await forge.remoteBranchSha('main')
  await expect(forge.remoteBranchSha('main')).rejects.toThrow()
  await expect(forge.remoteBranchSha('main')).rejects.toThrow()
  await expect(forge.setAutoMerge('/ws', 1, false)).rejects.toThrow()
  expect(outcomes).toEqual([
    'restPrimary',
    'restNotModified',
    'restPrimary',
    undefined,
    'restPrimary',
    'graphql',
  ])
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

test('landing reads with mutation in their inputs do not invalidate an observation epoch', async () => {
  let branches = 0
  const forge = new GitHubForge({
    repository: 'acme/app',
    transport: async (_method, path) => {
      if (path === 'graphql') throw new Error('landing reads must not use GraphQL')
      if (!path.includes('mutation-branch')) throw new Error('landing read unavailable')
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

for (const entry of ['rewrite', 'kernelRewrite'] as const) {
  for (const outcome of [
    'success',
    'lost',
    'race',
    'malformed',
    'invalid',
    'missing',
    'policy',
  ] as const) {
    test(`${entry} creates remote-only archives: ${outcome}`, async () => {
      const sha = 'a'.repeat(40)
      const ref = `refs/autobuild/archive/probe/${sha}`
      let published = false
      let materialized = false
      const forge = new GitHubForge({
        repository: 'acme/app',
        token: 'test-token',
        exec: async (cmd) => {
          expect(cmd[1]).not.toBe('push')
          if (cmd[1] === 'fetch') materialized = true
          return {
            exitCode: cmd[1] === 'cat-file' && !materialized ? 1 : 0,
            stdout: cmd[1] === 'ls-remote' && published ? `${sha}\t${ref}\n` : '',
            stderr: '',
          }
        },
        transport: async (method, path, opts) => {
          expect(method).toBe('POST')
          expect(path).toBe('repos/acme/app/git/refs')
          expect(opts?.body).toEqual({ ref, sha })
          if (outcome === 'missing' || outcome === 'policy')
            throw new GitHubApiError(outcome === 'missing' ? 422 : 403, outcome)
          if (outcome === 'invalid') return { status: 201, headers: {}, json: {} }
          published = true
          if (outcome === 'race') throw new GitHubApiError(422, 'already exists')
          if (outcome === 'lost') throw new Error('lost acknowledgement')
          return {
            status: 201,
            headers: {},
            json: outcome === 'malformed' ? {} : { ref, object: { sha, type: 'commit' } },
          }
        },
      })
      const promise = forge[entry].archive({ workspacePath: '/ws', sha, ref })
      if (outcome === 'missing' || outcome === 'policy' || outcome === 'invalid') {
        await expect(promise).rejects.toThrow(ref)
        expect(materialized).toBe(false)
      } else {
        await promise
        expect(materialized).toBe(true)
      }
    })
  }
}
for (const entry of ['rewrite', 'kernelRewrite'] as const) {
  const sha = 'a'.repeat(40)
  const ref = `refs/autobuild/archive/probe/${sha}`
  const refusal = 'remote: pushes of anything other than a branch are not allowed'
  function refusedForge(
    respond: (method: string, path: string, opts?: GitHubRequestOpts) => GitHubResponse,
    push = { exitCode: 1, stderr: refusal },
  ) {
    const calls: { method: string; path: string; body: unknown }[] = []
    const state = { published: false }
    const forge = new GitHubForge({
      repository: 'acme/app',
      token: 'test-token',
      exec: async (cmd) => {
        if (cmd[1] === 'push') {
          if (push.exitCode === 0) state.published = true
          return { stdout: '', ...push }
        }
        return {
          exitCode: 0,
          stdout: cmd[1] === 'ls-remote' && state.published ? `${sha}\t${ref}\n` : '',
          stderr: '',
        }
      },
      transport: async (method, path, opts) => {
        calls.push({ method, path, body: opts?.body })
        return respond(method, path, opts)
      },
    })
    const archive = () => forge[entry].archive({ workspacePath: '/ws', sha, ref })
    return { archive, calls, state }
  }
  const post = { method: 'POST', path: 'repos/acme/app/git/refs', body: { ref, sha } }
  const probe = { method: 'GET', path: `repos/acme/app/git/commits/${sha}`, body: undefined }

  for (const outcome of [
    'success',
    'rest-failure',
    'readback-mismatch',
    'local-only',
    'race',
  ] as const) {
    test(`${entry} falls back to REST archive creation after a refused push: ${outcome}`, async () => {
      const h = refusedForge((method) => {
        if (method === 'GET') {
          if (outcome === 'local-only') throw new GitHubApiError(404, 'Not Found')
          h.state.published = true // a concurrent writer published the same SHA
          return { status: 200, headers: {}, json: { sha } }
        }
        if (outcome === 'rest-failure') throw new GitHubApiError(403, 'Resource not accessible')
        if (outcome === 'local-only' || outcome === 'race')
          throw new GitHubApiError(422, 'Object does not exist')
        if (outcome === 'success') h.state.published = true
        return { status: 201, headers: {}, json: { ref, object: { sha, type: 'commit' } } }
      })
      const result = h.archive().then(
        () => undefined,
        (error: unknown) => error as Error,
      )
      const failure = await result
      for (const call of h.calls)
        expect(JSON.stringify(call.body ?? {})).not.toMatch(/refs\/(?:heads|tags)\//)
      if (outcome === 'success') {
        expect(failure).toBeUndefined()
        expect(h.calls).toEqual([post])
      } else if (outcome === 'race') {
        expect(failure).toBeUndefined()
        expect(h.calls).toEqual([post, probe])
      } else if (outcome === 'rest-failure') {
        expect(failure?.message).toContain(`git push refused (${refusal})`)
        expect(failure?.message).toContain('GitHub REST ref creation failed (')
        expect(failure?.message).toContain('Resource not accessible')
        expect(h.calls).toEqual([post])
      } else if (outcome === 'readback-mismatch') {
        expect(failure?.message).toContain('git push refused')
        expect(failure?.message).toContain('did not confirm publication')
        expect(h.calls).toEqual([post])
      } else {
        expect(failure?.message).toContain('refuses non-branch git pushes')
        expect(failure?.message).toContain('exists only in the local workspace')
        expect(failure?.message).toContain('git push refused')
        expect(h.calls).toEqual([post, probe])
      }
    })
  }

  test(`${entry} successful archive push makes no GitHub requests`, async () => {
    const h = refusedForge(
      () => {
        throw new Error('no REST request expected')
      },
      { exitCode: 0, stderr: '' },
    )
    await h.archive()
    expect(h.calls).toEqual([])
  })

  for (const [label, failure] of [
    ['transient', new ForgeFailure('unavailable', { kind: 'transient', retry: 'retryable' })],
    [
      'rate-limited',
      new ForgeFailure('rate limited', { kind: 'rate-limited', resetAt: '2026-11-17T12:00:00Z' }),
    ],
    ['deferred', new ForgeRequestDeferred('deferred')],
  ] as const) {
    test(`${entry} typed commit probe failure after a 422 keeps its class: ${label}`, async () => {
      const h = refusedForge((method) => {
        if (method === 'GET') throw failure
        throw new GitHubApiError(422, 'Object does not exist')
      })
      await expect(h.archive()).rejects.toBe(failure)
      expect(h.calls).toEqual([post, probe])
    })
    test(`${entry} typed REST creation failure after a refusal keeps its class: ${label}`, async () => {
      const h = refusedForge(() => {
        throw failure
      })
      await expect(h.archive()).rejects.toBe(failure)
      expect(h.calls).toEqual([post])
    })
  }
}
describe('refused archive fallback for guest transports', () => {
  const sha = 'a'.repeat(40)
  const ref = `refs/autobuild/archive/probe/${sha}`
  function forge(respond: (method: string) => GitHubResponse) {
    const calls: { method: string; path: string; body: unknown }[] = []
    const forge = new GitHubForge({
      repository: 'acme/app',
      token: 'test-token',
      transport: async (method, path, opts) => {
        calls.push({ method, path, body: opts?.body })
        return respond(method)
      },
    })
    return { forge, calls }
  }

  test('the GitHub fallback issues the create-only archive ref POST', async () => {
    const h = forge(() => ({
      status: 201,
      headers: {},
      json: { ref, object: { sha, type: 'commit' } },
    }))
    await refusedArchiveFallback(h.forge)!(ref, sha)
    expect(h.calls).toEqual([
      { method: 'POST', path: 'repos/acme/app/git/refs', body: { ref, sha } },
    ])
  })

  test('a commit GitHub lacks gets the actionable local-only error', async () => {
    const h = forge((method) => {
      if (method === 'GET') throw new GitHubApiError(404, 'Not Found')
      throw new GitHubApiError(422, 'Object does not exist')
    })
    await expect(refusedArchiveFallback(h.forge)!(ref, sha)).rejects.toThrow(
      'exists only in the local workspace',
    )
    expect(h.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST repos/acme/app/git/refs',
      `GET repos/acme/app/git/commits/${sha}`,
    ])
  })

  test('non-GitHub forges have no fallback', () => {
    expect(refusedArchiveFallback(new FakeForge())).toBeUndefined()
    expect(refusedArchiveFallback(new LocalGitForge({ repoRoot: '/repo' }))).toBeUndefined()
  })
})

describe('immutable ancestry proof', () => {
  const ancestor = 'a'.repeat(40)
  const descendant = 'b'.repeat(40)
  test.each(['ahead', 'identical', 'behind', 'diverged'])('%s comparison', async (status) => {
    const { forge, calls } = makeForge([{ json: { status, ahead_by: 0, behind_by: 0 } }])
    expect(await forge.isCommitAncestor(ancestor, descendant)).toBe(
      status === 'ahead' || status === 'identical',
    )
    expect(paths(calls)).toEqual([`GET repos/acme/app/compare/${ancestor}...${descendant}`])
  })
  test.each([{}, { status: 'unknown' }, { ahead_by: 1, behind_by: 0 }])(
    'malformed proof fails closed: %j',
    async (json) => {
      const { forge } = makeForge([{ json }])
      await expect(forge.isCommitAncestor(ancestor, descendant)).rejects.toThrow()
    },
  )
  test.each([404, 403, 429, 503])('HTTP %s is failure, never false ancestry', async (status) => {
    const { forge } = makeForge([{ status }])
    await expect(forge.isCommitAncestor(ancestor, descendant)).rejects.toThrow()
  })
  test('transport failures propagate', async () => {
    const error = new Error('connection reset')
    const forge = new GitHubForge({
      repository: 'acme/app',
      transport: async () => {
        throw error
      },
    })
    await expect(forge.isCommitAncestor(ancestor, descendant)).rejects.toThrow('connection reset')
  })
})

test('exact ancestry comparisons share one wire read within a dispatcher scope', async () => {
  const a = 'a'.repeat(40),
    b = 'b'.repeat(40)
  const { forge, calls } = makeForge([{ json: { status: 'ahead', ahead_by: 1, behind_by: 0 } }])
  await forge.withReadScope(async () => {
    expect(await forge.isCommitAncestor(a, b)).toBe(true)
    expect(await forge.isCommitAncestor(a, b)).toBe(true)
  })
  expect(calls).toHaveLength(1)
})

describe('GitHub landing when GraphQL is unavailable', () => {
  const identity = { buildSlug: 'polling-build' }
  const activityCalls = (calls: ApiCall[]) =>
    calls.filter((call) => call.path === 'repos/acme/app/activity')
  /** A gated PR in a GraphQL-blocked environment, at the given REST state. */
  const blocked = (state = 'blocked', overrides: Partial<FakeGitHub> = {}) => {
    let now = Date.parse('2026-11-17T00:00:00Z')
    const github = fakeGitHub(
      { gated: true, graphqlUnavailable: true, ...overrides },
      { now: () => now },
    )
    github.fake.pr.mergeable_state = state
    return { ...github, advance: (ms: number) => (now += ms) }
  }
  /** One dispatcher tick: the janitor poll, then the landing inspection. */
  const tick = (forge: GitHubForge, polling = false) =>
    forge.withReadScope(async () => {
      await forge.getPrState('/absent', 42)
      return forge.setAutoMerge('/absent', 42, true, {
        ...identity,
        ...(polling ? { polling } : {}),
      })
    })

  test('a blocked gated PR polls after one probe; quiet polls cost one conditional read', async () => {
    const { forge, calls, fake, transport } = blocked()
    expect(await tick(forge)).toEqual({
      kind: 'polling',
      headSha: 'head-42',
      clear: false,
      detail: "GitHub GraphQL is unavailable; PR #42 reports mergeable_state 'BLOCKED'",
    })
    expect(probeCalls(calls)).toHaveLength(1)
    expect(graphqlCalls(calls)).toEqual([])
    expect(activityCalls(calls)).toHaveLength(1)
    expect(activityCalls(calls)[0]!.opts?.query).toEqual({
      ref: 'refs/heads/main',
      activity_type: 'merge_queue_merge',
      per_page: '1',
    })

    for (const quiet of [forge, new GitHubForge({ transport, repository: 'acme/app' })]) {
      const before = calls.length
      expect(await tick(quiet, true)).toMatchObject({ kind: 'polling', clear: false })
      // One PR read (a 304 on the warm instance, a 200 on a fresh process);
      // no gate, activity, repository or GraphQL request.
      expect(paths(calls.slice(before))).toEqual(['GET repos/acme/app/pulls/42'])
    }
    expect(fake.pr.auto_merge).toBe(null)
  })

  test('availability is rechecked at most once per window, and only on a full evaluation', async () => {
    const { forge, calls, fake, advance } = blocked()
    await tick(forge)
    fake.pr.mergeable_state = 'clean'
    // Inside the window the clear tick's full path reuses the refusal.
    expect(await tick(forge, true)).toMatchObject({ kind: 'polling', clear: true })
    expect(probeCalls(calls)).toHaveLength(1)
    advance(GITHUB_GRAPHQL_RECHECK_MS)
    expect(await tick(forge, true)).toMatchObject({ kind: 'polling', clear: true })
    expect(probeCalls(calls)).toHaveLength(2)
    // The second refusal suppresses probes for the next window.
    await tick(forge, true)
    advance(GITHUB_GRAPHQL_RECHECK_MS - 1)
    await tick(forge, true)
    expect(probeCalls(calls)).toHaveLength(2)
  })

  test('a transient probe failure re-throws and leaves no suppression window', async () => {
    const { forge, calls, fake } = blocked('blocked', { graphqlStatus: 502 })
    const failure = await tick(forge).catch((error: unknown) => error)
    expect(isForgeFailure(failure)).toBe(true)
    delete fake.graphqlStatus
    expect(await tick(forge)).toMatchObject({ kind: 'polling', clear: false })
    expect(probeCalls(calls)).toHaveLength(2)
  })

  test.each(['clean', 'unstable', 'has_hooks'])(
    "'%s' is clear with one activity read",
    async (state) => {
      const { forge, calls } = blocked(state)
      expect(await tick(forge)).toMatchObject({ kind: 'polling', clear: true, headSha: 'head-42' })
      expect(activityCalls(calls)).toHaveLength(1)
    },
  )

  test.each(['blocked', 'behind', 'dirty', 'unknown', 'draft'])(
    "'%s' is never clear, and a quiet poll reads no activity",
    async (state) => {
      const { forge, calls } = blocked(state)
      const first = await tick(forge)
      expect(first).not.toMatchObject({ clear: true })
      // Every full-path evaluation reaches the queue check, whatever the state.
      expect(activityCalls(calls)).toHaveLength(1)
      const before = calls.length
      expect(await tick(forge, true)).toMatchObject({ kind: 'polling', clear: false })
      expect(activityCalls(calls.slice(before))).toEqual([])
      expect(mergeCalls(calls)).toEqual([])
    },
  )

  test('a clean PR that GitHub does not report mergeable is not clear', async () => {
    const { forge, fake } = blocked('clean')
    fake.pr.mergeable = null
    expect(await tick(forge)).toMatchObject({ kind: 'polling', clear: false })
  })

  test.each(['clean', 'unstable', 'has_hooks', 'blocked', 'behind', 'unknown', 'dirty', 'draft'])(
    "recorded merge-queue activity settles a '%s' PR on its first evaluation",
    async (state) => {
      // Classic required checks, no ruleset merge_queue rule.
      const { forge, calls } = blocked(state, {
        activity: [{ id: 1, activity_type: 'merge_queue_merge', ref: 'refs/heads/main' }],
      })
      expect(await tick(forge)).toEqual({
        kind: 'human-merge',
        cause: 'merge-queue-activity',
        detail: 'GitHub GraphQL is unavailable and GitHub reports merge-queue merges on main',
      })
      expect(mergeCalls(calls)).toEqual([])
      expect(graphqlCalls(calls)).toEqual([])
      expect(probeCalls(calls)).toHaveLength(1)
    },
  )

  test.each([403, 404, 422])('an activity %i is no evidence', async (status) => {
    const { forge } = blocked('clean', { activity: status })
    expect(await tick(forge)).toMatchObject({ kind: 'polling', clear: true })
  })

  test('an activity 502 propagates as a ForgeFailure', async () => {
    const { forge } = blocked('clean', { activity: 502 })
    expect(isForgeFailure(await tick(forge).catch((error: unknown) => error))).toBe(true)
  })

  test('a ruleset merge queue settles; with GraphQL available it still defers', async () => {
    const rules = [{ type: 'merge_queue', ruleset_id: 1 }]
    const { forge, calls } = blocked('clean', { rules })
    expect(await tick(forge)).toEqual({
      kind: 'human-merge',
      cause: 'merge-queue-rule',
      detail: 'GitHub GraphQL is unavailable and main requires its merge queue (ruleset)',
    })
    expect(mergeCalls(calls)).toEqual([])
    const working = blocked('clean', { rules, graphqlUnavailable: false })
    expect(await tick(working.forge)).toMatchObject({
      kind: 'deferred',
      reason: { code: 'unproven-gate-state', detail: expect.stringContaining('merge queues') },
    })
  })

  test('where GraphQL works, one probe precedes the first native application only', async () => {
    const { forge, calls, fake } = blocked('clean', { graphqlUnavailable: false })
    expect(await tick(forge)).toEqual({ kind: 'applied' })
    expect(probeCalls(calls)).toHaveLength(1)
    fake.pr.auto_merge = null
    expect(await tick(forge)).toEqual({ kind: 'applied' })
    expect(probeCalls(calls)).toHaveLength(1)
    expect(mutationKinds(calls)).toEqual(['enable', 'enable'])
  })

  test('a refused enable mutation defers quietly and routes the next tick to polling', async () => {
    const { forge, calls, fake } = blocked('clean', { graphqlUnavailable: false })
    expect(await tick(forge)).toEqual({ kind: 'applied' })
    fake.pr.auto_merge = null
    fake.graphqlUnavailable = true
    // No reason: nothing for an operator to act on, so no observation.
    expect(await tick(forge)).toEqual({ kind: 'deferred' })
    const before = calls.length
    expect(await tick(forge)).toMatchObject({ kind: 'polling', clear: true })
    expect(graphqlCalls(calls.slice(before))).toEqual([])
    expect(probeCalls(calls.slice(before))).toEqual([])
  })

  describe('squashMerge requireClearState', () => {
    const squash = (forge: GitHubForge, canApply?: () => Promise<boolean>) =>
      forge.squashMerge('/absent', 42, 'head-42', {
        ...identity,
        baseBranch: 'main',
        requireClearState: true,
        ...(canApply ? { canApply } : {}),
      })

    test('a clear PR merges at the verified head after consent', async () => {
      const { forge, calls, fake } = blocked('clean', { mergeLands: true })
      let consulted = 0
      await squash(forge, async () => {
        consulted++
        return true
      })
      expect(consulted).toBe(1)
      expect(mergeCalls(calls)).toHaveLength(1)
      expect(mergeCalls(calls)[0]!.opts?.body).toMatchObject({
        merge_method: 'squash',
        sha: 'head-42',
      })
      expect(fake.pr.merged).toBe(true)
    })

    test('a fresh blocked read never merges, even where the PUT would succeed', async () => {
      const { forge, calls } = blocked('blocked', { mergeLands: true })
      const error = await squash(forge).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(Error)
      expect(isForgeRejection(error)).toBe(false)
      expect((error as Error).message).toContain('no longer reports PR #42 clear')
      expect(mergeCalls(calls)).toEqual([])
    })

    test('revoked consent sends no merge request', async () => {
      const { forge, calls } = blocked('clean')
      await squash(forge, async () => false)
      expect(mergeCalls(calls)).toEqual([])
    })

    test('merge-queue activity is a merge-queue rejection with no merge request', async () => {
      const { forge, calls } = blocked('clean', {
        activity: [{ activity_type: 'merge_queue_merge' }],
      })
      const error = await squash(forge).catch((caught: unknown) => caught)
      expect(isForgeMergeQueueRejection(error)).toBe(true)
      expect(mergeCalls(calls)).toEqual([])
    })

    test.each([
      [405, 'Pull Request is not mergeable'],
      [422, 'Required status check "ci" is expected.'],
      [403, 'Merging is blocked by repository rules'],
    ])("a %i refusal is a ForgeRejection carrying GitHub's message", async (status, message) => {
      const { forge } = blocked('clean', { mergeError: { status, message } })
      const error = await squash(forge).catch((caught: unknown) => caught)
      expect(isForgeRejection(error)).toBe(true)
      expect(error).toMatchObject({ status, forgeMessage: message })
      expect(isForgeMergeQueueRejection(error)).toBe(false)
    })

    test('a moved head (409) stays a hard error and a 502 stays a ForgeFailure', async () => {
      const moved = blocked('clean', {
        mergeError: { status: 409, message: 'Head branch was modified' },
      })
      const conflict = await squash(moved.forge).catch((caught: unknown) => caught)
      expect(isForgeRejection(conflict)).toBe(false)
      expect(conflict).toBeInstanceOf(GitHubApiError)
      const flaky = blocked('clean', { mergeError: { status: 502, message: 'Bad gateway' } })
      expect(isForgeFailure(await squash(flaky.forge).catch((caught: unknown) => caught))).toBe(
        true,
      )
    })

    test('without requireClearState a refusal is unchanged', async () => {
      const { forge } = fakeGitHub({
        mergeError: { status: 405, message: 'Pull Request is not mergeable' },
      })
      const error = await forge
        .squashMerge('/absent', 42, 'head-42', { ...identity, baseBranch: 'main' })
        .catch((caught: unknown) => caught)
      expect(isForgeRejection(error)).toBe(false)
      expect(error).toBeInstanceOf(GitHubApiError)
    })
  })
})
