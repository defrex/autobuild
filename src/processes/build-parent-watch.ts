/** Parent-liveness watchdog for a local build child. The child deliberately
 * terminates without releasing its lease; ordinary expiry is the durable
 * recovery mechanism after an abrupt kernel death. */
export function watchBuildParent(
  parentPid: number,
  onDeath: () => never | void,
  intervalMs = 500,
): { close(): void } {
  let closed = false
  const check = (): void => {
    if (closed) return
    if (process.ppid !== parentPid || process.ppid === 1) {
      closed = true
      onDeath()
      return
    }
    try {
      process.kill(parentPid, 0)
    } catch {
      closed = true
      onDeath()
    }
  }
  const timer = setInterval(check, intervalMs)
  timer.unref()
  return {
    close() {
      if (closed) return
      closed = true
      clearInterval(timer)
    },
  }
}
