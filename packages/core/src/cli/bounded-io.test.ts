import { describe, expect, test } from 'bun:test'
import { drainStack, forEachBounded, orderedPrefetch } from './bounded-io'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (e: unknown) => void
}
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
async function flush(rounds = 20): Promise<void> {
  for (let index = 0; index < rounds; index++) await Promise.resolve()
}

describe('bounded io', () => {
  test('drainStack and forEachBounded never exceed the limit and run each item once', async () => {
    let active = 0
    let maxActive = 0
    const seen: number[] = []
    await drainStack([0], 4, async (item, push) => {
      active++
      maxActive = Math.max(maxActive, active)
      seen.push(item)
      await flush(item % 3)
      for (const child of [item * 2 + 1, item * 2 + 2]) if (child < 200) push(child)
      active--
    })
    expect(maxActive).toBe(4)
    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 200 }, (_, i) => i))

    active = 0
    maxActive = 0
    const ran = new Array(50).fill(0)
    await forEachBounded(ran, 3, async (_, index) => {
      active++
      maxActive = Math.max(maxActive, active)
      await flush(index % 4)
      ran[index]++
      active--
    })
    expect(maxActive).toBe(3)
    expect(ran.every((count) => count === 1)).toBe(true)
  })

  test('orderedPrefetch consumes in input order within the window', async () => {
    const gates = Array.from({ length: 10 }, () => deferred<number>())
    let started = 0
    let consumedCount = 0
    let maxAhead = 0
    const consumed: number[] = []
    const done = orderedPrefetch(
      gates.map((_, index) => index),
      3,
      (index) => {
        started++
        maxAhead = Math.max(maxAhead, started - consumedCount)
        return gates[index]!.promise
      },
      (value) => {
        consumed.push(value)
        consumedCount++
      },
    )
    for (let index = gates.length - 1; index >= 0; index--) {
      await flush()
      gates[index]!.resolve(index)
    }
    await done
    expect(consumed).toEqual(gates.map((_, index) => index))
    expect(maxAhead).toBe(3)
  })

  test('failure stops new work and settles only after in-flight work', async () => {
    const slow = deferred()
    const started: number[] = []
    let settled = false
    const run = forEachBounded([0, 1, 2, 3, 4, 5], 2, async (item) => {
      started.push(item)
      if (item === 0) await slow.promise
      if (item === 1) throw new Error('first failure')
    })
    run.then(
      () => (settled = true),
      () => (settled = true),
    )
    await flush()
    expect(started).toEqual([0, 1])
    expect(settled).toBe(false)
    slow.resolve()
    await expect(run).rejects.toThrow('first failure')
    expect(started).toEqual([0, 1])

    const pending = deferred()
    const stackStarted: string[] = []
    let stackSettled = false
    const drained = drainStack(['ok', 'bad'], 2, async (item, push) => {
      stackStarted.push(item)
      if (item === 'bad') throw new Error('stack failure')
      await pending.promise
      push('late')
    })
    drained.catch(() => {}).finally(() => (stackSettled = true))
    await flush()
    expect(stackSettled).toBe(false)
    pending.resolve()
    await expect(drained).rejects.toThrow('stack failure')
    expect(stackStarted.sort()).toEqual(['bad', 'ok'])
  })

  test('an early prefetch rejection is contained until consumed', async () => {
    const unhandled: unknown[] = []
    const spy = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', spy)
    try {
      const first = deferred<number>()
      const third = deferred<number>()
      let thirdSettled = false
      const run = orderedPrefetch(
        [0, 1, 2],
        3,
        (index) =>
          index === 0
            ? first.promise
            : index === 1
              ? Promise.reject(new Error('early'))
              : third.promise.finally(() => (thirdSettled = true)),
        () => {},
      )
      await flush()
      first.resolve(0)
      await flush()
      third.resolve(2)
      await expect(run).rejects.toThrow('early')
      expect(thirdSettled).toBe(true)
      await flush()
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', spy)
    }
  })

  test('limits must be finite positive integers', async () => {
    const work = async () => {}
    await expect(drainStack([], 0, work)).rejects.toBeInstanceOf(RangeError)
    await expect(forEachBounded([], Infinity, work)).rejects.toBeInstanceOf(RangeError)
    await expect(orderedPrefetch([], 1.5, work, () => {})).rejects.toBeInstanceOf(RangeError)
  })
})
