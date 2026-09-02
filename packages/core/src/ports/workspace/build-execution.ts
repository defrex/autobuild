/** Immutable identity passed when a workspace-adjacent executor is asked to
 * start a build. Build state, workspace location, config, progress, and outcome
 * are deliberately absent: both sides obtain those only from the BuildStore. */
export interface BuildExecutionStart {
  slug: string
  storeRef: string
  instance: string
  /** Expected supervising kernel pid. The local child uses this immutable
   * identity even if it is reparented before its modules finish loading. */
  parentPid: number
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
