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

/** Dispatch keeps its listener through the complete child drain; ordinary
 * sessionless commands preserve the historical one-shot cancellation. */
export function installSessionlessSigintHandler(
  command: string | undefined,
  onSigint: () => void,
  boundary: SessionlessSigintBoundary = process,
): () => void {
  if (!usesGenericSessionlessSigintHandler(command)) return () => {}
  if (command === 'dispatch') boundary.on('SIGINT', onSigint)
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
