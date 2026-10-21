export interface DispatchProcessHook {
  close(): void
}
export interface DispatchParentWatchDeps {
  intervalMs?: number
  currentParentPid?: () => number
  isAlive?: (pid: number) => boolean
}

/** A private kernel must never become a detached daemon if its terminal-owning
 * parent is killed directly rather than through the foreground process group.
 * Polling is deliberately local process liveness, not an operational IPC
 * channel; shutdown still converges through the normal AbortSignal boundary. */
export function watchDispatchParent(
  parentPid: number,
  onParentExit: () => void,
  deps: DispatchParentWatchDeps = {},
): DispatchProcessHook {
  const currentParentPid = deps.currentParentPid ?? (() => process.ppid)
  const isAlive =
    deps.isAlive ??
    ((pid: number): boolean => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    })
  let closed = false
  let timer: ReturnType<typeof setInterval>
  const close = (): void => {
    if (closed) return
    closed = true
    clearInterval(timer)
  }
  timer = setInterval(() => {
    if (currentParentPid() === parentPid && isAlive(parentPid)) return
    close()
    onParentExit()
  }, deps.intervalMs ?? 100)
  timer.unref?.()
  return { close }
}
