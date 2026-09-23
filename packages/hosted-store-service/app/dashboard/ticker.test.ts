import { expect, test } from 'bun:test'
import { createNowTicker, TICK_INTERVAL_MS } from './ticker'

type TimerHandle = ReturnType<typeof setTimeout>

/** A manual clock: `setInterval` records work, `advance` fires it on due multiples. */
class IntervalQueue {
  private nextId = 1
  private intervals = new Map<number, { every: number; nextAt: number; run: () => void }>()
  now = 0

  readonly setInterval = (handler: () => void, delay = 0): TimerHandle => {
    const id = this.nextId++
    const every = Math.max(1, delay)
    this.intervals.set(id, { every, nextAt: this.now + every, run: handler })
    return id as unknown as TimerHandle
  }

  readonly clearInterval = (handle: TimerHandle): void => {
    this.intervals.delete(handle as unknown as number)
  }

  /** Live interval count: a paused ticker holds no timer at all. */
  get live(): number {
    return this.intervals.size
  }

  advance(ms: number): void {
    const target = this.now + ms
    while (true) {
      let due: number | undefined
      let at = Number.POSITIVE_INFINITY
      for (const [id, interval] of this.intervals) {
        if (interval.nextAt < at) {
          at = interval.nextAt
          due = id
        }
      }
      if (due === undefined || at > target) break
      this.now = at
      const interval = this.intervals.get(due)!
      interval.nextAt = at + interval.every
      interval.run()
    }
    this.now = target
  }
}

function harness(startHidden = false) {
  const clock = new IntervalQueue()
  const ticks: number[] = []
  let hidden = startHidden
  const ticker = createNowTicker({
    visible: () => !hidden,
    onTick: () => ticks.push(clock.now),
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
  })
  const show = () => {
    hidden = false
    ticker.onVisibilityChange()
  }
  const hide = () => {
    hidden = true
    ticker.onVisibilityChange()
  }
  return { clock, ticks, ticker, show, hide }
}

test('pause on hide: a running ticker holds no timer and ticks never again while hidden', () => {
  const h = harness()
  expect(h.clock.live).toBe(1)

  h.hide()
  expect(h.clock.live).toBe(0)

  h.clock.advance(TICK_INTERVAL_MS * 5)
  expect(h.ticks).toEqual([])
})

test('resume on show: one immediate tick, then the one-second cadence returns', () => {
  const h = harness()
  h.clock.advance(TICK_INTERVAL_MS * 2)
  expect(h.ticks).toEqual([TICK_INTERVAL_MS, TICK_INTERVAL_MS * 2])

  h.hide()
  h.clock.advance(TICK_INTERVAL_MS * 10)
  expect(h.ticks).toEqual([TICK_INTERVAL_MS, TICK_INTERVAL_MS * 2])

  h.show()
  expect(h.ticks).toEqual([TICK_INTERVAL_MS, TICK_INTERVAL_MS * 2, TICK_INTERVAL_MS * 12])

  h.clock.advance(TICK_INTERVAL_MS - 1)
  expect(h.ticks).toHaveLength(3)
  h.clock.advance(1)
  expect(h.ticks).toEqual([
    TICK_INTERVAL_MS,
    TICK_INTERVAL_MS * 2,
    TICK_INTERVAL_MS * 12,
    TICK_INTERVAL_MS * 13,
  ])
  expect(h.clock.live).toBe(1)
})

test('start while hidden: no interval is scheduled until the document becomes visible', () => {
  const h = harness(true)
  expect(h.clock.live).toBe(0)

  h.clock.advance(TICK_INTERVAL_MS * 5)
  expect(h.ticks).toEqual([])

  h.show()
  expect(h.clock.live).toBe(1)
  expect(h.ticks).toEqual([TICK_INTERVAL_MS * 5])

  h.clock.advance(TICK_INTERVAL_MS)
  expect(h.ticks).toEqual([TICK_INTERVAL_MS * 5, TICK_INTERVAL_MS * 6])
})

test('dispose clears the interval and is idempotent, even after hiding', () => {
  const h = harness()
  h.clock.advance(TICK_INTERVAL_MS)
  expect(h.ticks).toEqual([TICK_INTERVAL_MS])

  h.ticker.dispose()
  expect(h.clock.live).toBe(0)
  h.clock.advance(TICK_INTERVAL_MS * 3)
  expect(h.ticks).toEqual([TICK_INTERVAL_MS])

  h.ticker.dispose()
  expect(h.clock.live).toBe(0)

  // A disposed ticker stays dormant even across a visibility transition.
  h.hide()
  h.show()
  expect(h.clock.live).toBe(0)
  h.clock.advance(TICK_INTERVAL_MS)
  expect(h.ticks).toEqual([TICK_INTERVAL_MS])
})

test('no double schedule: repeated show events keep a single interval', () => {
  const h = harness()
  h.show()
  h.show()
  h.show()
  expect(h.clock.live).toBe(1)

  h.clock.advance(TICK_INTERVAL_MS)
  expect(h.ticks).toEqual([TICK_INTERVAL_MS])
})
