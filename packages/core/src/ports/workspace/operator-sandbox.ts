/**
 * Operator sandbox capability (AUT-340): one persistent, credential-free
 * environment per operator × repository, provisioned like a build workspace
 * and exposed to agent tools only through the registry. The provider owns
 * environment mechanics; durable facts live in the repository journal; the
 * caller supervises from the journal — the same split as the harvest
 * execution capability.
 *
 * The credential-free rule (SPEC §14): the environment receives no store,
 * forge, ticket-provider, or model credential, so the typed operator tools
 * remain the only route to build state from inside a general-purpose agent
 * shell. `SANDBOX_FORBIDDEN_ENV` is the one name set that rule is enforced
 * from — config validation refuses forwarding any of them, and both adapters
 * build guest command environments from an empty record (never the process
 * environment) that can only ever contain forwarded names plus toolchain
 * PATH. Lexical path validation in the service is not a sandbox boundary;
 * the residual risk is bounded by this rule and by the guest network policy,
 * which is the build workspace's upload-pack policy.
 */

/** Environment variable names that may never be forwarded into an operator
 * sandbox — store, forge, ticket-provider, and model credentials. One set,
 * two enforcers: `[orchestrator].sandbox.environmentVariables` config
 * validation (refuses any of these names) and the guest command environment
 * both adapters build (starts from an empty record and adds only forwarded
 * names plus the toolchain PATH). Provider-specific credential names arrive
 * through a registration's `sandboxForbiddenEnv` capability declaration,
 * enforced at the two registry-aware seams (AUT-536, AUT-505). */
export const SANDBOX_FORBIDDEN_ENV: readonly string[] = [
  'AB_STORE',
  'AB_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'LINEAR_API_KEY',
  'AI_GATEWAY_API_KEY',
]

/** Durable identity of one operator sandbox environment: the provider-scoped
 * name tools re-derive and journal facts carry. Deterministic per
 * (repository origin, operator) — there is at most one live environment per
 * operator and repository. */
export interface SandboxEnvironmentIdentity {
  provider: string
  /** Provider-scoped durable name (Vercel sandbox name / local worktree path). */
  environmentId: string
  /** Provider session, for journal facts. */
  sessionId?: string
  /** Checkout root inside the environment; tool file paths are rooted here. */
  workspacePath: string
  /** The base branch head the fresh provision selected, present only on the
   * fresh-provision path (absent on reuse/resume, which never re-resolves
   * it). The publication preconditions compare against it: a publish must
   * be a descendant of the base head at provision or reset time. */
  baseSha?: string
}

export interface SandboxCommandRequest {
  command: string
  cwd?: string
  timeoutSeconds?: number
}

export interface SandboxCommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

/** State of one detached command. Vercel reports command output only after
 * exit: while `running`, `stdout`/`stderr` stay undefined. */
export interface SandboxWaitResult {
  state: 'running' | 'exited'
  exitCode?: number
  stdout?: string
  stderr?: string
}

/** Typed failure of one operator-sandbox operation. `stage` names where it
 * failed so a tool caller sees `sandbox-<stage>` codes; the message carries
 * the provider's text, redacted of credential values by the service. */
export class SandboxOperationError extends Error {
  override readonly name = 'SandboxOperationError'

  constructor(
    readonly stage:
      | 'provision'
      | 'resume'
      | 'exec'
      | 'exec-timeout'
      | 'not-found'
      | 'environment'
      | 'reset'
      | 'release'
      | 'publish',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

/** The substitutable seam at the workspace boundary for operator sandboxes.
 * Every environment-deriving operation takes `{ repo, operator }` (plus
 * `baseBranch` for `ensure`) so the one-environment-per-operator×repository
 * invariant holds at the type level; per-environment operations take the
 * resolved handle. Durable lifecycle facts are journaled by the caller
 * (the sandbox service), never by the provider. */
export interface OperatorSandboxExecution {
  /** Pure resolution of the deterministic identity — no provisioning, no
   * provider traffic beyond origin discovery. Used by release paths that
   * must name the environment without creating one. */
  describe(input: { repo: string; operator: string }): Promise<SandboxEnvironmentIdentity>
  /** Provision on first use, resume after a stop. `baseBranch` selects the
   * fresh-provision source; reuse/resume never re-checks it. */
  ensure(input: {
    repo: string
    operator: string
    baseBranch: string
  }): Promise<SandboxEnvironmentIdentity>
  exec(
    handle: SandboxEnvironmentIdentity,
    request: SandboxCommandRequest,
  ): Promise<SandboxCommandResult>
  start(
    handle: SandboxEnvironmentIdentity,
    request: SandboxCommandRequest,
  ): Promise<{ commandId: string }>
  wait(
    handle: SandboxEnvironmentIdentity,
    input: { commandId: string; waitSeconds: number },
  ): Promise<SandboxWaitResult>
  readFile(handle: SandboxEnvironmentIdentity, path: string): Promise<Uint8Array>
  writeFile(handle: SandboxEnvironmentIdentity, path: string, content: Uint8Array): Promise<void>
  /** Idle stop: end the session, keep the snapshot. `unsupported` lets local
   * providers decline honestly. Both fields come from journal facts, so the
   * dispatcher can call this without provisioning anything. */
  stop(input: { operator: string; environmentId: string }): Promise<{
    outcome: 'stopped' | 'absent' | 'unsupported'
  }>
  /** Full teardown + snapshot purge, by exact environment identity. */
  release(input: {
    repo: string
    operator: string
    environmentId: string
  }): Promise<{ snapshots: { outcome: 'confirmed' | 'unknown'; deleted?: number; error?: string } }>
}
