/** Store reads a web source runs at once over a list of builds. */
export const BUILD_READ_CONCURRENCY = 8

/**
 * `read` over every item, at most `BUILD_READ_CONCURRENCY` at a time, with
 * results in item order. A failure starts no further reads, and the call
 * rejects with the first failure only once every read already started has
 * settled. A caller holding a lock therefore releases it after the last of
 * its reads, so none can write a cache after a later request has moved on.
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  read: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  let failure: { error: unknown } | undefined
  const worker = async () => {
    while (failure === undefined && next < items.length) {
      const at = next++
      try {
        results[at] = await read(items[at]!)
      } catch (error) {
        failure ??= { error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(BUILD_READ_CONCURRENCY, items.length) }, worker))
  if (failure !== undefined) throw failure.error
  return results
}
