/**
 * Workspace adapter: git worktrees (SPEC §3.2). The worktree is disposable
 * scratch (§7); the branch is the build's durable code and travels through
 * the Forge, never the store (§15.2.4 [D3]) — so `release` removes only the
 * worktree and never touches the branch. Idempotent `provision` is what makes
 * resume-after-sandbox-death (§15.6-C) a re-run, not a special path
 * (constitution #2).
 */
import { mkdir, realpath } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { readFile as fsReadFile, rm, stat, writeFile as fsWriteFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { WorkspaceBase } from '../../ontology'
import {
  SandboxOperationError,
  type OperatorSandboxExecution,
  type SandboxCommandRequest,
  type SandboxCommandResult,
  type SandboxEnvironmentIdentity,
  type SandboxWaitResult,
} from './operator-sandbox'
import type {
  WorkspaceHandle,
  WorkspaceProvider,
  WorkspaceProvisionResult,
  WorkspacePublication,
} from '../types'

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

/** Injectable exec seam — the default shells out via Bun.spawn. */
export type Exec = (
  cmd: string[],
  opts: { cwd?: string; signal?: AbortSignal },
) => Promise<ExecResult>

export const spawnExec: Exec = async (cmd, opts) => {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
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
  readonly orchestratorSandbox: OperatorSandboxExecution
  readonly sandboxPublication: WorkspacePublication
  private readonly root: string
  private readonly sandboxRoot: string
  private readonly setupCommand: string | undefined
  private readonly sandboxEnvironmentVariables: readonly string[]
  private readonly sandboxEnvSource: Record<string, string | undefined>
  /** Canonicalized (symlink-free) root, resolved lazily — git reports
   * worktree paths canonicalized, so comparisons must be too. */
  private rootReal: string | null = null
  private readonly exec: Exec
  /** worktree path → repo it was provisioned from, so `release` can find the
   * repo without re-deriving it. Rebuilt lazily after a restart (release of a
   * still-on-disk worktree rediscovers the repo via git-common-dir). */
  private readonly repos = new Map<string, string>()

  constructor(opts: {
    root: string
    exec?: Exec
    /** Test-only override of the exit-stamp drain grace
     * (`DEFAULT_SANDBOX_EXIT_DRAIN_GRACE_MS`); production behavior is
     * unchanged. */
    exitDrainGraceMs?: number
    /** Operator-sandbox worktree root; defaults to a sibling of the build
     * worktree root inside the local state tree. */
    sandboxRoot?: string
    /** The repository's raw `[commands].setup` shell string, run once per
     * fresh operator-sandbox worktree. */
    setupCommand?: string
    /** Forwarded non-secret variable names, resolved from `envSource`. */
    sandboxEnvironmentVariables?: readonly string[]
    /** Host environment the guest PATH and forwarded names resolve from.
     * The guest environment is otherwise built from an empty record. */
    envSource?: Record<string, string | undefined>
  }) {
    this.root = resolve(opts.root)
    this.sandboxRoot = resolve(opts.sandboxRoot ?? join(opts.root, '..', 'orchestrator-sandboxes'))
    this.setupCommand = opts.setupCommand
    this.sandboxEnvironmentVariables = opts.sandboxEnvironmentVariables ?? []
    this.sandboxEnvSource = opts.envSource ?? {}
    this.exitDrainGraceMs =
      opts.exitDrainGraceMs ?? GitWorktreeProvider.DEFAULT_SANDBOX_EXIT_DRAIN_GRACE_MS
    this.exec = opts.exec ?? spawnExec
    this.orchestratorSandbox = {
      describe: (input) => Promise.resolve(this.sandboxIdentity(input.repo, input.operator)),
      ensure: (input) => this.ensureSandbox(input),
      exec: (handle, request) => this.sandboxExec(handle, request),
      start: (handle, request) => this.sandboxStart(handle, request),
      wait: (handle, input) => this.sandboxWait(handle, input),
      readFile: (handle, path) => this.sandboxReadFile(handle, path),
      writeFile: (handle, path, content) => this.sandboxWriteFile(handle, path, content),
      stop: () => Promise.resolve({ outcome: 'unsupported' as const }),
      release: (input) => this.sandboxRelease(input),
    }
    this.sandboxPublication = {
      isPublished: (input) => this.sandboxIsPublished(input),
      publish: (input) => this.publishSandbox(input),
    }
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
        localPath: worktrees.attached.path,
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
          localPath: worktrees.detached.path,
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
        localPath: worktreePath,
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
      localPath: worktreePath,
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

  // ── Operator sandbox capability (AUT-340) ──────────────────────
  //
  // One worktree per operator × repository under the local state tree,
  // provisioned with the repository's setup command; the same registry tools
  // operate on it. A local worktree has no stop/snapshot lifecycle, so `stop`
  // declines honestly and the idle settlement skips it.

  private sandboxPath(repo: string, operator: string): string {
    const digest = createHash('sha256').update(`${repo}\0${operator}`).digest('hex').slice(0, 10)
    return join(this.sandboxRoot, digest)
  }

  private sandboxIdentity(repo: string, operator: string): SandboxEnvironmentIdentity {
    const path = this.sandboxPath(repo, operator)
    return { provider: this.name, environmentId: path, workspacePath: path }
  }

  /** The credential-free guest environment: one fresh record per call —
   * never the host environment wholesale — holding the host PATH plus the
   * forwarded names. */
  private sandboxEnv(): Record<string, string> {
    const env: Record<string, string> = {
      PATH: this.sandboxEnvSource.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    }
    for (const name of this.sandboxEnvironmentVariables) {
      const value = this.sandboxEnvSource[name]
      if (value === undefined || value === '') {
        throw new SandboxOperationError(
          'environment',
          `operator sandbox environment variable ${name} is not set in the host environment`,
        )
      }
      env[name] = value
    }
    return env
  }

  private async isRegisteredWorktree(path: string, repo: string): Promise<boolean> {
    const list = await this.git(repo, ['worktree', 'list', '--porcelain'])
    if (list.exitCode !== 0) return false
    return parseWorktreeList(list.stdout).some((entry) => resolve(entry.path) === resolve(path))
  }

  private async ensureSandbox(input: {
    repo: string
    operator: string
    baseBranch: string
  }): Promise<SandboxEnvironmentIdentity> {
    const identity = this.sandboxIdentity(input.repo, input.operator)
    if (await this.isRegisteredWorktree(identity.environmentId, input.repo)) {
      // Pre-existing sandboxes provisioned before the info/exclude write
      // landed (AUT-580) keep an unexcluded marker; write the exclusion on
      // every ensure so the publish service's untracked-inclusive dirty
      // check never counts the marker as dirt and the correct baseSha /
      // reset-required diagnostic surfaces.
      await this.excludeProvisioningMarker(identity.workspacePath)
      return identity
    }
    await mkdir(this.sandboxRoot, { recursive: true })
    const baseHead = await this.resolveCommit(input.repo, `refs/heads/${input.baseBranch}`)
    await this.gitOrThrow(input.repo, [
      'worktree',
      'add',
      '--detach',
      identity.environmentId,
      baseHead,
    ])
    try {
      await this.excludeProvisioningMarker(identity.workspacePath)
      const marker = join(identity.workspacePath, '.autobuild-sandbox-provisioned')
      const provisioned = await stat(marker).then(
        () => true,
        () => false,
      )
      if (!provisioned && this.setupCommand !== undefined && this.setupCommand.trim() !== '') {
        // The setup command runs with the same credential-free guest
        // environment as every tool exec — never the host environment
        // wholesale, or a setup script would be a second route to build
        // state. Unbounded: provisioning may install for a long time.
        const result = await this.spawnSandboxCommand(this.setupCommand, identity.workspacePath)
        if (result.exitCode !== 0) {
          throw new SandboxOperationError(
            'provision',
            `operator sandbox setup failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`,
          )
        }
      }
      await fsWriteFile(marker, '')
    } catch (error) {
      // A half-provisioned worktree is removed so the next call starts over.
      await this.git(input.repo, ['worktree', 'remove', '--force', identity.environmentId])
      await this.git(input.repo, ['worktree', 'prune'])
      throw error
    }
    return { ...identity, baseSha: baseHead }
  }

  /** Idempotently exclude the provisioning marker in the worktree's
   * info/exclude so it never counts as dirt for the publish service's
   * untracked-inclusive dirty check (f_c748dc6a). Runs on both ensure
   * paths — fresh provisioning and the registered-worktree early return —
   * so sandboxes provisioned before the write landed are healed the next
   * time they are ensured. Errors propagate: a failed exclusion write
   * aborts provisioning, mirroring fail-closed behavior. */
  private async excludeProvisioningMarker(workspacePath: string): Promise<void> {
    const markerName = '.autobuild-sandbox-provisioned'
    const exclude = await this.gitOrThrow(workspacePath, [
      'rev-parse',
      '--git-path',
      'info/exclude',
    ])
    const excludePath = resolve(workspacePath, exclude.stdout.trim())
    await mkdir(excludePath.slice(0, excludePath.lastIndexOf(sep)), { recursive: true })
    const existing = await fsReadFile(excludePath, 'utf8').then(
      (content) => content,
      () => '',
    )
    const lines = existing.split('\n')
    if (!lines.includes(markerName)) {
      const prefix = existing === '' || existing.endsWith('\n') ? existing : `${existing}\n`
      await fsWriteFile(excludePath, `${prefix}${markerName}\n`)
    }
  }

  /** One `sh -c` command inside the sandbox worktree with the credential-free
   * guest environment (an empty record plus the host PATH and the forwarded
   * names — never the host environment wholesale). `timeoutSeconds` bounds
   * the child and kills it past the bound; undefined runs unbounded (the
   * setup command may install for a long time). */
  private async spawnSandboxCommand(
    command: string,
    cwd: string,
    timeoutSeconds?: number,
  ): Promise<SandboxCommandResult> {
    const proc = Bun.spawn(['sh', '-c', command], {
      cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: this.sandboxEnv(),
    })
    if (timeoutSeconds === undefined) {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return { exitCode: exitCode ?? -1, stdout, stderr }
    }
    const timer = AbortSignal.timeout(timeoutSeconds * 1000)
    const exitedOrTimeout = Promise.race([
      proc.exited.then((code) => ({ kind: 'exited' as const, code })),
      new Promise<never>((_, reject) => {
        timer.addEventListener(
          'abort',
          () =>
            reject(
              new SandboxOperationError(
                'exec-timeout',
                `sandbox command exceeded its ${timeoutSeconds}s bound and was killed`,
              ),
            ),
          { once: true },
        )
      }),
    ])
    const outcome = await exitedOrTimeout.then(
      (value) => value,
      (error) => {
        try {
          proc.kill('SIGTERM')
        } catch {
          /* already exited */
        }
        throw error
      },
    )
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    return { exitCode: outcome.code ?? -1, stdout, stderr }
  }

  private async sandboxExec(
    handle: SandboxEnvironmentIdentity,
    request: SandboxCommandRequest,
  ): Promise<SandboxCommandResult> {
    const timeoutSeconds = Math.min(Math.max(request.timeoutSeconds ?? 120, 1), 300)
    const cwd =
      request.cwd === undefined ? handle.workspacePath : join(handle.workspacePath, request.cwd)
    return this.spawnSandboxCommand(request.command, cwd, timeoutSeconds)
  }

  /** Bound on retained finished detached commands. A finished entry whose
   * result was delivered (`wait` observed `exited`) is consumed immediately;
   * this cap covers the fire-and-forget case — commands that finish but are
   * never waited on — so the map (and its retained stdout/stderr strings)
   * stays bounded at ~cap entries' worth of output regardless of how many
   * commands the process ever runs. Running entries are never evicted, and
   * cap-evicted commands fail `wait` typed `not-found`: the legitimate
   * not-found population under the cap is entries trimmed as the oldest
   * finished, entries already consumed by a terminal wait, and ids from a
   * restarted host. */
  private static readonly MAX_RETAINED_SANDBOX_COMMANDS = 50

  /** Bound on how long the exit stamp waits for the stdout/stderr pipe
   * readers to drain after the process exits. A normal child closes its
   * pipes on exit and drains immediately; a grandchild that inherited the
   * write end (e.g. `sleep 30 &`) keeps the pipe open long past the
   * child's exit, so the grace bounds the stamp instead of stalling the
   * delivered `exited` result until the grandchild dies. Because the race
   * outcome varies (reader drain vs. grace), stamp landing times are also
   * variable — which is why `evictFinishedBeyondCap` stops at
   * exited-but-unstamped entries instead of treating them as running. */
  private static readonly DEFAULT_SANDBOX_EXIT_DRAIN_GRACE_MS = 250
  private readonly exitDrainGraceMs: number

  /** Detached children tracked in-process only; a restarted host reports a
   * recorded command as gone (`wait` fails typed `not-found`). Eviction uses
   * the same semantics: the first `wait` that observes `exited` consumes the
   * entry (a later `wait` on the same id fails typed `not-found`, exactly as
   * after a restart), and finished-but-never-waited entries are bounded by
   * `MAX_RETAINED_SANDBOX_COMMANDS`. */
  private readonly sandboxChildren = new Map<
    string,
    {
      proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
      stdout: string
      stderr: string
      exitCode: number | null
    }
  >()

  /** Append a chunk to an entry's captured stream, tolerating an entry that
   * was already evicted (consumed by `wait` or removed by the cap): late
   * chunks for a delivered command are dropped, never a crash. */
  private appendChildStream(commandId: string, stream: 'stdout' | 'stderr', chunk: string): void {
    const tracked = this.sandboxChildren.get(commandId)
    if (tracked === undefined) return
    tracked[stream] += chunk
  }

  /** While the map exceeds the retention cap, delete the oldest finished
   * entries in insertion order (`Map` iterates in insertion order). Running
   * entries are never evicted — the live procs themselves are the resource.
   * A pass also stops at the first tracked command that has exited but whose
   * drain-gated exit stamp has not yet landed: such an entry is finished,
   * not running, so the stamped entries older than it are unambiguously
   * safe to evict (and are deleted by the walk reaching it), but nothing
   * newer may be selected ahead of it — deleting a newer finished entry
   * while an older one's stamp is still pending would make the victim
   * choice depend on when stamps happen to land. When the pending entry is
   * itself the oldest evictable entry, the pass deletes nothing and defers
   * to its stamp. The stop always resolves — every exited entry is stamped
   * within the drain grace, and every stamp runs this pass again — so the
   * map settles to the cap with victims chosen as the oldest finished
   * entries in insertion order, independent of stamp timing; while a stamp
   * is pending the map may transiently hold the cap plus the entries that
   * finished after that pending entry. */
  private evictFinishedBeyondCap(): void {
    if (this.sandboxChildren.size <= GitWorktreeProvider.MAX_RETAINED_SANDBOX_COMMANDS) return
    for (const [id, tracked] of this.sandboxChildren) {
      if (this.sandboxChildren.size <= GitWorktreeProvider.MAX_RETAINED_SANDBOX_COMMANDS) return
      // An exited-but-unstamped entry is finished, not running: stop here so
      // no entry newer than it is evicted ahead of it.
      if (tracked.exitCode === null && this.hasExitedProcess(tracked)) return
      if (tracked.exitCode !== null) this.sandboxChildren.delete(id)
    }
  }

  /** Synchronous exit probe for a tracked child: `exitCode` covers a normal
   * exit, `signalCode` a signal kill (where `exitCode` stays null). Both are
   * synchronous on `Bun.Subprocess`, so an eviction pass reads real state at
   * pass time rather than the drain-delayed stamp. */
  private hasExitedProcess(tracked: { proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'> }): boolean {
    return tracked.proc.exitCode !== null || tracked.proc.signalCode !== null
  }

  private trackChildStreams(
    commandId: string,
    child: { proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'> },
  ): void {
    const drained = Promise.all([
      (async () => {
        const reader = child.proc.stdout.getReader()
        const decoder = new TextDecoder()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          this.appendChildStream(commandId, 'stdout', decoder.decode(value, { stream: true }))
        }
      })(),
      (async () => {
        const reader = child.proc.stderr.getReader()
        const decoder = new TextDecoder()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          this.appendChildStream(commandId, 'stderr', decoder.decode(value, { stream: true }))
        }
      })(),
    ]).catch(() => {})
    void child.proc.exited.then(async (code) => {
      // Stamp `exited` only once the pipe readers have drained what the
      // child wrote, so a terminal `wait` never snapshots truncated output —
      // under load the exit can otherwise be observed before the readers
      // finish appending (seen as a flaky empty `stdout` in the retention
      // test's full-suite run). The grace bounds the stamp when a grandchild
      // keeps the write end open past the child's own exit.
      await Promise.race([
        drained,
        new Promise((resolve) => setTimeout(resolve, this.exitDrainGraceMs)),
      ])
      const tracked = this.sandboxChildren.get(commandId)
      if (tracked === undefined) return
      tracked.exitCode = code ?? -1
      // Enforce the cap on the stamp path too: a burst of fire-and-forget
      // commands whose exits land after the last start's eviction pass must
      // still settle within bound.
      this.evictFinishedBeyondCap()
    })
  }

  private async sandboxStart(
    handle: SandboxEnvironmentIdentity,
    request: SandboxCommandRequest,
  ): Promise<{ commandId: string }> {
    const cwd =
      request.cwd === undefined ? handle.workspacePath : join(handle.workspacePath, request.cwd)
    const proc = Bun.spawn(['sh', '-c', request.command], {
      cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: this.sandboxEnv(),
    })
    const commandId = `sbcmd-${randomBytes(8).toString('hex')}`
    this.sandboxChildren.set(commandId, { proc, stdout: '', stderr: '', exitCode: null })
    this.evictFinishedBeyondCap()
    this.trackChildStreams(commandId, { proc })
    return { commandId }
  }

  private async sandboxWait(
    _handle: SandboxEnvironmentIdentity,
    input: { commandId: string; waitSeconds: number },
  ): Promise<SandboxWaitResult> {
    const child = this.sandboxChildren.get(input.commandId)
    if (child === undefined) {
      throw new SandboxOperationError(
        'not-found',
        `unknown sandbox command ${JSON.stringify(input.commandId)}; a restarted host loses detached-command tracking`,
      )
    }
    const deadline = Date.now() + Math.min(Math.max(input.waitSeconds, 0), 300) * 1000
    while (child.exitCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    if (child.exitCode === null)
      return { state: 'running', stdout: child.stdout, stderr: child.stderr }
    // Consume-on-delivery: the terminal `wait` snapshots the result and drops
    // the entry, so a second `wait` on the same id fails typed `not-found` —
    // indistinguishable from the restarted-host case. `running` waits never
    // consume, so poll loops keep working unchanged.
    const result: SandboxWaitResult = {
      state: 'exited',
      exitCode: child.exitCode,
      stdout: child.stdout,
      stderr: child.stderr,
    }
    this.sandboxChildren.delete(input.commandId)
    return result
  }

  private async sandboxRootedPath(
    handle: SandboxEnvironmentIdentity,
    path: string,
  ): Promise<string> {
    if (path.includes('\\') || path.startsWith('/')) {
      throw new SandboxOperationError(
        'exec',
        `sandbox path ${JSON.stringify(path)} must be relative to the checkout and use "/" separators`,
      )
    }
    const rooted = resolve(handle.workspacePath, path)
    if (
      rooted !== handle.workspacePath &&
      !rooted.startsWith(resolve(handle.workspacePath) + sep)
    ) {
      throw new SandboxOperationError(
        'exec',
        `sandbox path ${JSON.stringify(path)} escapes the checkout`,
      )
    }
    return rooted
  }

  private async sandboxReadFile(
    handle: SandboxEnvironmentIdentity,
    path: string,
  ): Promise<Uint8Array> {
    const rooted = await this.sandboxRootedPath(handle, path)
    try {
      return new Uint8Array(await fsReadFile(rooted))
    } catch (error) {
      throw new SandboxOperationError(
        'not-found',
        `could not read sandbox file ${JSON.stringify(path)}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }

  private async sandboxWriteFile(
    handle: SandboxEnvironmentIdentity,
    path: string,
    content: Uint8Array,
  ): Promise<void> {
    const rooted = await this.sandboxRootedPath(handle, path)
    await mkdir(resolve(rooted, '..'), { recursive: true })
    await fsWriteFile(rooted, content)
  }

  private async sandboxRelease(input: {
    repo: string
    operator: string
    environmentId: string
  }): Promise<{ snapshots: { outcome: 'confirmed' } }> {
    const path = resolve(input.environmentId)
    const repo = this.repos.get(path) ?? (await this.discoverRepo(path)) ?? input.repo
    const removed = await this.git(repo, ['worktree', 'remove', '--force', path])
    if (
      removed.exitCode !== 0 &&
      !/is not a working tree|validation failed, cannot remove working tree/i.test(removed.stderr)
    ) {
      throw new SandboxOperationError(
        'release',
        `could not remove operator sandbox worktree ${path}: ${removed.stderr.trim() || removed.stdout.trim() || `exit ${removed.exitCode}`}`,
      )
    }
    await this.git(repo, ['worktree', 'prune'])
    await rm(path, { recursive: true, force: true }).catch(() => {})
    this.repos.delete(path)
    // A local worktree has no snapshot concept; release is always complete.
    return { snapshots: { outcome: 'confirmed' } }
  }

  // ── Operator-sandbox publication (PR-only) ──────────────────
  //
  // The push and its probe run host-side in the sandbox worktree with the
  // host's own forge configuration — exactly the transport a local build's
  // finalize push uses (GitHubForge.pushBranch runs `git push` in the
  // worktree); the only difference is an exact sha rather than HEAD, because
  // publish accepts an explicit commit. No credential is ever handed to the
  // sandbox itself: the sandbox performs no push, the provider does.

  /** Same shape validation as the vercel publication adapter: an exact
   * commit SHA and a canonical publication branch. */
  private static assertPublicationInput(input: { sha: string; branch: string }): void {
    if (!/^[0-9a-f]{40,64}$/i.test(input.sha) || !/^ab\/[a-z0-9][a-z0-9-]*$/.test(input.branch)) {
      throw new Error('publication requires an exact commit SHA and canonical build branch')
    }
  }

  /** Linked worktrees share the origin remote configuration with the main
   * repository, so the probe runs from the worktree path itself. */
  private async hasOriginRemote(cwd: string): Promise<boolean> {
    const result = await this.git(cwd, ['remote'])
    if (result.exitCode !== 0) return false
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .includes('origin')
  }

  private async sandboxIsPublished(input: {
    ref?: string
    sha: string
    branch: string
  }): Promise<boolean> {
    GitWorktreeProvider.assertPublicationInput(input)
    if (input.ref === undefined || input.ref === '') {
      throw new Error('the git-worktree publication probe requires the workspace ref')
    }
    const ref = resolve(input.ref)
    if (await this.hasOriginRemote(ref)) {
      const result = await this.git(ref, ['ls-remote', 'origin', `refs/heads/${input.branch}`])
      if (result.exitCode !== 0) {
        throw new GitError(['-C', ref, 'ls-remote', 'origin', `refs/heads/${input.branch}`], result)
      }
      return result.stdout
        .split('\n')
        .some((line) => line.trim() === `${input.sha}\trefs/heads/${input.branch}`)
    }
    // No origin remote (local-git-forge deployments, where a local finalize
    // performs no network push): compare the branch locally. Linked
    // worktrees share all refs with the main repository, so no bookkeeping
    // beyond the worktree path is needed.
    const head = await this.resolveOptionalCommit(ref, `refs/heads/${input.branch}`)
    return head === input.sha
  }

  private async publishSandbox(input: { ref: string; sha: string; branch: string }): Promise<void> {
    GitWorktreeProvider.assertPublicationInput(input)
    const ref = resolve(input.ref)
    if (await this.hasOriginRemote(ref)) {
      const args = [
        '-C',
        ref,
        'push',
        '--no-verify',
        'origin',
        `${input.sha}:refs/heads/${input.branch}`,
      ]
      const result = await this.exec(['git', ...args], {})
      if (result.exitCode !== 0) throw new GitError(args, result)
      return
    }
    // Local equivalent of the finalize push for deployments without an
    // origin remote: a ref move guarded so it can never be a
    // non-fast-forward. The service refuses the base branch before this
    // seam is reached.
    const existing = await this.resolveOptionalCommit(ref, `refs/heads/${input.branch}`)
    if (existing !== null && existing !== input.sha) {
      if (!(await this.isAncestor(ref, existing, input.sha))) {
        throw new Error(
          `refusing to move refs/heads/${input.branch}: its current tip ${existing} ` +
            `is not an ancestor of ${input.sha}`,
        )
      }
    }
    const args = ['-C', ref, 'update-ref', `refs/heads/${input.branch}`, input.sha]
    const result = await this.git(ref, ['update-ref', `refs/heads/${input.branch}`, input.sha])
    if (result.exitCode !== 0) throw new GitError(args, result)
  }
}
