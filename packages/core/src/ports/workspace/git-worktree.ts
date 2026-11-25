import { restoreGitCommits } from './commit-preservation'
import { publishBranch, remoteBranchHead, refreshBranchCache } from '../forge/git-rewrite'
/**
 * Workspace adapter: git worktrees (SPEC §3.2). The worktree is disposable
 * scratch (§7); the branch is the build's durable code and travels through
 * the Forge, never the store (§15.2.4 [D3]) — so `release` removes only the
 * worktree and never touches the branch. Idempotent `provision` is what makes
 * resume-after-sandbox-death (§15.6-C) a re-run, not a special path
 * (constitution #2).
 */
import { lstat, mkdir, realpath, rename } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { readFile as fsReadFile, rm, stat, writeFile as fsWriteFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { WorkspaceBase } from '../../ontology'
import {
  redactSandboxMessage,
  SandboxOperationError,
  type OperatorSandboxExecution,
  type SandboxCommandRequest,
  type SandboxCommandResult,
  type SandboxEnvironmentIdentity,
  type SandboxProviderStatus,
  type SandboxProvisionStage,
  type SandboxRefreshResult,
  type SandboxWaitResult,
} from './operator-sandbox'
import { groupAlive, terminateProcessGroup } from './process-group'
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
  opts: {
    cwd?: string
    signal?: AbortSignal
    env?: Record<string, string | undefined>
    /** Bytes written to the child's stdin; omitted means no stdin at all.
     * Wrappers that delegate must forward it (spread the opts). */
    stdin?: string
  },
) => Promise<ExecResult>

export const spawnExec: Exec = async (cmd, opts) => {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdin: opts.stdin === undefined ? 'ignore' : new Blob([opts.stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      ...opts.env,
      AB_DISPATCH_GENERATION: undefined,
      AB_PROJECT_SECRETS_KEY: undefined,
    },
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

/**
 * No build worktree destination is isolated from the checkout's packages:
 * the chosen root resolves inside the checkout, or a directory from the root
 * up to `/` holds a `node_modules` entry that Node and Bun resolution would
 * walk into. The message names the offending path and the remedy.
 */
export class WorktreeIsolationError extends Error {
  constructor(
    /** The chosen build worktree root, as configured. */
    readonly root: string,
    /** The canonical checkout the provider provisions from. */
    readonly checkout: string,
    /** The canonical directory holding `node_modules`, when that is the fault. */
    readonly ancestor?: string,
  ) {
    super(
      (ancestor !== undefined
        ? `build worktree root ${root} is not isolated: ${join(ancestor, 'node_modules')} lies above it, so package resolution in a worktree would reach packages the build does not own`
        : `build worktree root ${root} resolves inside the checkout ${checkout}, so package resolution in a worktree would reach the checkout's node_modules`) +
        `; set XDG_STATE_HOME to an absolute directory outside ${checkout} with no node_modules above it, or select a local store outside the checkout`,
    )
    this.name = 'WorktreeIsolationError'
  }
}

/** A startup notice for a host where new build worktrees cannot be
 * provisioned, or `undefined` when the destination is isolated. Never a gate:
 * builds already in a worktree keep running and release. Errors other than
 * `WorktreeIsolationError` are genuine IO faults and propagate. */
export async function worktreeIsolationNotice(
  provider: GitWorktreeProvider,
  checkout: string,
): Promise<string | undefined> {
  try {
    await provider.assertIsolatedRoot(checkout)
    return undefined
  } catch (error) {
    if (!(error instanceof WorktreeIsolationError)) throw error
    return `new build worktrees cannot be provisioned: ${error.message}; builds already in a worktree continue`
  }
}

function isInside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep)
}

function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** The realpath of the nearest existing ancestor joined with the remaining
 * segments: a canonical answer for a path that may not exist yet, without
 * creating anything. */
async function canonicalize(path: string): Promise<string> {
  const absolute = resolve(path)
  const rest: string[] = []
  for (let current = absolute; ; current = dirname(current)) {
    try {
      return join(await realpath(current), ...rest)
    } catch (error) {
      if (!missing(error)) throw error
    }
    if (dirname(current) === current) return absolute
    rest.unshift(basename(current))
  }
}

/** Where a provisioning repository's build worktrees go. `legacy` is the
 * in-checkout state-tree root that existing registrations are adopted from. */
interface WorktreeLayout {
  checkoutReal: string
  chosen: string
  legacy?: string
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
  /** Requested branch attached inside the chosen or legacy root. */
  attached?: WorktreeEntry
  /** Detached registration at the requested branch's deterministic path. */
  detached?: WorktreeEntry
  /** The requested branch is attached anywhere, including outside our root. */
  branchAttached: boolean
  /** Every registration attached to the requested branch anywhere, plus a
   * detached registration at one of its deterministic paths. */
  holders: WorktreeEntry[]
}

/** Where fresh-provision creation receipts for `branch` live. */
function receiptPrefix(branch: string): string {
  return `refs/autobuild/provision/${branch}/created`
}

/** Owner tokens are opaque, ref-safe and bounded. */
const OWNER_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

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

