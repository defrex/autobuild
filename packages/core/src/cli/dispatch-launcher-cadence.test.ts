import { describe, expect, test } from 'bun:test'
import {
  PREPARATION_OBSERVATION_LIMIT,
  PREPARATION_OBSERVATION_MS,
  SUPERVISION_IDLE_MS,
  SUPERVISION_PENDING_MS,
  supervisionCadence,
  supervisionPause,
} from './dispatch-launcher-cadence'

describe('supervisionCadence', () => {
  test('keeps ordinary idle and pending cadence without a preparation', () => {
    const cadence = supervisionCadence()
    expect([cadence({}, false), cadence({}, false)]).toEqual([1_000, 1_000])
    expect(cadence({}, true)).toBe(250)
    expect([SUPERVISION_IDLE_MS, SUPERVISION_PENDING_MS]).toEqual([1_000, 250])
  })

  test('observes one preparation quickly for a finite count, then idles for good', () => {
    expect(PREPARATION_OBSERVATION_MS).toBeLessThanOrEqual(100)
    expect(Number.isSafeInteger(PREPARATION_OBSERVATION_LIMIT)).toBe(true)
    const cadence = supervisionCadence()
    // Pending supervision does not consume the preparation budget.
    expect(cadence({ preparing: 'a' }, true)).toBe(SUPERVISION_PENDING_MS)
    const delays = Array.from({ length: PREPARATION_OBSERVATION_LIMIT }, () =>
      cadence({ preparing: 'a' }, false),
    )
    expect(delays.every((delay) => delay === PREPARATION_OBSERVATION_MS)).toBe(true)
    expect(cadence({ preparing: 'a' }, false)).toBe(SUPERVISION_IDLE_MS)
    // The same stalled correlation reappearing does not restart the budget.
    expect(cadence({}, false)).toBe(SUPERVISION_IDLE_MS)
    expect(cadence({ preparing: 'a' }, false)).toBe(SUPERVISION_IDLE_MS)
    // A new detection does.
    expect(cadence({ preparing: 'b' }, false)).toBe(PREPARATION_OBSERVATION_MS)
    // Resolution (failure, completion) returns to idle at once.
    expect(cadence({}, false)).toBe(SUPERVISION_IDLE_MS)
  })
})

describe('supervisionPause', () => {
  function harness(aborted = false) {
    const timers: { callback: () => void; ms: number; cleared: boolean }[] = []
    const listeners = new Set<() => void>()
    let added = 0
    const signal = {
      aborted,
      addEventListener: (_: string, listener: () => void) => {
        added++
        listeners.add(listener)
      },
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
      abort() {
        signal.aborted = true
        for (const listener of [...listeners]) listener()
      },
    }
    const fake = {
      setTimeout: (callback: () => void, ms: number) => {
        const timer = { callback, ms, cleared: false }
        timers.push(timer)
        return timer
      },
      clearTimeout: (timer: unknown) => {
        if (timer) (timer as (typeof timers)[number]).cleared = true
      },
    }
    return { timers, listeners, signal, fake, added: () => added }
  }

  test('ends on the timer, a wakeup or a later abort, releasing both', async () => {
    const timed = harness()
    const pause = supervisionPause(50, [], timed.signal as never, timed.fake)
    expect(timed.timers[0]!.ms).toBe(50)
    timed.timers[0]!.callback()
    await pause
    expect(timed.timers[0]!.cleared).toBe(true)
    expect(timed.listeners.size).toBe(0)

    const woken = harness()
    await supervisionPause(1_000, [Promise.resolve()], woken.signal as never, woken.fake)
    expect(woken.timers[0]!.cleared).toBe(true)
    expect(woken.listeners.size).toBe(0)

    const stopped = harness()
    const stopping = supervisionPause(
      1_000,
      [new Promise(() => {})],
      stopped.signal as never,
      stopped.fake,
    )
    stopped.signal.abort()
    await stopping
    expect(stopped.timers[0]!.cleared).toBe(true)
    expect(stopped.listeners.size).toBe(0)
  })

  test('returns at once for an already aborted signal', async () => {
    const aborted = harness(true)
    await supervisionPause(1_000, [new Promise(() => {})], aborted.signal as never, aborted.fake)
    expect(aborted.timers).toHaveLength(0)
    expect(aborted.added()).toBe(0)
  })
})
