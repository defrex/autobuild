/**
 * FakeWorkspaceProvider (SPEC §3.2): WorkspaceProvider for seam tests. Its
 * default filesystem mode copies a source working tree so the returned path
 * has the same usable-path semantics as GitWorktreeProvider. High-volume
 * process-decision tests may explicitly select `logical` mode when their
 * synthetic repo/path values are intentionally not filesystem fixtures.
 *
 * Shape parity with GitWorktreeProvider: `ref` and `path` are the same
 * string (`<root>/<branch>`), provision is idempotent per branch (resume is
 * a re-run, not a special path — constitution #2), and release of an
 * unknown or already-released workspace is a no-op, never an error.
 */
import { createHash } from 'node:crypto'
import {
  cp,
  mkdir,
  readFile as fsReadFile,
  rm,
  stat,
  writeFile as fsWriteFile,
} from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { WorkspaceBase } from '../../ontology'
import {
  redactSandboxMessage,
  SandboxOperationError,
  type OperatorSandboxExecution,
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

export interface ProvisionRecord {
  repo: string
  baseBranch: string
  branch: string
  fresh?: { owner: string }
}

export type FakeWorkspaceMode = 'filesystem' | 'logical'

const SANDBOX_MARKER = '.autobuild-sandbox-provisioned'
const SHA_PATTERN = /^[0-9a-f]{40,64}$/i

/** A provision attempt stopped by `close` or `release`; not a failure. */
class SandboxCancelledError extends Error {
  override readonly name = 'SandboxCancelledError'
  constructor() {
    super('operator sandbox provisioning was cancelled')
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export class FakeWorkspaceProvider implements WorkspaceProvider {
  readonly name = 'fake'
  readonly preservation: NonNullable<WorkspacePublication['preserve']> = async () => ({
    outcome: 'preserved',
    heads: [],
  })
  readonly orchestratorSandbox: OperatorSandboxExecution
  readonly sandboxPublication: WorkspacePublication

  /** Journals — public so tests assert directly on call order and args. */
  readonly provisions: ProvisionRecord[] = []
  readonly releases: WorkspaceHandle[] = []
  /** Journal — per-spawn guest environments, recorded by the operator-sandbox
   * capability's spawn sites (`exec`, `start`, and the setup-command spawn)
   * just before the child launches. Credential-freeness is asserted against
   * these records directly: what the provider constructed, not what a shell
   * reported. */
  readonly sandboxExecEnvironments: Array<{
    op: 'exec' | 'start' | 'setup'
    command: string
    env: Record<string, string>
  }> = []
  /** Journal — sandbox publication pushes, in call order. */
  readonly publications: Array<{ ref: string; sha: string; branch: string }> = []

  private readonly root: string
  private readonly initialBase: WorkspaceBase
  private readonly mode: FakeWorkspaceMode
  private readonly sandboxRoot: string
  private readonly sandboxSetupCommand: string | undefined
  private readonly sandboxEnvSource: Record<string, string | undefined>
  private readonly sandboxEnvironmentVariables: readonly string[]
  /** ref → handle for workspaces provisioned and not yet released. */
  private readonly active = new Map<string, WorkspaceHandle>()
  /** Durable fake branch heads survive release, like real Git branches. */
  private readonly branchHeads = new Map<string, string>()
  private readonly failures = new Map<'provision' | 'release', Error>()
  /** Injectable publication failure: while set, `sandboxPublication.publish`
   * throws it on every call (pass `null` to clear). */
  private publicationFailure: Error | null = null
  /** environmentId → the base branch the fresh provision selected, so the
   * publication capability can refuse the base branch as defense in depth. */
  private readonly sandboxBaseBranches = new Map<string, string>()

  constructor(
    opts: {
      root?: string
      base?: WorkspaceBase
      /** Default `filesystem` enforces a real usable working-copy path. */
      mode?: FakeWorkspaceMode
      /** Operator-sandbox knobs: sandbox root (defaults to a sibling of the
       * workspace root), the setup command, and forwarded variable names
       * resolved from `envSource`. */
      sandboxRoot?: string
      sandboxSetupCommand?: string
      sandboxEnvironmentVariables?: readonly string[]
      envSource?: Record<string, string | undefined>
    } = {},
  ) {
    this.root = resolve(opts.root ?? '/fake/workspaces')
    this.initialBase = opts.base ?? { source: 'remote', sha: 'fake-base-sha' }
    this.mode = opts.mode ?? 'filesystem'
    this.sandboxRoot = resolve(opts.sandboxRoot ?? join(this.root, '..', 'orchestrator-sandboxes'))
    this.sandboxSetupCommand = opts.sandboxSetupCommand
    this.sandboxEnvironmentVariables = opts.sandboxEnvironmentVariables ?? []
    this.sandboxEnvSource = opts.envSource ?? {}
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
      stop: () => Promise.resolve({ outcome: 'stopped' as const }),
      release: (input) => this.sandboxRelease(input),
    }
    this.sandboxPublication = {
      isPublished: (input) =>
        Promise.resolve(
          this.publications.some(
            (entry) => entry.branch === input.branch && entry.sha === input.sha,
          ),
        ),
      publish: (input) => this.publishSandbox(input),
    }
  }

  /** Injectable publication failure: while set, the sandbox publication push
   * throws `error` on every call (pass `null` to clear). */
  setPublicationFailure(error: Error | null): void {
    this.publicationFailure = error
  }

  private async publishSandbox(input: { ref: string; sha: string; branch: string }): Promise<void> {
    if (this.publicationFailure) throw this.publicationFailure
    const baseBranch = this.sandboxBaseBranches.get(input.ref)
    if (baseBranch !== undefined && input.branch === baseBranch) {
      throw new Error(`publication refuses the base branch ${baseBranch}`)
    }
    this.publications.push({ ...input })
  }

  /**
   * Injectable failure: while set, the named operation throws `error` on
   * every call (pass `null` to clear). Lets tests drive the provision/release
   * failure paths without a real provider.
   */
  setFailure(op: 'provision' | 'release', error: Error | null): void {
    if (error === null) this.failures.delete(op)
    else this.failures.set(op, error)
  }

  /** Whether the workspace at `ref` is currently provisioned. */
  isActive(ref: string): boolean {
    return this.active.has(ref)
  }

  /** Test seam for commits made between provision calls. */
  setBranchHead(branch: string, sha: string): void {
    this.branchHeads.set(branch, sha)
  }

  /** Test seam: local branches `localBranchExists` reports, independent of
   * `branchHeads` so tests that set a head keep their slugs. */
  readonly localBranches = new Set<string>()

  async localBranchExists(_repo: string, branch: string): Promise<boolean> {
    return this.localBranches.has(branch)
  }

  async provision(opts: {
    repo: string
    baseBranch: string
    branch: string
    fresh?: { owner: string }
  }): Promise<WorkspaceProvisionResult> {
    const failure = this.failures.get('provision')
    if (failure) throw failure
    const ref = resolve(join(this.root, opts.branch))
    const existing = this.active.get(ref)
    if (existing) {
      if (this.mode === 'logical' || (await pathExists(existing.path))) {
        this.provisions.push({ ...opts })
        return {
          ...existing,
          base: {
            source: 'existing',
            sha: this.branchHeads.get(opts.branch) ?? this.initialBase.sha,
          },
        }
      }
      // The active map is only process-local bookkeeping. If its filesystem
      // working copy disappeared out of band, forget that stale registration
      // and rematerialize below without changing the durable fake branch head.
      this.active.delete(ref)
    }

    if (this.mode === 'filesystem') {
      await mkdir(dirname(ref), { recursive: true })
      // The fake owns its root. Remove an out-of-band leftover before making
      // the new active working copy, just as worktree prune permits recovery.
      await rm(ref, { recursive: true, force: true })
      await cp(opts.repo, ref, { recursive: true })
    }

    const handle: WorkspaceHandle = {
      provider: this.name,
      ref,
      path: ref,
      branch: opts.branch,
    }
    this.active.set(ref, handle)
    this.provisions.push({ ...opts })

    const existingSha = this.branchHeads.get(opts.branch)
    if (existingSha !== undefined) {
      return { ...handle, base: { source: 'existing', sha: existingSha } }
    }
    this.branchHeads.set(opts.branch, this.initialBase.sha)
    return { ...handle, base: { ...this.initialBase } }
  }

  /** Idempotent: releasing an unknown or already-released handle is a no-op
   * (matching GitWorktreeProvider's already-gone-worktree behavior). */
  async release(handle: WorkspaceHandle): Promise<void> {
    const failure = this.failures.get('release')
    if (failure) throw failure
    this.releases.push({
      provider: handle.provider,
      ref: handle.ref,
      path: handle.path,
      branch: handle.branch,
    })
    const active = this.active.get(handle.ref)
    if (!active) return
    if (this.mode === 'filesystem') {
      await rm(active.path, { recursive: true, force: true })
    }
    this.active.delete(handle.ref)
  }

  // ── Operator sandbox capability (AUT-340) ───────────────────
  // Filesystem-backed so service and registry contract tests exercise real
  // exec/read/write/reset semantics against a disposable tree.

  /** Journal — environments idly stopped via the capability's `stop`. */
  readonly sandboxStops: Array<{ operator: string; environmentId: string }> = []
  /** Journal — full teardowns via the capability's `release`. */
  readonly sandboxReleases: Array<{ repo: string; operator: string; environmentId: string }> = []
  /** Serialization probe: in-flight exec recording, for overlap tests. */
  private readonly sandboxChildren = new Map<
    string,
    {
      proc: ReturnType<typeof Bun.spawn>
      stdout: string
      stderr: string
      exitCode: number | null
    }
  >()

  private sandboxIdentity(repo: string, operator: string): SandboxEnvironmentIdentity {
    const digest = createHash('sha256').update(`${repo}\0${operator}`).digest('hex').slice(0, 10)
    const path = join(this.sandboxRoot, digest)
    return { provider: this.name, environmentId: path, workspacePath: path }
  }

  /** The credential-free guest environment: empty record + host PATH + the
   * forwarded names. Mirrors the builtin adapters' rule. */
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
    if (await pathExists(join(identity.workspacePath, SANDBOX_MARKER))) {
      // Pre-existing sandboxes provisioned before the info/exclude write
      // landed (AUT-580) keep an unexcluded marker; write the exclusion on
      // every ensure, mirroring GitWorktreeProvider, so the publish
      // service's untracked-inclusive dirty check never counts the marker
      // as dirt.
      await this.excludeProvisioningMarker(identity.workspacePath)
      return identity
    }
    if (this.mode !== 'filesystem') {
      throw new SandboxOperationError(
        'provision',
        'the logical fake mode has no filesystem to host an operator sandbox',
      )
    }
    control.onStage?.('checkout')
    if (signal?.aborted) throw new SandboxCancelledError()
    await mkdir(dirname(identity.workspacePath), { recursive: true })
    await rm(identity.workspacePath, { recursive: true, force: true })
    await cp(input.repo, identity.workspacePath, { recursive: true })
    try {
      if (signal?.aborted) throw new SandboxCancelledError()
      // Real git checkout (publish-service parity): the three git checks the
      // publish service runs through capability.exec (rev-parse, status,
      // merge-base) must work against the fake exactly as against the real
      // providers, which serve a genuine checkout. A plain fixture source is
      // not a git repository, so the fake initializes one from the base
      // branch and makes a seed commit; a source that already IS a git
      // repository is used as-is. baseSha is the base branch's head after
      // provisioning — the same value the real providers resolve.
      if (!(await pathExists(join(identity.workspacePath, '.git')))) {
        await this.runSandboxGit(identity.workspacePath, ['init', '-b', input.baseBranch])
        await this.runSandboxGit(identity.workspacePath, ['config', 'user.name', 'autobuild[bot]'])
        await this.runSandboxGit(identity.workspacePath, [
          'config',
          'user.email',
          'autobuild[bot]@users.noreply.github.com',
        ])
        await this.runSandboxGit(identity.workspacePath, ['add', '-A'])
        const committed = await this.runSandboxGit(identity.workspacePath, [
          'commit',
          '--allow-empty',
          '-q',
          '-m',
          'sandbox seed',
        ])
        if (committed.exitCode !== 0) {
          throw new SandboxOperationError(
            'provision',
            `operator sandbox git seed failed: ${committed.stderr.trim() || committed.stdout.trim()}`,
          )
        }
      }
      const head = await this.runSandboxGit(identity.workspacePath, [
        'rev-parse',
        `refs/heads/${input.baseBranch}`,
      ])
      if (head.exitCode !== 0 || head.stdout.trim() === '') {
        throw new SandboxOperationError(
          'provision',
          `operator sandbox could not resolve base branch ${input.baseBranch}: ${head.stderr.trim() || head.stdout.trim() || `exit ${head.exitCode}`}`,
        )
      }
      const baseSha = head.stdout.trim()
      this.sandboxBaseBranches.set(identity.environmentId, input.baseBranch)
      if (signal?.aborted) throw new SandboxCancelledError()
      if (this.sandboxSetupCommand !== undefined && this.sandboxSetupCommand.trim() !== '') {
        control.onStage?.('setup')
        this.sandboxExecEnvironments.push({
          op: 'setup',
          command: this.sandboxSetupCommand,
          env: this.sandboxEnv(),
        })
        // Its own process group, so a cancel stops setup and its children
        // together and releases the pipes awaited below (mirrors the real
        // provider).
        const proc = Bun.spawn(['sh', '-c', this.sandboxSetupCommand], {
          cwd: identity.workspacePath,
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
          env: this.sandboxEnv(),
          detached: true,
        })
        const onAbort = (): void => void terminateProcessGroup(proc.pid)
        if (signal?.aborted) onAbort()
        else signal?.addEventListener('abort', onAbort, { once: true })
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]).finally(() => signal?.removeEventListener('abort', onAbort))
        if (signal?.aborted) throw new SandboxCancelledError()
        if (exitCode !== 0) {
          throw new SandboxOperationError(
            'provision',
            `operator sandbox setup failed: ${stderr.trim() || stdout.trim() || `exit ${exitCode}`}`,
          )
        }
      }
      await this.excludeProvisioningMarker(identity.workspacePath)
      // The marker file write deliberately stays outside
      // excludeProvisioningMarker: that helper is the info/exclude exclusion
      // logic alone (the early-return heal runs it too), while this write is
      // provisioning-specific.
      if (signal?.aborted) throw new SandboxCancelledError()
      await fsWriteFile(join(identity.workspacePath, SANDBOX_MARKER), JSON.stringify({ baseSha }))
      return { ...identity, baseSha }
    } catch (error) {
      await rm(identity.workspacePath, { recursive: true, force: true })
      throw error
    }
  }

  // ── Operator sandbox lifecycle (#1223), mirroring GitWorktreeProvider ──

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
  /** environmentId → process groups of its detached commands; dead groups
   * are pruned on every `start`. */
  private readonly sandboxGroups = new Map<string, Set<number>>()

  /** The marker's recorded metadata: `null` when missing, `{}` when legacy. */
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

  private async sandboxHead(workspacePath: string): Promise<string | undefined> {
    const head = await this.runSandboxGit(workspacePath, ['rev-parse', 'HEAD'])
    return head.exitCode === 0 && head.stdout.trim() !== '' ? head.stdout.trim() : undefined
  }

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
    const marker =
      this.mode === 'filesystem' ? await this.readSandboxMarker(identity.workspacePath) : null
    if (marker !== null) {
      await this.excludeProvisioningMarker(identity.workspacePath)
      this.sandboxFailures.delete(id)
      const headSha = await this.sandboxHead(identity.workspacePath)
      return {
        status: {
          state: 'ready',
          handle: {
            ...identity,
            ...(marker.baseSha !== undefined ? { baseSha: marker.baseSha } : {}),
          },
          kind: 'resume',
          ...(headSha !== undefined ? { headSha } : {}),
        },
      }
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
      let stage: SandboxProvisionStage = 'provision'
      try {
        const handle = await this.ensureSandbox(input, {
          signal: abort.signal,
          onStage: (next) => {
            stage = next
          },
        })
        const headSha = await this.sandboxHead(handle.workspacePath)
        return {
          state: 'ready',
          handle,
          kind: 'provision',
          ...(headSha !== undefined ? { headSha } : {}),
        }
      } catch (error) {
        if (error instanceof SandboxCancelledError) {
          await rm(id, { recursive: true, force: true })
          return { state: 'absent', cancelled: true }
        }
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
    if (this.mode !== 'filesystem' || !(await pathExists(identity.workspacePath))) {
      return { state: 'absent' }
    }
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
    const headSha = await this.sandboxHead(identity.workspacePath)
    return {
      state: 'ready',
      handle: { ...identity, ...(marker.baseSha !== undefined ? { baseSha: marker.baseSha } : {}) },
      ...(headSha !== undefined ? { headSha } : {}),
    }
  }

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
    const attempt = await this.cancelSandboxAttempt(input.environmentId)
    const groups = [...(this.sandboxGroups.get(input.environmentId) ?? [])]
    this.sandboxGroups.delete(input.environmentId)
    const stopped = await Promise.all(groups.map((pgid) => terminateProcessGroup(pgid)))
    if (stopped.includes(false)) {
      throw new SandboxOperationError(
        'close',
        'a detached sandbox command survived SIGKILL; the environment is not stopped',
      )
    }
    const kept =
      this.mode === 'filesystem' && (await this.readSandboxMarker(input.environmentId)) !== null
    return { outcome: kept ? 'closed' : 'absent', ...(attempt !== undefined ? { attempt } : {}) }
  }

  /** The base head comes from the source repository when it is a git
   * repository (fetched into the checkout), else the checkout's own base
   * branch; then the same clean/ancestor/diverged rules as the real
   * provider apply. */
  private async refreshSandbox(
    handle: SandboxEnvironmentIdentity,
    input: { repo: string; baseBranch: string },
  ): Promise<SandboxRefreshResult> {
    const cwd = handle.workspacePath
    let base: string | undefined
    if (await pathExists(join(input.repo, '.git'))) {
      const fetched = await this.runSandboxGit(cwd, [
        'fetch',
        '--quiet',
        input.repo,
        `refs/heads/${input.baseBranch}`,
      ])
      if (fetched.exitCode !== 0) {
        throw new SandboxOperationError(
          'refresh',
          `operator sandbox could not fetch ${input.baseBranch}: ${fetched.stderr.trim() || `exit ${fetched.exitCode}`}`,
        )
      }
      const resolved = await this.runSandboxGit(cwd, ['rev-parse', 'FETCH_HEAD'])
      base = resolved.stdout.trim()
    } else {
      const resolved = await this.runSandboxGit(cwd, [
        'rev-parse',
        `refs/heads/${input.baseBranch}`,
      ])
      base = resolved.stdout.trim()
    }
    const head = await this.sandboxHead(cwd)
    if (base === '' || head === undefined) {
      throw new SandboxOperationError('refresh', 'operator sandbox could not resolve its heads')
    }
    const status = await this.runSandboxGit(cwd, ['status', '--porcelain'])
    if (status.stdout.trim() !== '') {
      return {
        outcome: 'refused',
        reason: 'dirty',
        message:
          'the sandbox checkout has uncommitted changes; commit or discard them before refreshing',
      }
    }
    const isAncestor = async (ancestor: string, descendant: string): Promise<boolean> =>
      (await this.runSandboxGit(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]))
        .exitCode === 0
    if (head === base || (await isAncestor(base, head))) {
      return { outcome: 'current', headSha: head, baseSha: base, previousHeadSha: head }
    }
    if (!(await isAncestor(head, base))) {
      return {
        outcome: 'refused',
        reason: 'diverged',
        message: `the checkout head ${head} has diverged from ${input.baseBranch} (${base}); a fast-forward is impossible`,
      }
    }
    const moved = await this.runSandboxGit(cwd, [
      '-c',
      'advice.detachedHead=false',
      'checkout',
      '--quiet',
      '--detach',
      base,
    ])
    if (moved.exitCode !== 0) {
      throw new SandboxOperationError(
        'refresh',
        `operator sandbox could not check out ${base}: ${moved.stderr.trim() || `exit ${moved.exitCode}`}`,
      )
    }
    await fsWriteFile(join(cwd, SANDBOX_MARKER), JSON.stringify({ baseSha: base }))
    return { outcome: 'refreshed', headSha: base, baseSha: base, previousHeadSha: head }
  }

  /** Idempotently exclude the provisioning marker in the checkout's
   * info/exclude so the publish service's untracked-inclusive dirty check
   * never counts it as dirt (f_c748dc6a). Runs on both ensure paths —
   * fresh provisioning and the marker-exists early return — so sandboxes
   * provisioned before the write landed are healed the next time they are
   * ensured. Mirrors GitWorktreeProvider. */
  private async excludeProvisioningMarker(workspacePath: string): Promise<void> {
    const exclude = await this.runSandboxGit(workspacePath, [
      'rev-parse',
      '--git-path',
      'info/exclude',
    ])
    if (exclude.exitCode !== 0 || exclude.stdout.trim() === '') {
      throw new SandboxOperationError(
        'provision',
        `operator sandbox could not resolve info/exclude: ${exclude.stderr.trim() || `exit ${exclude.exitCode}`}`,
      )
    }
    const excludePath = resolve(workspacePath, exclude.stdout.trim())
    await mkdir(dirname(excludePath), { recursive: true })
    const existingExclude = await fsReadFile(excludePath, 'utf8').then(
      (content) => content,
      () => '',
    )
    if (!existingExclude.split('\n').includes(SANDBOX_MARKER)) {
      const prefix =
        existingExclude === '' || existingExclude.endsWith('\n')
          ? existingExclude
          : `${existingExclude}\n`
      await fsWriteFile(excludePath, `${prefix}${SANDBOX_MARKER}\n`)
    }
  }

  /** One git invocation inside the sandbox checkout with the same
   * credential-free guest environment as every exec. */
  private async runSandboxGit(
    cwd: string,
    args: string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(['git', ...args], {
      cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: this.sandboxEnv(),
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { exitCode: exitCode ?? -1, stdout, stderr }
  }

  private sandboxCwd(handle: SandboxEnvironmentIdentity, cwd: string | undefined): string {
    return cwd === undefined ? handle.workspacePath : join(handle.workspacePath, cwd)
  }

  private async sandboxExec(
    handle: SandboxEnvironmentIdentity,
    request: { command: string; cwd?: string; timeoutSeconds?: number },
  ): Promise<SandboxCommandResult> {
    const timeoutSeconds = Math.min(Math.max(request.timeoutSeconds ?? 120, 1), 300)
    const env = this.sandboxEnv()
    this.sandboxExecEnvironments.push({ op: 'exec', command: request.command, env })
    const proc = Bun.spawn(['sh', '-c', request.command], {
      cwd: this.sandboxCwd(handle, request.cwd),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env,
    })
    const timer = AbortSignal.timeout(timeoutSeconds * 1000)
    const outcome = await Promise.race([
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
    ]).catch((error: unknown) => {
      try {
        proc.kill('SIGTERM')
      } catch {
        /* already exited */
      }
      throw error
    })
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    return { exitCode: outcome.code ?? -1, stdout, stderr }
  }

  private async sandboxStart(
    handle: SandboxEnvironmentIdentity,
    request: { command: string; cwd?: string },
  ): Promise<{ commandId: string }> {
    const env = this.sandboxEnv()
    this.sandboxExecEnvironments.push({ op: 'start', command: request.command, env })
    const proc = Bun.spawn(['sh', '-c', request.command], {
      cwd: this.sandboxCwd(handle, request.cwd),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env,
      detached: true,
    })
    const environmentGroups = this.sandboxGroups.get(handle.environmentId) ?? new Set()
    for (const pgid of environmentGroups) if (!groupAlive(pgid)) environmentGroups.delete(pgid)
    environmentGroups.add(proc.pid)
    this.sandboxGroups.set(handle.environmentId, environmentGroups)
    const commandId = `sbcmd-${Math.random().toString(36).slice(2, 12)}`
    const tracked = {
      proc,
      stdout: '',
      stderr: '',
      exitCode: null as number | null,
    }
    this.sandboxChildren.set(commandId, tracked)
    void (async () => {
      const decoder = new TextDecoder()
      const reader = proc.stdout.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        tracked.stdout += decoder.decode(value, { stream: true })
      }
    })()
    void (async () => {
      const decoder = new TextDecoder()
      const reader = proc.stderr.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        tracked.stderr += decoder.decode(value, { stream: true })
      }
    })()
    void proc.exited.then((code) => {
      tracked.exitCode = code ?? -1
    })
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
        `unknown sandbox command ${JSON.stringify(input.commandId)}`,
      )
    }
    const deadline = Date.now() + Math.min(Math.max(input.waitSeconds, 0), 300) * 1000
    while (child.exitCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    if (child.exitCode === null) {
      return { state: 'running', stdout: child.stdout, stderr: child.stderr }
    }
    return {
      state: 'exited',
      exitCode: child.exitCode,
      stdout: child.stdout,
      stderr: child.stderr,
    }
  }

  private async sandboxReadFile(
    handle: SandboxEnvironmentIdentity,
    path: string,
  ): Promise<Uint8Array> {
    return new Uint8Array(await fsReadFile(this.sandboxRootedPath(handle, path)))
  }

  private async sandboxWriteFile(
    handle: SandboxEnvironmentIdentity,
    path: string,
    content: Uint8Array,
  ): Promise<void> {
    const rooted = this.sandboxRootedPath(handle, path)
    await mkdir(dirname(rooted), { recursive: true })
    await fsWriteFile(rooted, content)
  }

  /** Root tool paths at the checkout; rejects escapes lexically. */
  private sandboxRootedPath(handle: SandboxEnvironmentIdentity, path: string): string {
    const rooted = resolve(handle.workspacePath, path)
    if (!rooted.startsWith(resolve(handle.workspacePath) + sep)) {
      throw new SandboxOperationError(
        'exec',
        `sandbox path ${JSON.stringify(path)} escapes the checkout`,
      )
    }
    return rooted
  }

  private async sandboxRelease(input: {
    repo: string
    operator: string
    environmentId: string
  }): Promise<{ snapshots: { outcome: 'confirmed' } }> {
    this.sandboxReleases.push({ ...input })
    await this.cancelSandboxAttempt(input.environmentId)
    this.sandboxFailures.delete(input.environmentId)
    await rm(input.environmentId, { recursive: true, force: true })
    return { snapshots: { outcome: 'confirmed' } }
  }
}
