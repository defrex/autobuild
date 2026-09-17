/**
 * Contract tests for the git-worktree Workspace adapter (SPEC §3.2, §7,
 * §15.6-C) — real git against throwaway repos; the exec seam is used only
 * for error paths git itself can't produce on demand.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkspaceHandle } from '../types'
import { describeWorkspaceProviderContract } from './contract'
import { GitWorktreeProvider, spawnExec, type Exec } from './git-worktree'
import { SANDBOX_FORBIDDEN_ENV, SandboxOperationError } from './operator-sandbox'

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
    const { localSha, publishedSha } = await publishDetachedCommit(repo, handle.path, branch)
    await writeFile(join(handle.path, 'recovery-wip.txt'), 'preserve me\n')

    expect(await run(['git', 'rev-parse', `refs/heads/${branch}`], repo)).toBe(localSha)
    expect(await run(['git', 'rev-parse', `refs/remotes/origin/${branch}`], repo)).toBe(
      publishedSha,
    )
    expect(await run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], handle.path)).toBe('HEAD')

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
    expect(await run(['git', 'symbolic-ref', '--short', 'HEAD'], recovered.path)).toBe(branch)
    expect(await run(['git', 'rev-parse', 'HEAD'], recovered.path)).toBe(publishedSha)
    expect(await run(['git', 'rev-parse', `refs/heads/${branch}`], repo)).toBe(publishedSha)
    expect(await readFile(join(recovered.path, 'recovery-wip.txt'), 'utf8')).toBe('preserve me\n')
    expect(await registrationCount(repo, handle.path)).toBe(1)
    expect(calls.some((cmd) => cmd.includes('fetch'))).toBe(false)
    expect(calls.some((cmd) => cmd.includes('push'))).toBe(false)
  })

  test('reprovision rematerializes a removed detached workspace at its published head', async () => {
    const branch = 'ab/detached-removed'
    const handle = await provider.provision({ repo, baseBranch: 'main', branch })
    const { localSha, publishedSha } = await publishDetachedCommit(repo, handle.path, branch)
    await rm(handle.path, { recursive: true, force: true })

    expect(await run(['git', 'rev-parse', `refs/heads/${branch}`], repo)).toBe(localSha)

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
    expect(await run(['git', 'symbolic-ref', '--short', 'HEAD'], recovered.path)).toBe(branch)
    expect(await run(['git', 'rev-parse', 'HEAD'], recovered.path)).toBe(publishedSha)
    expect(await run(['git', 'rev-parse', `refs/heads/${branch}`], repo)).toBe(publishedSha)
    expect(await registrationCount(repo, handle.path)).toBe(1)
    expect(calls.some((cmd) => cmd.includes('fetch'))).toBe(false)
    expect(calls.some((cmd) => cmd.includes('push'))).toBe(false)
  })

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

  test('published recovery rejects divergent local and remote-tracking tips without rewriting either', async () => {
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
    const { publishedSha } = await publishDetachedCommit(repo, handle.path, branch)
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
    expect(await run(['git', 'rev-parse', 'HEAD'], handle.path)).toBe(unpublishedSha)
    expect(await run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], handle.path)).toBe('HEAD')
  })

  test('published recovery uses an expected old ref and preserves a concurrent advance', async () => {
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
      .provision({ repo, baseBranch: 'main', branch })
      .then(() => null)
      .catch((failure: unknown) => failure as Error)

    expect(raced).toBe(true)
    expect(attemptedUpdate?.slice(-3)).toEqual([branchRef, publishedSha, localSha])
    expect(error?.message).toMatch(/cannot lock ref|expected/i)
    expect(await run(['git', 'rev-parse', branchRef], repo)).toBe(concurrentSha)
    expect(await run(['git', 'rev-parse', `refs/remotes/origin/${branch}`], repo)).toBe(
      publishedSha,
    )
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
    const fetchedRef = 'refs/autobuild/provision/ab/resolve-fallback/base^{commit}'
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
    expect(provider.provision({ repo: missing, baseBranch: 'main', branch: 'x' })).rejects.toThrow(
      /does-not-exist/,
    )

    const plain = join(tmp, 'plain-dir')
    await mkdir(plain)
    expect(provider.provision({ repo: plain, baseBranch: 'main', branch: 'x' })).rejects.toThrow(
      /not a git repository/i,
    )
  })

  test('exec seam: git failures surface stderr in the thrown error', async () => {
    const failing: Exec = async () => ({
      stdout: '',
      stderr: 'fatal: disk on fire',
      exitCode: 128,
    })
    const broken = new GitWorktreeProvider({ root, exec: failing })
    expect(broken.provision({ repo, baseBranch: 'main', branch: 'ab/feature-6' })).rejects.toThrow(
      /disk on fire/,
    )
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

    // Reuse: the marker and setup are not re-run.
    const setupAt = statSync(join(identity.workspacePath, 'setup-marker.txt')).mtimeMs
    const reused = await provider.orchestratorSandbox.ensure({
      repo,
      operator: 'ops',
      baseBranch: 'main',
    })
    expect(reused).toEqual(identity)
    expect(statSync(join(identity.workspacePath, 'setup-marker.txt')).mtimeMs).toBe(setupAt)

    // describe resolves the same identity without provisioning anything new.
    expect(await provider.orchestratorSandbox.describe({ repo, operator: 'ops' })).toEqual(identity)
    expect(await provider.orchestratorSandbox.describe({ repo, operator: 'other' })).not.toEqual(
      identity,
    )
  })

  test('setup runs with the scrubbed guest environment, never the host environment', async () => {
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
      const dump = readFileSync(join(identity.workspacePath, 'env-dump.txt'), 'utf8')
      // Built from an empty record: a host-only variable never leaks in, and
      // only PATH plus the forwarded names are present.
      expect(dump).not.toContain('AB_SANDBOX_SETUP_CANARY')
      expect(dump).toContain('MY_TOOL_CONFIG=tool-value')
      expect(dump).toContain('PATH=')
      for (const name of SANDBOX_FORBIDDEN_ENV) {
        expect(dump).not.toContain(`${name}=`)
      }
    } finally {
      delete process.env.AB_SANDBOX_SETUP_CANARY
    }
  })

  test('exec runs commands with a scrubbed environment inside the checkout', async () => {
    const identity = await provider.orchestratorSandbox.ensure({
      repo,
      operator: 'ops',
      baseBranch: 'main',
    })
    const result = await provider.orchestratorSandbox.exec(identity, {
      command: 'pwd && echo "cfg=$MY_TOOL_CONFIG"',
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(identity.workspacePath)
    expect(result.stdout).toContain('cfg=tool-value')
    // Built from an empty record: no credential name, only PATH + forwarded.
    const envProbe = await provider.orchestratorSandbox.exec(identity, {
      command: 'env | sort',
    })
    for (const name of SANDBOX_FORBIDDEN_ENV) {
      expect(envProbe.stdout).not.toContain(`${name}=`)
    }
    expect(envProbe.stdout).toContain('MY_TOOL_CONFIG=tool-value')
    expect(envProbe.stdout).toContain('PATH=')
  })

  test('exec past its timeout fails typed and start/wait round-trips a detached child', async () => {
    const identity = await provider.orchestratorSandbox.ensure({
      repo,
      operator: 'ops',
      baseBranch: 'main',
    })
    const error = await provider.orchestratorSandbox
      .exec(identity, { command: 'sleep 5', timeoutSeconds: 1 })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SandboxOperationError)
    expect((error as SandboxOperationError).stage).toBe('exec-timeout')

    const { commandId } = await provider.orchestratorSandbox.start(identity, {
      command: 'echo streamed-output',
    })
    expect(
      await provider.orchestratorSandbox.wait(identity, { commandId, waitSeconds: 5 }),
    ).toEqual({
      state: 'exited',
      exitCode: 0,
      stdout: 'streamed-output\n',
      stderr: '',
    })
    // A restarted host loses detached-command tracking: typed not-found.
    const lost = await provider.orchestratorSandbox
      .wait(identity, { commandId: 'sbcmd-gone', waitSeconds: 0 })
      .catch((e: unknown) => e)
    expect(lost).toBeInstanceOf(SandboxOperationError)
    expect((lost as SandboxOperationError).stage).toBe('not-found')
  })

  test('the terminal wait consumes a finished detached command; a second wait fails typed not-found', async () => {
    const identity = await provider.orchestratorSandbox.ensure({
      repo,
      operator: 'ops',
      baseBranch: 'main',
    })
    const { commandId } = await provider.orchestratorSandbox.start(identity, {
      command: 'echo consumed',
    })
    expect(
      await provider.orchestratorSandbox.wait(identity, { commandId, waitSeconds: 5 }),
    ).toEqual({
      state: 'exited',
      exitCode: 0,
      stdout: 'consumed\n',
      stderr: '',
    })
    // Eviction reuses the restarted-host semantics: delivered results are
    // gone, and re-waiting them is typed not-found, not stale repetition.
    const again = await provider.orchestratorSandbox
      .wait(identity, { commandId, waitSeconds: 0 })
      .catch((e: unknown) => e)
    expect(again).toBeInstanceOf(SandboxOperationError)
    expect((again as SandboxOperationError).stage).toBe('not-found')
  })

  test('running waits do not consume; only the terminal exited wait does', async () => {
    const identity = await provider.orchestratorSandbox.ensure({
      repo,
      operator: 'ops',
      baseBranch: 'main',
    })
    const { commandId } = await provider.orchestratorSandbox.start(identity, {
      command: 'sleep 1',
    })
    for (let i = 0; i < 2; i++) {
      expect(
        await provider.orchestratorSandbox.wait(identity, { commandId, waitSeconds: 0 }),
      ).toEqual({
        state: 'running',
        stdout: '',
        stderr: '',
      })
    }
    expect(
      await provider.orchestratorSandbox.wait(identity, { commandId, waitSeconds: 5 }),
    ).toEqual({
      state: 'exited',
      exitCode: 0,
      stdout: '',
      stderr: '',
    })
  })

  test('finished-but-never-waited commands are bounded by the retention cap; running entries survive', async () => {
    const cap = (GitWorktreeProvider as unknown as { MAX_RETAINED_SANDBOX_COMMANDS: number })
      .MAX_RETAINED_SANDBOX_COMMANDS
    const identity = await provider.orchestratorSandbox.ensure({
      repo,
      operator: 'ops',
      baseBranch: 'main',
    })
    // Live sentinel: running for the whole test, must never be evicted.
    const sentinel = await provider.orchestratorSandbox.start(identity, {
      command: 'sleep 30',
    })
    // A burst of fire-and-forget echoes exceeding the cap by a wide margin;
    // none of them is waited on before the assertions, so only the cap can
    // bound them.
    const excess = 20
    const echoes: string[] = []
    for (let i = 0; i < cap + excess; i++) {
      echoes.push(
        (await provider.orchestratorSandbox.start(identity, { command: 'echo burst' })).commandId,
      )
    }

    // No private-access idiom exists in this suite; one-line cast local.
    const children = (
      provider as unknown as { sandboxChildren: Map<string, { exitCode: number | null }> }
    ).sandboxChildren

    // Settle: wait for every echo to have exited (and been stamped) without
    // calling `wait` — a wait observing `exited` would consume a never-waited
    // entry and defeat the test. The last exit stamp itself runs the final
    // cap-eviction pass, so once this settles the map is within bound.
    const deadline = Date.now() + 10_000
    const settled = (id: string): boolean => {
      const tracked = children.get(id)
      return tracked === undefined || tracked.exitCode !== null
    }
    while (Date.now() < deadline && !echoes.every(settled)) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(echoes.every(settled)).toBe(true)

    // The regression guard: with cap enforcement broken on either path
    // (insert-time or exit-stamp-time), the cap+excess entries remain.
    expect(children.size).toBeLessThanOrEqual(cap)

    // Exactly the oldest `excess + 1` echoes were evicted — 71 entries
    // (sentinel + cap + excess) trim to the cap with the sentinel
    // un-evictable, so the boundary is settled once every observed exit is
    // stamped, not left to scheduler timing. Typed not-found on wait.
    for (const id of echoes.slice(0, excess + 1)) {
      const evicted = await provider.orchestratorSandbox
        .wait(identity, { commandId: id, waitSeconds: 0 })
        .catch((e: unknown) => e)
      expect(evicted).toBeInstanceOf(SandboxOperationError)
      expect((evicted as SandboxOperationError).stage).toBe('not-found')
    }
    // The first retained echo — immediately past the evicted slice — still
    // delivers its result (and is consumed).
    const retained = echoes[excess + 1]!
    expect(
      await provider.orchestratorSandbox.wait(identity, { commandId: retained, waitSeconds: 5 }),
    ).toEqual({
      state: 'exited',
      exitCode: 0,
      stdout: 'burst\n',
      stderr: '',
    })
    // The running sentinel is untouched by the cap.
    expect(
      await provider.orchestratorSandbox.wait(identity, {
        commandId: sentinel.commandId,
        waitSeconds: 0,
      }),
    ).toEqual({
      state: 'running',
      stdout: '',
      stderr: '',
    })
  })

  test('eviction defers while an exited command’s drain-gated stamp is pending, then evicts the oldest finished first', async () => {
    // Own provider with a large drain grace so the delayed command’s stamp
    // is gated by its grandchild’s lifetime (drain EOF wins the race at ~2s),
    // not by the 250ms default — stamp timing is controlled, not lucky.
    const slowRoot = await mkdtemp(join(tmpdir(), 'ab-sandbox-worktrees-slow-'))
    const slowSandboxRoot = await mkdtemp(join(tmpdir(), 'ab-sandbox-root-slow-'))
    try {
      const slowProvider = new GitWorktreeProvider({
        root: slowRoot,
        sandboxRoot: slowSandboxRoot,
        exitDrainGraceMs: 5000,
      })
      const identity = await slowProvider.orchestratorSandbox.ensure({
        repo,
        operator: 'ops-slow',
        baseBranch: 'main',
      })
      const cap = (GitWorktreeProvider as unknown as { MAX_RETAINED_SANDBOX_COMMANDS: number })
        .MAX_RETAINED_SANDBOX_COMMANDS

      // Live sentinel: running for the whole test, never evictable.
      const sentinel = await slowProvider.orchestratorSandbox.start(identity, {
        command: 'sleep 30',
      })
      // The oldest finished command: its child exits in ~ms, but the
      // `sleep 2 &` grandchild holds the pipe write end, so the drain-gated
      // stamp lands ~2s later — long after any echo's stamp (~ms).
      const delayed = await slowProvider.orchestratorSandbox.start(identity, {
        command: 'sleep 2 & echo held-open',
      })

      // No private-access idiom exists in this suite; one-line cast local.
      const children = (
        slowProvider as unknown as {
          sandboxChildren: Map<
            string,
            {
              proc: { exitCode: number | null; signalCode: NodeJS.Signals | null }
              exitCode: number | null
            }
          >
        }
      ).sandboxChildren

      // Poll the tracked entry's synchronous exit state (the same probe the
      // eviction pass reads) until the child has exited but not yet been
      // stamped. Only then is the burst inserted, so the first over-cap pass
      // deterministically sees an exited-but-unstamped entry.
      const exitedUnstamped = (id: string): boolean => {
        const tracked = children.get(id)
        return (
          tracked !== undefined &&
          tracked.exitCode === null &&
          (tracked.proc.exitCode !== null || tracked.proc.signalCode !== null)
        )
      }
      const stampDeadline = Date.now() + 5000
      while (Date.now() < stampDeadline && !exitedUnstamped(delayed.commandId)) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(exitedUnstamped(delayed.commandId)).toBe(true)

      // Fill past the cap: sentinel + delayed + (cap - 1) echoes = cap + 1.
      const echoes: string[] = []
      for (let i = 0; i < cap - 1; i++) {
        echoes.push(
          (await slowProvider.orchestratorSandbox.start(identity, { command: 'echo burst' }))
            .commandId,
        )
      }
      // Every echo stamps within ~ms of its start (drain EOF wins
      // immediately); the delayed command's stamp needs ~2s.
      const echoDeadline = Date.now() + 5000
      const stamped = (id: string): boolean => children.get(id)?.exitCode !== null
      while (Date.now() < echoDeadline && !echoes.every(stamped)) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(echoes.every(stamped)).toBe(true)

      // Deferral: while the older command's stamp is pending, the over-cap
      // map evicts nothing — pre-fix code deletes the oldest stamped echo
      // here instead of the oldest finished entry.
      expect(children.has(delayed.commandId)).toBe(true)
      expect(children.size).toBe(cap + 1)
      expect(echoes.every((id) => children.has(id))).toBe(true)
      // Stamp semantics unchanged: an exited-but-unstamped entry still
      // reports `running`, and the wait does not consume it. (stdout may
      // already carry what drained before the stamp — the gate covers the
      // stamp, not the reader's own appends.)
      const pending = await slowProvider.orchestratorSandbox.wait(identity, {
        commandId: delayed.commandId,
        waitSeconds: 0,
      })
      expect(pending.state).toBe('running')

      // The delayed stamp (~2s) runs the next pass, which evicts exactly the
      // oldest finished entry — the delayed command itself (the running
      // sentinel is un-evictable). Size settles at the cap.
      const evictDeadline = Date.now() + 5000
      while (Date.now() < evictDeadline && children.has(delayed.commandId)) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(children.has(delayed.commandId)).toBe(false)
      expect(children.size).toBe(cap)

      // The evicted delayed command reports typed not-found on wait — the
      // legitimate not-found population under the cap.
      const evicted = await slowProvider.orchestratorSandbox
        .wait(identity, { commandId: delayed.commandId, waitSeconds: 0 })
        .catch((e: unknown) => e)
      expect(evicted).toBeInstanceOf(SandboxOperationError)
      expect((evicted as SandboxOperationError).stage).toBe('not-found')
      // Every newer echo survived, in order, with its output intact.
      for (const id of echoes) {
        expect(
          await slowProvider.orchestratorSandbox.wait(identity, { commandId: id, waitSeconds: 5 }),
        ).toEqual({
          state: 'exited',
          exitCode: 0,
          stdout: 'burst\n',
          stderr: '',
        })
      }
      // The running sentinel is untouched by the cap.
      expect(
        await slowProvider.orchestratorSandbox.wait(identity, {
          commandId: sentinel.commandId,
          waitSeconds: 0,
        }),
      ).toEqual({
        state: 'running',
        stdout: '',
        stderr: '',
      })
    } finally {
      await rm(slowRoot, { recursive: true, force: true })
      await rm(slowSandboxRoot, { recursive: true, force: true })
    }
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
})
