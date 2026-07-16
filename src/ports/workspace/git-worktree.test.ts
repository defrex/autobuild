/**
 * Contract tests for the git-worktree Workspace adapter (SPEC §3.2, §7,
 * §15.6-C) — real git against throwaway repos; the exec seam is used only
 * for error paths git itself can't produce on demand.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkspaceHandle } from '../types'
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

describe('GitWorktreeProvider', () => {
  let tmp: string
  let repo: string
  let root: string
  let provider: GitWorktreeProvider

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'ab-git-worktree-'))
    repo = join(tmp, 'origin')
    root = join(tmp, 'worktrees')
    await initRepo(repo)
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

  test('provision is idempotent for the same branch (constitution #2)', async () => {
    const first = await provider.provision({
      repo,
      baseBranch: 'main',
      branch: 'ab/feature-1',
    })
    await writeFile(join(first.path, 'in-progress.txt'), 'wip\n')

    const second = await provider.provision({
      repo,
      baseBranch: 'main',
      branch: 'ab/feature-1',
    })

    expect(second.path).toBe(first.path)
    expect(second.ref).toBe(first.ref)
    expect(second.branch).toBe(first.branch)
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
  })

  test('worktree is disposable, branch is durable: commit → release → re-provision (§15.6-C)', async () => {
    const handle = await provider.provision({
      repo,
      baseBranch: 'main',
      branch: 'ab/feature-2',
    })
    const sha = await commitFile(handle.path, 'work.txt', 'round 1\n', 'round 1')

    await provider.release(handle)
    expect(existsSync(handle.path)).toBe(false)
    // The branch survives release [D3].
    expect(
      await run(['git', 'rev-parse', 'refs/heads/ab/feature-2'], repo),
    ).toBe(sha)

    const resumed = await provider.provision({
      repo,
      baseBranch: 'main',
      branch: 'ab/feature-2',
    })
    expect(await run(['git', 'rev-parse', 'HEAD'], resumed.path)).toBe(sha)
    expect(existsSync(join(resumed.path, 'work.txt'))).toBe(true)
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

  test('unknown baseBranch fails with git stderr included', async () => {
    expect.assertions(2)
    try {
      await provider.provision({
        repo,
        baseBranch: 'no-such-base',
        branch: 'ab/feature-5',
      })
    } catch (error) {
      expect((error as Error).message).toContain('invalid reference')
      expect((error as Error).message).toContain('no-such-base')
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
