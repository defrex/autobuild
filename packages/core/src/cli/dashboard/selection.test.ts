import { describe, expect, test } from 'bun:test'
import type { DashboardSelection } from './model'
import {
  dashboardSelections,
  initialSelection,
  moveSelection,
  reconcileSelection,
  sameSelection,
} from './selection'

const global = (): DashboardSelection => ({ kind: 'global' })
const harvest = (): DashboardSelection => ({ kind: 'harvest' })
const build = (slug: string): DashboardSelection => ({ kind: 'build', slug })

describe('dashboard row selection', () => {
  test('the always-present global row is first, before optional harvest and builds', () => {
    expect(dashboardSelections({ builds: [] })).toEqual([global()])
    expect(
      dashboardSelections({
        harvest: {
          kind: 'harvest',
          run: 'h_1',
          status: 'running',
          steps: [],
          observations: 1,
          rounds: 0,
        },
        builds: [
          {
            slug: 'a',
            status: 'running',
            alsoPaused: false,
            steps: [],
            blockers: [],
            autoMerge: 'off',
          },
        ],
      }),
    ).toEqual([global(), harvest(), build('a')])
  })

  test('initial selection is global, while the generic helper still clears an empty list', () => {
    expect(initialSelection([global(), harvest(), build('a')])).toEqual(global())
    expect(initialSelection([global(), build('a')])).toEqual(global())
    expect(initialSelection([])).toBeUndefined()
  })

  test('Up/Down clamp through global, harvest, and builds by stable identity', () => {
    const rows = [global(), harvest(), build('a'), build('b')]
    expect(moveSelection(rows, global(), -1)).toEqual(global())
    expect(moveSelection(rows, global(), 1)).toEqual(harvest())
    expect(moveSelection(rows, harvest(), -1)).toEqual(global())
    expect(moveSelection(rows, harvest(), 1)).toEqual(build('a'))
    expect(moveSelection(rows, build('a'), 1)).toEqual(build('b'))
    expect(moveSelection(rows, build('b'), 1)).toEqual(build('b'))
  })

  test('global selection survives harvest/build insertion, removal, and re-sort', () => {
    expect(
      reconcileSelection(
        [global(), build('a')],
        [global(), harvest(), build('a'), build('c')],
        global(),
      ),
    ).toEqual(global())
    expect(
      reconcileSelection(
        [global(), harvest(), build('a'), build('b')],
        [global(), build('b'), build('a')],
        global(),
      ),
    ).toEqual(global())
  })

  test('repaint, harvest insertion, and build re-sort preserve selected body rows', () => {
    expect(
      reconcileSelection(
        [global(), build('a'), build('c')],
        [global(), harvest(), build('a'), build('c')],
        build('c'),
      ),
    ).toEqual(build('c'))
    expect(
      reconcileSelection(
        [global(), harvest(), build('a'), build('b')],
        [global(), harvest(), build('b'), build('a')],
        harvest(),
      ),
    ).toEqual(harvest())
    expect(
      reconcileSelection(
        [global(), harvest(), build('a'), build('b')],
        [global(), harvest(), build('b'), build('a')],
        build('b'),
      ),
    ).toEqual(build('b'))
  })

  test('body-row removal selects the successor at the old index, or the final predecessor', () => {
    expect(
      reconcileSelection(
        [global(), harvest(), build('a'), build('b')],
        [global(), build('a'), build('b')],
        harvest(),
      ),
    ).toEqual(build('a'))
    expect(reconcileSelection([global(), harvest()], [global()], harvest())).toEqual(global())
    expect(
      reconcileSelection(
        [global(), harvest(), build('a'), build('b')],
        [global(), harvest(), build('b')],
        build('a'),
      ),
    ).toEqual(build('b'))
    expect(
      reconcileSelection([global(), harvest(), build('a')], [global(), harvest()], build('a')),
    ).toEqual(harvest())
  })

  test('identity comparison is structural, not object-reference based', () => {
    expect(sameSelection(global(), global())).toBe(true)
    expect(sameSelection(harvest(), harvest())).toBe(true)
    expect(sameSelection(build('a'), build('a'))).toBe(true)
    expect(sameSelection(build('a'), build('b'))).toBe(false)
    expect(sameSelection(global(), harvest())).toBe(false)
    expect(sameSelection(harvest(), build('harvest'))).toBe(false)
  })
})
