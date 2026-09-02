import { distributionPath } from '../../distribution'
import {
  DEFAULT_PROCESS_GROUP_STOP_TIMEOUT_MS,
  terminateProcessGroup,
} from '../../processes/process-group'
import type {
  BuildExecution,
  BuildExecutionExit,
  BuildExecutionHandle,
  BuildExecutionStart,
} from './build-execution'

export const BUILD_RUNNER_OPTIONS_ENV = 'AB_BUILD_RUNNER_OPTIONS'

export interface LocalBuildExecutionOptions {
  entrypoint?: string
  env?: Record<string, string | undefined>
  stopTimeoutMs?: number
  spawn?: typeof Bun.spawn
}

/** Shipped local workspace+process implementation. stdio is ignored on
 * purpose: child output can never become a private progress/outcome channel. */
export class LocalBuildExecution implements BuildExecution {
  private readonly entrypoint: string
  private readonly env: Record<string, string | undefined>
  private readonly stopTimeoutMs: number
  private readonly spawn: typeof Bun.spawn

  constructor(opts: LocalBuildExecutionOptions = {}) {
    this.entrypoint = opts.entrypoint ?? distributionPath('bin', 'ab-build-runner.ts')
    this.env = opts.env ?? process.env
    this.stopTimeoutMs = opts.stopTimeoutMs ?? DEFAULT_PROCESS_GROUP_STOP_TIMEOUT_MS
    this.spawn = opts.spawn ?? Bun.spawn
  }

  async start(input: BuildExecutionStart): Promise<BuildExecutionHandle> {
    const child = this.spawn([process.execPath, this.entrypoint], {
      env: {
        ...this.env,
        [BUILD_RUNNER_OPTIONS_ENV]: JSON.stringify(input),
      },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      // On POSIX this makes the build child a new session and process-group
      // leader. Every agent tool descendant inherits that group by default.
      detached: true,
    })
    let reaping: Promise<void> | undefined
    const reap = (): Promise<void> =>
      (reaping ??= terminateProcessGroup(child.pid, this.stopTimeoutMs))
    const leaderExit = child.exited.then(
      (exitCode): BuildExecutionExit => ({
        exitCode,
        ...(child.signalCode !== null ? { signal: child.signalCode } : {}),
      }),
    )
    const completion = leaderExit.then(async (exit) => {
      // A naturally exited leader may leave inherited descendants behind.
      await reap()
      return exit
    })

    return {
      pid: child.pid,
      completion,
      stop: async () => {
        await Promise.all([reap(), leaderExit])
      },
    }
  }
}
