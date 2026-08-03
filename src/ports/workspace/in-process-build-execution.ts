import type { BuildExecution, BuildExecutionHandle, BuildExecutionStart } from './build-execution'

/** Deterministic test double. Production wiring never constructs this class;
 * it keeps exhaustive scripted-agent scenarios in-process behind the same
 * execution seam without weakening process isolation in the product path. */
export class InProcessBuildExecution implements BuildExecution {
  constructor(private readonly run: (input: BuildExecutionStart) => Promise<void>) {}

  async start(input: BuildExecutionStart): Promise<BuildExecutionHandle> {
    const completion = Promise.resolve()
      .then(() => this.run(input))
      .then(
        () => ({ exitCode: 0 }),
        () => ({ exitCode: 1 }),
      )
    return {
      completion,
      async stop() {
        // Scripted test turns are finite. Cancellation behavior belongs to the
        // real local supervisor tests rather than this deterministic double.
      },
    }
  }
}
