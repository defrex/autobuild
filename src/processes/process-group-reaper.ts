import { resolve } from 'node:path'
import { DEFAULT_PROCESS_GROUP_STOP_TIMEOUT_MS } from './process-group'

export const PROCESS_GROUP_REAPER_OPTIONS_ENV = 'AB_PROCESS_GROUP_REAPER_OPTIONS'

export interface ProcessGroupReaperOptions {
  groupId: number
  stopTimeoutMs: number
}

export function processGroupReaperOptions(groupId: number): ProcessGroupReaperOptions {
  return { groupId, stopTimeoutMs: DEFAULT_PROCESS_GROUP_STOP_TIMEOUT_MS }
}

/** Start an owner outside the dying build's session so group-wide SIGKILL
 * cannot kill the process responsible for escalating to it. */
export function launchProcessGroupReaper(
  options: ProcessGroupReaperOptions,
  spawn: typeof Bun.spawn = Bun.spawn,
): void {
  const child = spawn(
    [process.execPath, resolve(import.meta.dir, '../../bin/ab-process-group-reaper.ts')],
    {
      env: {
        ...process.env,
        [PROCESS_GROUP_REAPER_OPTIONS_ENV]: JSON.stringify(options),
      },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      detached: true,
    },
  )
  child.unref()
}
