/** Immutable identity passed when a workspace-adjacent executor is asked to
 * start a build. Build state, workspace location, config, progress, and outcome
 * are deliberately absent: both sides obtain those only from the BuildStore. */
export interface BuildExecutionStart {
  slug: string
  storeRef: string
  instance: string
  /** Provider-native locator from the current workspace.provisioned fact. */
  workspaceRef: string
}

/** Serialized private-child envelope. Host PIDs are meaningful only to the
 * local executor; an environment-owned VM is supervised as one unit by its
 * provider. Keeping the modes discriminated prevents accidental cross-namespace
 * signalling. */
export type BuildChildLaunch = BuildExecutionStart &
  (
    | { supervision: { kind: 'local-parent'; parentPid: number } }
    | { supervision: { kind: 'environment' } }
  )

export function parseBuildChildLaunch(value: unknown): BuildChildLaunch | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as Partial<BuildChildLaunch> & { supervision?: Record<string, unknown> }
  if (
    typeof candidate.slug !== 'string' ||
    candidate.slug.length === 0 ||
    typeof candidate.storeRef !== 'string' ||
    candidate.storeRef.length === 0 ||
    typeof candidate.instance !== 'string' ||
    candidate.instance.length === 0 ||
    typeof candidate.workspaceRef !== 'string' ||
    candidate.workspaceRef.length === 0 ||
    candidate.supervision === undefined
  )
    return undefined
  const supervision = candidate.supervision
  if (supervision.kind === 'environment') {
    if (Object.hasOwn(supervision, 'parentPid')) return undefined
    return candidate as BuildChildLaunch
  }
  if (
    supervision.kind === 'local-parent' &&
    Number.isInteger(supervision.parentPid) &&
    (supervision.parentPid as number) > 0
  )
    return candidate as BuildChildLaunch
  return undefined
}

export const BUILD_EXECUTION_LEASE_TTL_MS = 60_000

/** Child exit is liveness evidence only. It carries no pipeline outcome. */
export interface BuildExecutionExit {
  exitCode: number | null
  signal?: string
}

/** Immutable provider identity recorded as soon as an execution starts. */
export interface BuildExecutionIdentity {
  provider: string
  workspaceRef: string
  /** Provider-native VM/container identity when it differs from workspaceRef. */
  environmentId?: string
  /** Provider-native session identity. A resumed persistent VM gets a new one. */
  sessionId?: string
  /** Provider-native detached command identity, recorded durably at launch so
   * a later process can re-observe the execution without process memory. */
  commandId?: string
}

/** Teardown must distinguish proof from an interrupted/ambiguous acknowledgement. */
export type BuildExecutionTeardownResult =
  | { outcome: 'confirmed' | 'absent' }
  | { outcome: 'unknown'; error: string }

/** How a handle's lifetime is tied to its supervising process. `local-parent`
 * means the kernel owns the process tree and must reap it at teardown;
 * `environment` means the guest environment owns the execution and the kernel
 * supervises only its local wait — teardown detaches instead of stopping, so
 * the guest outlives the supervising process and a later invocation settles
 * the execution from the Store plus provider liveness. */
export type BuildExecutionSupervision = 'local-parent' | 'environment'

export interface BuildExecutionHandle {
  /** Available for supervision/tests, never used as build state. */
  readonly pid?: number
  readonly identity?: BuildExecutionIdentity
  /** Explicit supervision kind. Never inferred from `environmentId` — a local
   * pid and a remote VM id are different namespaces. */
  readonly supervision: BuildExecutionSupervision
  /** Resolves only after the execution environment has reaped everything the
   * build started. The exit projection still describes the build leader. */
  readonly completion: Promise<BuildExecutionExit>
  /** Idempotent shutdown: graceful, bounded force escalation, then full reap. */
  stop(): Promise<BuildExecutionTeardownResult | void>
  /** Stop supervising without touching the environment: abort the local wait
   * only. No command kill, no environment stop, no lease release, no
   * `execution.ended`, no publication settlement. The teardown mode when the
   * guest must outlive the supervising process. */
  detach(): Promise<void>
}

/** Provider liveness observation of one recorded execution, derived from
 * provider state rather than process memory. `ended` carries the observed
 * exit code; `lost` means the provider proved the environment/command no
 * longer exists without an exit code. */
export type ExecutionObservation =
  | { state: 'running' }
  | { state: 'ended'; exitCode?: number }
  | { state: 'lost' }

/** The substitutable seam at the workspace boundary. A remote workspace
 * provider may implement this by starting the fixed build process beside its
 * checkout; the kernel need not know where that is. Every provider owns full
 * teardown of the environment and descendants it starts before completion. */
export interface BuildExecution {
  start(input: BuildExecutionStart): Promise<BuildExecutionHandle>
  /** Optional liveness observation of a previously recorded execution, from
   * provider state alone. Absent = this provider cannot observe; callers
   * supervise exactly as before ("cannot observe" never means "act"). */
  observe?(identity: BuildExecutionIdentity): Promise<ExecutionObservation>
}
