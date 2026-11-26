/** Bounded concurrency for runtime tree IO. Every helper caps in-flight work at
 * an explicit finite limit, stops starting work after the first failure and
 * settles only once every started operation has settled, so callers can clean
 * up without racing outstanding writes. Stage-level helpers join whole
 * concurrent branches under the same settle-before-report contract. */

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

/** Awaits every task, then rejects with the first failure in argument order or
 * resolves with every value in order. Concurrent branches therefore all settle
 * before a caller cleans up, and report the error a serial run would have hit
 * first. Build every task in the argument expression so none rejects unheard. */
export async function settleInOrder<T extends readonly unknown[]>(
  tasks: {
    readonly [K in keyof T]: Promise<T[K]>
  },
): Promise<T> {
  const outcomes = await Promise.allSettled(tasks as readonly Promise<unknown>[])
  for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason
  return outcomes.map((outcome) => (outcome as PromiseFulfilledResult<unknown>).value) as never
}

/** Starts `start` speculatively and runs `body` alongside it. `take` awaits the
 * speculative value, rethrowing its error at the point the body needs it. When
 * the body ends without taking it, the signal aborts and its outcome, even a
 * failure, is discarded. Either way this settles only after the speculative
 * task has settled, so nothing it started outlives the caller. */
export async function withSpeculation<T, R>(
  start: (signal: AbortSignal) => Promise<T>,
  body: (take: () => Promise<T>) => Promise<R>,
): Promise<R> {
  const controller = new AbortController()
  let taken = false
  // Contained at once, synchronous throws included, so a failure is never
  // an unhandled rejection however early it lands.
  const outcome: Promise<{ value: T } | { error: unknown }> = Promise.resolve()
    .then(() => start(controller.signal))
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
  try {
    return await body(async () => {
      taken = true
      const settled = await outcome
      if ('error' in settled) throw settled.error
      return settled.value
    })
  } finally {
    if (!taken) controller.abort()
    await outcome
  }
}
