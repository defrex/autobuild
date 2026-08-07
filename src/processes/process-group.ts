export const DEFAULT_PROCESS_GROUP_STOP_TIMEOUT_MS = 5_000

function validateGroupId(groupId: number): void {
  if (!Number.isSafeInteger(groupId) || groupId <= 0) {
    throw new Error(`invalid process group id ${JSON.stringify(groupId)}`)
  }
}

function isGone(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH'
}

/** Probe a POSIX process group without ever falling back to its leader PID. */
export function processGroupAlive(groupId: number): boolean {
  validateGroupId(groupId)
  try {
    process.kill(-groupId, 0)
    return true
  } catch (error) {
    if (isGone(error)) return false
    throw error
  }
}

/** Signal a complete POSIX process group. An already-gone group is success. */
export function signalProcessGroup(groupId: number, signal: NodeJS.Signals): boolean {
  validateGroupId(groupId)
  try {
    process.kill(-groupId, signal)
    return true
  } catch (error) {
    if (isGone(error)) return false
    throw error
  }
}

async function waitForGroupExit(groupId: number, deadline: number): Promise<boolean> {
  while (processGroupAlive(groupId)) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    await Bun.sleep(Math.min(10, remaining))
  }
  return true
}

/**
 * Gracefully stop a complete local execution group, then force the same group
 * after the bounded stop delay. The force path waits until no member remains;
 * callers may therefore use resolution as the workspace-teardown boundary.
 */
export async function terminateProcessGroup(
  groupId: number,
  stopTimeoutMs = DEFAULT_PROCESS_GROUP_STOP_TIMEOUT_MS,
): Promise<void> {
  validateGroupId(groupId)
  if (!Number.isFinite(stopTimeoutMs) || stopTimeoutMs < 0) {
    throw new Error(`invalid process-group stop timeout ${JSON.stringify(stopTimeoutMs)}`)
  }
  if (!signalProcessGroup(groupId, 'SIGTERM')) return

  if (await waitForGroupExit(groupId, Date.now() + stopTimeoutMs)) return
  if (!signalProcessGroup(groupId, 'SIGKILL')) return

  while (processGroupAlive(groupId)) await Bun.sleep(10)
}
