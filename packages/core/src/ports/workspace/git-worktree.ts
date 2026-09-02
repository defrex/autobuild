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
import type { WorkspaceBase } from '../../ontology'
import type { WorkspaceHandle, WorkspaceProvider, WorkspaceProvisionResult } from '../types'

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

/** Injectable exec seam — the default shells out via Bun.spawn. */
export type Exec = (cmd: string[], opts: { cwd?: string }) => Promise<ExecResult>

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
  const cleaned = branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '')
  return cleaned || 'branch'
}

interface WorktreeEntry {
  path: string
  head?: string
  branch?: string
  detached: boolean
}

interface WorktreeSelection {
  /** Requested branch attached inside this provider's root. */
  attached?: WorktreeEntry
  /** Detached registration at the requested branch's deterministic path. */
  detached?: WorktreeEntry
  /** The requested branch is attached anywhere, including outside our root. */
  branchAttached: boolean
}

function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  for (const block of porcelain.split('\n\n')) {
    let path: string | undefined
    let head: string | undefined
    let branch: string | undefined
    let detached = false
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length)
      else if (line.startsWith('branch refs/heads/'))
        branch = line.slice('branch refs/heads/'.length)
      else if (line === 'detached') detached = true
    }
    if (path) entries.push({ path, head, branch, detached })
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

  private shaFrom(dir: string, args: string[], result: ExecResult): string {
    if (result.exitCode !== 0) {
      throw new GitError(['-C', dir, ...args], result)
    }
    const sha = result.stdout.trim()
    if (sha === '') {
      throw new GitError(['-C', dir, ...args], {
        ...result,
        exitCode: 1,
        stderr: 'git returned no commit SHA',
      })
    }
    return sha
  }

  private async resolveCommit(repo: string, ref: string): Promise<string> {
    const args = ['rev-parse', '--verify', `${ref}^{commit}`]
    return this.shaFrom(repo, args, await this.git(repo, args))
  }

  private async resolveOptionalCommit(repo: string, ref: string): Promise<string | null> {
    const args = ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]
    const result = await this.git(repo, args)
    if (result.exitCode === 0) return this.shaFrom(repo, args, result)
    if (result.exitCode === 1) return null
    throw new GitError(['-C', repo, ...args], result)
  }

  private async isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean> {
    const args = ['merge-base', '--is-ancestor', ancestor, descendant]
    const result = await this.git(repo, args)
    if (result.exitCode === 0) return true
    if (result.exitCode === 1) return false
    throw new GitError(['-C', repo, ...args], result)
  }

  /** Reconcile a stale local build ref from the ref updated by a successful
   * Forge push. Both ancestry checks and the expected-old update make this a
   * normal fast-forward that cannot overwrite divergent or concurrent work. */
  private async recoverPublishedBranch(
    repo: string,
    branch: string,
    localSha: string,
  ): Promise<string> {
    const branchRef = `refs/heads/${branch}`
    const publishedRef = `refs/remotes/origin/${branch}`
    const publishedSha = await this.resolveOptionalCommit(repo, publishedRef)
    if (!publishedSha || publishedSha === localSha) return localSha

    if (await this.isAncestor(repo, localSha, publishedSha)) {
      await this.gitOrThrow(repo, ['update-ref', branchRef, publishedSha, localSha])
      return publishedSha
    }

    if (await this.isAncestor(repo, publishedSha, localSha)) return localSha

    throw new Error(
      `cannot recover ${branchRef}: local tip ${localSha} and published ` +
        `${publishedRef} tip ${publishedSha} have diverged; refusing to rewrite either ref`,
    )
  }

  /** Attach the one detached registration this provider owns. The published
   * ref must first have made its HEAD exactly the durable branch tip; an
   * arbitrary detached commit is never adopted or discarded. */
  private async reattachDetachedWorktree(
    repo: string,
    entry: WorktreeEntry,
    branch: string,
    expectedSha: string,
  ): Promise<string> {
    if (!entry.head) {
      throw new Error(
        `cannot recover detached worktree ${entry.path}: its registered HEAD is missing`,
      )
    }

    const liveHead = await this.resolveCommit(entry.path, 'HEAD')
    const branchRef = `refs/heads/${branch}`
    const branchSha = await this.resolveCommit(repo, branchRef)
    if (entry.head !== liveHead || branchSha !== expectedSha) {
      throw new Error(
        `cannot recover detached worktree ${entry.path}: its registration or ` +
          `${branchRef} changed during provisioning; refusing to move it`,
      )
    }
    if (liveHead !== branchSha) {
      throw new Error(
        `cannot recover detached worktree ${entry.path}: detached HEAD ${liveHead} ` +
          `does not match durable ${branchRef} tip ${branchSha}; refusing to discard either commit`,
      )
    }

    await this.gitOrThrow(entry.path, ['checkout', '--quiet', branch])

    const symbolicArgs = ['symbolic-ref', '--quiet', '--short', 'HEAD']
    const symbolic = await this.git(entry.path, symbolicArgs)
    const actualHead = await this.resolveCommit(entry.path, 'HEAD')
    const actualBranch = await this.resolveCommit(repo, branchRef)
    if (
      symbolic.exitCode !== 0 ||
      symbolic.stdout.trim() !== branch ||
      actualHead !== expectedSha ||
      actualBranch !== expectedSha
    ) {
      throw new Error(
        `detached worktree recovery at ${entry.path} did not produce ${branch} ` +
          `at expected commit ${expectedSha}`,
      )
    }
    return actualHead
  }

  /** Select a new branch's base without mutating any operator or shared
   * remote-tracking ref. A remote failure is evidence, not a dispatch gate. */
  private async selectNewBranchBase(
    repo: string,
    baseBranch: string,
    branch: string,
  ): Promise<WorkspaceBase> {
    const fetchedRef = `refs/autobuild/provision/${branch}/base`
    const fetchArgs = [
      'fetch',
      '--no-tags',
      '--no-write-fetch-head',
      '--refmap=',
      'origin',
      `+refs/heads/${baseBranch}:${fetchedRef}`,
    ]
    const fetched = await this.git(repo, fetchArgs)

    let remoteError: string | undefined
    if (fetched.exitCode !== 0) {
      remoteError = new GitError(['-C', repo, ...fetchArgs], fetched).message
    } else {
      const resolveArgs = ['rev-parse', '--verify', `${fetchedRef}^{commit}`]
      const resolved = await this.git(repo, resolveArgs)
      if (resolved.exitCode === 0) {
        return { source: 'remote', sha: this.shaFrom(repo, resolveArgs, resolved) }
      }
      remoteError = new GitError(['-C', repo, ...resolveArgs], resolved).message
    }

    // Remote refresh failures are non-fatal only while the fully qualified
    // local base is still a usable commit. A missing local base remains a
    // provisioning error rather than being hidden behind the fallback.
    const sha = await this.resolveCommit(repo, `refs/heads/${baseBranch}`)
    return { source: 'local', sha, remoteError }
  }

  async provision(opts: {
    repo: string
    baseBranch: string
    branch: string
  }): Promise<WorkspaceProvisionResult> {
    const { repo, baseBranch, branch } = opts
    // Fails with git's stderr for a missing path or a non-repo directory.
    await this.gitOrThrow(repo, ['rev-parse', '--git-dir'])
    // Drop registrations whose directories were deleted out-of-band, so
    // re-provision after a hand-cleaned sandbox still succeeds.
    await this.gitOrThrow(repo, ['worktree', 'prune'])

    const rootDir = await this.realRoot()
    const worktreePath = join(rootDir, sanitizeBranch(branch))
    const worktrees = await this.findWorktrees(repo, branch, rootDir, worktreePath)
    if (worktrees.attached) {
      // Idempotent provision (constitution #2): the registered worktree — at
      // the branch's current tip — is the resume point, not a fresh checkout.
      const sha = await this.resolveCommit(repo, `refs/heads/${branch}`)
      this.repos.set(worktrees.attached.path, repo)
      return {
        provider: this.name,
        ref: worktrees.attached.path,
        path: worktrees.attached.path,
        branch,
        base: { source: 'existing', sha },
      }
    }

    const branchRef = `refs/heads/${branch}`
    const localSha = await this.resolveOptionalCommit(repo, branchRef)
    if (localSha) {
      // A branch attached outside this provider's root is not ours to repair
      // or reuse. The ordinary worktree-add/checkout error below remains the
      // non-destructive diagnostic for that unsupported registration.
      const sha = worktrees.branchAttached
        ? localSha
        : await this.recoverPublishedBranch(repo, branch, localSha)

      if (worktrees.detached) {
        if (worktrees.branchAttached) {
          throw new Error(
            `cannot recover detached worktree ${worktrees.detached.path}: ` +
              `${branchRef} is already attached to another worktree`,
          )
        }
        const recoveredSha = await this.reattachDetachedWorktree(
          repo,
          worktrees.detached,
          branch,
          sha,
        )
        this.repos.set(worktrees.detached.path, repo)
        return {
          provider: this.name,
          ref: worktrees.detached.path,
          path: worktrees.detached.path,
          branch,
          base: { source: 'existing', sha: recoveredSha },
        }
      }

      // Resume (§15.6-C): rematerialize only after the local branch has been
      // monotonically reconciled with any push-updated publication evidence.
      // This path performs no fetch and no remote write.
      await this.gitOrThrow(repo, ['worktree', 'add', worktreePath, branch])
      this.repos.set(worktreePath, repo)
      return {
        provider: this.name,
        ref: worktreePath,
        path: worktreePath,
        branch,
        base: { source: 'existing', sha },
      }
    }

    if (worktrees.detached) {
      throw new Error(
        `cannot recover detached worktree ${worktrees.detached.path}: ` +
          `${branchRef} does not exist; refusing to adopt an arbitrary detached commit`,
      )
    }

    const base = await this.selectNewBranchBase(repo, baseBranch, branch)
    // Consume the selected immutable commit, not a mutable name that could
    // move between fetch and branch creation.
    await this.gitOrThrow(repo, ['worktree', 'add', '-b', branch, worktreePath, base.sha])
    const actualSha = await this.resolveCommit(repo, branchRef)
    if (actualSha !== base.sha) {
      throw new Error(`created ${branchRef} at ${actualSha}, expected selected base ${base.sha}`)
    }

    this.repos.set(worktreePath, repo)
    return {
      provider: this.name,
      ref: worktreePath,
      path: worktreePath,
      branch,
      base: { ...base, sha: actualSha },
    }
  }

  async release(handle: WorkspaceHandle): Promise<void> {
    const path = resolve(handle.ref)
    const repo = this.repos.get(path) ?? (await this.discoverRepo(path))
    // No repo to prune against means nothing was ever provisioned here (or it
    // is already fully gone) — releasing it is a no-op, not an error.
    if (!repo) return
    const removed = await this.git(repo, ['worktree', 'remove', '--force', path])
    // Already-gone worktrees are a no-op: unregistered paths say "is not a
    // working tree"; registered-but-deleted dirs say "validation failed …"
    // on older gits (2.50 removes them silently). Prune below cleans up.
    if (
      removed.exitCode !== 0 &&
      !/is not a working tree|validation failed, cannot remove working tree/i.test(removed.stderr)
    ) {
      throw new GitError(['-C', repo, 'worktree', 'remove', '--force', path], removed)
    }
    await this.gitOrThrow(repo, ['worktree', 'prune'])
    this.repos.delete(path)
  }

  /** Discover only registrations relevant to the requested branch. Attached
   * reuse stays root-scoped (and therefore excludes the main checkout); a
   * detached registration is recoverable only at this branch's exact,
   * deterministic provider-owned path. */
  private async findWorktrees(
    repo: string,
    branch: string,
    rootDir: string,
    worktreePath: string,
  ): Promise<WorktreeSelection> {
    const list = await this.gitOrThrow(repo, ['worktree', 'list', '--porcelain'])
    const entries = parseWorktreeList(list.stdout).map((entry) => ({
      ...entry,
      path: resolve(entry.path),
    }))
    return {
      attached: entries.find(
        (entry) => entry.branch === branch && entry.path.startsWith(rootDir + sep),
      ),
      detached: entries.find((entry) => entry.detached && entry.path === worktreePath),
      branchAttached: entries.some((entry) => entry.branch === branch),
    }
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
    return commonDir.endsWith(`${sep}.git`) ? commonDir.slice(0, -`${sep}.git`.length) : commonDir
  }
}
