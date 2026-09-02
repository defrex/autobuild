#!/usr/bin/env bun
/** Private shipped helper: reap one abandoned local build process group. */
import { terminateProcessGroup } from '../packages/core/src/processes/process-group'
import {
  PROCESS_GROUP_REAPER_OPTIONS_ENV,
  type ProcessGroupReaperOptions,
} from '../packages/core/src/processes/process-group-reaper'

const raw = process.env[PROCESS_GROUP_REAPER_OPTIONS_ENV]
let options: ProcessGroupReaperOptions | undefined
try {
  const parsed =
    raw === undefined ? undefined : (JSON.parse(raw) as Partial<ProcessGroupReaperOptions>)
  if (
    parsed !== undefined &&
    Number.isSafeInteger(parsed.groupId) &&
    parsed.groupId! > 0 &&
    Number.isFinite(parsed.stopTimeoutMs) &&
    parsed.stopTimeoutMs! >= 0
  ) {
    options = parsed as ProcessGroupReaperOptions
  }
} catch {
  // Invalid immutable launch envelope exits below.
}
if (options === undefined) process.exit(2)

try {
  await terminateProcessGroup(options.groupId, options.stopTimeoutMs)
} catch {
  process.exit(1)
}
