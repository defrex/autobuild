/**
 * The pure decisions behind `StableFlow`: whether a page's next blocks keep
 * the geometry on screen, and if not, where a layout transaction starts.
 * No DOM here; `StableFlow` measures and this module decides.
 */

/** One flow block's measured geometry. `rects` lists every descendant
 * element's offset box relative to the block (x, y, width, height per
 * element, whole pixels), so any inner move counts as a change. */
export interface BlockGeometry {
  key: string
  top: number
  height: number
  rects: readonly number[]
}

function sameRects(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** The first index whose block differs in key, position, size or inner
 * geometry, or the first index past the shorter list; undefined when the two
 * lists are equal. */
export function firstChange(
  shown: readonly BlockGeometry[],
  next: readonly BlockGeometry[],
): number | undefined {
  const common = Math.min(shown.length, next.length)
  for (let i = 0; i < common; i++) {
    const a = shown[i]!
    const b = next[i]!
    if (a.key !== b.key || a.top !== b.top || a.height !== b.height || !sameRects(a.rects, b.rects))
      return i
  }
  return shown.length === next.length ? undefined : common
}

export type CommitPlan =
  | { kind: 'in-place' }
  | { kind: 'offscreen' }
  | { kind: 'transaction'; from: number; exit: boolean }

/**
 * How to apply the next blocks. Equal geometry commits in place; a change
 * that starts at or below the viewport's bottom edge moves nothing visible
 * and commits at once; anything else is a transaction from the first changed
 * block. A pure append (the change starts past the shown blocks) has nothing
 * to fade out first.
 */
export function planCommit(input: {
  firstChange: number | undefined
  changeTop: number
  viewportBottom: number
  shownCount: number
}): CommitPlan {
  if (input.firstChange === undefined) return { kind: 'in-place' }
  if (input.changeTop >= input.viewportBottom) return { kind: 'offscreen' }
  return {
    kind: 'transaction',
    from: input.firstChange,
    exit: input.firstChange < input.shownCount,
  }
}

/**
 * The `min-height` a shrinking flow holds so the browser never clamps scroll
 * and drags visible content upward: the previous height while the new
 * bottom would be visible, released once the flow's bottom is below the
 * viewport.
 */
export function shrinkHold(
  prevHeight: number,
  nextHeight: number,
  flowBottom: number,
  viewportBottom: number,
): number | undefined {
  if (nextHeight >= prevHeight) return undefined
  return flowBottom > viewportBottom ? undefined : prevHeight
}
