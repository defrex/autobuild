/**
 * Process-group termination for operator-sandbox commands (#1223). The local
 * providers spawn setup and detached commands with `detached: true`
 * (`setsid`), so each one leads its own process group, and stopping it means
 * stopping every member, not only the leader shell. Escalation is tied to the
 * group's liveness (`kill(-pgid, 0)`), never to the leader's exit: a shell
 * that dies on SIGTERM while a child ignores it still leaves a live group,
 * and that child gets SIGKILL. A member that calls `setsid` itself leaves the
 * group and is out of reach.
 */

/** Whether any member of the process group is still alive. */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal)
  } catch {
    /* already gone */
  }
}

async function waitGone(pgid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (groupAlive(pgid)) {
    if (Date.now() >= deadline) return false
    await Bun.sleep(25)
  }
  return true
}

/** SIGTERM the group, SIGKILL whatever is left after `graceMs`, and resolve
 * `true` once no member remains (`false` if one survives even SIGKILL for
 * `graceMs`, e.g. a process stuck in uninterruptible sleep). */
export async function terminateProcessGroup(pgid: number, graceMs = 2_000): Promise<boolean> {
  if (!groupAlive(pgid)) return true
  signalGroup(pgid, 'SIGTERM')
  if (await waitGone(pgid, graceMs)) return true
  signalGroup(pgid, 'SIGKILL')
  return waitGone(pgid, graceMs)
}
