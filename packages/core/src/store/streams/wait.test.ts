/**
 * Deterministic abort semantics of the shared wait loops (AUT-380): an
 * aborted hold resolves promptly with its current result and issues no
 * further polls after the signal. All aborts are explicit AbortController
 * aborts — no timing-flaky disconnect simulation.
 */
import { describe, expect, test } from 'bun:test'
import { readEventsWithWait, readStreamWithWait } from './wait'

describe('abort on the shared wait loops (AUT-380)', () => {
  const WAIT_SECONDS = 10
  const POLL_MS = 10

  function countingRead<T>(initial: () => T): { read: () => Promise<T>; count: () => number } {
    let calls = 0
    return {
      read: async () => {
        calls++
        return initial()
      },
      count: () => calls,
    }
  }

  describe('readEventsWithWait', () => {
    test('abort mid-hold resolves promptly and issues no further polls', async () => {
      const { read, count } = countingRead<string[]>(() => [])
      const controller = new AbortController()
      const pending = readEventsWithWait({
        read,
        waitSeconds: WAIT_SECONDS,
        pollMs: POLL_MS,
        signal: controller.signal,
      })
      // Let the hold establish: the initial read plus at least one poll.
      await Bun.sleep(50)
      const countAtAbort = count()
      expect(countAtAbort).toBeGreaterThanOrEqual(2)
      const started = Date.now()
      controller.abort()
      expect(await pending).toEqual([])
      expect(Date.now() - started).toBeLessThan(500)
      // No further polls after the signal: the count is frozen across a
      // later sample (observed on `read`, not timed against the bound).
      await Bun.sleep(100)
      expect(count()).toBe(countAtAbort)
    })

    test('a pre-aborted signal performs the initial read only', async () => {
      const { read, count } = countingRead<string[]>(() => [])
      const controller = new AbortController()
      controller.abort()
      const started = Date.now()
      expect(
        await readEventsWithWait({
          read,
          waitSeconds: WAIT_SECONDS,
          pollMs: POLL_MS,
          signal: controller.signal,
        }),
      ).toEqual([])
      expect(Date.now() - started).toBeLessThan(500)
      expect(count()).toBe(1)
    })

    test('no signal: unchanged behavior — quiet read honors the bound, an arriving item wakes early', async () => {
      const { read, count } = countingRead<string[]>(() => [])
      const started = Date.now()
      expect(await readEventsWithWait({ read, waitSeconds: 1, pollMs: POLL_MS })).toEqual([])
      expect(Date.now() - started).toBeGreaterThanOrEqual(950)
      const callsAtBound = count()

      let item: string[] = []
      const waking = countingRead<string[]>(() => item)
      setTimeout(() => {
        item = ['wake']
      }, 100)
      expect(await readEventsWithWait({ read: waking.read, waitSeconds: 5, pollMs: POLL_MS })).toBe(
        item,
      )
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(waking.count()).toBeLessThan(callsAtBound)
    })
  })

  describe('readStreamWithWait', () => {
    const emptyOpen = () => ({
      chunks: [] as never[],
      status: 'open' as const,
    })

    test('abort mid-hold resolves promptly with the last-read shape and issues no further polls', async () => {
      const { read, count } = countingRead(emptyOpen)
      const controller = new AbortController()
      const pending = readStreamWithWait({
        read,
        waitSeconds: WAIT_SECONDS,
        pollMs: POLL_MS,
        signal: controller.signal,
      })
      await Bun.sleep(50)
      const countAtAbort = count()
      expect(countAtAbort).toBeGreaterThanOrEqual(2)
      const started = Date.now()
      controller.abort()
      // Resolves with the current (last-read) result: open status, no chunks.
      expect(await pending).toEqual(emptyOpen())
      expect(Date.now() - started).toBeLessThan(500)
      await Bun.sleep(100)
      expect(count()).toBe(countAtAbort)
    })

    test('a pre-aborted signal performs the initial read only', async () => {
      const { read, count } = countingRead(emptyOpen)
      const controller = new AbortController()
      controller.abort()
      const started = Date.now()
      expect(
        await readStreamWithWait({
          read,
          waitSeconds: WAIT_SECONDS,
          pollMs: POLL_MS,
          signal: controller.signal,
        }),
      ).toEqual(emptyOpen())
      expect(Date.now() - started).toBeLessThan(500)
      expect(count()).toBe(1)
    })

    test('a closed stream still answers immediately, with or without a signal', async () => {
      const closed = () => ({ chunks: [] as never[], status: 'closed' as const })
      const { read, count } = countingRead(closed)
      const controller = new AbortController()
      const started = Date.now()
      expect(
        await readStreamWithWait({
          read,
          waitSeconds: WAIT_SECONDS,
          pollMs: POLL_MS,
          signal: controller.signal,
        }),
      ).toEqual(closed())
      expect(Date.now() - started).toBeLessThan(500)
      expect(count()).toBe(1)
    })
  })
})
