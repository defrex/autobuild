// Load the reducer registry first: build-runner's import cycle otherwise reaches
// a reducer before it is initialized when this file runs alone.
import '../kernel/reducer-registry'
import { describe, expect, test } from 'bun:test'
import { verifyCheckBaseReadBudget } from '../testing/reduced-read-budget'

describe('check commands receive the verify diff base', () => {
  test('from facts the runner already reads, at a cost independent of history', async () => {
    const short = await verifyCheckBaseReadBudget({ length: 100 })
    const long = await verifyCheckBaseReadBudget({ length: 2_000 })
    expect(long.calls).toEqual(short.calls)
    // The runner before the base was exported made 21 reduced reads and 11
    // snapshot writes here: the two conditional resolutions each also read the
    // standalone verifyDiffBaseValue selector, which this change removes.
    expect(short.calls).toEqual({
      getReducerValue: 19,
      readValue: 19,
      snapshotTail: 28,
      state: 27,
      append: 8,
      now: 8,
      advanceRepo: 8,
      putSnapshot: 9,
    })
    expect(long.rows).toBe(short.rows)
    expect(short.historicalRows).toBe(0)
    expect(long.historicalRows).toBe(0)
    expect(short.verifyDiffBaseReads).toBe(0)
    expect(long.verifyDiffBaseReads).toBe(0)
    expect(short.bases).toEqual(Array(4).fill('b'.repeat(40)))
    expect(long.bases).toEqual(short.bases)
  })

  test('a leaf with no provisioned base clears the variable instead of leaking an inherited one', async () => {
    const costs = await verifyCheckBaseReadBudget({ length: 100, provisioned: false })
    expect(costs.bases).toEqual([undefined])
  })
})
