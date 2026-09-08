#!/usr/bin/env bun
/** Private shipped child: one operating-system process per build. */
import { runBuildChild } from '../packages/core/src/processes/build-child'
import { BuildChildExitCoordinator } from '../packages/core/src/processes/build-child-exit'
import { watchBuildParent } from '../packages/core/src/processes/build-parent-watch'
import { BUILD_RUNNER_OPTIONS_ENV } from '../packages/core/src/ports/workspace/local-build-execution'
import {
  parseBuildChildLaunch,
  type BuildChildLaunch,
} from '../packages/core/src/ports/workspace/build-execution'

const raw = process.env[BUILD_RUNNER_OPTIONS_ENV]
let input: BuildChildLaunch | undefined
try {
  input = parseBuildChildLaunch(raw === undefined ? undefined : JSON.parse(raw))
} catch {
  // Invalid immutable launch envelope exits below.
}
if (input === undefined) process.exit(2)

let exitCode = 0
if (input.supervision.kind === 'local-parent') {
  // Every local exit first transfers group teardown to an owner outside this
  // session. Environment-owned execution deliberately installs neither this
  // group reaper nor a meaningless host-PID watchdog.
  const terminal = new BuildChildExitCoordinator({ groupId: process.pid })
  process.on('SIGINT', () => terminal.terminate(130))
  process.on('SIGTERM', () => terminal.terminate(143))
  terminal.setParentWatch(
    watchBuildParent(input.supervision.parentPid, () => terminal.terminate(143)),
  )
  try {
    await runBuildChild(input, process.env)
  } catch {
    exitCode = 1
  }
  terminal.terminate(exitCode)
} else {
  // Vercel owns teardown of the complete VM session. Addressing a POSIX group
  // here could leave the SDK believing a still-running environment completed.
  try {
    await runBuildChild(input, process.env)
  } catch {
    exitCode = 1
  }
  process.exit(exitCode)
}
