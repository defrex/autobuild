/**
 * Launcher supervision pacing. The launcher observes durable upgrade state
 * through runtime-owned readers between pauses; this module only decides how
 * long each pause lasts and how it ends. It has no imports, so it keeps the
 * launcher's filesystem/process-only import graph.
 */

/** Ordinary supervision while no successor is pending. */
export const SUPERVISION_IDLE_MS = 1_000
/** Supervision while a successor preflight is pending. */
export const SUPERVISION_PENDING_MS = 250
/** Temporary cadence while the active run's detected upgrade is unresolved. */
export const PREPARATION_OBSERVATION_MS = 50
/** Fast observations allowed per detection correlation before idle cadence. */
export const PREPARATION_OBSERVATION_LIMIT = 600

/**
 * Returns the delay before the next observation. A durably detected,
 * unresolved preparation (`preparing`, an advisory reader field) earns at most
 * `PREPARATION_OBSERVATION_LIMIT` fast observations per correlation. The
 * budget resets only when a different correlation appears, so a stalled
 * preparation returns to the idle cadence for good. Readers that omit the
 * field keep the ordinary cadence.
 */
export function supervisionCadence() {
  let correlation: string | undefined
  let observed = 0
  return (projection: { preparing?: string }, pending: boolean): number => {
    if (pending) return SUPERVISION_PENDING_MS
    const preparing = projection.preparing
    if (typeof preparing !== 'string') return SUPERVISION_IDLE_MS
    if (preparing !== correlation) {
      correlation = preparing
      observed = 0
    }
    if (observed >= PREPARATION_OBSERVATION_LIMIT) return SUPERVISION_IDLE_MS
    observed++
    return PREPARATION_OBSERVATION_MS
  }
}

interface PauseTimers {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(timer: unknown): void
}
const realTimers: PauseTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}

/**
 * Waits `delay` ms, or until any wakeup settles, or until `signal` aborts
 * (immediately when it already has). The timer and abort listener are always
 * released.
 */
export async function supervisionPause(
  delay: number,
  wakeups: Promise<unknown>[],
  signal: Pick<AbortSignal, 'aborted' | 'addEventListener' | 'removeEventListener'>,
  timers: PauseTimers = realTimers,
): Promise<void> {
  if (signal.aborted) return
  let timer: unknown
  let onAbort: (() => void) | undefined
  try {
    await Promise.race([
      new Promise<void>((resolve) => {
        timer = timers.setTimeout(resolve, delay)
      }),
      new Promise<void>((resolve) => {
        onAbort = resolve
        signal.addEventListener('abort', onAbort)
      }),
      ...wakeups,
    ])
  } finally {
    timers.clearTimeout(timer)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}
