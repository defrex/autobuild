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

export interface BuildExecutionHandle {
  /** Available for supervision/tests, never used as build state. */
  readonly pid?: number
  /** Resolves only after the execution environment has reaped everything the
   * build started. The exit projection still describes the build leader. */
  readonly completion: Promise<BuildExecutionExit>
  /** Idempotent shutdown: graceful, bounded force escalation, then full reap. */
  stop(): Promise<void>
}

/** The substitutable seam at the workspace boundary. A remote workspace
 * provider may implement this by starting the fixed build process beside its
 * checkout; the kernel need not know where that is. Every provider owns full
 * teardown of the environment and descendants it starts before completion. */
export interface BuildExecution {
  start(input: BuildExecutionStart): Promise<BuildExecutionHandle>
}