/** The provisioning marker written into a finished operator sandbox. */
const SANDBOX_MARKER = '.autobuild-sandbox-provisioned'
const SHA_PATTERN = /^[0-9a-f]{40,64}$/i

/** A provision attempt stopped by `close` or `release`; not a failure. */
class SandboxCancelledError extends Error {
  override readonly name = 'SandboxCancelledError'
  constructor() {
    super('operator sandbox provisioning was cancelled')
  }
}

export class GitWorktreeProvider implements WorkspaceProvider {
  readonly name = 'git-worktree'
  readonly orchestratorSandbox: OperatorSandboxExecution
  readonly sandboxPublication: WorkspacePublication
  private readonly root: string
  private readonly isolatedRoot: string | undefined
  private readonly sandboxRoot: string
  private readonly setupCommand: string | undefined
  private readonly sandboxEnvironmentVariables: readonly string[]
  private readonly sandboxEnvSource: Record<string, string | undefined>
  /** Placement per canonical provisioning repository. Paths are compared
   * canonicalized (symlink-free) because git reports worktree paths that way;
   * the isolation check itself is never cached. */
  private readonly layouts = new Map<string, WorktreeLayout>()
  private readonly exec: Exec
  /** worktree path → repo it was provisioned from, so `release` can find the
   * repo without re-deriving it. Rebuilt lazily after a restart (release of a
   * still-on-disk worktree rediscovers the repo via git-common-dir). */
  private readonly repos = new Map<string, string>()

