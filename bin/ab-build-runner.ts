#!/usr/bin/env bun
/** Private shipped child: one operating-system process per build. */
import { runBuildChild } from '../packages/core/src/processes/build-child'
import { BuildChildExitCoordinator } from '../packages/core/src/processes/build-child-exit'
import { watchBuildParent } from '../packages/core/src/processes/build-parent-watch'
import { BUILD_RUNNER_OPTIONS_ENV } from '../packages/core/src/ports/workspace/local-build-execution'
import type { BuildExecutionStart } from '../packages/core/src/ports/workspace/build-execution'

const raw = process.env[BUILD_RUNNER_OPTIONS_ENV]
let input: BuildExecutionStart | undefined
try {
  const parsed = raw === undefined ? undefined : (JSON.parse(raw) as Partial<BuildExecutionStart>)
  if (
    parsed !== undefined &&
    typeof parsed.slug === 'string' &&
    parsed.slug.length > 0 &&
    typeof parsed.storeRef === 'string' &&
    parsed.storeRef.length > 0 &&
    typeof parsed.instance === 'string' &&
    parsed.instance.length > 0 &&
    Number.isInteger(parsed.parentPid) &&
    parsed.parentPid! > 0
  ) {
    input = parsed as BuildExecutionStart
  }
} catch {
  // Invalid immutable launch envelope exits below.
}
if (input === undefined) process.exit(2)

// Every exit first transfers group teardown to an owner outside this session.
// The live kernel independently reaps the same group before releasing its
// lease; after abrupt kernel death, the detached owner finishes the job.
const terminal = new BuildChildExitCoordinator({ groupId: process.pid })
process.on('SIGINT', () => terminal.terminate(130))
process.on('SIGTERM', () => terminal.terminate(143))
terminal.setParentWatch(
  watchBuildParent(input.parentPid, () => {
    terminal.terminate(143)
  }),
)

let exitCode = 0
try {
  await runBuildChild(input, process.env)
} catch {
  exitCode = 1
}
terminal.terminate(exitCode)
