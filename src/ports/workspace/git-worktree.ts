/**
 * Workspace adapter: git worktrees (SPEC §3.2). The worktree is disposable
 * scratch (§7); the branch is the build's durable code and travels through
 * the Forge, never the store (§15.2.4 [D3]) — so `release` removes only the
 * worktree and never touches the branch. Idempotent `provision` is what makes
 * resume-after-sandbox-death (§15.6-C) a re-run, not a special path
 * (constitution #2).
 */
import { mkdir, realpath } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { WorkspaceHandle, WorkspaceProvider } from '../types'

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

/** Injectable exec seam — the default shells out via Bun.spawn. */
export type Exec = (
  cmd: string[],
  opts: { cwd?: string },
) => Promise<ExecResult>

export const spawnExec: Exec = async (cmd, opts) => {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly result: ExecResult,
  ) {
    super(
      `git ${args.join(' ')} exited ${result.exitCode}: ${
        result.stderr.trim() || result.stdout.trim() || '(no output)'
      }`,
    )
    this.name = 'GitError'
  }
}

/** `ab/build-123` → `ab-build-123` — one subdir per branch under the root. */
function sanitizeBranch(branch: string): string {
  const cleaned = branch
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
  return cleaned || 'branch'
}

interface WorktreeEntry {
  path: string
  branch?: string
}

function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  for (const block of porcelain.split('\n\n')) {
    let path: string | undefined
    let branch: string | undefined
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
      else if (line.startsWith('branch refs/heads/'))
        branch = line.slice('branch refs/heads/'.length)
    }
    if (path) entries.push({ path, branch })
  }
  return entries
}

export class GitWorktreeProvider implements WorkspaceProvider {
  readonly name = 'git-worktree'
  private readonly root: string
  /** Canonicalized (symlink-free) root, resolved lazily — git reports
   * worktree paths canonicalized, so comparisons must be too. */
  private rootReal: string | null = null
  private readonly exec: Exec
  /** worktree path → repo it was provisioned from, so `release` can find the
   * repo without re-deriving it. Rebuilt lazily after a restart (release of a
   * still-on-disk worktree rediscovers the repo via git-common-dir). */
  private readonly repos = new Map<string, string>()

  constructor(opts: { root: string; exec?: Exec }) {
    this.root = resolve(opts.root)
    this.exec = opts.exec ?? spawnExec
  }

  private async realRoot(): Promise<string> {
    if (!this.rootReal) {
      await mkdir(this.root, { recursive: true })
      this.rootReal = await realpath(this.root)
    }
    return this.rootReal
  }

  /** Runs git against `dir` via `-C` so a nonexistent dir surfaces as git's
   * own stderr (`cannot change to …`) rather than a spawn failure. */
  private async git(dir: string, args: string[]): Promise<ExecResult> {
    return this.exec(['git', '-C', dir, ...args], {})
  }

  private async gitOrThrow(dir: string, args: string[]): Promise<ExecResult> {
    const result = await this.git(dir, args)
    if (result.exitCode !== 0) throw new GitError(['-C', dir, ...args], result)
    return result
  }

  async provision(opts: {
    repo: string
    baseBranch: string
    branch: string
  }): Promise<WorkspaceHandle> {
    const { repo, baseBranch, branch } = opts
    // Fails with git's stderr for a missing path or a non-repo directory.
    await this.gitOrThrow(repo, ['rev-parse', '--git-dir'])
    // Drop registrations whose directories were deleted out-of-band, so
    // re-provision after a hand-cleaned sandbox still succeeds.
    await this.gitOrThrow(repo, ['worktree', 'prune'])

    const rootDir = await this.realRoot()
    const existing = await this.findWorktree(repo, branch, rootDir)
    if (existing) {
      // Idempotent provision (constitution #2): the registered worktree — at
      // the branch's current tip — is the resume point, not a fresh checkout.
      this.repos.set(existing, repo)
      return { provider: this.name, ref: existing, path: existing, branch }
    }

    const worktreePath = join(rootDir, sanitizeBranch(branch))
    const branchExists =
      (
        await this.git(repo, [
          'rev-parse',
          '--verify',
          '--quiet',
          `refs/heads/${branch}`,
        ])
      ).exitCode === 0
    if (branchExists) {
      // Resume (§15.6-C): the worktree starts at the branch's current tip.
      await this.gitOrThrow(repo, ['worktree', 'add', worktreePath, branch])
    } else {
      // Creates the branch from baseBranch; an unknown baseBranch fails here
      // with git's stderr (`invalid reference: …`).
      await this.gitOrThrow(repo, [
        'worktree',
        'add',
        '-b',
        branch,
        worktreePath,
        baseBranch,
      ])
    }
    this.repos.set(worktreePath, repo)
    return {
      provider: this.name,
      ref: worktreePath,
      path: worktreePath,
      branch,
    }
  }

  async release(handle: WorkspaceHandle): Promise<void> {
    const path = resolve(handle.ref)
    const repo = this.repos.get(path) ?? (await this.discoverRepo(path))
    // No repo to prune against means nothing was ever provisioned here (or it
    // is already fully gone) — releasing it is a no-op, not an error.
    if (!repo) return
    const removed = await this.git(repo, [
      'worktree',
      'remove',
      '--force',
      path,
    ])
    // Already-gone worktrees are a no-op: unregistered paths say "is not a
    // working tree"; registered-but-deleted dirs say "validation failed …"
    // on older gits (2.50 removes them silently). Prune below cleans up.
    if (
      removed.exitCode !== 0 &&
      !/is not a working tree|validation failed, cannot remove working tree/i.test(
        removed.stderr,
      )
    ) {
      throw new GitError(['-C', repo, 'worktree', 'remove', '--force', path], removed)
    }
    await this.gitOrThrow(repo, ['worktree', 'prune'])
    this.repos.delete(path)
  }

  /** Registered worktree for `branch` under this provider's root, if any.
   * The root-prefix filter also excludes the main working tree, so
   * provisioning never aliases the origin's own checkout. */
  private async findWorktree(
    repo: string,
    branch: string,
    rootDir: string,
  ): Promise<string | null> {
    const list = await this.gitOrThrow(repo, [
      'worktree',
      'list',
      '--porcelain',
    ])
    for (const entry of parseWorktreeList(list.stdout)) {
      const path = resolve(entry.path)
      const underRoot = path.startsWith(rootDir + sep)
      if (entry.branch === branch && underRoot) return path
    }
    return null
  }

  /** Main-repo directory owning the worktree at `path`, or null if the path
   * is gone or not a worktree — the release-is-a-no-op cases. Needed when a
   * restarted process releases a worktree it did not provision (§7.4). */
  private async discoverRepo(path: string): Promise<string | null> {
    const result = await this.git(path, ['rev-parse', '--git-common-dir'])
    if (result.exitCode !== 0) return null
    const commonDir = resolve(path, result.stdout.trim())
    // The common dir is the main repo's `.git`; worktree commands need the
    // repo directory itself (a bare common dir already is one).
    return commonDir.endsWith(`${sep}.git`)
      ? commonDir.slice(0, -`${sep}.git`.length)
      : commonDir
  }
}
