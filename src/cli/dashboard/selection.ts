/** Pure slug-based selection for the dispatch dashboard. */

export function initialSelection(slugs: readonly string[]): string | undefined {
  return slugs[0]
}

/** Move by one (or any supplied delta) without wrapping. */
export function moveSelection(
  slugs: readonly string[],
  selected: string | undefined,
  delta: number,
): string | undefined {
  if (slugs.length === 0) return undefined
  const current = selected === undefined ? 0 : slugs.indexOf(selected)
  const index = current === -1 ? 0 : current
  const next = Math.max(0, Math.min(slugs.length - 1, index + delta))
  return slugs[next]
}

/**
 * Preserve the selected BUILD across repaints, insertions, and re-sorts. If it
 * disappears, its old row index chooses the successor now occupying that row,
 * or the final predecessor when the old row was last. Only an empty list
 * clears selection.
 */
export function reconcileSelection(
  previousSlugs: readonly string[],
  nextSlugs: readonly string[],
  selected: string | undefined,
): string | undefined {
  if (nextSlugs.length === 0) return undefined
  if (selected === undefined) return initialSelection(nextSlugs)
  if (nextSlugs.includes(selected)) return selected
  const oldIndex = previousSlugs.indexOf(selected)
  if (oldIndex === -1) return initialSelection(nextSlugs)
  return nextSlugs[Math.min(oldIndex, nextSlugs.length - 1)]
}
