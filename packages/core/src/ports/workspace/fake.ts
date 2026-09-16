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
  SandboxOperationError,
  type OperatorSandboxExecution,
  type SandboxCommandResult,
  type SandboxEnvironmentIdentity,
  type SandboxWaitResult,
} from './operator-sandbox'
import type { WorkspaceHandle, WorkspaceProvider, WorkspaceProvisionResult } from '../types'

export interface ProvisionRecord {
  repo: string
  baseBranch: string
  branch: string
}

export type FakeWorkspaceMode = 'filesystem' | 'logical'

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
  readonly orchestratorSandbox: OperatorSandboxExecution

  /** Journals — public so tests assert directly on call order and args. */
  readonly provisions: ProvisionRecord[] = []
  readonly releases: WorkspaceHandle[] = []

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

  async provision(opts: {
    repo: string
    baseBranch: string
    branch: string
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
    { proc: ReturnType<typeof Bun.spawn>; stdout: string; stderr: string; exitCode: number | null }
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

  private async ensureSandbox(input: {
    repo: string
    operator: string
    baseBranch: string
  }): Promise<SandboxEnvironmentIdentity> {
    const identity = this.sandboxIdentity(input.repo, input.operator)
    if (await pathExists(join(identity.workspacePath, '.autobuild-sandbox-provisioned'))) {
      return identity
    }
    if (this.mode !== 'filesystem') {
      throw new SandboxOperationError(
        'provision',
        'the logical fake mode has no filesystem to host an operator sandbox',
      )
    }
    await mkdir(dirname(identity.workspacePath), { recursive: true })
    await rm(identity.workspacePath, { recursive: true, force: true })
    await cp(input.repo, identity.workspacePath, { recursive: true })
    try {
      if (this.sandboxSetupCommand !== undefined && this.sandboxSetupCommand.trim() !== '') {
        const proc = Bun.spawn(['sh', '-c', this.sandboxSetupCommand], {
          cwd: identity.workspacePath,
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
        if (exitCode !== 0) {
          throw new SandboxOperationError(
            'provision',
            `operator sandbox setup failed: ${stderr.trim() || stdout.trim() || `exit ${exitCode}`}`,
          )
        }
      }
      await fsWriteFile(join(identity.workspacePath, '.autobuild-sandbox-provisioned'), '')
    } catch (error) {
      await rm(identity.workspacePath, { recursive: true, force: true })
      throw error
    }
    return identity
  }

  private sandboxCwd(handle: SandboxEnvironmentIdentity, cwd: string | undefined): string {
    return cwd === undefined ? handle.workspacePath : join(handle.workspacePath, cwd)
  }

  private async sandboxExec(
    handle: SandboxEnvironmentIdentity,
    request: { command: string; cwd?: string; timeoutSeconds?: number },
  ): Promise<SandboxCommandResult> {
    const timeoutSeconds = Math.min(Math.max(request.timeoutSeconds ?? 120, 1), 300)
    const proc = Bun.spawn(['sh', '-c', request.command], {
      cwd: this.sandboxCwd(handle, request.cwd),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: this.sandboxEnv(),
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
    const proc = Bun.spawn(['sh', '-c', request.command], {
      cwd: this.sandboxCwd(handle, request.cwd),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: this.sandboxEnv(),
    })
    const commandId = `sbcmd-${Math.random().toString(36).slice(2, 12)}`
    const tracked = { proc, stdout: '', stderr: '', exitCode: null as number | null }
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
    await rm(input.environmentId, { recursive: true, force: true })
    return { snapshots: { outcome: 'confirmed' } }
  }
}
