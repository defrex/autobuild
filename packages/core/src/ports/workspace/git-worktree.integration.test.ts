import { temporaryDirectories as ownTempDirectories } from '../../testing/temp-directories'
/**
 * Contract tests for the git-worktree Workspace adapter (SPEC §3.2, §7,
 * §15.6-C) — real git against throwaway repos; the exec seam is used only
 * for error paths git itself can't produce on demand.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import type { WorkspaceHandle } from '../types'
import { describeWorkspaceProviderContract } from './contract'
import {
  GitWorktreeProvider,
  WorktreeIsolationError,
  spawnExec,
  worktreeIsolationNotice,
  type Exec,
} from './git-worktree'
import { SANDBOX_FORBIDDEN_ENV, SandboxOperationError } from './operator-sandbox'

const mkdtemp = ownTempDirectories(afterEach)

/** Identity/signing pinned per-invocation so tests ignore user git config. */
const GIT_ID = [
  '-c',
  'user.email=ab@test.invalid',
  '-c',
  'user.name=ab-test',
  '-c',
  'commit.gpgsign=false',
]

async function run(cmd: string[], cwd: string): Promise<string> {
  const result = await spawnExec(cmd, { cwd })
  if (result.exitCode !== 0) {
    throw new Error(`${cmd.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout.trim()
}

async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await run(['git', 'init', '-q', '-b', 'main'], dir)
  await writeFile(join(dir, 'README.md'), 'origin\n')
  await run(['git', 'add', 'README.md'], dir)
  await run(['git', ...GIT_ID, 'commit', '-q', '-m', 'initial'], dir)
}

async function commitFile(
  worktree: string,
  file: string,
  content: string,
  message: string,
): Promise<string> {
  await writeFile(join(worktree, file), content)
  await run(['git', 'add', file], worktree)
  await run(['git', ...GIT_ID, 'commit', '-q', '-m', message], worktree)
  return run(['git', 'rev-parse', 'HEAD'], worktree)
}

async function publishDetachedCommit(
  repo: string,
  worktree: string,
  branch: string,
): Promise<{ localSha: string; publishedSha: string }> {
  const localSha = await run(['git', 'rev-parse', `refs/heads/${branch}`], repo)
  await run(['git', 'checkout', '-q', '--detach', 'HEAD'], worktree)
  const publishedSha = await commitFile(
    worktree,
    'detached.ts',
    'export const detached = true\n',
    'detached completion',
  )
  await run(['git', 'push', '-q', '-u', 'origin', `HEAD:refs/heads/${branch}`], worktree)
  return { localSha, publishedSha }
}

async function registrationCount(repo: string, path: string): Promise<number> {
  const list = await run(['git', 'worktree', 'list', '--porcelain'], repo)
  return list.split('\n\n').filter((block) => block.split('\n').includes(`worktree ${path}`)).length
}

/** The private tracked-child shape the eviction tests probe. */
type TrackedChild = {
  proc: { exitCode: number | null; signalCode: NodeJS.Signals | null; kill(): void }
  exitCode: number | null
}

/** A source repo whose `branch` is published to a bare origin at `base`,
 * then carries two unpublished commits. */
async function unpublishedBranch(prefix: string, branch: string) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const origin = join(root, 'origin.git')
  const source = join(root, 'source')
  await initRepo(source)
  await run(['git', 'init', '--bare', origin], root)
  await run(['git', 'remote', 'add', 'origin', origin], source)
  await run(['git', 'push', 'origin', 'main'], source)
  const base = await run(['git', 'rev-parse', 'HEAD'], source)
  await run(['git', 'checkout', '-b', branch], source)
  await run(['git', 'push', 'origin', branch], source)
  const first = await commitFile(source, 'one', 'one', 'first unpublished')
  const second = await commitFile(source, 'two', 'two', 'second unpublished')
  return { root, origin, source, base, first, second }
}

describeWorkspaceProviderContract('GitWorktreeProvider', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'ab-git-worktree-contract-'))
  const remote = join(tmp, 'remote.git')
  const upstream = join(tmp, 'upstream')
  const repo = join(tmp, 'repo')
  const root = join(tmp, 'worktrees')
  await mkdir(remote, { recursive: true })
  await run(['git', 'init', '--bare', '-q', '-b', 'main'], remote)
  await initRepo(upstream)
  await run(['git', 'remote', 'add', 'origin', remote], upstream)
  await run(['git', 'push', '-q', '-u', 'origin', 'main'], upstream)
  await run(['git', 'clone', '-q', remote, repo], tmp)
  const selectedSha = await run(['git', 'rev-parse', 'refs/heads/main'], remote)
  return {
    provider: new GitWorktreeProvider({ root }),
    provision: {
      repo,
      baseBranch: 'main',
      branch: `ab/contract-${crypto.randomUUID()}`,
    },
    expectedBase: { source: 'remote', sha: selectedSha },
    fixture: { relativePath: 'README.md', content: 'origin\n' },
    cleanup: () => rm(tmp, { recursive: true, force: true }),
  }
})

describe('GitWorktreeProvider', () => {
  let tmp: string
  let remote: string
  let upstream: string
  let repo: string
  let root: string
  let provider: GitWorktreeProvider

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'ab-git-worktree-'))
    remote = join(tmp, 'remote.git')
    upstream = join(tmp, 'upstream')
    repo = join(tmp, 'repo')
    root = join(tmp, 'worktrees')

    await mkdir(remote, { recursive: true })
    await run(['git', 'init', '--bare', '-q', '-b', 'main'], remote)
    await initRepo(upstream)
    await run(['git', 'remote', 'add', 'origin', remote], upstream)
    await run(['git', 'push', '-q', '-u', 'origin', 'main'], upstream)
    await run(['git', 'clone', '-q', remote, repo], tmp)

    provider = new GitWorktreeProvider({ root })
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  test('provision creates an isolated worktree on a new branch from base', async () => {
    // The shared contract suite above checks provider, branch, base, fixture
    // content and writability; this pins the git-worktree specifics.
    const handle = await provider.provision({
      repo,
      baseBranch: 'main',
      branch: 'ab/feature-1',
    })

    // Paths come back canonicalized (macOS /var → /private/var), one
    // sanitized subdir per branch.
    expect(handle.path).toBe(join(await realpath(root), 'ab-feature-1'))
    expect(handle.ref).toBe(handle.path)

    // Starts at the base branch's tip.
    const baseSha = await run(['git', 'rev-parse', 'main'], repo)
    expect(await run(['git', 'rev-parse', 'HEAD'], handle.path)).toBe(baseSha)

    // Workspace is scratch (§7): writes never leak into the origin tree.
    await writeFile(join(handle.path, 'scratch.txt'), 'workspace-only\n')
    expect(existsSync(join(repo, 'scratch.txt'))).toBe(false)

    // The branch is durable state in the origin repo [D3].
    const ref = await run(['git', 'rev-parse', '--verify', 'refs/heads/ab/feature-1'], repo)
    expect(ref).toBe(baseSha)
  })

  test('a new branch starts at a remote-only base commit without moving local refs', async () => {
    const staleLocalSha = await run(['git', 'rev-parse', 'refs/heads/main'], repo)
    const remoteSha = await commitFile(
      upstream,
      'remote-only.txt',
      'only on remote main\n',
      'advance remote main',
    )
    await run(['git', 'push', '-q', 'origin', 'main'], upstream)

    const handle = await provider.provision({
      repo,
      baseBranch: 'main',
      branch: 'ab/remote-base',
    })

    expect(handle.base).toEqual({ source: 'remote', sha: remoteSha })
    expect(await run(['git', 'rev-parse', 'HEAD'], handle.path)).toBe(remoteSha)
    expect(existsSync(join(handle.path, 'remote-only.txt'))).toBe(true)
    expect(await run(['git', 'rev-parse', 'refs/heads/main'], repo)).toBe(staleLocalSha)
    expect(await run(['git', 'rev-parse', 'refs/remotes/origin/main'], repo)).toBe(staleLocalSha)
  })

  test('the target moving between base selection and checkout cannot change the recorded base (AUT-1252)', async () => {
    const selected = await run(['git', 'rev-parse', 'refs/heads/main'], remote)
    let moved: string | undefined
    provider = new GitWorktreeProvider({
      root,
      exec: async (cmd, opts) => {
        const result = await spawnExec(cmd, opts)
        if (
          moved === undefined &&
          cmd.includes('fetch') &&
          cmd.at(-1)?.startsWith('+refs/heads/main:refs/autobuild/provision/')
        ) {
          // A merge lands on the target right after the base was fetched.
          moved = await commitFile(upstream, 'merged.txt', 'merged\n', 'merge to main')
          await run(['git', 'push', '-q', 'origin', 'main'], upstream)
          await run(['git', 'fetch', '-q', 'origin'], repo)
          await run(['git', 'update-ref', 'refs/heads/main', moved], repo)
        }
        return result
      },
    })

    const handle = await provider.provision({
      repo,
      baseBranch: 'main',
      branch: 'ab/raced',
    })

    expect(moved).toBeDefined()
    expect(moved).not.toBe(selected)
    expect(handle.base).toEqual({ source: 'remote', sha: selected })
    expect(await run(['git', 'rev-parse', 'HEAD'], handle.path)).toBe(selected)
    await commitFile(handle.path, 'work.txt', 'work\n', 'build work')
    const ancestry = await spawnExec(
      ['git', 'merge-base', '--is-ancestor', handle.base.sha, 'HEAD'],
      { cwd: handle.path },
    )
    expect(ancestry.exitCode).toBe(0)
  })

  test('provision is idempotent for the same branch (constitution #2)', async () => {
    // The contract suite pins the reused path, existing base and preserved
    // work; this pins that reuse never fetches and survives a restart.
    const calls: string[][] = []
    provider = new GitWorktreeProvider({
      root,
      exec: async (cmd, opts) => {
        calls.push([...cmd])
        return spawnExec(cmd, opts)
      },
    })
    const first = await provider.provision({
      repo,
      baseBranch: 'main',
      branch: 'ab/feature-1',
    })

    calls.length = 0
    await provider.provision({ repo, baseBranch: 'main', branch: 'ab/feature-1' })
    expect(calls.some((cmd) => cmd.includes('fetch'))).toBe(false)

    // A fresh provider instance (post-restart) also reuses the registration.
    const restarted = new GitWorktreeProvider({ root })
    const third = await restarted.provision({
      repo,
      baseBranch: 'main',
      branch: 'ab/feature-1',
    })
    expect(third.path).toBe(first.path)
    expect(third.base).toEqual({
      source: 'existing',
      sha: first.base.sha,
    })
  })

  test.each([
    ['registered', 'reattaches'],
    ['removed', 'rematerializes'],
  ] as const)(
    'reprovision of a %s detached worktree %s it at its published head',
    async (state) => {
      const branch = `ab/detached-${state}`
      const handle = await provider.provision({ repo, baseBranch: 'main', branch })
      const { localSha, publishedSha } = await publishDetachedCommit(repo, handle.path, branch)
      expect(await run(['git', 'rev-parse', `refs/heads/${branch}`], repo)).toBe(localSha)
      if (state === 'registered') {
        await writeFile(join(handle.path, 'recovery-wip.txt'), 'preserve me\n')
        expect(await run(['git', 'rev-parse', `refs/remotes/origin/${branch}`], repo)).toBe(
          publishedSha,
        )
        expect(await run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], handle.path)).toBe('HEAD')
      } else {
        await rm(handle.path, { recursive: true, force: true })
      }

      const calls: string[][] = []
      const restarted = new GitWorktreeProvider({
        root,
        exec: async (cmd, opts) => {
          calls.push([...cmd])
          return spawnExec(cmd, opts)
        },
      })
      const recovered = await restarted.provision({
        repo,
        baseBranch: 'main',
        branch,
        publication: { sha: publishedSha, cacheHeads: [localSha] },
      })

      expect(recovered.path).toBe(handle.path)
      expect(recovered.base).toEqual({ source: 'existing', sha: publishedSha })
      expect(await run(['git', 'symbolic-ref', '--short', 'HEAD'], recovered.path)).toBe(branch)
      expect(await run(['git', 'rev-parse', 'HEAD'], recovered.path)).toBe(publishedSha)
      expect(await run(['git', 'rev-parse', `refs/heads/${branch}`], repo)).toBe(publishedSha)
      if (state === 'registered') {
        expect(await readFile(join(recovered.path, 'recovery-wip.txt'), 'utf8')).toBe(
          'preserve me\n',
        )
      }
      expect(await registrationCount(repo, handle.path)).toBe(1)
      expect(calls.some((cmd) => cmd.includes('fetch'))).toBe(false)
      expect(calls.some((cmd) => cmd.includes('push'))).toBe(false)
    },
  )

  test('published recovery never rolls back a newer local build branch', async () => {
    const branch = 'ab/local-ahead'
    const branchRef = `refs/heads/${branch}`
    const handle = await provider.provision({ repo, baseBranch: 'main', branch })
    const { localSha, publishedSha } = await publishDetachedCommit(repo, handle.path, branch)
    const newerSha = await commitFile(
      handle.path,
      'newer.ts',
      'export const newer = true\n',
      'newer local completion',
    )
    await run(['git', 'update-ref', branchRef, newerSha, localSha], repo)
    await rm(handle.path, { recursive: true, force: true })

    const recovered = await new GitWorktreeProvider({ root }).provision({
      repo,
      baseBranch: 'main',
      branch,
    })

    expect(publishedSha).not.toBe(newerSha)
    expect(await run(['git', 'merge-base', '--is-ancestor', publishedSha, newerSha], repo)).toBe('')
    expect(recovered.base).toEqual({ source: 'existing', sha: newerSha })
    expect(await run(['git', 'rev-parse', branchRef], repo)).toBe(newerSha)
    expect(await run(['git', 'rev-parse', 'HEAD'], recovered.path)).toBe(newerSha)
    expect(await run(['git', 'rev-parse', `refs/remotes/origin/${branch}`], repo)).toBe(
      publishedSha,
    )
  })

  test('ordinary resume preserves divergent unpublished work without trusting tracking refs', async () => {
    const branch = 'ab/divergent-recovery'
    const branchRef = `refs/heads/${branch}`
    const publishedRef = `refs/remotes/origin/${branch}`
    const handle = await provider.provision({ repo, baseBranch: 'main', branch })
    const { publishedSha } = await publishDetachedCommit(repo, handle.path, branch)

    await run(['git', 'checkout', '-q', branch], handle.path)
    const divergentSha = await commitFile(
      handle.path,
      'divergent.ts',
      'export const divergent = true\n',
      'divergent local work',
    )
    await provider.release(handle)

    const recovered = await new GitWorktreeProvider({ root }).provision({
      repo,
      baseBranch: 'main',
      branch,
    })
    expect(recovered.base).toEqual({ source: 'existing', sha: divergentSha })
    expect(await run(['git', 'rev-parse', branchRef], repo)).toBe(divergentSha)
    expect(await run(['git', 'rev-parse', publishedRef], repo)).toBe(publishedSha)
  })

  test('registered detached recovery refuses an unpublished detached commit', async () => {
    const branch = 'ab/unpublished-detached'
    const branchRef = `refs/heads/${branch}`
    const handle = await provider.provision({ repo, baseBranch: 'main', branch })
    const { localSha, publishedSha } = await publishDetachedCommit(repo, handle.path, branch)
    const unpublishedSha = await commitFile(
      handle.path,
      'unpublished.ts',
      'export const unpublished = true\n',
      'unpublished detached work',
    )

    const error = await new GitWorktreeProvider({ root })
      .provision({
        repo,
        baseBranch: 'main',
        branch,
        publication: { sha: publishedSha, cacheHeads: [localSha] },
      })
      .then(() => null)
      .catch((failure: unknown) => failure as Error)

    expect(error?.message).toContain('does not match durable')
    expect(error?.message).toContain('refusing to discard either commit')
    expect(await run(['git', 'rev-parse', branchRef], repo)).toBe(localSha)
    expect(await run(['git', 'rev-parse', 'HEAD'], handle.path)).toBe(unpublishedSha)
    expect(await run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], handle.path)).toBe('HEAD')
  })

  test('confirmed publication refreshes the cache without an expected-old guard', async () => {
    const branch = 'ab/concurrent-recovery'
    const branchRef = `refs/heads/${branch}`
    const handle = await provider.provision({ repo, baseBranch: 'main', branch })
    const { localSha, publishedSha } = await publishDetachedCommit(repo, handle.path, branch)
    const concurrentSha = await commitFile(
      handle.path,
      'concurrent.ts',
      'export const concurrent = true\n',
      'concurrent local advance',
    )
    await run(['git', 'update-ref', 'refs/autobuild/tests/concurrent', concurrentSha], repo)
    await run(['git', 'checkout', '-q', '--detach', publishedSha], handle.path)
    await provider.release(handle)

    let raced = false
    let attemptedUpdate: string[] | undefined
    const raceExec: Exec = async (cmd, opts) => {
      const updateRef = cmd.indexOf('update-ref')
      if (!raced && updateRef >= 0 && cmd[updateRef + 1] === branchRef) {
        raced = true
        attemptedUpdate = [...cmd]
        const movement = await spawnExec(
          ['git', '-C', repo, 'update-ref', branchRef, concurrentSha, localSha],
          {},
        )
        if (movement.exitCode !== 0) {
          throw new Error(`failed to stage ref race: ${movement.stderr}`)
        }
      }
      return spawnExec(cmd, opts)
    }

    const error = await new GitWorktreeProvider({ root, exec: raceExec })
      .provision({
        repo,
        baseBranch: 'main',
        branch,
        publication: { sha: publishedSha, cacheHeads: [localSha] },
      })
      .then(() => null)
      .catch((failure: unknown) => failure as Error)

    expect(raced).toBe(true)
    expect(attemptedUpdate?.slice(-2)).toEqual([branchRef, publishedSha])
    expect(error).toBeNull()
    expect(await run(['git', 'rev-parse', branchRef], repo)).toBe(publishedSha)
    expect(await run(['git', 'rev-parse', `refs/remotes/origin/${branch}`], repo)).toBe(
      publishedSha,
    )
    expect(existsSync(handle.path)).toBe(true)
  })

  test('release/re-provision reuses the branch tip without fetching a moved origin (§15.6-C)', async () => {
    const calls: string[][] = []
    const observedExec: Exec = async (cmd, opts) => {
      calls.push([...cmd])
      return spawnExec(cmd, opts)
    }
    provider = new GitWorktreeProvider({ root, exec: observedExec })

    const handle = await provider.provision({
      repo,
      baseBranch: 'main',
      branch: 'ab/feature-2',
    })
    const sha = await commitFile(handle.path, 'work.txt', 'round 1\n', 'round 1')

    const movedRemote = await commitFile(
      upstream,
      'base-moved.txt',
      'new base work\n',
      'move base after branch creation',
    )
    await run(['git', 'push', '-q', 'origin', 'main'], upstream)
    expect(movedRemote).not.toBe(sha)

    await provider.release(handle)
    expect(existsSync(handle.path)).toBe(false)
    // The branch survives release [D3].
    expect(await run(['git', 'rev-parse', 'refs/heads/ab/feature-2'], repo)).toBe(sha)

    calls.length = 0
    const resumed = await provider.provision({
      repo,
      baseBranch: 'main',
      branch: 'ab/feature-2',
    })
    expect(resumed.base).toEqual({ source: 'existing', sha })
    expect(await run(['git', 'rev-parse', 'HEAD'], resumed.path)).toBe(sha)
    expect(existsSync(join(resumed.path, 'work.txt'))).toBe(true)
    expect(calls.some((cmd) => cmd.includes('fetch'))).toBe(false)
  })

  test('release no-ops on never-provisioned handles and a restarted provider rediscovers the repo', async () => {
    // Releasing twice is the contract suite's "safe to call twice" case.
    const never: WorkspaceHandle = {
      provider: 'git-worktree',
      ref: join(root, 'never-existed'),
      path: join(root, 'never-existed'),
      branch: 'ab/never',
    }
    await provider.release(never) // never provisioned → no-op

    // A restarted provider (empty in-memory map) can still release a live
    // worktree by rediscovering its repo (§7.4).
    const live = await provider.provision({
      repo,
      baseBranch: 'main',
      branch: 'ab/feature-4',
    })
    const restarted = new GitWorktreeProvider({ root })
    await restarted.release(live)
    expect(existsSync(live.path)).toBe(false)
  })

  test('no origin falls back to the local base with the complete fetch diagnostic', async () => {
    await run(['git', 'remote', 'remove', 'origin'], repo)
    const localSha = await run(['git', 'rev-parse', 'refs/heads/main'], repo)

    const handle = await provider.provision({
      repo,
      baseBranch: 'main',
      branch: 'ab/no-origin',
    })

    expect(handle.base.source).toBe('local')
    if (handle.base.source !== 'local') throw new Error('expected local fallback')
    expect(handle.base.sha).toBe(localSha)
    expect(handle.base.remoteError).toContain('git -C')
    expect(handle.base.remoteError).toContain('fetch --no-tags --no-write-fetch-head')
    expect(handle.base.remoteError).toContain('exited 128')
    expect(handle.base.remoteError).toMatch(/origin.*repository|repository.*origin/i)
    expect(await run(['git', 'rev-parse', 'HEAD'], handle.path)).toBe(localSha)
  })

  test.each([
    [
      'an authentication-style fetch failure falls back locally and is retained verbatim',
      'ab/auth-fallback',
      (cmd: string[]) => cmd.includes('fetch'),
      'fatal: Authentication failed for origin',
      'fatal: Authentication failed for origin',
    ],
    [
      'a fetched-ref resolution failure also falls back with its diagnostic',
      'ab/resolve-fallback',
      (cmd: string[]) =>
        cmd.at(-1) === 'refs/autobuild/provision/ab/resolve-fallback/base^{commit}',
      'fatal: fetched ref could not be resolved',
      'refs/autobuild/provision/ab/resolve-fallback/base^{commit} exited 128',
    ],
  ])('%s', async (_name, branch, fails, stderr, diagnostic) => {
    const localSha = await run(['git', 'rev-parse', 'refs/heads/main'], repo)
    provider = new GitWorktreeProvider({
      root,
      exec: async (cmd, opts) =>
        fails(cmd) ? { stdout: '', stderr, exitCode: 128 } : spawnExec(cmd, opts),
    })

    const handle = await provider.provision({ repo, baseBranch: 'main', branch })

    expect(handle.base).toEqual({
      source: 'local',
      sha: localSha,
      remoteError: expect.stringContaining(diagnostic),
    })
  })

  test('concurrent new branches fetch into distinct refs without writing FETCH_HEAD', async () => {
    const calls: string[][] = []
    provider = new GitWorktreeProvider({
      root,
      exec: async (cmd, opts) => {
        calls.push([...cmd])
        return spawnExec(cmd, opts)
      },
    })
    const remoteSha = await run(['git', 'rev-parse', 'refs/heads/main'], remote)

    const [first, second] = await Promise.all([
      provider.provision({
        repo,
        baseBranch: 'main',
        branch: 'ab/concurrent-one',
      }),
      provider.provision({
        repo,
        baseBranch: 'main',
        branch: 'ab/concurrent-two',
      }),
    ])

    expect(first.base).toEqual({ source: 'remote', sha: remoteSha })
    expect(second.base).toEqual({ source: 'remote', sha: remoteSha })
    expect(await run(['git', 'rev-parse', 'HEAD'], first.path)).toBe(remoteSha)
    expect(await run(['git', 'rev-parse', 'HEAD'], second.path)).toBe(remoteSha)

    const fetches = calls.filter((cmd) => cmd.includes('fetch'))
    expect(fetches).toHaveLength(2)
    for (const fetch of fetches) {
      expect(fetch).toContain('--no-write-fetch-head')
      expect(fetch).toContain('--no-tags')
      expect(fetch).toContain('--refmap=')
    }
    expect(fetches.map((fetch) => fetch.at(-1)).sort()).toEqual([
      '+refs/heads/main:refs/autobuild/provision/ab/concurrent-one/base',
      '+refs/heads/main:refs/autobuild/provision/ab/concurrent-two/base',
    ])
  })

  test('bad inputs fail informatively', async () => {
    const unknownBase = await provider
      .provision({ repo, baseBranch: 'no-such-base', branch: 'ab/feature-5' })
      .then(
        () => null,
        (error: unknown) => error as Error,
      )
    expect(unknownBase?.message).toContain('Needed a single revision')
    expect(unknownBase?.message).toContain('refs/heads/no-such-base')

    const missing = join(tmp, 'does-not-exist')
    await expect(
      provider.provision({ repo: missing, baseBranch: 'main', branch: 'x' }),
    ).rejects.toThrow(/does-not-exist/)

    const plain = join(tmp, 'plain-dir')
    await mkdir(plain)
    await expect(
      provider.provision({ repo: plain, baseBranch: 'main', branch: 'x' }),
    ).rejects.toThrow(/not a git repository/i)
  })
})

describe('GitWorktreeProvider operator sandbox', () => {
  let repo: string
  let root: string
  let sandboxRoot: string
  let provider: GitWorktreeProvider

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ab-sandbox-repo-'))
    root = await mkdtemp(join(tmpdir(), 'ab-sandbox-worktrees-'))
    sandboxRoot = await mkdtemp(join(tmpdir(), 'ab-sandbox-root-'))
    await initRepo(repo)
    provider = new GitWorktreeProvider({
      root,
      sandboxRoot,
      setupCommand: 'echo setup-ran > setup-marker.txt',
      sandboxEnvironmentVariables: ['MY_TOOL_CONFIG'],
      envSource: { PATH: process.env.PATH ?? '', MY_TOOL_CONFIG: 'tool-value' },
    })
  })

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
    await rm(sandboxRoot, { recursive: true, force: true })
  })

  test('ensure provisions a detached worktree from the base head and runs setup once', async () => {
    const identity = await provider.orchestratorSandbox.ensure({
      repo,
      operator: 'ops',
      baseBranch: 'main',
    })
    expect(identity.workspacePath).toBe(identity.environmentId)
    expect(await run(['git', 'rev-parse', 'HEAD'], identity.workspacePath)).toBe(
      await run(['git', 'rev-parse', 'refs/heads/main'], repo),
    )
    expect(readFileSync(join(identity.workspacePath, 'setup-marker.txt'), 'utf8')).toContain(
      'setup-ran',
    )
    // The provisioning marker is excluded in the worktree's info/exclude, so
    // it never counts as dirt for the publish service's untracked-inclusive
    // dirty check. (setup-marker.txt is real untracked dirt and stays.)
    expect(await run(['git', 'status', '--porcelain'], identity.workspacePath)).not.toContain(
      '.autobuild-sandbox-provisioned',
    )

    // Reuse: the marker and setup are not re-run. The reuse identity omits
    // `baseSha` (only a fresh provision resolves it), so compare with the
    // fresh-only field stripped.
    const setupAt = statSync(join(identity.workspacePath, 'setup-marker.txt')).mtimeMs
    const reused = await provider.orchestratorSandbox.ensure({
      repo,
      operator: 'ops',
      baseBranch: 'main',
    })
    const { baseSha: _baseSha, ...reuseExpected } = identity
    expect(reused).toEqual(reuseExpected)
    expect(statSync(join(identity.workspacePath, 'setup-marker.txt')).mtimeMs).toBe(setupAt)

    // describe resolves the same identity without provisioning anything new
    // (and never carries the fresh-only baseSha).
    expect(await provider.orchestratorSandbox.describe({ repo, operator: 'ops' })).toEqual(
      reuseExpected,
    )
    expect(await provider.orchestratorSandbox.describe({ repo, operator: 'other' })).not.toEqual(
      reuseExpected,
    )
  })

  test('ensure heals a pre-existing registered worktree whose provisioning marker is not excluded (AUT-580)', async () => {
    // Reproduce the pre-exclusion-era state: a registered detached worktree
    // carrying the marker file, with no marker line in info/exclude — what
    // ensureSandbox's registered-worktree early return used to skip.
    const legacy = await provider.orchestratorSandbox.describe({ repo, operator: 'legacy' })
    await run(['git', 'worktree', 'add', '--detach', legacy.workspacePath, 'HEAD'], repo)
    await writeFile(join(legacy.workspacePath, '.autobuild-sandbox-provisioned'), '')
    const excludePath = resolve(
      legacy.workspacePath,
      await run(['git', 'rev-parse', '--git-path', 'info/exclude'], legacy.workspacePath),
    )
    expect(readFileSync(excludePath, 'utf8')).not.toContain('.autobuild-sandbox-provisioned')

    await provider.orchestratorSandbox.ensure({
      repo,
      operator: 'legacy',
      baseBranch: 'main',
    })

    // The early-return path now writes the exclusion, so the marker never
    // counts as dirt for the publish service's untracked-inclusive dirty
    // check and the correct baseSha / reset-required diagnostic surfaces.
    expect(readFileSync(excludePath, 'utf8')).toContain('.autobuild-sandbox-provisioned')
    expect(await run(['git', 'status', '--porcelain'], legacy.workspacePath)).not.toContain(
      '.autobuild-sandbox-provisioned',
    )

    // A second ensure is still a no-op reuse: the exclusion line is not
    // duplicated and setup is not re-run (it never ran on this path).
    await provider.orchestratorSandbox.ensure({
      repo,
      operator: 'legacy',
      baseBranch: 'main',
    })
    const lines = readFileSync(excludePath, 'utf8').split('\n')
    expect(lines.filter((line) => line === '.autobuild-sandbox-provisioned')).toHaveLength(1)
    expect(existsSync(join(legacy.workspacePath, 'setup-marker.txt'))).toBe(false)
  })

  test('ensure fails typed when rev-parse --git-path info/exclude succeeds with empty stdout', async () => {
    // The guard mirrors the fake workspace's degenerate-input handling: a
    // successful git-path probe with empty output would otherwise feed '' into
    // resolve(workspacePath, …) and target the workspace directory itself.
    // Unreachable for real git output — pinned at the exec seam, the same
    // injection point the suite uses for error shapes git cannot produce.
    let intercepted = false
    const emptyGitPath: Exec = async (cmd, opts) => {
      if (cmd[0] === 'git' && cmd.slice(-3).join(' ') === 'rev-parse --git-path info/exclude') {
        intercepted = true
        return { stdout: '', stderr: '', exitCode: 0 }
      }
      return spawnExec(cmd, opts)
    }
    const broken = new GitWorktreeProvider({ root, sandboxRoot, exec: emptyGitPath })
    const error = await broken.orchestratorSandbox
      .ensure({ repo, operator: 'ops-empty', baseBranch: 'main' })
      .catch((e: unknown) => e)
    expect(intercepted).toBe(true)
    expect(error).toBeInstanceOf(SandboxOperationError)
    expect((error as SandboxOperationError).stage).toBe('provision')
    // Exact pin: the message must be byte-identical to fake.ts's twin guard
    // message for the same degenerate input (exit 0, empty stdout, empty
    // stderr → the stderr-or-exit tail is `exit 0`). A future edit to either
    // side's tail must move both implementations together and update this pin.
    expect((error as Error).message).toBe('operator sandbox could not resolve info/exclude: exit 0')

    // The guard fired before any filesystem side effect: the fresh-provision
    // catch path removed the half-provisioned worktree, so nothing is
    // registered and a healthy ensure provisions the same sandbox cleanly.
    const identity = await broken.orchestratorSandbox.describe({ repo, operator: 'ops-empty' })
    expect(await registrationCount(repo, identity.workspacePath)).toBe(0)
    expect(existsSync(identity.workspacePath)).toBe(false)
    const healed = await provider.orchestratorSandbox.ensure({
      repo,
      operator: 'ops-empty',
      baseBranch: 'main',
    })
    expect(healed.baseSha).toBe(await run(['git', 'rev-parse', 'refs/heads/main'], repo))
    expect(await run(['git', 'status', '--porcelain'], healed.workspacePath)).not.toContain(
      '.autobuild-sandbox-provisioned',
    )
  })

  test('setup and exec run with the scrubbed guest environment inside the checkout', async () => {
    process.env.AB_SANDBOX_SETUP_CANARY = 'host-canary'
    try {
      const scrubProvider = new GitWorktreeProvider({
        root,
        sandboxRoot,
        setupCommand: 'env | sort > env-dump.txt',
        sandboxEnvironmentVariables: ['MY_TOOL_CONFIG'],
        envSource: { PATH: process.env.PATH ?? '', MY_TOOL_CONFIG: 'tool-value' },
      })
      const identity = await scrubProvider.orchestratorSandbox.ensure({
        repo,
        operator: 'ops-scrub',
        baseBranch: 'main',
      })
      const setupEnv = readFileSync(join(identity.workspacePath, 'env-dump.txt'), 'utf8')
      const exec = await scrubProvider.orchestratorSandbox.exec(identity, {
        command: 'pwd && env | sort',
      })
      expect(exec.exitCode).toBe(0)
      expect(exec.stdout.split('\n')[0]).toContain(identity.workspacePath)
      // Built from an empty record: a host-only variable never leaks in, and
      // only PATH plus the forwarded names are present.
      for (const dump of [setupEnv, exec.stdout]) {
        expect(dump).not.toContain('AB_SANDBOX_SETUP_CANARY')
        expect(dump).toContain('MY_TOOL_CONFIG=tool-value')
        expect(dump).toContain('PATH=')
        for (const name of SANDBOX_FORBIDDEN_ENV) {
          expect(dump).not.toContain(`${name}=`)
        }
      }
    } finally {
      delete process.env.AB_SANDBOX_SETUP_CANARY
    }
  })

  test('exec past its timeout fails typed; detached waits consume only the terminal exit', async () => {
    const identity = await provider.orchestratorSandbox.ensure({
      repo,
      operator: 'ops',
      baseBranch: 'main',
    })
    const { commandId } = await provider.orchestratorSandbox.start(identity, {
      command: 'sleep 1; echo streamed-output',
    })
    // Running waits do not consume.
    for (let i = 0; i < 2; i++) {
      expect(
        await provider.orchestratorSandbox.wait(identity, { commandId, waitSeconds: 0 }),
      ).toEqual({
        state: 'running',
        stdout: '',
        stderr: '',
      })
    }

    // The detached child finishes while this exec times out.
    const error = await provider.orchestratorSandbox
      .exec(identity, { command: 'sleep 5', timeoutSeconds: 1 })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SandboxOperationError)
    expect((error as SandboxOperationError).stage).toBe('exec-timeout')

    expect(
      await provider.orchestratorSandbox.wait(identity, { commandId, waitSeconds: 5 }),
    ).toEqual({
      state: 'exited',
      exitCode: 0,
      stdout: 'streamed-output\n',
      stderr: '',
    })
    // The terminal wait consumed it: delivered results are gone, and
    // re-waiting them is typed not-found, not stale repetition. A restarted
    // host loses detached-command tracking the same way.
    for (const id of [commandId, 'sbcmd-gone']) {
      const lost = await provider.orchestratorSandbox
        .wait(identity, { commandId: id, waitSeconds: 0 })
        .catch((e: unknown) => e)
      expect(lost).toBeInstanceOf(SandboxOperationError)
      expect((lost as SandboxOperationError).stage).toBe('not-found')
    }
  })

  /** A provider with a large drain grace, so a `sleep 2 &` grandchild gates
   * its command's exit stamp (drain EOF wins the race at ~2s) rather than the
   * 250ms default, plus a running `sleep 30` sentinel that is never evictable
   * and is killed afterwards. Own temp roots, removed afterwards. */
  async function withSlowDrainSandbox(
    operator: string,
    body: (sandbox: {
      cap: number
      sentinel: string
      children: Map<string, TrackedChild>
      start: (command: string) => Promise<string>
      wait: (
        commandId: string,
        waitSeconds: number,
      ) => ReturnType<GitWorktreeProvider['orchestratorSandbox']['wait']>
      expectNotFound: (commandId: string) => Promise<void>
      expectRunning: (commandId: string) => Promise<void>
    }) => Promise<void>,
  ): Promise<void> {
    const slowRoot = await mkdtemp(join(tmpdir(), 'ab-sandbox-worktrees-slow-'))
    const slowSandboxRoot = await mkdtemp(join(tmpdir(), 'ab-sandbox-root-slow-'))
    const slowProvider = new GitWorktreeProvider({
      root: slowRoot,
      sandboxRoot: slowSandboxRoot,
      exitDrainGraceMs: 5000,
    })
    // No private-access idiom exists in this suite; one cast local.
    const children = (slowProvider as unknown as { sandboxChildren: Map<string, TrackedChild> })
      .sandboxChildren
    const started: TrackedChild[] = []
    try {
      const identity = await slowProvider.orchestratorSandbox.ensure({
        repo,
        operator,
        baseBranch: 'main',
      })
      const start = async (command: string) => {
        const { commandId } = await slowProvider.orchestratorSandbox.start(identity, { command })
        started.push(children.get(commandId)!)
        return commandId
      }
      const wait = (commandId: string, waitSeconds: number) =>
        slowProvider.orchestratorSandbox.wait(identity, { commandId, waitSeconds })
      await body({
        cap: (GitWorktreeProvider as unknown as { MAX_RETAINED_SANDBOX_COMMANDS: number })
          .MAX_RETAINED_SANDBOX_COMMANDS,
        sentinel: await start('sleep 30'),
        children,
        start,
        wait,
        expectNotFound: async (commandId) => {
          const evicted = await wait(commandId, 0).catch((e: unknown) => e)
          expect(evicted).toBeInstanceOf(SandboxOperationError)
          expect((evicted as SandboxOperationError).stage).toBe('not-found')
        },
        expectRunning: async (commandId) => {
          expect(await wait(commandId, 0)).toEqual({ state: 'running', stdout: '', stderr: '' })
        },
      })
    } finally {
      for (const child of started) child.proc.kill()
      await rm(slowRoot, { recursive: true, force: true })
      await rm(slowSandboxRoot, { recursive: true, force: true })
    }
  }

  /** The tracked entry's synchronous exit state, the same probe the eviction
   * pass reads: exited but not yet stamped. */
  const exitedUnstamped = (children: Map<string, TrackedChild>, id: string): boolean => {
    const tracked = children.get(id)
    return (
      tracked !== undefined &&
      tracked.exitCode === null &&
      (tracked.proc.exitCode !== null || tracked.proc.signalCode !== null)
    )
  }
  /** Stamped, or already evicted (which only happens to stamped entries). */
  const stamped = (children: Map<string, TrackedChild>, id: string): boolean =>
    children.get(id)?.exitCode !== null

  async function pollUntil(done: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline && !done()) await Bun.sleep(25)
  }

  test('eviction defers while an exited command’s drain-gated stamp is pending, then evicts the oldest finished first', async () => {
    await withSlowDrainSandbox(
      'ops-slow',
      async ({ cap, sentinel, children, start, wait, expectNotFound, expectRunning }) => {
        // The oldest finished command: its child exits in ~ms, but the
        // `sleep 2 &` grandchild holds the pipe write end, so the drain-gated
        // stamp lands ~2s later — long after any echo's stamp (~ms).
        const delayed = await start('sleep 2 & echo held-open')
        // Only once it has exited unstamped is the burst inserted, so the
        // first over-cap pass deterministically sees an exited-but-unstamped
        // entry.
        await pollUntil(() => exitedUnstamped(children, delayed))
        expect(exitedUnstamped(children, delayed)).toBe(true)

        // Fill past the cap: sentinel + delayed + (cap - 1) echoes = cap + 1.
        const echoes: string[] = []
        for (let i = 0; i < cap - 1; i++) echoes.push(await start('echo burst'))
        await pollUntil(() => echoes.every((id) => stamped(children, id)))
        expect(echoes.every((id) => stamped(children, id))).toBe(true)

        // Deferral: while the older command's stamp is pending, the over-cap
        // map evicts nothing — pre-fix code deletes the oldest stamped echo
        // here instead of the oldest finished entry.
        expect(children.has(delayed)).toBe(true)
        expect(children.size).toBe(cap + 1)
        expect(echoes.every((id) => children.has(id))).toBe(true)
        // Stamp semantics unchanged: an exited-but-unstamped entry still
        // reports `running`, and the wait does not consume it. (stdout may
        // already carry what drained before the stamp.)
        expect((await wait(delayed, 0)).state).toBe('running')

        // The delayed stamp (~2s) runs the next pass, which evicts exactly the
        // oldest finished entry — the delayed command itself (the running
        // sentinel is un-evictable). Size settles at the cap.
        await pollUntil(() => !children.has(delayed))
        expect(children.has(delayed)).toBe(false)
        expect(children.size).toBe(cap)

        // The evicted delayed command reports typed not-found on wait.
        await expectNotFound(delayed)
        // Every newer echo survived, in order, with its output intact.
        for (const id of echoes) {
          expect(await wait(id, 5)).toEqual({
            state: 'exited',
            exitCode: 0,
            stdout: 'burst\n',
            stderr: '',
          })
        }
        await expectRunning(sentinel)
      },
    )
  })

  test('a pending newer stamp does not block eviction of older stamped finished entries', async () => {
    await withSlowDrainSandbox(
      'ops-newer',
      async ({ cap, sentinel, children, start, wait, expectNotFound, expectRunning }) => {
        // A burst of fast echoes settling the map exactly at the cap.
        const echoes: string[] = []
        for (let i = 0; i < cap - 1; i++) echoes.push(await start('echo burst'))
        // The pending command is NEWER than the burst; its drain-gated stamp
        // lands ~2s after its exit, long after every echo's stamp.
        const delayed = await start('sleep 2 & echo held-open')
        await pollUntil(() => exitedUnstamped(children, delayed))
        expect(exitedUnstamped(children, delayed)).toBe(true)

        // More fast echoes after the pending command push the map past the
        // cap while the pending stamp has not landed: the echoes before the
        // pending entry are unambiguously older finished entries.
        const newer: string[] = []
        for (let i = 0; i < 10; i++) newer.push(await start('echo burst'))

        // Settle without calling `wait` on any echo (a terminal wait would
        // consume the entry and defeat the test).
        const all = [...echoes, ...newer]
        await pollUntil(() => all.every((id) => stamped(children, id)))
        expect(all.every((id) => stamped(children, id))).toBe(true)
        // The eviction choice below was made with a pending stamp in the map.
        expect(exitedUnstamped(children, delayed)).toBe(true)

        // The pending NEWER stamp must not block eviction of the older stamped
        // echoes: the map is trimmed back to the cap, and the pending entry
        // itself is untouched. Exactly the oldest `newer.length + 1` echoes
        // were evicted: the walk reaches the cap before the pending command.
        expect(children.size).toBe(cap)
        expect(children.has(delayed)).toBe(true)
        for (const id of echoes.slice(0, newer.length + 1)) await expectNotFound(id)
        for (const id of [...echoes.slice(newer.length + 1), ...newer]) {
          expect(children.has(id)).toBe(true)
        }
        // The pending entry is still exited-but-unstamped to any observer.
        expect((await wait(delayed, 0)).state).toBe('running')
        await expectRunning(sentinel)
      },
    )
  })

  test('a grandchild inheriting the pipe bounds the exit stamp without truncating it', async () => {
    const identity = await provider.orchestratorSandbox.ensure({
      repo,
      operator: 'ops',
      baseBranch: 'main',
    })
    // `sleep 2 &` keeps the stdout write end open ~2s past `sh`'s own exit,
    // so the reader drain — EOF — lands long after the child is gone. The
    // exit stamp must land within the drain grace (not the grandchild's
    // lifetime, so a `waitSeconds: 1` deadline still observes `exited` where
    // an unbounded drain wait would report `running`), and must carry what
    // the child wrote before exiting.
    const { commandId } = await provider.orchestratorSandbox.start(identity, {
      command: 'sleep 2 & echo held-open',
    })
    expect(
      await provider.orchestratorSandbox.wait(identity, { commandId, waitSeconds: 1 }),
    ).toEqual({
      state: 'exited',
      exitCode: 0,
      stdout: 'held-open\n',
      stderr: '',
    })
  })

  test('readFile and writeFile are rooted at the checkout and reject escapes', async () => {
    const identity = await provider.orchestratorSandbox.ensure({
      repo,
      operator: 'ops',
      baseBranch: 'main',
    })
    await provider.orchestratorSandbox.writeFile(
      identity,
      'sub/dir/file.txt',
      new TextEncoder().encode('bytes!'),
    )
    expect(
      new TextDecoder().decode(
        await provider.orchestratorSandbox.readFile(identity, 'sub/dir/file.txt'),
      ),
    ).toBe('bytes!')
    expect(await provider.orchestratorSandbox.readFile(identity, 'README.md')).toEqual(
      new Uint8Array(await readFile(join(identity.workspacePath, 'README.md'))),
    )
    for (const bad of ['../outside', '/abs', 'a/../../b']) {
      const refusal = await provider.orchestratorSandbox
        .readFile(identity, bad)
        .catch((e: unknown) => e)
      expect(refusal).toBeInstanceOf(SandboxOperationError)
    }
  })

  test('stop declines honestly; release removes the worktree and reports confirmed', async () => {
    const identity = await provider.orchestratorSandbox.ensure({
      repo,
      operator: 'ops',
      baseBranch: 'main',
    })
    expect(
      await provider.orchestratorSandbox.stop({
        operator: 'ops',
        environmentId: identity.environmentId,
      }),
    ).toEqual({ outcome: 'unsupported' })

    const released = await provider.orchestratorSandbox.release({
      repo,
      operator: 'ops',
      environmentId: identity.environmentId,
    })
    expect(released.snapshots).toEqual({ outcome: 'confirmed' })
    expect(existsSync(identity.workspacePath)).toBe(false)
    // Release of a never-provisioned operator is a no-op, not an error.
    const missing = await provider.orchestratorSandbox.describe({ repo, operator: 'nobody' })
    await provider.orchestratorSandbox.release({
      repo,
      operator: 'nobody',
      environmentId: missing.environmentId,
    })
  })

  test('sandboxPublication pushes an exact sha to one branch against a real temp origin', async () => {
    // A bare origin so the push has a real network-style destination; the
    // worktree's origin remote carries the host's local forge configuration
    // exactly as a local build's finalize push does.
    const origin = join(repo, 'publish-origin')
    await mkdir(origin)
    await run(['git', 'init', '-q', '--bare', '-b', 'main', origin], repo)
    await run(['git', 'remote', 'add', 'origin', origin], repo)
    const identity = await provider.orchestratorSandbox.ensure({
      repo,
      operator: 'ops',
      baseBranch: 'main',
    })
    const sha = await commitFile(identity.workspacePath, 'fix.txt', 'fix\n', 'operator fix')
    const publication = provider.sandboxPublication!
    expect(
      await publication.isPublished!({
        ref: identity.environmentId,
        sha,
        branch: 'ab/orch-ops-abc12345',
      }),
    ).toBe(false)
    await publication.publish({ ref: identity.environmentId, sha, branch: 'ab/orch-ops-abc12345' })
    // Exactly the pushed branch exists on the origin, at exactly the sha.
    const refs = await run(['git', 'ls-remote', '--heads', 'origin'], repo)
    expect(refs.split('\n')).toEqual([`${sha}\trefs/heads/ab/orch-ops-abc12345`])
    expect(
      await publication.isPublished!({
        ref: identity.environmentId,
        sha,
        branch: 'ab/orch-ops-abc12345',
      }),
    ).toBe(true)
  })

  test('sandboxPublication without an origin remote moves the local ref forward-only', async () => {
    const identity = await provider.orchestratorSandbox.ensure({
      repo,
      operator: 'ops-local',
      baseBranch: 'main',
    })
    const sha = await commitFile(identity.workspacePath, 'fix.txt', 'fix\n', 'operator fix')
    const publication = provider.sandboxPublication!
    await publication.publish({ ref: identity.environmentId, sha, branch: 'ab/orch-ops-local999' })
    expect(await run(['git', 'rev-parse', 'refs/heads/ab/orch-ops-local999'], repo)).toBe(sha)
    expect(
      await publication.isPublished!({
        ref: identity.environmentId,
        sha,
        branch: 'ab/orch-ops-local999',
      }),
    ).toBe(true)

    // A second push that is NOT a descendant of the current tip is refused.
    await run(['git', 'checkout', '-q', '--orphan', 'divergent'], identity.workspacePath)
    await writeFile(join(identity.workspacePath, 'divergent.txt'), 'divergent\n')
    await run(['git', 'add', 'divergent.txt'], identity.workspacePath)
    await run(['git', ...GIT_ID, 'commit', '-q', '-m', 'divergent'], identity.workspacePath)
    const divergent = await run(['git', 'rev-parse', 'HEAD'], identity.workspacePath)
    await expect(
      publication.publish({
        ref: identity.environmentId,
        sha: divergent,
        branch: 'ab/orch-ops-local999',
      }),
    ).rejects.toThrow(/not an ancestor/)
  })
})

test('private checkpoint retains two unpublished branch commits and detached work across replacement', async () => {
  const { preserveGitCommits, restoreGitCommits } = await import('./commit-preservation')
  const { gitRewrite } = await import('../forge/git-rewrite')
  const { root, origin, source, base, first, second } = await unpublishedBranch(
    'ab-commit-checkpoint-',
    'ab/checkpoint',
  )
  await run(['git', 'checkout', '--detach'], source)
  const detached = await commitFile(source, 'three', 'three', 'detached producer')
  const heads = await preserveGitCommits({
    exec: spawnExec,
    workspacePath: source,
    slug: 'checkpoint',
    branch: 'ab/checkpoint',
    base,
    candidates: [detached],
    archive: gitRewrite(spawnExec, false).archive,
  })
  expect(heads.find((head) => head.role === 'branch')?.commits).toEqual([second, first])
  expect(heads.find((head) => head.role === 'producer')?.sha).toBe(detached)
  const replacement = join(root, 'replacement')
  await run(['git', 'clone', '--branch', 'ab/checkpoint', origin, replacement], root)
  await restoreGitCommits({
    exec: spawnExec,
    workspacePath: replacement,
    branch: 'ab/checkpoint',
    heads,
  })
  expect(await run(['git', 'rev-parse', 'HEAD'], replacement)).toBe(second)
  for (const sha of [first, second, detached])
    await run(['git', 'cat-file', '-e', `${sha}^{commit}`], replacement)
  // Repeated restoration cannot move the branch or lose the detached object.
  await restoreGitCommits({
    exec: spawnExec,
    workspacePath: replacement,
    branch: 'ab/checkpoint',
    heads,
  })
  expect(await run(['git', 'rev-parse', 'HEAD'], replacement)).toBe(second)
})

test('a forge refusing archive refs preserves the unpublished range in the store for another host', async () => {
  const { preserveGitCommits, restoreGitCommits } = await import('./commit-preservation')
  const { gitRewrite } = await import('../forge/git-rewrite')
  const { retainPreservedCopy, restoreRetainedHead } = await import(
    '../../kernel/history-retention'
  )
  const { seedStore, BUILD } = await import('../../cli/testkit')
  const { root, origin, source, base, first, second } = await unpublishedBranch(
    'ab-commit-retained-',
    'ab/retained',
  )
  // Branch pushes are accepted; archive refs are refused, like a proxy.
  await writeFile(
    join(origin, 'hooks', 'update'),
    '#!/bin/sh\ncase "$1" in refs/autobuild/archive/*) echo "only branches" >&2; exit 1;; esac\nexit 0\n',
    { mode: 0o755 },
  )
  const store = await seedStore()
  const archive = gitRewrite(spawnExec, false).archive
  const context = (exec: Exec, workspacePath: string, exclude: string) => ({
    store,
    slug: BUILD,
    exec,
    workspacePath,
    exclude,
    local: false,
    branch: 'ab/retained',
    targetBranch: 'main',
    archive,
  })
  const preserve = () =>
    preserveGitCommits({
      exec: spawnExec,
      workspacePath: source,
      slug: BUILD,
      branch: 'ab/retained',
      base,
      candidates: [],
      archive,
      retain: (input) =>
        retainPreservedCopy(context(input.exec, input.workspacePath, input.base), input.sha),
    })
  const heads = await preserve()
  expect(heads).toEqual([
    { sha: second, role: 'branch', commits: [second, first], storeBase: base },
  ])
  expect(await store.getArtifact(BUILD, `history-objects-${second}`)).not.toBeNull()
  // A repeated preservation reuses the copy.
  expect(await preserve()).toEqual(heads)
  // Another host clones only the published branch and restores exactly those commits.
  const replacement = join(root, 'replacement')
  await run(['git', 'clone', '--branch', 'ab/retained', origin, replacement], root)
  const restore = (sha: string) => restoreRetainedHead(context(spawnExec, replacement, sha), sha)
  await restoreGitCommits({
    exec: spawnExec,
    workspacePath: replacement,
    branch: 'ab/retained',
    heads,
    restoreStored: restore,
  })
  expect(await run(['git', 'rev-parse', 'HEAD'], replacement)).toBe(second)
  expect(await run(['git', 'log', '--format=%s', `${base}..HEAD`], replacement)).toBe(
    'second unpublished\nfirst unpublished',
  )
})

describe('preserved branch heads superseded by a recorded rewrite', () => {
  /** base ← A ← P (replaced, archived) and base ← Q (the current branch). */
  async function history() {
    const { gitRewrite } = await import('../forge/git-rewrite')
    const root = await mkdtemp(join(tmpdir(), 'ab-superseded-'))
    const origin = join(root, 'origin.git')
    const repo = join(root, 'repo')
    await initRepo(repo)
    await run(['git', 'init', '-q', '--bare', origin], root)
    await run(['git', 'remote', 'add', 'origin', origin], repo)
    await run(['git', 'push', '-q', 'origin', 'main'], repo)
    const base = await run(['git', 'rev-parse', 'HEAD'], repo)
    const tree = await run(['git', 'rev-parse', 'HEAD^{tree}'], repo)
    const commit = (parent: string, message: string) =>
      run(['git', ...GIT_ID, 'commit-tree', tree, '-p', parent, '-m', message], repo)
    const a = await commit(base, 'preserved')
    const p = await commit(a, 'replaced')
    const q = await commit(base, 'rewritten')
    const c = await commit(p, 'unpublished over replaced')
    const archive = (sha: string) => `refs/autobuild/archive/x/${sha}`
    const head = (sha: string) => ({
      sha,
      remoteRef: archive(sha),
      role: 'branch' as const,
      commits: [sha],
    })
    return { gitRewrite, root, origin, repo, base, a, p, q, c, archive, head }
  }

  test('release archives a covered local branch as a producer', async () => {
    const { preserveGitCommits } = await import('./commit-preservation')
    const h = await history()
    const preserve = async (branchAt: string, replaced: string[]) => {
      await run(['git', 'update-ref', 'refs/heads/ab/x', branchAt], h.repo)
      const heads = await preserveGitCommits({
        exec: spawnExec,
        workspacePath: h.repo,
        branch: 'ab/x',
        slug: 'x',
        base: h.base,
        candidates: [],
        archive: h.gitRewrite(spawnExec, true).archive,
        replaced,
        local: true,
      })
      return heads.find((head) => head.sha === branchAt)?.role
    }
    expect(await preserve(h.p, [h.p])).toBe('producer')
    await run(['git', 'update-ref', h.archive(h.p), h.p], h.repo)
    expect(await preserve(h.a, [h.p])).toBe('producer')
    expect(await preserve(h.a, [])).toBe('branch')
    expect(await preserve(h.c, [h.p])).toBe('branch')
  })

  test('restoration classifies branch heads before any branch mutation', async () => {
    const { restoreGitCommits } = await import('./commit-preservation')
    const h = await history()
    for (const sha of [h.a, h.p, h.c]) await run(['git', 'update-ref', h.archive(sha), sha], h.repo)
    const restore = async (branchAt: string, heads: string[], replaced: string[]) => {
      await run(['git', 'update-ref', 'refs/heads/ab/x', branchAt], h.repo)
      const result = await restoreGitCommits({
        exec: spawnExec,
        workspacePath: h.repo,
        branch: 'ab/x',
        heads: heads.map(h.head),
        replaced,
        local: true,
      })
      return { ...result, branch: await run(['git', 'rev-parse', 'refs/heads/ab/x'], h.repo) }
    }
    // (d) a legacy divergent ancestor of a replaced head is skipped.
    expect(await restore(h.q, [h.a], [h.p])).toEqual({
      skipped: [{ sha: h.a, reason: 'superseded' }],
      branch: h.q,
    })
    // (e) supersession wins over the fast-forward path.
    expect(await restore(h.base, [h.a], [h.p])).toEqual({
      skipped: [{ sha: h.a, reason: 'superseded' }],
      branch: h.base,
    })
    // (f) divergent work outside the record is refused as before.
    await expect(restore(h.q, [h.a], [])).rejects.toThrow(
      'workspace restoration would overwrite divergent branch work',
    )
    await expect(restore(h.q, [h.c], [h.p])).rejects.toThrow(
      'workspace restoration would overwrite divergent branch work',
    )
    // (g) a head outside the record still fast-forwards.
    expect(await restore(h.base, [h.a], [h.q])).toEqual({ skipped: [], branch: h.a })
    // (h) an already-contained head is reported as contained.
    expect(await restore(h.p, [h.a], [])).toEqual({
      skipped: [{ sha: h.a, reason: 'contained' }],
      branch: h.p,
    })
  })

  test('a remote workspace fetches only missing replaced archives to classify', async () => {
    const { restoreGitCommits } = await import('./commit-preservation')
    const h = await history()
    await run(
      ['git', 'push', '-q', 'origin', `${h.q}:refs/heads/ab/x`, `${h.a}:${h.archive(h.a)}`],
      h.repo,
    )
    const workspace = join(h.root, 'workspace')
    await run(['git', 'clone', '-q', '--branch', 'ab/x', h.origin, workspace], h.root)
    const restore = () =>
      restoreGitCommits({
        exec: spawnExec,
        workspacePath: workspace,
        branch: 'ab/x',
        heads: [h.head(h.a)],
        replaced: [h.p],
      })
    // Without the replaced archive the head is not covered: the refusal stands.
    await expect(restore()).rejects.toThrow(
      'workspace restoration would overwrite divergent branch work',
    )
    expect(
      (await spawnExec(['git', 'cat-file', '-e', `${h.p}^{commit}`], { cwd: workspace })).exitCode,
    ).not.toBe(0)
    await run(['git', 'push', '-q', 'origin', `${h.p}:${h.archive(h.p)}`], h.repo)
    expect(await restore()).toEqual({ skipped: [{ sha: h.a, reason: 'superseded' }] })
    expect(await run(['git', 'rev-parse', 'HEAD'], workspace)).toBe(h.q)
  })
})

describe('local worktree restoration from forge archives (#916)', () => {
  /** A cloned repository whose provisioned branch is published, with one
   * unpublished commit preserved through `archive` and the worktree released. */
  async function preserved(local: boolean) {
    const { preserveGitCommits } = await import('./commit-preservation')
    const { gitRewrite } = await import('../forge/git-rewrite')
    const tmp = await mkdtemp(join(tmpdir(), 'ab-remote-restore-'))
    const origin = join(tmp, 'origin.git')
    const upstream = join(tmp, 'upstream')
    const repo = join(tmp, 'repo')
    const root = join(tmp, 'worktrees')
    await mkdir(origin, { recursive: true })
    await run(['git', 'init', '--bare', '-q', '-b', 'main'], origin)
    await initRepo(upstream)
    await run(['git', 'remote', 'add', 'origin', origin], upstream)
    await run(['git', 'push', '-q', '-u', 'origin', 'main'], upstream)
    await run(['git', 'clone', '-q', origin, repo], tmp)
    const base = await run(['git', 'rev-parse', 'refs/heads/main'], repo)
    const branch = 'ab/remote-restore'
    const calls: string[][] = []
    const provider = new GitWorktreeProvider({
      root,
      exec: async (cmd, opts) => {
        calls.push([...cmd])
        return spawnExec(cmd, opts)
      },
    })
    const handle = await provider.provision({ repo, baseBranch: 'main', branch })
    await run(['git', 'push', '-q', 'origin', branch], handle.path)
    const published = await run(['git', 'rev-parse', 'HEAD'], handle.path)
    const work = await commitFile(handle.path, 'work.ts', 'export const work = 1\n', 'work')
    const heads = await preserveGitCommits({
      exec: spawnExec,
      workspacePath: handle.path,
      slug: 'remote-restore',
      branch,
      base,
      candidates: [],
      archive: gitRewrite(spawnExec, local).archive,
      local,
    })
    expect(heads.map((head) => head.sha)).toEqual([work])
    await provider.release(handle)
    // The branch moved back after preservation, as a restack does, so
    // restoration must actually advance it to the preserved head.
    await run(['git', 'update-ref', `refs/heads/${branch}`, published], repo)
    const ref = heads[0]!.remoteRef!
    const localRef = () =>
      spawnExec(['git', 'rev-parse', '--verify', '--quiet', ref], { cwd: repo })
    const restore = (restorationArchives: 'local' | 'remote') =>
      provider.provision({
        repo,
        baseBranch: 'main',
        branch,
        restoration: heads,
        restorationArchives,
      })
    return { provider, origin, repo, base, work, ref, calls, localRef, restore }
  }

  test('a remote forge archive that exists only on origin restores without a manual fetch', async () => {
    const h = await preserved(false)
    // The stuck state from #916: archived on origin, absent locally.
    expect(await run(['git', 'ls-remote', 'origin', h.ref], h.repo)).toContain(h.work)
    expect((await h.localRef()).exitCode).toBe(1)

    const handle = await h.restore('remote')
    expect(await run(['git', 'rev-parse', 'HEAD'], handle.path)).toBe(h.work)
    expect(handle.base).toEqual({ source: 'existing', sha: h.work })
    expect((await h.localRef()).stdout.trim()).toBe(h.work)

    // Strict: an archive ref naming a different commit still fails.
    await h.provider.release(handle)
    await run(['git', 'update-ref', h.ref, h.base], h.origin)
    await run(['git', 'update-ref', '-d', h.ref], h.repo)
    await expect(h.restore('remote')).rejects.toThrow(/changed/)

    // A ref missing on both sides fails and names the ref.
    await run(['git', 'update-ref', '-d', h.ref], h.origin)
    await run(['git', 'update-ref', '-d', h.ref], h.repo)
    await expect(h.restore('remote')).rejects.toThrow(h.ref)
  })

  test('the local-git forge restores from the local repository without a fetch', async () => {
    const h = await preserved(true)
    expect((await h.localRef()).stdout.trim()).toBe(h.work)
    h.calls.length = 0
    const handle = await h.restore('local')
    expect(await run(['git', 'rev-parse', 'HEAD'], handle.path)).toBe(h.work)
    expect(h.calls.some((cmd) => cmd.includes('fetch') || cmd.includes('ls-remote'))).toBe(false)

    await h.provider.release(handle)
    await run(['git', 'update-ref', '-d', h.ref], h.repo)
    await expect(h.restore('local')).rejects.toThrow(
      `workspace restoration archive ref ${h.ref} is missing from the local repository`,
    )
  })
})

describe('GitWorktreeProvider placement and isolation (#1096)', () => {
  let tmp: string
  let repo: string
  /** The legacy state-tree root inside the checkout. */
  let legacyRoot: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'ab-git-worktree-isolation-'))
    repo = join(tmp, 'repo')
    legacyRoot = join(repo, '.autobuild', 'worktrees')
    await initRepo(repo)
  })

  const provisionOf = (provider: GitWorktreeProvider, branch: string) =>
    provider.provision({ repo, baseBranch: 'main', branch })
  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => {
        throw new Error('expected provisioning to fail')
      },
      (error: unknown) => error as WorktreeIsolationError,
    )
  const registrations = async () =>
    (await run(['git', 'worktree', 'list', '--porcelain'], repo)).split('\n\n').length

  test('an in-checkout destination is refused before anything is created; the notice never rejects', async () => {
    const isolatedRoot = join(repo, '.state', 'autobuild', 'worktrees', 'k')
    const provider = new GitWorktreeProvider({ root: legacyRoot, isolatedRoot })
    const error = await failure(provisionOf(provider, 'ab/in-checkout'))
    expect(error).toBeInstanceOf(WorktreeIsolationError)
    expect(error.root).toBe(isolatedRoot)
    expect(error.message).toContain('XDG_STATE_HOME')
    expect(await registrations()).toBe(1)
    expect(existsSync(legacyRoot)).toBe(false)
    expect(existsSync(isolatedRoot)).toBe(false)

    const notice = await worktreeIsolationNotice(provider, repo)
    expect(notice).toContain(error.message)
    expect(notice).toContain('builds already in a worktree continue')
    const valid = new GitWorktreeProvider({ root: legacyRoot, isolatedRoot: join(tmp, 'xdg', 'k') })
    expect(await worktreeIsolationNotice(valid, repo)).toBeUndefined()
  })

  test('a store symlinked into the checkout is placed on real paths', async () => {
    await mkdir(join(repo, '.autobuild'), { recursive: true })
    await symlink(join(repo, '.autobuild'), join(tmp, 'state-link'))
    const root = join(tmp, 'state-link', 'worktrees')
    const isolatedRoot = join(tmp, 'xdg', 'autobuild', 'worktrees', 'k')
    const handle = await provisionOf(new GitWorktreeProvider({ root, isolatedRoot }), 'ab/link')
    expect(handle.path).toBe(join(await realpath(isolatedRoot), 'ab-link'))
    expect(relative(await realpath(repo), handle.path)).toStartWith('..')

    const error = await failure(provisionOf(new GitWorktreeProvider({ root }), 'ab/link-bare'))
    expect(error).toBeInstanceOf(WorktreeIsolationError)
  })

  test('a node_modules above the destination is refused, and rechecked on every provision', async () => {
    const home = join(tmp, 'home')
    await mkdir(join(home, 'node_modules'), { recursive: true })
    const isolatedRoot = join(home, '.local', 'state', 'autobuild', 'worktrees', 'k')
    const provider = new GitWorktreeProvider({ root: legacyRoot, isolatedRoot })
    const error = await failure(provisionOf(provider, 'ab/ancestor'))
    expect(error).toBeInstanceOf(WorktreeIsolationError)
    expect(error.ancestor).toBe(await realpath(home))

    await rm(join(home, 'node_modules'), { recursive: true })
    const handle = await provisionOf(provider, 'ab/ancestor')
    expect(handle.path).toBe(join(await realpath(isolatedRoot), 'ab-ancestor'))
  })

  test('a legacy in-checkout registration is adopted in place, released, and never recreated there', async () => {
    const branch = 'ab/legacy'
    await run(['git', 'worktree', 'add', '-q', '-b', branch, join(legacyRoot, 'ab-legacy')], repo)
    const legacyPath = join(await realpath(legacyRoot), 'ab-legacy')
    await writeFile(join(legacyPath, 'probe.txt'), 'kept\n')
    const isolatedRoot = join(tmp, 'xdg', 'k')
    // Adoption is exempt from the check, even with an invalid destination.
    for (const candidate of [isolatedRoot, join(repo, '.state', 'k')]) {
      const handle = await provisionOf(
        new GitWorktreeProvider({ root: legacyRoot, isolatedRoot: candidate }),
        branch,
      )
      expect(handle.path).toBe(legacyPath)
      expect(handle.base.source).toBe('existing')
      expect(readFileSync(join(legacyPath, 'probe.txt'), 'utf8')).toBe('kept\n')
    }
    expect(existsSync(join(repo, '.state'))).toBe(false)

    const restarted = new GitWorktreeProvider({ root: legacyRoot, isolatedRoot })
    await restarted.release({ provider: 'git-worktree', ref: legacyPath, path: legacyPath, branch })
    expect(existsSync(legacyPath)).toBe(false)
    expect(await registrations()).toBe(1)
    const next = await provisionOf(restarted, branch)
    expect(next.path).toBe(join(await realpath(isolatedRoot), 'ab-legacy'))
  })

  test('a detached legacy registration at the branch tip is reattached in place', async () => {
    const branch = 'ab/legacy-detached'
    const path = join(legacyRoot, 'ab-legacy-detached')
    await run(['git', 'worktree', 'add', '-q', '-b', branch, path], repo)
    await run(['git', 'checkout', '-q', '--detach', 'HEAD'], path)
    const handle = await provisionOf(
      new GitWorktreeProvider({ root: legacyRoot, isolatedRoot: join(tmp, 'xdg', 'k') }),
      branch,
    )
    expect(handle.path).toBe(await realpath(path))
    expect(await run(['git', 'symbolic-ref', '--short', 'HEAD'], handle.path)).toBe(branch)
  })
})
