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
// Guest tolerance (AUT-517): an environment-supervised build child is
// structurally a guest — it never constructs workspace providers — so a
// configured provider plugin it cannot resolve is skipped with a notice
// instead of failing the build. A local-parent child runs on the host with
// the repository's full dependency tree, so it stays strict.
const guest = input.supervision.kind === 'environment'
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
    await runBuildChild(input, process.env, undefined, { guest })
  } catch {
    exitCode = 1
  }
  terminal.terminate(exitCode)
} else {
  // Vercel owns teardown of the complete VM session. Addressing a POSIX group
  // here could leave the SDK believing a still-running environment completed.
  try {
    await runBuildChild(input, process.env, undefined, { guest })
  } catch {
    exitCode = 1
  }
  process.exit(exitCode)
}
