#!/usr/bin/env bun
import { cachedRuntime } from '../packages/core/src/cli/dispatch-runtime-cache'
import { distributionRoot } from '../packages/core/src/distribution'
import {
  consumeGenerationMarker,
  GENERATION_EXITS,
} from '../packages/core/src/cli/dispatch-launch-contract'
import { watchDispatchParent } from '../packages/core/src/cli/dispatch-parent-watch'
let code: number = GENERATION_EXITS.failed
try {
  const launch = consumeGenerationMarker(process.env, distributionRoot())
  if (!(await cachedRuntime(launch.runtimeRoot)))
    throw new Error('dispatcher generation requires a completed cached runtime')
  const watch = watchDispatchParent(process.ppid, () => process.kill(process.pid, 'SIGINT'))
  try {
    const { runDirectBinary } = await import('../packages/core/src/cli/binary-direct')
    const result = await runDirectBinary(process.argv.slice(2))
    code = result === 0 ? GENERATION_EXITS.stopped : result
  } finally {
    watch.close()
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
}
process.exit(code)
