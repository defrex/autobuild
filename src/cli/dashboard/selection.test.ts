import { describe, expect, test } from 'bun:test'
import {
  initialSelection,
  moveSelection,
  reconcileSelection,
} from './selection'

describe('dashboard slug selection', () => {
  test('initial selection is the first build, or clear for an empty list', () => {
    expect(initialSelection(['a', 'b'])).toBe('a')
    expect(initialSelection([])).toBeUndefined()
  })

  test('Up/Down clamp at the list ends and target slugs, not row numbers', () => {
    const slugs = ['a', 'b', 'c']
    expect(moveSelection(slugs, 'b', -1)).toBe('a')
    expect(moveSelection(slugs, 'b', 1)).toBe('c')
    expect(moveSelection(slugs, 'a', -1)).toBe('a')
    expect(moveSelection(slugs, 'c', 1)).toBe('c')
  })

  test('repaint, insertion, and re-sort preserve the same selected build', () => {
    expect(reconcileSelection(['a', 'c'], ['a', 'b', 'c'], 'c')).toBe('c')
    expect(reconcileSelection(['a', 'b', 'c'], ['c', 'a', 'b'], 'b')).toBe('b')
  })

  test('removal selects the successor at the old index, or the last predecessor', () => {
    expect(reconcileSelection(['a', 'b', 'c'], ['a', 'c'], 'b')).toBe('c')
    expect(reconcileSelection(['a', 'b', 'c'], ['a', 'b'], 'c')).toBe('b')
    expect(reconcileSelection(['only'], [], 'only')).toBeUndefined()
  })
})
