/** Pure stable-identity selection for every selectable dashboard row. */
import type { DashboardModel, DashboardSelection } from './model'

/** Render order is selection order: the always-present process-global row,
 * optional repository harvest, then the model's already slug-sorted builds. */
export function dashboardSelections(
  model: Pick<DashboardModel, 'harvest' | 'builds'>,
): DashboardSelection[] {
  return [
    { kind: 'global' },
    ...(model.harvest !== undefined ? [{ kind: 'harvest' } as const] : []),
    ...model.builds.map((build) => ({ kind: 'build' as const, slug: build.slug })),
  ]
}

export function sameSelection(
  left: DashboardSelection | undefined,
  right: DashboardSelection | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.kind === right.kind &&
    (left.kind === 'global' ||
      left.kind === 'harvest' ||
      (right.kind === 'build' && left.slug === right.slug))
}

export function initialSelection(
  rows: readonly DashboardSelection[],
): DashboardSelection | undefined {
  return rows[0]
}

/** Move by one (or any supplied delta) without wrapping. */
export function moveSelection(
  rows: readonly DashboardSelection[],
  selected: DashboardSelection | undefined,
  delta: number,
): DashboardSelection | undefined {
  if (rows.length === 0) return undefined
  const current = selected === undefined
    ? 0
    : rows.findIndex((row) => sameSelection(row, selected))
  const index = current === -1 ? 0 : current
  const next = Math.max(0, Math.min(rows.length - 1, index + delta))
  return rows[next]
}

/**
 * Preserve the selected ROW across repaints, harvest appearance, and build
 * re-sorts. If it disappears, its old row index chooses the successor now
 * occupying that row, or the final predecessor when the old row was last.
 * Only an empty list clears selection.
 */
export function reconcileSelection(
  previousRows: readonly DashboardSelection[],
  nextRows: readonly DashboardSelection[],
  selected: DashboardSelection | undefined,
): DashboardSelection | undefined {
  if (nextRows.length === 0) return undefined
  if (selected === undefined) return initialSelection(nextRows)
  const retained = nextRows.find((row) => sameSelection(row, selected))
  if (retained !== undefined) return retained
  const oldIndex = previousRows.findIndex((row) => sameSelection(row, selected))
  if (oldIndex === -1) return initialSelection(nextRows)
  return nextRows[Math.min(oldIndex, nextRows.length - 1)]
}
