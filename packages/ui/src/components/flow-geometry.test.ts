import { describe, expect, test } from 'bun:test'
import { type BlockGeometry, firstChange, planCommit, shrinkHold } from './flow-geometry'

const block = (key: string, top: number, rects: number[] = [0, 0, 10, 10]): BlockGeometry => ({
  key,
  top,
  height: 20,
  rects,
})
const list = [block('a', 0), block('b', 20), block('c', 40), block('d', 60)]

describe('firstChange', () => {
  test('equal lists have no change', () => {
    expect(
      firstChange(
        list,
        list.map((b) => ({ ...b })),
      ),
    ).toBeUndefined()
  })
  test('the first block whose inner geometry, key or extent differs', () => {
    const moved = list.map((b, i) => (i === 3 ? block('d', 60, [0, 2, 10, 10]) : b))
    expect(firstChange(list, moved)).toBe(3)
    const rekeyed = list.map((b, i) => (i === 2 ? block('x', 40) : b))
    expect(firstChange(list, rekeyed)).toBe(2)
    expect(firstChange(list, [...list, block('e', 80)])).toBe(4)
    expect(firstChange(list, list.slice(0, 2))).toBe(2)
  })
})

describe('planCommit', () => {
  const base = { changeTop: 100, viewportBottom: 800, shownCount: 4 }
  test('no change commits in place; a change below the fold commits at once', () => {
    expect(planCommit({ ...base, firstChange: undefined })).toEqual({ kind: 'in-place' })
    expect(planCommit({ ...base, firstChange: 2, changeTop: 800 })).toEqual({
      kind: 'offscreen',
    })
  })
  test('a visible change is a transaction; a pure append skips the exit', () => {
    expect(planCommit({ ...base, firstChange: 2 })).toEqual({
      kind: 'transaction',
      from: 2,
      exit: true,
    })
    expect(planCommit({ ...base, firstChange: 4 })).toEqual({
      kind: 'transaction',
      from: 4,
      exit: false,
    })
  })
})

test('shrinkHold holds the old height only while the flow bottom is visible', () => {
  expect(shrinkHold(500, 400, 450, 800)).toBe(500)
  expect(shrinkHold(500, 400, 900, 800)).toBeUndefined()
  expect(shrinkHold(400, 500, 450, 800)).toBeUndefined()
})
