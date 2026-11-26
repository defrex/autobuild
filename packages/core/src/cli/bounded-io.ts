/** Bounded concurrency for runtime tree IO. Every helper caps in-flight work at
 * an explicit finite limit, stops starting work after the first failure and
 * settles only once every started operation has settled, so callers can clean
 * up without racing outstanding writes. */

/** Filesystem operations in flight per traversal, and the prefetch window. */
export const TREE_IO_CONCURRENCY = 16
/** Dependency packages digested or copied at once. */
export const PACKAGE_CONCURRENCY = 4

function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError(`concurrency limit must be a positive integer: ${limit}`)
}

/** Runs `work` over a growing LIFO stack with at most `limit` items in flight.
 * `work` may push more items. After the first failure no item starts; the
 * returned promise settles only once every in-flight item has settled, then
 * rejects with the first error. */
export async function drainStack<T>(
  initial: T[],
  limit: number,
  work: (item: T, push: (item: T) => void) => Promise<void>,
): Promise<void> {
  assertLimit(limit)
  const stack = [...initial]
  let active = 0
  let failed = false
  let error: unknown
  let waiting: Array<() => void> = []
  const wake = () => {
    const ready = waiting
    waiting = []
    for (const resolve of ready) resolve()
  }
  const push = (item: T) => {
    stack.push(item)
    wake()
  }
  const worker = async (): Promise<void> => {
    for (;;) {
      if (failed) return
      if (stack.length === 0) {
        if (active === 0) return wake()
        await new Promise<void>((resolve) => waiting.push(resolve))
        continue
      }
      const item = stack.pop() as T
      active++
      try {
        await work(item, push)
      } catch (cause) {
        if (!failed) {
          failed = true
          error = cause
        }
      } finally {
        active--
        wake()
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, worker))
  if (failed) throw error
}

/** Runs `work` over a fixed list with at most `limit` items in flight, under the
 * same failure contract as {@link drainStack}. */
export async function forEachBounded<T>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<void>,
): Promise<void> {
  assertLimit(limit)
  let next = 0
  let failed = false
  let error: unknown
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next++
      try {
        await work(items[index] as T, index)
      } catch (cause) {
        if (!failed) {
          failed = true
          error = cause
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  if (failed) throw error
}

/** Starts at most `window` fetches ahead of the consumer and hands results to
 * `consume` strictly in input order. On a fetch or consume failure it starts
 * no more fetches, awaits the outstanding ones, then rethrows. */
export async function orderedPrefetch<T, R>(
  items: readonly T[],
  window: number,
  fetch: (item: T) => Promise<R>,
  consume: (result: R, item: T) => void | Promise<void>,
): Promise<void> {
  assertLimit(window)
  const pending: Array<Promise<R>> = []
  let started = 0
  const fill = () => {
    while (pending.length < window && started < items.length) {
      const item = items[started++] as T
      const promise = Promise.resolve().then(() => fetch(item))
      // Observed here so an early rejection is never unhandled; the consumer
      // still receives it when it reaches this slot.
      promise.catch(() => {})
      pending.push(promise)
    }
  }
  try {
    for (let index = 0; index < items.length; index++) {
      fill()
      const result = await (pending.shift() as Promise<R>)
      await consume(result, items[index] as T)
    }
  } catch (error) {
    await Promise.allSettled(pending)
    throw error
  }
}
