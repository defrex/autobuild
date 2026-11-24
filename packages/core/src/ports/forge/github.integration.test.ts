import { temporaryDirectories as ownTempDirectories } from '../../testing/temp-directories'
import { afterEach, describe, expect, test } from 'bun:test'
import { GitHubForge } from './github'

import { makeForge, paths, fakeGitHub, graphqlCalls } from './github-fixtures.test'

const mkdtemp = ownTempDirectories(afterEach)

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
  const branchWith = (protection: unknown) => ({ json: { protection } })
  const fullProtection = {
    required_status_checks: null,
    required_pull_request_reviews: null,
    restrictions: null,
  }
  const ruleset = (rules: unknown[]) => ({ json: rules })
  const repositoryAutoMerge = (enabled: boolean) => ({ json: { allow_auto_merge: enabled } })

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
})

describe('GitHub stable build identity', () => {
  const identity = { buildSlug: 'stable-build' }

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
})
