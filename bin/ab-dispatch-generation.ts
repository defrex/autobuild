#!/usr/bin/env bun
import { ownsDispatchPresentation } from '../packages/core/src/cli/dispatch-presentation-ownership'
import { cachedRuntime } from '../packages/core/src/cli/dispatch-runtime-cache'
import { distributionRoot } from '../packages/core/src/distribution'
import {
  consumeGenerationMarker,
  consumeUpgradeCondition,
  DISPATCH_CONDITIONAL_ENV,
  GENERATION_EXITS,
  DISPATCH_LAUNCH_CONTEXT_ENV,
} from '../packages/core/src/cli/dispatch-launch-contract'
import { watchDispatchParent } from '../packages/core/src/cli/dispatch-parent-watch'
let code: number = GENERATION_EXITS.failed
const readerMode = process.argv[2]?.startsWith('--read-') ?? false
let presentationOwner = process.argv[2] !== '--preflight'
try {
  const condition =
    process.argv[2] === '--read-upgrade' ? consumeUpgradeCondition(process.env) : undefined
  delete process.env[DISPATCH_CONDITIONAL_ENV]
  const launch = consumeGenerationMarker(process.env, distributionRoot())
  if (!(await cachedRuntime(launch.runtimeRoot)))
    throw new Error('dispatcher generation requires a completed cached runtime')
  const { loadDotEnv } = await import('../packages/core/src/cli/dotenv')
  const { join } = await import('node:path')
  loadDotEnv(join(launch.checkout, '.env'), process.env)
  delete process.env[DISPATCH_CONDITIONAL_ENV]
  const { readHandoff } = await import('../packages/core/src/cli/dispatch-handoff')
  if (process.argv[2] === '--read-journal') {
    const { readGenerationJournal } = await import('../packages/core/src/cli/dispatch-handoff')
    console.log(
      JSON.stringify(await readGenerationJournal(launch, process.argv.slice(3), process.env)),
    )
    process.exit(0)
  }
  if (process.argv[2] === '--recover-terminal-release') {
    const { recoverTerminalRelease } = await import('../packages/core/src/cli/dispatch-handoff')
    await recoverTerminalRelease(launch, process.argv.slice(3), process.env)
    process.exit(0)
  }
  if (process.argv[2] === '--read-upgrade') {
    const { readUpgradeProjection } = await import('../packages/core/src/cli/dispatch-handoff')
    console.log(
      JSON.stringify(
        await readUpgradeProjection(launch, process.argv.slice(3), process.env, { condition }),
      ),
    )
    process.exit(0)
  }
  if (process.argv[2] === '--record-preflight-failure') {
    const { recordPreflightFailure } = await import('../packages/core/src/cli/dispatch-handoff')
    await recordPreflightFailure(
      launch,
      process.argv.slice(5),
      process.env,
      process.argv[3]!,
      process.argv[4]!,
    )
    process.exit(0)
  }
  if (process.argv[2] === '--read-handoff') {
    const handoff = await readHandoff(launch, process.argv.slice(3), process.env)
    console.log(JSON.stringify({ version: 1, handoff: handoff ?? null }))
    process.exit(0)
  }
  if (process.argv[2] === '--preflight') {
    if (launch.overlapVersion !== 1) throw new Error('launcher has no overlap capability')
    const { preflightGeneration } = await import('../packages/core/src/cli/dispatch-preflight')
    const abort = new AbortController()
    const stop = () => abort.abort()
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const)
      process.on(signal, stop)
    try {
      if (!(await preflightGeneration(launch, process.argv.slice(3), process.env, abort.signal)))
        process.exit(GENERATION_EXITS.failed)
      presentationOwner = true
      process.argv.splice(2, 1)
    } finally {
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const)
        process.removeListener(signal, stop)
    }
  }
  process.env[DISPATCH_LAUNCH_CONTEXT_ENV] = JSON.stringify(launch)
  const watch = watchDispatchParent(launch.launcherPid ?? process.ppid, () =>
    process.kill(process.pid, 'SIGINT'),
  )
  try {
    const { runDirectBinary } = await import('../packages/core/src/cli/binary-direct')
    const result = await runDirectBinary(process.argv.slice(2))
    code =
      result === 0
        ? (await readHandoff(launch, process.argv.slice(2), process.env))
          ? GENERATION_EXITS.handoff
          : GENERATION_EXITS.stopped
        : result
  } finally {
    watch.close()
  }
} catch (error) {
  if (readerMode || (presentationOwner && ownsDispatchPresentation()))
    console.error(error instanceof Error ? error.message : String(error))
}
process.exit(code)
