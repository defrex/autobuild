import type { TerminalOut } from './terminal'
import { installTerminalRestoreHook, type TerminalRestoreProcess } from './terminal-restore'
/** Upgrade (including its `update` alias) owns Ctrl-C only while raw per-file
 * progress is active. Everywhere else its process must retain Node's ordinary
 * immediate SIGINT termination. */
export function usesGenericSessionlessSigintHandler(command: string | undefined): boolean {
  return command !== 'upgrade' && command !== 'update'
}

export interface SessionlessSigintBoundary {
  on(event: 'SIGINT', listener: () => void): unknown
  once(event: 'SIGINT', listener: () => void): unknown
  removeListener(event: 'SIGINT', listener: () => void): unknown
}

/** Dispatch and watch keep their listeners through shutdown cleanup; ordinary
 * sessionless commands preserve the historical one-shot cancellation. */
export function installSessionlessSigintHandler(
  command: string | undefined,
  onSigint: () => void,
  boundary: SessionlessSigintBoundary = process,
): () => void {
  if (!usesGenericSessionlessSigintHandler(command)) return () => {}
  if (command === 'dispatch' || command === 'watch') boundary.on('SIGINT', onSigint)
  else boundary.once('SIGINT', onSigint)
  return () => boundary.removeListener('SIGINT', onSigint)
}

/** Install the dispatch-only process fallback around the exact CLI lifetime. */
export async function withDispatchTerminalRestore<T>(
  command: string | undefined,
  terminal: TerminalOut,
  run: () => Promise<T>,
  boundary: TerminalRestoreProcess = process as unknown as TerminalRestoreProcess,
  requestStop: (signal: NodeJS.Signals) => void = () => {},
): Promise<T> {
  const hook =
    command === 'dispatch'
      ? installTerminalRestoreHook(terminal.modes, boundary, requestStop)
      : undefined
  try {
    return await run()
  } finally {
    hook?.close()
  }
}

/** Watch alone catches termination long enough to withdraw advisory presence.
 * SIGTERM/HUP are re-raised after cleanup to retain the shell's signal outcome. */
export function installWatchTermination(controller: AbortController): {
  close: () => void
  write: (line: string) => void
  flush: () => Promise<void>
  complete: (code: number) => Promise<number>
} {
  const pending = new Set<Promise<void>>()
  let broken = false
  let signal: 'SIGTERM' | 'SIGHUP' | undefined
  const stop = (value: 'SIGTERM' | 'SIGHUP'): void => {
    signal ??= value
    controller.abort(value)
  }
  const term = (): void => stop('SIGTERM')
  const hup = (): void => stop('SIGHUP')
  const pipe = (error: NodeJS.ErrnoException): void => {
    if (error.code !== 'EPIPE') throw error
    broken = true
    controller.abort('EPIPE')
  }
  process.on('SIGTERM', term)
  process.on('SIGHUP', hup)
  process.stdout.on('error', pipe)
  const close = (): void => {
    process.removeListener('SIGTERM', term)
    process.removeListener('SIGHUP', hup)
    process.stdout.removeListener('error', pipe)
  }
  return {
    close,
    write(line) {
      if (broken || signal !== undefined) return
      const written = new Promise<void>((resolve) => {
        try {
          process.stdout.write(`${line}\n`, (error) => {
            if (error) pipe(error)
            resolve()
          })
        } catch (error) {
          pipe(error as NodeJS.ErrnoException)
          resolve()
        }
      })
      pending.add(written)
      void written.then(() => pending.delete(written))
    },
    async flush() {
      await Promise.all(pending)
    },
    async complete(code) {
      close()
      if (signal) {
        process.kill(process.pid, signal)
        // Wait for default signal delivery before the entry point can exit.
        await new Promise<never>(() => {})
      }
      return broken ? 1 : code
    },
  }
}
