/** Store reads a web source runs at once over a list of builds. */
export const BUILD_READ_CONCURRENCY = 8

/** `read` over every item, at most `BUILD_READ_CONCURRENCY` at a time, with
 * results in item order. */
export async function mapBounded<T, R>(
  items: readonly T[],
  read: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const at = next++
      results[at] = await read(items[at]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(BUILD_READ_CONCURRENCY, items.length) }, worker))
  return results
}
