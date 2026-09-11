#!/usr/bin/env bun
/** Private shipped child: one disposable environment per hosted harvest run.
 * The environment owns teardown (no process-group reaper, no parent watchdog)
 * — the same contract as the build child's `environment` branch. */
import { runHarvestChild } from '../packages/core/src/processes/harvest-child'
import {
  HARVEST_RUNNER_OPTIONS_ENV,
  parseHarvestRunnerLaunch,
  type HarvestRunnerLaunch,
} from '../packages/core/src/ports/workspace/harvest-execution'

const raw = process.env[HARVEST_RUNNER_OPTIONS_ENV]
let input: HarvestRunnerLaunch | undefined
try {
  input = parseHarvestRunnerLaunch(raw === undefined ? undefined : JSON.parse(raw))
} catch {
  // Invalid immutable launch envelope exits below.
}
if (input === undefined) process.exit(2)

let exitCode = 0
try {
  await runHarvestChild(input, process.env)
} catch {
  // The durable outcome lives in the repository journal; the guest exit code
  // is liveness evidence only.
  exitCode = 1
}
process.exit(exitCode)
