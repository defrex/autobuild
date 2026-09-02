import type { TerminalInput, TerminalOut } from './terminal'
import {
  UpgradeResolutionCancelledError,
  type ResolveConflict,
  type ResolveConflictOptions,
} from './upgrade'

const SPINNER = ['|', '/', '-', '\\'] as const
const DEFAULT_REFRESH_MS = 250
const CLEAR_LINE = '\r\u001b[2K'

/** Keep every repaint on one physical terminal row. */
function fitToColumns(frame: string, columns: number): string {
  const width = Math.max(0, Math.floor(columns))
  if (frame.length <= width) return frame
  if (width === 0) return ''
  if (width === 1) return '~'
  return `${frame.slice(0, width - 1)}~`
}

export interface UpgradeProgressOptions {
  terminal: TerminalOut
  input: TerminalInput
  /** Deterministic time/scheduling seams for the renderer tests. */
  now?: () => number
  refreshMs?: number
  schedule?: (callback: () => void, milliseconds: number) => unknown
  cancelSchedule?: (timer: unknown) => void
}

/**
 * Decorate one per-file upgrade resolver with an interactive-only live line.
 * Plain output never enters the progress path, preserving piped stdout bytes.
 */
export function withUpgradeProgress(
  resolve: ResolveConflict,
  options: UpgradeProgressOptions,
): ResolveConflict {
  if (!options.terminal.interactive) return resolve

  return async (conflict, callOptions?: ResolveConflictOptions) => {
    const now = options.now ?? Date.now
    const schedule =
      options.schedule ?? ((callback, milliseconds) => setInterval(callback, milliseconds))
    const cancelSchedule =
      options.cancelSchedule ?? ((timer) => clearInterval(timer as NodeJS.Timeout))
    const startedAt = now()
    const controller = new AbortController()
    let frame = 0
    let cleaned = false
    let cancelled = false
    let rejectCancellation!: (error: Error) => void
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject
    })

    const cancel = (): void => {
      if (cancelled) return
      cancelled = true
      controller.abort()
      rejectCancellation(new UpgradeResolutionCancelledError())
    }
    const onCallerCancel = (): void => cancel()
    if (callOptions?.signal !== undefined) {
      callOptions.signal.addEventListener('abort', onCallerCancel, { once: true })
      if (callOptions.signal.aborted) cancel()
    }

    const paint = (): void => {
      const elapsed = Math.max(0, Math.floor((now() - startedAt) / 1_000))
      const spinner = SPINNER[frame % SPINNER.length]
      frame += 1
      const status =
        `${spinner} Resolving ${conflict.skill}/${conflict.path} — ` +
        `elapsed ${elapsed}s — Ctrl-C to cancel`
      options.terminal.write(`${CLEAR_LINE}${fitToColumns(status, options.terminal.columns)}`)
    }

    let timer: unknown
    let stopInput = (): void => {}
    const cleanup = (): void => {
      if (cleaned) return
      cleaned = true
      try {
        if (timer !== undefined) cancelSchedule(timer)
      } finally {
        try {
          stopInput()
        } finally {
          callOptions?.signal?.removeEventListener('abort', onCallerCancel)
          options.terminal.write(CLEAR_LINE)
        }
      }
    }

    try {
      paint()
      timer = schedule(paint, Math.min(1_000, Math.max(1, options.refreshMs ?? DEFAULT_REFRESH_MS)))
      stopInput = options.input.start((event) => {
        if (event.type === 'interrupt') cancel()
      })
      if (cancelled) return await cancellation
      // The race is deliberate: even an injected or defective resolver that
      // ignores its signal cannot return a proposal after the human cancels.
      return await Promise.race([resolve(conflict, { signal: controller.signal }), cancellation])
    } finally {
      cleanup()
    }
  }
}
