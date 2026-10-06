import { describe, expect, test } from 'bun:test'
import { compareFrameSets } from './capture-parity'

describe('compareFrameSets', () => {
  const base = new Map([
    ['terminal/a.png', '1'],
    ['web/b.png', '2'],
  ])

  test('identical sets are clean', () => {
    expect(compareFrameSets(base, new Map(base))).toEqual({
      missing: [],
      extra: [],
      differing: [],
      compared: 2,
    })
  })

  test('reports a differing, a missing, and an extra frame', () => {
    const head = new Map([
      ['terminal/a.png', 'changed'],
      ['web/c.png', '3'],
    ])
    expect(compareFrameSets(base, head)).toEqual({
      missing: ['web/b.png'],
      extra: ['web/c.png'],
      differing: ['terminal/a.png'],
      compared: 1,
    })
  })
})