  /**
   * `root` is the state tree's own worktree directory. When it resolves
   * inside the provisioning checkout and `isolatedRoot` is set, build
   * worktrees go to `isolatedRoot` and `root` becomes the legacy root whose
   * existing registrations are still adopted in place. Either way the chosen
   * root is validated before any worktree is created or reused there.
   */
  constructor(opts: {
    root: string
    /** Build worktree root outside the checkout's package ancestry, used
     * when `root` resolves inside the checkout. */
    isolatedRoot?: string
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
    this.isolatedRoot = opts.isolatedRoot === undefined ? undefined : resolve(opts.isolatedRoot)
    this.sandboxRoot = resolve(opts.sandboxRoot ?? join(opts.root, '..', 'orchestrator-sandboxes'))
    this.setupCommand = opts.setupCommand
    this.sandboxEnvironmentVariables = opts.sandboxEnvironmentVariables ?? []
    this.sandboxEnvSource = opts.envSource ?? {}
    this.exitDrainGraceMs =
      opts.exitDrainGraceMs ?? GitWorktreeProvider.DEFAULT_SANDBOX_EXIT_DRAIN_GRACE_MS
    this.exec = opts.exec ?? spawnExec
    this.orchestratorSandbox = {
      lifecycleSupported: true,
      open: (input) => this.openSandbox(input),
      status: (input) => this.sandboxStatus(input),
      close: (input) => this.closeSandbox(input),
      refresh: (handle, input) => this.refreshSandbox(handle, input),
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

  private async layout(repo: string): Promise<WorktreeLayout> {
    const checkoutReal = await realpath(repo)
    const cached = this.layouts.get(checkoutReal)
    if (cached) return cached
    const root = await canonicalize(this.root)
    const layout: WorktreeLayout =
      this.isolatedRoot !== undefined && isInside(root, checkoutReal)
        ? { checkoutReal, chosen: this.isolatedRoot, legacy: root }
        : { checkoutReal, chosen: this.root }
    this.layouts.set(checkoutReal, layout)
    return layout
  }

  /**
   * Validate the build worktree root chosen for `repo` and return its real
   * path, creating it. Throws `WorktreeIsolationError` when it resolves
   * inside the checkout or any directory from it up to `/` holds a
   * `node_modules` entry; a worktree's own `node_modules` lies below the root,
   * so the build owns it. Not cached: a `node_modules` that appears later is
   * noticed on the next provision.
   */
  async assertIsolatedRoot(repo: string): Promise<string> {
    const { checkoutReal, chosen } = await this.layout(repo)
    const canonical = await canonicalize(chosen)
    if (isInside(canonical, checkoutReal)) throw new WorktreeIsolationError(chosen, checkoutReal)
    for (let dir = canonical; ; dir = dirname(dir)) {
      try {
        await lstat(join(dir, 'node_modules'))
        throw new WorktreeIsolationError(chosen, checkoutReal, dir)
      } catch (error) {
        if (error instanceof WorktreeIsolationError || !missing(error)) throw error
      }
      if (dirname(dir) === dir) break
    }
    await mkdir(chosen, { recursive: true })
    const real = await realpath(chosen)
    // A symlink created between the check and mkdir must not slip through.
    if (isInside(real, checkoutReal)) throw new WorktreeIsolationError(chosen, checkoutReal)
    return real
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

  /** `git` with `input` on stdin; used only by the creation transactions. */
  private async gitWithInput(dir: string, args: string[], input: string): Promise<ExecResult> {
    return this.exec(['git', '-C', dir, ...args], { stdin: input })
  }

  private async gitWithInputOrThrow(
    dir: string,
    args: string[],
    input: string,
  ): Promise<ExecResult> {
    const result = await this.gitWithInput(dir, args, input)
    if (result.exitCode !== 0) throw new GitError(['-C', dir, ...args], result)
    return result
  }

  /** True only for a local `refs/heads/<branch>` in `repo`; throws when the
   * probe itself fails. Claim-time slug deduplication (#1261). */
  async localBranchExists(repo: string, branch: string): Promise<boolean> {
    const args = ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]
    const result = await this.git(repo, args)
    if (result.exitCode === 0) return true
    if (result.exitCode === 1) return false
    throw new GitError(['-C', repo, ...args], result)
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

  async provision(
    opts: Parameters<WorkspaceProvider['provision']>[0],
  ): Promise<WorkspaceProvisionResult> {
    const handle = await this.provisionCore(opts)
    if (opts.restoration?.length) {
      const { skipped } = await restoreGitCommits({
        exec: this.exec,
        workspacePath: handle.path,
        branch: opts.branch,
        heads: opts.restoration,
        replaced: opts.restorationReplaced,
        // A remote forge's archive fetch writes no local ref, so restoration
        // has to fetch the exact ref itself; local-git never consults origin.
        local: opts.restorationArchives !== 'remote',
        ...(opts.restoreStored
          ? {
              restoreStored: (sha: string) =>
                opts.restoreStored!({ exec: this.exec, workspacePath: handle.path, sha }),
            }
          : {}),
      })
      if (skipped.length) handle.restorationSkipped = skipped
      handle.base = {
        source: 'existing',
        sha: await this.resolveCommit(handle.path, `refs/heads/${opts.branch}`),
      }
    }
    return handle
  }

  private async provisionCore(opts: {
    repo: string
    baseBranch: string
    branch: string
    publication?: { sha: string; cacheHeads: string[] }
    fresh?: { owner: string }
  }): Promise<WorkspaceProvisionResult> {
    const { repo, baseBranch, branch } = opts
    // Fails with git's stderr for a missing path or a non-repo directory.
    await this.gitOrThrow(repo, ['rev-parse', '--git-dir'])
    // Drop registrations whose directories were deleted out-of-band, so
    // re-provision after a hand-cleaned sandbox still succeeds.
    await this.gitOrThrow(repo, ['worktree', 'prune'])

    const layout = await this.layout(repo)
    const leaf = sanitizeBranch(branch)
    const chosenDir = await canonicalize(layout.chosen)
    let worktreePath = join(chosenDir, leaf)
    const roots = layout.legacy !== undefined ? [chosenDir, layout.legacy] : [chosenDir]
    const worktrees = await this.findWorktrees(
      repo,
      branch,
      roots,
      roots.map((root) => join(root, leaf)),
    )
    if (opts.fresh) {
      return this.provisionFresh({
        repo,
        baseBranch,
        branch,
        owner: opts.fresh.owner,
        leaf,
        chosenDir,
        roots,
        holders: worktrees.holders,
      })
    }
    // A registration that already exists at the legacy in-checkout root is
    // adopted in place without the isolation check, so builds provisioned
    // before worktrees moved resume, clean up and release. Nothing new is
    // ever created there.
    const legacy = layout.legacy
    const adopted = worktrees.attached ?? worktrees.detached
    const exempt = legacy !== undefined && adopted?.path.startsWith(legacy + sep) === true
    if (!exempt) worktreePath = join(await this.assertIsolatedRoot(repo), leaf)
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
    let localSha = await this.resolveOptionalCommit(repo, branchRef)
    if (
      !localSha &&
      opts.publication &&
      (await remoteBranchHead(this.exec, repo, branch)) === opts.publication.sha
    ) {
      await refreshBranchCache(this.exec, repo, branch, opts.publication.sha)
      localSha = opts.publication.sha
    }
    if (localSha) {
      // A branch attached outside this provider's root is not ours to repair
      // or reuse. The ordinary worktree-add/checkout error below remains the
      // non-destructive diagnostic for that unsupported registration.
      let sha = localSha
      const proof = opts.publication
      if (
        !worktrees.branchAttached &&
        proof &&
        proof.sha !== localSha &&
        proof.cacheHeads.includes(localSha)
      ) {
        // A detached unknown result is live unpublished work, even if the
        // public branch cache is stale. Refuse before mutating that cache.
        if (worktrees.detached) {
          const detached = await this.resolveCommit(worktrees.detached.path, 'HEAD')
          if (detached !== proof.sha)
            throw new Error(
              `detached HEAD ${detached} does not match durable publication ${proof.sha}; refusing to discard either commit`,
            )
        }
        if ((await remoteBranchHead(this.exec, repo, branch)) === proof.sha) {
          await refreshBranchCache(this.exec, repo, branch, proof.sha)
          sha = proof.sha
        }
      }

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

      // Resume from retained work. Tracking refs cannot authorize replacing it;
      // only a recorded publication confirmed above can refresh a stale cache.
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
    // move between fetch and branch creation. The recorded base is the new
    // worktree's verified HEAD, so it is always an ancestor of the build's
    // own commits (AUT-1252).
    await this.gitOrThrow(repo, ['worktree', 'add', '-b', branch, worktreePath, base.sha])
    const actualSha = await this.resolveCommit(repo, branchRef)
    if (actualSha !== base.sha) {
      throw new Error(`created ${branchRef} at ${actualSha}, expected selected base ${base.sha}`)
    }
    const head = await this.resolveCommit(worktreePath, 'HEAD')
    if (head !== base.sha) {
      throw new Error(`checked out ${worktreePath} at ${head}, expected selected base ${base.sha}`)
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
    // Every later provision of a released build is non-fresh, so its creation
    // receipts are spent. Best effort: a leftover receipt only pins a commit.
    if (handle.branch) {
      const listed = await this.git(repo, [
        'for-each-ref',
        '--format=%(refname)',
        `${receiptPrefix(handle.branch)}/`,
      ])
      if (listed.exitCode === 0) {
        for (const ref of listed.stdout.split('\n').filter((line) => line !== '')) {
          await this.git(repo, ['update-ref', '-d', ref])
        }
      }
    }
  }

  /** This owner's creation receipt for `branch`, when one exists. */
  private async ownCreation(
    repo: string,
    branch: string,
    owner: string,
  ): Promise<string | undefined> {
    if (!OWNER_PATTERN.test(owner)) {
      throw new Error(`invalid fresh-provision owner ${JSON.stringify(owner)}`)
    }
    return (
      (await this.resolveOptionalCommit(repo, `${receiptPrefix(branch)}/${owner}`)) ?? undefined
    )
  }

  /**
   * A build's first provision (#1261). A pre-existing branch of this name is
   * not the build's work: on 2026-11-25 a new build adopted a months-old
   * merged branch's local ref as its base and parked forever on
   * `target-rewritten`. Ownership is proven only by this owner's creation
   * receipt, which is written in one atomic ref transaction with the build's
   * own branch write, after every foreign holder is set aside. Ancestry is
   * never consulted. Foreign holders are detached in place (and moved under
   * `.displaced/` when they occupy a provider path), never destroyed; a
   * foreign tip is kept under `refs/autobuild/displaced/<branch>/<sha>`.
   */
  private async provisionFresh(input: {
    repo: string
    baseBranch: string
    branch: string
    owner: string
    leaf: string
    chosenDir: string
    roots: string[]
    holders: WorktreeEntry[]
  }): Promise<WorkspaceProvisionResult> {
    const { repo, baseBranch, branch, owner, leaf, chosenDir, roots } = input
    const branchRef = `refs/heads/${branch}`
    const receiptRef = `${receiptPrefix(branch)}/${owner}`
    const leafPaths = roots.map((root) => join(root, leaf))
    const ownPath = join(chosenDir, leaf)
    const tip = (await this.resolveOptionalCommit(repo, branchRef)) ?? undefined
    const receipt = await this.ownCreation(repo, branch, owner)
    let holders = input.holders

    // This owner's interrupted creation: adopt it, so a lost
    // `workspace.provisioned` append re-runs as a no-op.
    if (
      tip !== undefined &&
      receipt === tip &&
      holders.every((holder) => holder.branch === branch && holder.path === ownPath)
    ) {
      const attached = holders[0]
      let path = attached?.path
      if (path === undefined) {
        path = join(await this.assertIsolatedRoot(repo), leaf)
        await this.gitOrThrow(repo, ['worktree', 'add', path, branch])
        const head = await this.resolveCommit(path, 'HEAD')
        if (head !== tip) {
          throw new Error(`checked out ${path} at ${head}, expected own creation ${tip}`)
        }
      }
      this.repos.set(path, repo)
      return {
        provider: this.name,
        ref: path,
        path,
        localPath: path,
        branch,
        base: { source: 'existing', sha: tip },
      }
    }

    // Set every foreign holder aside before any ref moves. Nothing is written
    // yet, so an interrupted attempt leaves no receipt and simply repeats.
    for (const holder of holders) {
      let head = holder.head ?? tip
      if (holder.branch === branch) {
        if (tip === undefined) {
          throw new Error(`worktree ${holder.path} holds ${branchRef}, which does not resolve`)
        }
        await this.gitOrThrow(holder.path, ['update-ref', '--no-deref', 'HEAD', tip])
        const symbolic = await this.git(holder.path, ['symbolic-ref', '-q', 'HEAD'])
        const detachedHead = await this.resolveCommit(holder.path, 'HEAD')
        if (symbolic.exitCode === 0 || detachedHead !== tip) {
          throw new Error(`could not detach worktree ${holder.path} from ${branchRef} at ${tip}`)
        }
        head = tip
      }
      if (leafPaths.includes(holder.path)) {
        await this.moveAside(
          repo,
          holder.path,
          join(chosenDir, '.displaced', leaf, head ?? 'unknown'),
        )
      }
    }
    holders = (await this.findWorktrees(repo, branch, roots, leafPaths)).holders
    if (holders.length > 0) {
      throw new Error(
        `${branchRef} is still held by ${holders.map((holder) => holder.path).join(', ')} after displacement`,
      )
    }

    const worktreePath = join(await this.assertIsolatedRoot(repo), leaf)
    const base = await this.selectNewBranchBase(repo, baseBranch, branch)
    const archiveRef =
      tip !== undefined && tip !== base.sha
        ? `refs/autobuild/displaced/${branch}/${tip}`
        : undefined
    const transaction = [
      'start',
      tip === undefined
        ? `create ${branchRef} ${base.sha}`
        : `update ${branchRef} ${base.sha} ${tip}`,
      ...(archiveRef !== undefined ? [`update ${archiveRef} ${tip}`] : []),
      `update ${receiptRef} ${base.sha}`,
      'prepare',
      'commit',
      '',
    ].join('\n')
    await this.gitWithInputOrThrow(repo, ['update-ref', '--stdin'], transaction)
    // A seam that dropped stdin would let git commit an empty transaction
    // and exit 0; read every ref back so that fails loudly.
    const expected: Array<[string, string]> = [
      [branchRef, base.sha],
      [receiptRef, base.sha],
      ...(archiveRef !== undefined ? [[archiveRef, tip!] as [string, string]] : []),
    ]
    for (const [ref, sha] of expected) {
      const actual = await this.resolveOptionalCommit(repo, ref)
      if (actual !== sha) {
        throw new Error(`ref transaction left ${ref} at ${actual ?? '(missing)'}, expected ${sha}`)
      }
    }

    await this.gitOrThrow(repo, ['worktree', 'add', worktreePath, branch])
    const actualSha = await this.resolveCommit(repo, branchRef)
    if (actualSha !== base.sha) {
      throw new Error(`created ${branchRef} at ${actualSha}, expected selected base ${base.sha}`)
    }
    const head = await this.resolveCommit(worktreePath, 'HEAD')
    if (head !== base.sha) {
      throw new Error(`checked out ${worktreePath} at ${head}, expected selected base ${base.sha}`)
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

  /** Move a foreign registration off a provider-derived path, keeping every
   * file and its lock. Git refuses `worktree move` with submodules; a
   * same-filesystem rename plus `worktree repair` keeps the files then. */
  private async moveAside(repo: string, from: string, preferred: string): Promise<void> {
    let dest = preferred
    for (
      let n = 2;
      await lstat(dest).then(
        () => true,
        () => false,
      );
      n += 1
    ) {
      dest = `${preferred}-${n}`
    }
    await mkdir(dirname(dest), { recursive: true })
    const moved = await this.git(repo, ['worktree', 'move', '--force', '--force', from, dest])
    if (moved.exitCode === 0) return
    if (!/submodule/i.test(moved.stderr)) {
      throw new GitError(['-C', repo, 'worktree', 'move', '--force', '--force', from, dest], moved)
    }
    await rename(from, dest)
    await this.gitOrThrow(repo, ['worktree', 'repair', dest])
  }

  /** Discover only registrations relevant to the requested branch. Attached
   * reuse stays scoped to the chosen and legacy roots (and therefore excludes
   * the main checkout); a detached registration is recoverable only at this
   * branch's exact, deterministic provider-owned path under either root. */
  private async findWorktrees(
    repo: string,
    branch: string,
    rootDirs: readonly string[],
    worktreePaths: readonly string[],
  ): Promise<WorktreeSelection> {
    const list = await this.gitOrThrow(repo, ['worktree', 'list', '--porcelain'])
    const entries = parseWorktreeList(list.stdout).map((entry) => ({
      ...entry,
      path: resolve(entry.path),
    }))
    return {
      attached: entries.find(
        (entry) =>
          entry.branch === branch && rootDirs.some((root) => entry.path.startsWith(root + sep)),
      ),
      detached: worktreePaths
        .map((path) => entries.find((entry) => entry.detached && entry.path === path))
        .find((entry) => entry !== undefined),
      branchAttached: entries.some((entry) => entry.branch === branch),
      holders: entries.filter(
        (entry) =>
          entry.branch === branch || (entry.detached && worktreePaths.includes(entry.path)),
      ),
    }
  }

  /** Main-repo directory owning the worktree at `path`, or null if the path
   * is gone or not a worktree — the release-is-a-no-op cases. Needed when a
   * restarted process releases a worktree it did not provision (§7.4).
   * A successful `rev-parse --git-common-dir` with empty stdout is a
   * degenerate input — feeding it to `resolve` would target the worktree
   * directory itself and misdirect the subsequent `worktree remove` — so it
   * fails loudly with a `GitError` (same posture as `shaFrom`'s empty-SHA
   * guard) rather than masquerading as a release-is-a-no-op case. The error
   * type diverges deliberately from `excludeProvisioningMarker`'s
   * `SandboxOperationError`: this is provider-level discovery shared by
   * `release` and `sandboxRelease`, not a sandbox operation. */
  private async discoverRepo(path: string): Promise<string | null> {
    const result = await this.git(path, ['rev-parse', '--git-common-dir'])
    if (result.exitCode !== 0) return null
    if (result.stdout.trim() === '') {
      throw new GitError(['-C', path, 'rev-parse', '--git-common-dir'], {
        ...result,
        exitCode: 1,
        stderr: 'git returned no common directory',
      })
    }
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
    delete env.AB_DISPATCH_GENERATION
    return env
  }

  private async isRegisteredWorktree(path: string, repo: string): Promise<boolean> {
    const list = await this.git(repo, ['worktree', 'list', '--porcelain'])
    if (list.exitCode !== 0) return false
    return parseWorktreeList(list.stdout).some((entry) => resolve(entry.path) === resolve(path))
  }

  /** Blocking provision primitive. `onStage` reports `checkout` before the
   * base is resolved and the worktree added, and `setup` before the setup
   * command; `signal` cancels between steps and kills a running setup, and a
   * cancelled attempt removes its half worktree and throws
   * `SandboxCancelledError`. The marker records the selected base head as
   * JSON `{"baseSha":"<sha>"}` so a later process can recover it. */
  private async ensureSandbox(
    input: {
      repo: string
      operator: string
      baseBranch: string
    },
    control: { onStage?: (stage: SandboxProvisionStage) => void; signal?: AbortSignal } = {},
  ): Promise<SandboxEnvironmentIdentity> {
    const identity = this.sandboxIdentity(input.repo, input.operator)
    const { signal } = control
    if (await this.isRegisteredWorktree(identity.environmentId, input.repo)) {
      // Pre-existing sandboxes provisioned before the info/exclude write
      // landed (AUT-580) keep an unexcluded marker; write the exclusion on
      // every ensure so the publish service's untracked-inclusive dirty
      // check never counts the marker as dirt and the correct baseSha /
      // reset-required diagnostic surfaces.
      await this.excludeProvisioningMarker(identity.workspacePath)
      return identity
    }
    control.onStage?.('checkout')
    if (signal?.aborted) throw new SandboxCancelledError()
    await mkdir(this.sandboxRoot, { recursive: true })
    const baseHead = await this.resolveCommit(input.repo, `refs/heads/${input.baseBranch}`)
    if (signal?.aborted) throw new SandboxCancelledError()
    await this.gitOrThrow(input.repo, [
      'worktree',
      'add',
      '--detach',
      identity.environmentId,
      baseHead,
    ])
    try {
      if (signal?.aborted) throw new SandboxCancelledError()
      await this.excludeProvisioningMarker(identity.workspacePath)
      const marker = join(identity.workspacePath, SANDBOX_MARKER)
      const provisioned = await stat(marker).then(
        () => true,
        () => false,
      )
      if (!provisioned && this.setupCommand !== undefined && this.setupCommand.trim() !== '') {
        control.onStage?.('setup')
        if (signal?.aborted) throw new SandboxCancelledError()
        // The setup command runs with the same credential-free guest
        // environment as every tool exec — never the host environment
        // wholesale, or a setup script would be a second route to build
        // state. Unbounded: provisioning may install for a long time.
        const result = await this.spawnSandboxCommand(
          this.setupCommand,
          identity.workspacePath,
          undefined,
          signal,
        )
        if (signal?.aborted) throw new SandboxCancelledError()
        if (result.exitCode !== 0) {
          throw new SandboxOperationError(
            'provision',
            `operator sandbox setup failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`,
          )
        }
      }
      if (signal?.aborted) throw new SandboxCancelledError()
      await fsWriteFile(marker, JSON.stringify({ baseSha: baseHead }))
    } catch (error) {
      // A half-provisioned worktree is removed so the next call starts over.
      await this.git(input.repo, ['worktree', 'remove', '--force', identity.environmentId])
      await this.git(input.repo, ['worktree', 'prune'])
      await rm(identity.environmentId, { recursive: true, force: true }).catch(() => {})
      throw error
    }
    return { ...identity, baseSha: baseHead }
  }

  /** The provisioning marker's recorded metadata: `null` when the marker is
   * missing, `{}` for a legacy empty or unparseable marker. */
  private async readSandboxMarker(workspacePath: string): Promise<{ baseSha?: string } | null> {
    let content: string
    try {
      content = await fsReadFile(join(workspacePath, SANDBOX_MARKER), 'utf8')
    } catch {
      return null
    }
    try {
      const parsed = JSON.parse(content) as { baseSha?: unknown }
      return typeof parsed?.baseSha === 'string' && SHA_PATTERN.test(parsed.baseSha)
        ? { baseSha: parsed.baseSha }
        : {}
    } catch {
      return {}
    }
  }

  // ── Operator sandbox lifecycle (#1223) ─────────────────────────
  //
  // `open` starts provisioning as an in-process background attempt; `status`
  // probes the in-flight map, the recorded failure, and the worktree plus its
  // marker; `close` cancels an attempt and kills detached commands but keeps
  // the checkout; `refresh` fast-forwards a clean detached checkout.

  private readonly sandboxInflight = new Map<
    string,
    {
      kind: 'provision' | 'resume'
      promise: Promise<SandboxProviderStatus>
      abort: AbortController
    }
  >()
  private readonly sandboxFailures = new Map<
    string,
    { stage: SandboxProvisionStage; message: string }
  >()
  /** environmentId → process groups of its detached commands, kept past
   * `wait` consuming a command's result (a finished command can leave
   * background children). Groups with no live member are pruned on every
   * `start`, so the set stays bounded by the live groups. */
  private readonly sandboxGroups = new Map<string, Set<number>>()

  private async openSandbox(input: {
    repo: string
    operator: string
    baseBranch: string
  }): Promise<{
    status: SandboxProviderStatus
    settled?: Promise<SandboxProviderStatus>
  }> {
    const identity = this.sandboxIdentity(input.repo, input.operator)
    const id = identity.environmentId
    const inflight = this.sandboxInflight.get(id)
    if (inflight !== undefined) {
      return {
        status: {
          state: inflight.kind === 'resume' ? 'resuming' : 'provisioning',
          kind: inflight.kind,
        },
        settled: inflight.promise,
      }
    }
    if (await this.isRegisteredWorktree(id, input.repo)) {
      const marker = await this.readSandboxMarker(identity.workspacePath)
      if (marker !== null) {
        // Keeps the AUT-580 heal on the reuse path.
        await this.excludeProvisioningMarker(identity.workspacePath)
        this.sandboxFailures.delete(id)
        const headSha = await this.resolveOptionalCommit(identity.workspacePath, 'HEAD')
        return {
          status: {
            state: 'ready',
            handle: {
              ...identity,
              ...(marker.baseSha !== undefined ? { baseSha: marker.baseSha } : {}),
            },
            kind: 'resume',
            ...(headSha !== null ? { headSha } : {}),
          },
        }
      }
      // An interrupted provision: start over.
      await this.git(input.repo, ['worktree', 'remove', '--force', id])
      await this.git(input.repo, ['worktree', 'prune'])
    }
    this.sandboxFailures.delete(id)
    const abort = new AbortController()
    const entry = {
      kind: 'provision' as const,
      abort,
      promise: Promise.resolve<SandboxProviderStatus>({ state: 'absent' }),
    }
    this.sandboxInflight.set(id, entry)
    entry.promise = (async (): Promise<SandboxProviderStatus> => {
      let stage: SandboxProvisionStage = 'checkout'
      try {
        const handle = await this.ensureSandbox(input, {
          signal: abort.signal,
          onStage: (next) => {
            stage = next
          },
        })
        const headSha = await this.resolveOptionalCommit(handle.workspacePath, 'HEAD')
        return {
          state: 'ready',
          handle,
          kind: 'provision',
          ...(headSha !== null ? { headSha } : {}),
        }
      } catch (error) {
        if (error instanceof SandboxCancelledError) return { state: 'absent', cancelled: true }
        const failure = {
          stage:
            error instanceof SandboxOperationError && error.stage === 'environment'
              ? ('environment' as const)
              : stage,
          message:
            redactSandboxMessage(error instanceof Error ? error.message : String(error)) ||
            'operator sandbox provisioning failed',
        }
        this.sandboxFailures.set(id, failure)
        return { state: 'failed', failure }
      } finally {
        if (this.sandboxInflight.get(id) === entry) this.sandboxInflight.delete(id)
      }
    })()
    return { status: { state: 'provisioning', kind: 'provision' }, settled: entry.promise }
  }

  private async sandboxStatus(input: {
    repo: string
    operator: string
  }): Promise<SandboxProviderStatus> {
    const identity = this.sandboxIdentity(input.repo, input.operator)
    const id = identity.environmentId
    const inflight = this.sandboxInflight.get(id)
    if (inflight !== undefined) {
      return { state: inflight.kind === 'resume' ? 'resuming' : 'provisioning' }
    }
    const failure = this.sandboxFailures.get(id)
    if (failure !== undefined) return { state: 'failed', failure }
    if (!(await this.isRegisteredWorktree(id, input.repo))) return { state: 'absent' }
    const marker = await this.readSandboxMarker(identity.workspacePath)
    if (marker === null) {
      return {
        state: 'failed',
        failure: {
          stage: 'provision',
          message: 'provisioning was interrupted before it finished; call sandbox.open to retry',
        },
      }
    }
    const headSha = await this.resolveOptionalCommit(identity.workspacePath, 'HEAD')
    return {
      state: 'ready',
      handle: { ...identity, ...(marker.baseSha !== undefined ? { baseSha: marker.baseSha } : {}) },
      ...(headSha !== null ? { headSha } : {}),
    }
  }

  /** Abort an in-flight attempt and wait for it to finish its own cleanup. */
  private async cancelSandboxAttempt(id: string): Promise<SandboxProviderStatus | undefined> {
    const inflight = this.sandboxInflight.get(id)
    if (inflight === undefined) return undefined
    inflight.abort.abort()
    return inflight.promise
  }

  private async closeSandbox(input: {
    repo: string
    operator: string
    environmentId: string
  }): Promise<{ outcome: 'closed' | 'absent'; attempt?: SandboxProviderStatus }> {
    const id = resolve(input.environmentId)
    const attempt = await this.cancelSandboxAttempt(id)
    // Every detached command leads its own process group; stop each whole
    // group (a finished leader can leave background children running) and
    // confirm it is gone before reporting the environment closed.
    const groups = [...(this.sandboxGroups.get(id) ?? [])]
    this.sandboxGroups.delete(id)
    const stopped = await Promise.all(groups.map((pgid) => terminateProcessGroup(pgid)))
    if (stopped.includes(false)) {
      throw new SandboxOperationError(
        'close',
        'a detached sandbox command survived SIGKILL; the environment is not stopped',
      )
    }
    const kept =
      (await this.isRegisteredWorktree(id, input.repo)) &&
      (await this.readSandboxMarker(id)) !== null
    return { outcome: kept ? 'closed' : 'absent', ...(attempt !== undefined ? { attempt } : {}) }
  }

  private async refreshSandbox(
    handle: SandboxEnvironmentIdentity,
    input: { repo: string; baseBranch: string },
  ): Promise<SandboxRefreshResult> {
    const cwd = handle.workspacePath
    const base = await this.resolveCommit(input.repo, `refs/heads/${input.baseBranch}`)
    const head = await this.resolveCommit(cwd, 'HEAD')
    const status = await this.gitOrThrow(cwd, ['status', '--porcelain'])
    if (status.stdout.trim() !== '') {
      return {
        outcome: 'refused',
        reason: 'dirty',
        message:
          'the sandbox checkout has uncommitted changes; commit or discard them before refreshing',
      }
    }
    if (head === base || (await this.isAncestor(cwd, base, head))) {
      return { outcome: 'current', headSha: head, baseSha: base, previousHeadSha: head }
    }
    if (!(await this.isAncestor(cwd, head, base))) {
      return {
        outcome: 'refused',
        reason: 'diverged',
        message: `the checkout head ${head} has diverged from ${input.baseBranch} (${base}); a fast-forward is impossible, so rebase inside the sandbox or run sandbox.reset`,
      }
    }
    await this.gitOrThrow(cwd, [
      '-c',
      'advice.detachedHead=false',
      'checkout',
      '--quiet',
      '--detach',
      base,
    ])
    await fsWriteFile(join(cwd, SANDBOX_MARKER), JSON.stringify({ baseSha: base }))
    return { outcome: 'refreshed', headSha: base, baseSha: base, previousHeadSha: head }
  }

  /** Idempotently exclude the provisioning marker in the worktree's
   * info/exclude so it never counts as dirt for the publish service's
   * untracked-inclusive dirty check (f_c748dc6a). Runs on both ensure
   * paths — fresh provisioning and the registered-worktree early return —
   * so sandboxes provisioned before the write landed are healed the next
   * time they are ensured. Errors propagate: a failed exclusion write
   * aborts provisioning, mirroring fail-closed behavior. A successful
   * `rev-parse --git-path` with empty stdout is a degenerate input — feeding
   * it to `resolve` would target the workspace directory itself — so it fails
   * loudly with the same `SandboxOperationError` — and the identical
   * failure string — the fake workspace uses for the same case, keeping
   * the two workspace-port implementations aligned. */
  private async excludeProvisioningMarker(workspacePath: string): Promise<void> {
    const markerName = SANDBOX_MARKER
    const exclude = await this.gitOrThrow(workspacePath, [
      'rev-parse',
      '--git-path',
      'info/exclude',
    ])
    if (exclude.stdout.trim() === '') {
      throw new SandboxOperationError(
        'provision',
        `operator sandbox could not resolve info/exclude: ${exclude.stderr.trim() || `exit ${exclude.exitCode}`}`,
      )
    }
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
   * setup command may install for a long time). `signal` runs the command
   * in its own process group (`setsid`) and, on abort, terminates the whole
   * group with SIGTERM then SIGKILL, escalating on the group's liveness
   * rather than the shell's exit, so a cancelled setup and the children it
   * forked stop together and release the output pipes this call awaits. */
  private async spawnSandboxCommand(
    command: string,
    cwd: string,
    timeoutSeconds?: number,
    signal?: AbortSignal,
  ): Promise<SandboxCommandResult> {
    const proc = Bun.spawn(['sh', '-c', command], {
      cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: this.sandboxEnv(),
      ...(signal !== undefined ? { detached: true } : {}),
    })
    let onAbort: (() => void) | undefined
    if (signal !== undefined) {
      onAbort = () => void terminateProcessGroup(proc.pid)
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    if (timeoutSeconds === undefined) {
      try {
        // A child that keeps the pipes open keeps this pending, and the abort
        // listener armed, until the group is gone.
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
        return { exitCode: exitCode ?? -1, stdout, stderr }
      } finally {
        if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
      }
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
    // Its own process group (`setsid`), so `close` can stop the command and
    // everything it forked.
    const proc = Bun.spawn(['sh', '-c', request.command], {
      cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: this.sandboxEnv(),
      detached: true,
    })
    const environmentGroups = this.sandboxGroups.get(resolve(handle.environmentId)) ?? new Set()
    for (const pgid of environmentGroups) if (!groupAlive(pgid)) environmentGroups.delete(pgid)
    environmentGroups.add(proc.pid)
    this.sandboxGroups.set(resolve(handle.environmentId), environmentGroups)
    const commandId = `sbcmd-${randomBytes(8).toString('hex')}`
    this.sandboxChildren.set(commandId, {
      proc,
      stdout: '',
      stderr: '',
      exitCode: null,
    })
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
    await this.cancelSandboxAttempt(path)
    this.sandboxFailures.delete(path)
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
      const head = await remoteBranchHead(this.exec, ref, input.branch)
      if (head === input.sha) await refreshBranchCache(this.exec, ref, input.branch, input.sha)
      return head === input.sha
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
      await publishBranch(this.exec, ref, input.branch, input.sha)
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
    const result = await this.git(ref, [
      'update-ref',
      `refs/heads/${input.branch}`,
      input.sha,
      existing ?? '0'.repeat(input.sha.length),
    ])
    if (result.exitCode !== 0) throw new GitError(args, result)
  }
}
