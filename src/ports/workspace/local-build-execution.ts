import { resolve } from 'node:path'
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
    this.entrypoint = opts.entrypoint ?? resolve(import.meta.dir, '../../../bin/ab-build-runner.ts')
    this.env = opts.env ?? process.env
    this.stopTimeoutMs = opts.stopTimeoutMs ?? 5_000
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
    })
    let stopping: Promise<void> | undefined
    const completion: Promise<BuildExecutionExit> = child.exited.then((exitCode) => ({
      exitCode,
      ...(child.signalCode !== null ? { signal: child.signalCode } : {}),
    }))

    return {
      pid: child.pid,
      completion,
      stop: () => {
        stopping ??= (async () => {
          if (child.exitCode !== null) return
          child.kill('SIGTERM')
          const exited = await Promise.race([
            child.exited.then(() => true),
            Bun.sleep(this.stopTimeoutMs).then(() => false),
          ])
          if (!exited && child.exitCode === null) {
            child.kill('SIGKILL')
            await child.exited
          }
        })()
        return stopping
      },
    }
  }
}
