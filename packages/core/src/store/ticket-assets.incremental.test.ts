import { describe, expect, test } from 'bun:test'
import type { AbEvent } from '../events/catalog'
import { checkIncremental } from '../kernel/incremental-contract'
import { buildLog, generatedLogs, randomBuildItem } from '../kernel/incremental-fixtures'
import { findPinnedRevision, pinnedAssetsReducer, pinnedRevision } from './ticket-assets'

// The original implementation, verbatim, as the oracle.
function reference(events: AbEvent[], kind: string, name: string, rev?: number) {
  let latest: number | undefined
  for (const event of events) {
    if (event.type !== 'build.created' && event.type !== 'spec.revised') continue
    const assets = event.payload.assets
    if (assets === undefined) continue
    if (rev !== undefined) {
      if (assets.some((a) => a.kind === kind && a.name === name && a.revision === rev)) return rev
      continue
    }
    latest = assets.find((a) => a.kind === kind && a.name === name)?.revision
  }
  return latest
}

describe('pinned asset reducer', () => {
  test('matches the original for latest and per-revision lookups, ordered and shuffled', () => {
    let hits = 0
    for (const log of generatedLogs(buildLog, randomBuildItem, [1, 2, 3, 4, 5, 6, 7, 8])) {
      for (const [kind, name] of [
        ['doc', 'a'],
        ['doc', 'b'],
        ['img', 'c'],
      ] as const) {
        for (const rev of [undefined, 1, 2, 3]) {
          const expected = reference(log, kind, name, rev)
          if (expected !== undefined) hits += 1
          expect(findPinnedRevision(log, kind, name, rev)).toEqual(expected)
          checkIncremental(pinnedAssetsReducer, log, {
            compare: (actual, oracle) => {
              expect(pinnedRevision(actual, kind, name, rev)).toEqual(
                pinnedRevision(oracle, kind, name, rev),
              )
              expect(pinnedRevision(actual, kind, name, rev)).toEqual(expected)
            },
            stepwise: rev === undefined,
          })
        }
      }
    }
    expect(hits).toBeGreaterThan(0)
  })
})
