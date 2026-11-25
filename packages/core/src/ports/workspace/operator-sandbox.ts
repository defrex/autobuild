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
 * sandbox — store, forge, ticket-provider, model, and Vercel credentials.
 * One set, two enforcers: `[orchestrator].sandbox.environmentVariables`
 * config validation (refuses any of these names) and the guest command
 * environment both adapters build (starts from an empty record and adds only
 * forwarded names plus the toolchain PATH). */
export const SANDBOX_FORBIDDEN_ENV: readonly string[] = [
  'AB_STORE',
  'AB_TOKEN',
  'AB_TICKET_TOKEN',
  'AB_TICKET_URL',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'LINEAR_API_KEY',
  'VERCEL_OIDC_TOKEN',
  'VERCEL_TOKEN',
  'VERCEL_TEAM_ID',
  'VERCEL_PROJECT_ID',
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
  /** The base branch head the provision selected. `ensure` reports it on the
   * fresh-provision path; a lifecycle provider reports it on every `ready`
   * status whenever it recorded one at provisioning. The publication
   * preconditions compare against it: a publish must be a descendant of the
   * base head at provision, refresh or reset time. */
  baseSha?: string
}

/** The lifecycle state a provider reports for one operator's environment. */
export type SandboxLifecycleState =
  | 'absent'
  | 'provisioning'
  | 'resuming'
  | 'ready'
  | 'stopped'
  | 'failed'

/** Where a background provision or resume failed. */
export type SandboxProvisionStage = 'checkout' | 'setup' | 'environment' | 'resume' | 'provision'

/** One provider status report. `handle` is present when `ready`; `kind` says
 * which attempt produced a ready or in-flight report when the provider knows
 * (status probes leave it to the journal); `cancelled` marks an attempt that
 * `close` or `release` aborted. */
export interface SandboxProviderStatus {
  state: SandboxLifecycleState
  handle?: SandboxEnvironmentIdentity
  headSha?: string
  failure?: { stage: SandboxProvisionStage; message: string }
  kind?: 'provision' | 'resume'
  cancelled?: true
}

/** Outcome of `refresh`: a fast-forward, an already-current checkout, or a
 * refusal that changed nothing. */
export type SandboxRefreshResult =
  | {
      outcome: 'refreshed' | 'current'
      headSha: string
      baseSha: string
      previousHeadSha: string
    }
  | { outcome: 'refused'; reason: 'dirty' | 'diverged'; message: string }

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

/** Redact values of credential-named environment variables from a provider
 * message (the existing credential-redaction discipline): the message may
 * travel to a tool caller, so a value of any forbidden name never rides on
 * it. Values are read from the host environment of the serving process. */
export function redactSandboxMessage(message: string): string {
  let redacted = message
  for (const name of SANDBOX_FORBIDDEN_ENV) {
    const value = process.env[name]
    if (value !== undefined && value !== '') redacted = redacted.split(value).join('[REDACTED]')
  }
  return redacted
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
      | 'publish'
      | 'not-ready'
      | 'unsupported'
      | 'close'
      | 'refresh'
      | 'refresh-dirty'
      | 'refresh-diverged',
    message: string,
    options?: { cause?: unknown; state?: SandboxLifecycleState },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined)
    if (options?.state !== undefined) this.state = options.state
  }

  /** The environment's lifecycle state, on `not-ready` refusals. */
  readonly state?: SandboxLifecycleState
}

/** The substitutable seam at the workspace boundary for operator sandboxes.
 * Every environment-deriving operation takes `{ repo, operator }` (plus
 * `baseBranch` for `ensure`/`open`) so the one-environment-per-operator×
 * repository invariant holds at the type level; per-environment operations
 * take the resolved handle. Durable lifecycle facts are journaled by the
 * caller (the sandbox service), never by the provider.
 *
 * `open` is the service's entry point: it returns promptly and leaves any
 * provisioning to a background attempt the provider owns. `ensure` is the
 * provider's blocking provision primitive, used inside those attempts and by
 * provider tests; the service never calls it. */
export interface OperatorSandboxExecution {
  /** Whether the provider implements `open`/`status`/`close`/`refresh`. When
   * false the service answers those tools `unsupported` without calling
   * them. */
  readonly lifecycleSupported: boolean
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
  /** Open the operator's environment without blocking on provisioning.
   * Returns `ready` (no `settled`) when the environment already exists or
   * resumed at once; otherwise `provisioning`/`resuming` plus a `settled`
   * promise that resolves — never rejects — to the attempt's final status.
   * Idempotent: an in-flight attempt returns the same status and promise. */
  open(input: { repo: string; operator: string; baseBranch: string }): Promise<{
    status: SandboxProviderStatus
    settled?: Promise<SandboxProviderStatus>
  }>
  /** Pure probe of the environment's state; never provisions. A `ready`
   * report carries the handle (with the base head recorded at provisioning,
   * when known) and the checkout head. */
  status(input: { repo: string; operator: string }): Promise<SandboxProviderStatus>
  /** Stop the environment and release its capacity, keeping the checkout.
   * An in-flight attempt is cancelled: aborted, its running setup killed, and
   * awaited — close returns only after it settled, reporting its final
   * status as `attempt` (`ready` when it completed before the abort took
   * effect, `{ state: 'absent', cancelled: true }` when the abort stopped it;
   * a cancelled fresh provision leaves no checkout). */
  close(input: { repo: string; operator: string; environmentId: string }): Promise<{
    outcome: 'closed' | 'absent'
    attempt?: SandboxProviderStatus
  }>
  /** Fast-forward a clean checkout to the current base-branch head. Refuses a
   * dirty or diverged checkout and changes nothing when it refuses. */
  refresh(
    handle: SandboxEnvironmentIdentity,
    input: { repo: string; baseBranch: string },
  ): Promise<SandboxRefreshResult>
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
  /** Full teardown + snapshot purge, by exact environment identity. An
   * in-flight open attempt is cancelled and awaited first. */
  release(input: {
    repo: string
    operator: string
    environmentId: string
  }): Promise<{ snapshots: { outcome: 'confirmed' | 'unknown'; deleted?: number; error?: string } }>
}
