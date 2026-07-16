/**
 * Deterministic test doubles shared across the suite. Production code never
 * imports from `src/testing/`.
 */
import type { Clock } from '../store/types'

/**
 * A clock that starts at `start` and advances `stepMs` per call — so every
 * store-assigned `ts` in a test is distinct and predictable.
 */
export function steppingClock(
  start = '2026-07-15T12:00:00.000Z',
  stepMs = 1000,
): Clock & { advance(ms: number): void } {
  let now = new Date(start).getTime()
  const clock = (() => {
    const current = new Date(now)
    now += stepMs
    return current
  }) as Clock & { advance(ms: number): void }
  clock.advance = (ms: number) => {
    now += ms
  }
  return clock
}

/** A clock frozen at `at` until manually advanced. */
export function manualClock(at = '2026-07-15T12:00:00.000Z'): Clock & {
  advance(ms: number): void
  set(iso: string): void
} {
  let now = new Date(at).getTime()
  const clock = (() => new Date(now)) as Clock & {
    advance(ms: number): void
    set(iso: string): void
  }
  clock.advance = (ms: number) => {
    now += ms
  }
  clock.set = (iso: string) => {
    now = new Date(iso).getTime()
  }
  return clock
}
