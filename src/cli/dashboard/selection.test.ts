import { describe, expect, test } from 'bun:test'
import type { DashboardSelection } from './model'
import {
  initialSelection,
  moveSelection,
  reconcileSelection,
  sameSelection,
} from './selection'

const harvest = (): DashboardSelection => ({ kind: 'harvest' })
const build = (slug: string): DashboardSelection => ({ kind: 'build', slug })

describe('dashboard row selection', () => {
  test('initial selection is the first rendered row, or clear for an empty list', () => {
    expect(initialSelection([harvest(), build('a')])).toEqual(harvest())
    expect(initialSelection([build('a'), build('b')])).toEqual(build('a'))
    expect(initialSelection([])).toBeUndefined()
  })

  test('Up/Down clamp through harvest and builds by stable identity', () => {
    const rows = [harvest(), build('a'), build('b')]
    expect(moveSelection(rows, build('a'), -1)).toEqual(harvest())
    expect(moveSelection(rows, harvest(), 1)).toEqual(build('a'))
    expect(moveSelection(rows, build('a'), 1)).toEqual(build('b'))
    expect(moveSelection(rows, harvest(), -1)).toEqual(harvest())
    expect(moveSelection(rows, build('b'), 1)).toEqual(build('b'))
  })

  test('repaint, harvest insertion, and build re-sort preserve the selected row', () => {
    expect(
      reconcileSelection([build('a'), build('c')], [harvest(), build('a'), build('c')], build('c')),
    ).toEqual(build('c'))
    expect(
      reconcileSelection([harvest(), build('a'), build('b')], [harvest(), build('b'), build('a')], harvest()),
    ).toEqual(harvest())
    expect(
      reconcileSelection([harvest(), build('a'), build('b')], [harvest(), build('b'), build('a')], build('b')),
    ).toEqual(build('b'))
  })

  test('removal selects the successor at the old index, or the final predecessor', () => {
    expect(
      reconcileSelection([harvest(), build('a'), build('b')], [build('a'), build('b')], harvest()),
    ).toEqual(build('a'))
    expect(
      reconcileSelection([harvest(), build('a'), build('b')], [harvest(), build('b')], build('a')),
    ).toEqual(build('b'))
    expect(
      reconcileSelection([harvest(), build('a')], [harvest()], build('a')),
    ).toEqual(harvest())
    expect(reconcileSelection([harvest()], [], harvest())).toBeUndefined()
  })

  test('identity comparison is structural, not object-reference based', () => {
    expect(sameSelection(harvest(), harvest())).toBe(true)
    expect(sameSelection(build('a'), build('a'))).toBe(true)
    expect(sameSelection(build('a'), build('b'))).toBe(false)
    expect(sameSelection(harvest(), build('harvest'))).toBe(false)
  })
})
