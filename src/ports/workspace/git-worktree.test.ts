/**
 * Contract tests for the git-worktree Workspace adapter (SPEC §3.2, §7,
 * §15.6-C) — real git against throwaway repos; the exec seam is used only
 * for error paths git itself can't produce on demand.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkspaceHandle } from '../types'
import { describeWorkspaceProviderContract } from './contract'
import { GitWorktreeProvider, spawnExec, type Exec } from './git-worktree'

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
  const localSha = await run(
    ['git', 'rev-parse', `refs/heads/${branch}`],
    repo,
  )
  await run(['git', 'checkout', '-q', '--detach', 'HEAD'], worktree)
  const publishedSha = await commitFile(
    worktree,
    'detached.ts',
    'export const detached = true\n',
    'detached completion',
  )
  await run(
    ['git', 'push', '-q', '-u', 'origin', `HEAD:refs/heads/${branch}`],
    worktree,
  )
  return { localSha, publishedSha }
}

async function registrationCount(repo: string, path: string): Promise<number> {
  const list = await run(['git', 'worktree', 'list', '--porcelain'], repo)
  return list
    .split('\n\n')
    .filter((block) => block.split('\n').includes(`worktree ${path}`)).length
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
    const handle = await provider.provision({
      repo,
      baseBranch: 'main',
      branch: 'ab/feature-1',
    })

    expect(handle.provider).toBe('git-worktree')
    expect(handle.branch).toBe('ab/feature-1')
    expect(handle.base).toEqual({
      source: 'remote',
      sha: await run(['git', 'rev-parse', 'refs/heads/main'], remote),
    })
    // Paths come back canonicalized (macOS /var → /private/var), one
    // sanitized subdir per branch.
    expect(handle.path).toBe(join(await realpath(root), 'ab-feature-1'))
    expect(handle.ref).toBe(handle.path)
    expect(existsSync(join(handle.path, 'README.md'))).toBe(true)

    // Starts at the base branch's tip.
    const baseSha = await run(['git', 'rev-parse', 'main'], repo)
    expect(await run(['git', 'rev-parse', 'HEAD'], handle.path)).toBe(baseSha)

    // Workspace is scratch (§7): writes never leak into the origin tree.
    await writeFile(join(handle.path, 'scratch.txt'), 'workspace-only\n')
    expect(existsSync(join(repo, 'scratch.txt'))).toBe(false)

    // The branch is durable state in the origin repo [D3].
    const ref = await run(
      ['git', 'rev-parse', '--verify', 'refs/heads/ab/feature-1'],
      repo,
    )
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
    expect(await run(['git', 'rev-parse', 'refs/heads/main'], repo)).toBe(
      staleLocalSha,
    )
    expect(await run(['git', 'rev-parse', 'refs/remotes/origin/main'], repo)).toBe(
      staleLocalSha,
    )
  })

  test('provision is idempotent for the same branch (constitution #2)', async () => {
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
    await writeFile(join(first.path, 'in-progress.txt'), 'wip\n')

    calls.length = 0
    const second = await provider.provision({
      repo,
      baseBranch: 'main',
      branch: 'ab/feature-1',
    })

    expect(second.path).toBe(first.path)
    expect(second.ref).toBe(first.ref)
    expect(second.branch).toBe(first.branch)
    expect(second.base).toEqual({
      source: 'existing',
      sha: first.base.sha,
    })
    expect(calls.some((cmd) => cmd.includes('fetch'))).toBe(false)
    // Reused, not recreated: uncommitted work is untouched.
    expect(existsSync(join(first.path, 'in-progress.txt'))).toBe(true)

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

  test('reprovision reattaches a registered detached worktree at its published head', async () => {
    const branch = 'ab/detached-registered'
    const handle = await provider.provision({ repo, baseBranch: 'main', branch })
    const { localSha, publishedSha } = await publishDetachedCommit(
      repo,
      handle.path,
      branch,
    )
    await writeFile(join(handle.path, 'recovery-wip.txt'), 'preserve me\n')

    expect(await run(['git', 'rev-parse', `refs/heads/${branch}`], repo)).toBe(
      localSha,
    )
    expect(
      await run(['git', 'rev-parse', `refs/remotes/origin/${branch}`], repo),
    ).toBe(publishedSha)
    expect(await run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], handle.path)).toBe(
      'HEAD',
    )

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
    })

    expect(recovered.path).toBe(handle.path)
    expect(recovered.base).toEqual({ source: 'existing', sha: publishedSha })
    expect(await run(['git', 'symbolic-ref', '--short', 'HEAD'], recovered.path)).toBe(
      branch,
    )
    expect(await run(['git', 'rev-parse', 'HEAD'], recovered.path)).toBe(
      publishedSha,
    )
    expect(await run(['git', 'rev-parse', `refs/heads/${branch}`], repo)).toBe(
      publishedSha,
    )
    expect(await readFile(join(recovered.path, 'recovery-wip.txt'), 'utf8')).toBe(
      'preserve me\n',
    )
    expect(await registrationCount(repo, handle.path)).toBe(1)
    expect(calls.some((cmd) => cmd.includes('fetch'))).toBe(false)
    expect(calls.some((cmd) => cmd.includes('push'))).toBe(false)
  })

  test('reprovision rematerializes a removed detached workspace at its published head', async () => {
    const branch = 'ab/detached-removed'
    const handle = await provider.provision({ repo, baseBranch: 'main', branch })
    const { localSha, publishedSha } = await publishDetachedCommit(
      repo,
      handle.path,
      branch,
    )
    await rm(handle.path, { recursive: true, force: true })

    expect(await run(['git', 'rev-parse', `refs/heads/${branch}`], repo)).toBe(
      localSha,
    )

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
    })

    expect(recovered.path).toBe(handle.path)
    expect(recovered.base).toEqual({ source: 'existing', sha: publishedSha })
    expect(await run(['git', 'symbolic-ref', '--short', 'HEAD'], recovered.path)).toBe(
      branch,
    )
    expect(await run(['git', 'rev-parse', 'HEAD'], recovered.path)).toBe(
      publishedSha,
    )
    expect(await run(['git', 'rev-parse', `refs/heads/${branch}`], repo)).toBe(
      publishedSha,
    )
    expect(await registrationCount(repo, handle.path)).toBe(1)
    expect(calls.some((cmd) => cmd.includes('fetch'))).toBe(false)
    expect(calls.some((cmd) => cmd.includes('push'))).toBe(false)
  })

  test('published recovery never rolls back a newer local build branch', async () => {
    const branch = 'ab/local-ahead'
    const branchRef = `refs/heads/${branch}`
    const handle = await provider.provision({ repo, baseBranch: 'main', branch })
    const { localSha, publishedSha } = await publishDetachedCommit(
      repo,
      handle.path,
      branch,
    )
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
    expect(
      await run(['git', 'merge-base', '--is-ancestor', publishedSha, newerSha], repo),
    ).toBe('')
    expect(recovered.base).toEqual({ source: 'existing', sha: newerSha })
    expect(await run(['git', 'rev-parse', branchRef], repo)).toBe(newerSha)
    expect(await run(['git', 'rev-parse', 'HEAD'], recovered.path)).toBe(newerSha)
    expect(
      await run(['git', 'rev-parse', `refs/remotes/origin/${branch}`], repo),
    ).toBe(publishedSha)
  })

  test('published recovery rejects divergent local and remote-tracking tips without rewriting either', async () => {
    const branch = 'ab/divergent-recovery'
    const branchRef = `refs/heads/${branch}`
    const publishedRef = `refs/remotes/origin/${branch}`
    const handle = await provider.provision({ repo, baseBranch: 'main', branch })
    const { publishedSha } = await publishDetachedCommit(
      repo,
      handle.path,
      branch,
    )

    await run(['git', 'checkout', '-q', branch], handle.path)
    const divergentSha = await commitFile(
      handle.path,
      'divergent.ts',
      'export const divergent = true\n',
      'divergent local work',
    )
    await provider.release(handle)

    const error = await new GitWorktreeProvider({ root })
      .provision({ repo, baseBranch: 'main', branch })
      .then(() => null)
      .catch((failure: unknown) => failure as Error)

    expect(error?.message).toContain('have diverged')
    expect(error?.message).toContain(branchRef)
    expect(error?.message).toContain(publishedRef)
    expect(await run(['git', 'rev-parse', branchRef], repo)).toBe(divergentSha)
    expect(await run(['git', 'rev-parse', publishedRef], repo)).toBe(publishedSha)
    expect(existsSync(handle.path)).toBe(false)
  })

  test('registered detached recovery refuses an unpublished detached commit', async () => {
    const branch = 'ab/unpublished-detached'
    const branchRef = `refs/heads/${branch}`
    const handle = await provider.provision({ repo, baseBranch: 'main', branch })
    const { publishedSha } = await publishDetachedCommit(
      repo,
      handle.path,
      branch,
    )
    const unpublishedSha = await commitFile(
      handle.path,
      'unpublished.ts',
      'export const unpublished = true\n',
      'unpublished detached work',
    )

    const error = await new GitWorktreeProvider({ root })
      .provision({ repo, baseBranch: 'main', branch })
      .then(() => null)
      .catch((failure: unknown) => failure as Error)

    expect(error?.message).toContain('does not match durable')
    expect(error?.message).toContain('refusing to discard either commit')
    expect(await run(['git', 'rev-parse', branchRef], repo)).toBe(publishedSha)
    expect(await run(['git', 'rev-parse', 'HEAD'], handle.path)).toBe(
      unpublishedSha,
    )
    expect(await run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], handle.path)).toBe(
      'HEAD',
    )
  })

  test('published recovery uses an expected old ref and preserves a concurrent advance', async () => {
    const branch = 'ab/concurrent-recovery'
    const branchRef = `refs/heads/${branch}`
    const handle = await provider.provision({ repo, baseBranch: 'main', branch })
    const { localSha, publishedSha } = await publishDetachedCommit(
      repo,
      handle.path,
      branch,
    )
    const concurrentSha = await commitFile(
      handle.path,
      'concurrent.ts',
      'export const concurrent = true\n',
      'concurrent local advance',
    )
    await run(
      ['git', 'update-ref', 'refs/autobuild/tests/concurrent', concurrentSha],
      repo,
    )
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
      .provision({ repo, baseBranch: 'main', branch })
      .then(() => null)
      .catch((failure: unknown) => failure as Error)

    expect(raced).toBe(true)
    expect(attemptedUpdate?.slice(-3)).toEqual([
      branchRef,
      publishedSha,
      localSha,
    ])
    expect(error?.message).toMatch(/cannot lock ref|expected/i)
    expect(await run(['git', 'rev-parse', branchRef], repo)).toBe(concurrentSha)
    expect(
      await run(['git', 'rev-parse', `refs/remotes/origin/${branch}`], repo),
    ).toBe(publishedSha)
    expect(existsSync(handle.path)).toBe(false)
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
    expect(
      await run(['git', 'rev-parse', 'refs/heads/ab/feature-2'], repo),
    ).toBe(sha)

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

  test('release is idempotent and no-ops on never-provisioned handles', async () => {
    const handle = await provider.provision({
      repo,
      baseBranch: 'main',
      branch: 'ab/feature-3',
    })
    await provider.release(handle)
    await provider.release(handle) // already removed → no-op

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

  test('an authentication-style fetch failure falls back locally and is retained verbatim', async () => {
    const localSha = await run(['git', 'rev-parse', 'refs/heads/main'], repo)
    const authFailure: Exec = async (cmd, opts) => {
      if (cmd.includes('fetch')) {
        return {
          stdout: '',
          stderr: 'fatal: Authentication failed for origin',
          exitCode: 128,
        }
      }
      return spawnExec(cmd, opts)
    }
    provider = new GitWorktreeProvider({ root, exec: authFailure })

    const handle = await provider.provision({
      repo,
      baseBranch: 'main',
      branch: 'ab/auth-fallback',
    })

    expect(handle.base).toEqual({
      source: 'local',
      sha: localSha,
      remoteError: expect.stringContaining('fatal: Authentication failed for origin'),
    })
  })

  test('a fetched-ref resolution failure also falls back with its diagnostic', async () => {
    const localSha = await run(['git', 'rev-parse', 'refs/heads/main'], repo)
    const fetchedRef =
      'refs/autobuild/provision/ab/resolve-fallback/base^{commit}'
    const resolutionFailure: Exec = async (cmd, opts) => {
      if (cmd.at(-1) === fetchedRef) {
        return {
          stdout: '',
          stderr: 'fatal: fetched ref could not be resolved',
          exitCode: 128,
        }
      }
      return spawnExec(cmd, opts)
    }
    provider = new GitWorktreeProvider({ root, exec: resolutionFailure })

    const handle = await provider.provision({
      repo,
      baseBranch: 'main',
      branch: 'ab/resolve-fallback',
    })

    expect(handle.base).toEqual({
      source: 'local',
      sha: localSha,
      remoteError: expect.stringContaining(
        'refs/autobuild/provision/ab/resolve-fallback/base^{commit} exited 128',
      ),
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

  test('unknown baseBranch fails with the local ref diagnostic', async () => {
    expect.assertions(2)
    try {
      await provider.provision({
        repo,
        baseBranch: 'no-such-base',
        branch: 'ab/feature-5',
      })
    } catch (error) {
      expect((error as Error).message).toContain('Needed a single revision')
      expect((error as Error).message).toContain('refs/heads/no-such-base')
    }
  })

  test('nonexistent repo path and non-repo directory fail informatively', async () => {
    const missing = join(tmp, 'does-not-exist')
    expect(
      provider.provision({ repo: missing, baseBranch: 'main', branch: 'x' }),
    ).rejects.toThrow(/does-not-exist/)

    const plain = join(tmp, 'plain-dir')
    await mkdir(plain)
    expect(
      provider.provision({ repo: plain, baseBranch: 'main', branch: 'x' }),
    ).rejects.toThrow(/not a git repository/i)
  })

  test('exec seam: git failures surface stderr in the thrown error', async () => {
    const failing: Exec = async () => ({
      stdout: '',
      stderr: 'fatal: disk on fire',
      exitCode: 128,
    })
    const broken = new GitWorktreeProvider({ root, exec: failing })
    expect(
      broken.provision({ repo, baseBranch: 'main', branch: 'ab/feature-6' }),
    ).rejects.toThrow(/disk on fire/)
  })

  test('exec seam: release rethrows unexpected worktree-remove failures', async () => {
    let failRemove = false
    const flaky: Exec = async (cmd, opts) => {
      if (failRemove && cmd.includes('remove')) {
        return { stdout: '', stderr: 'fatal: worktree is locked', exitCode: 128 }
      }
      return spawnExec(cmd, opts)
    }
    const flakyProvider = new GitWorktreeProvider({ root, exec: flaky })
    const handle = await flakyProvider.provision({
      repo,
      baseBranch: 'main',
      branch: 'ab/feature-7',
    })
    failRemove = true
    expect(flakyProvider.release(handle)).rejects.toThrow(/worktree is locked/)
  })
})
