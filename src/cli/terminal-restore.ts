/**
 * Terminal modes owned by the interactive dispatch dashboard. A declaration is
 * the single source for both its ordinary enter/leave writes and the
 * process-boundary emergency restore.
 */
export interface TerminalMode {
  readonly name: string
  readonly enter: string
  readonly restore: string
  /** Lower values restore first when the process boundary unwinds all modes. */
  readonly restoreOrder: number
}

export const ALTERNATE_SCREEN_MODE = {
  name: 'alternate-screen',
  enter: '\x1b[?1049h',
  restore: '\x1b[?1049l',
  restoreOrder: 30,
} as const satisfies TerminalMode

export const HIDDEN_CURSOR_MODE = {
  name: 'hidden-cursor',
  enter: '\x1b[?25l',
  restore: '\x1b[?25h',
  restoreOrder: 40,
} as const satisfies TerminalMode

export const BRACKETED_PASTE_MODE = {
  name: 'bracketed-paste',
  enter: '\x1b[?2004h',
  restore: '\x1b[?2004l',
  restoreOrder: 20,
} as const satisfies TerminalMode

export const KITTY_KEYBOARD_FLAGS = 0b1_1101

export const KITTY_KEYBOARD_MODE = {
  name: 'kitty-keyboard-flags',
  enter: `\x1b[>${KITTY_KEYBOARD_FLAGS}u`,
  restore: '\x1b[<1u',
  restoreOrder: 10,
} as const satisfies TerminalMode

export interface TerminalModeController {
  /** Arm before writing the enter sequence. Re-entering an active mode is inert. */
  enter(mode: TerminalMode): void
  /** Write the ordinary restore sequence, then disarm. */
  leave(mode: TerminalMode): void
  /** Synchronously and best-effort restore every active mode. */
  restoreAll(): void
  isActive(mode: TerminalMode): boolean
  readonly activeModes: readonly TerminalMode[]
}

/**
 * Keep the currently active terminal modes at the output seam.
 *
 * Enter arms before its write and leave disarms only after a successful write.
 * A failed normal write therefore remains visible to the synchronous emergency
 * path. Emergency restoration attempts every mode even if one write fails.
 */
export function createTerminalModeController(
  write: (chunk: string) => void,
  emergencyWrite: (chunk: string) => void = write,
): TerminalModeController {
  const active = new Map<TerminalMode, number>()
  let activation = 0

  return {
    enter(mode): void {
      if (active.has(mode)) return
      active.set(mode, activation++)
      write(mode.enter)
    },
    leave(mode): void {
      if (!active.has(mode)) return
      write(mode.restore)
      active.delete(mode)
    },
    restoreAll(): void {
      const modes = [...active.entries()].sort(
        ([left, leftActivation], [right, rightActivation]) =>
          left.restoreOrder - right.restoreOrder || leftActivation - rightActivation,
      )
      for (const [mode] of modes) {
        try {
          emergencyWrite(mode.restore)
          active.delete(mode)
        } catch {
          // Best effort means one broken write cannot prevent the remaining
          // independent modes from being restored. The failed mode stays armed
          // so a later exit boundary may retry it.
        }
      }
    },
    isActive: (mode): boolean => active.has(mode),
    get activeModes(): readonly TerminalMode[] {
      return [...active.keys()]
    },
  }
}

export const TERMINATING_SIGNALS = [
  'SIGHUP',
  'SIGQUIT',
  'SIGTERM',
] as const satisfies readonly NodeJS.Signals[]

export interface TerminalRestoreProcess {
  readonly pid: number
  on(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown
  kill(pid: number, signal: NodeJS.Signals): unknown
}

export interface TerminalRestoreHook {
  /** Restore active modes, then remove only this hook's listeners. Idempotent. */
  close(): void
}

/**
 * Install the synchronous process-boundary fallback used only by `ab dispatch`.
 * SIGINT is deliberately absent: raw Ctrl-C and the binary's AbortController
 * must retain the dashboard's normal final-frame teardown.
 */
export function installTerminalRestoreHook(
  modes: TerminalModeController,
  boundary: TerminalRestoreProcess = process as unknown as TerminalRestoreProcess,
): TerminalRestoreHook {
  let closed = false
  const registrations: Array<[string, (...args: unknown[]) => void]> = []

  const restore = (): void => {
    modes.restoreAll()
  }
  const remove = (): void => {
    if (closed) return
    closed = true
    for (const [event, listener] of registrations) boundary.removeListener(event, listener)
  }
  const add = (event: string, listener: (...args: unknown[]) => void): void => {
    registrations.push([event, listener])
    boundary.on(event, listener)
  }

  // `uncaughtExceptionMonitor` observes an uncaught fault without changing
  // Node's default crash behavior. `exit` is the final synchronous fallback.
  add('uncaughtExceptionMonitor', restore)
  add('exit', restore)
  for (const signal of TERMINATING_SIGNALS) {
    add(signal, () => {
      restore()
      // Re-signal only after our own handlers are gone, preserving the
      // operating system's ordinary terminating-signal semantics.
      remove()
      boundary.kill(boundary.pid, signal)
    })
  }

  return {
    close(): void {
      if (closed) return
      // Closing after runCli returns also catches an unexpectedly active ledger
      // without depending on another promise turn or stream drain.
      restore()
      remove()
    },
  }
}
