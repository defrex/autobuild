#!/usr/bin/env bun
/** Private shipped child: one operating-system process per build. */
import { runBuildChild } from '../src/processes/build-child'
import { BUILD_RUNNER_OPTIONS_ENV } from '../src/ports/workspace/local-build-execution'
import type { BuildExecutionStart } from '../src/ports/workspace/build-execution'

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
    parsed.instance.length > 0
  ) {
    input = parsed as BuildExecutionStart
  }
} catch {
  // Invalid immutable launch envelope exits below.
}
if (input === undefined) process.exit(2)

// A build child must not outlive an abruptly dead local kernel. Stopping is
// intentionally abrupt: no synthetic pipeline outcome or lease release is
// manufactured; ordinary lease expiry drives recovery.
const stop = (code: number): never => process.exit(code)
process.on('SIGINT', () => stop(130))
process.on('SIGTERM', () => stop(143))
const parent = process.ppid
const parentWatch = setInterval(() => {
  if (process.ppid !== parent || process.ppid === 1) stop(143)
  try {
    process.kill(parent, 0)
  } catch {
    stop(143)
  }
}, 500)
parentWatch.unref()

let exitCode = 0
try {
  await runBuildChild(input, process.env)
} catch {
  exitCode = 1
} finally {
  clearInterval(parentWatch)
}
process.exit(exitCode)
