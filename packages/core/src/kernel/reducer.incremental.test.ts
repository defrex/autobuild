/**
 * Incremental contract for the build reducer over seeded generated logs. The
 * existing walkthrough fixtures are checked by `reducer.test.ts` itself, which
 * routes every `reduceBuild` call through `checkIncremental`.
 */
import { describe, expect, test } from 'bun:test'
import { checkIncremental } from './incremental-contract'
import { randomBuildLog } from './generators/build-log'
import { buildReducer, reduceBuild } from './reducer'

describe('buildReducer incremental contract', () => {
  test('whole-array form equals the incremental fold', () => {
    const log = randomBuildLog(1, 30)
    expect(buildReducer.finish(buildReducer.advance(buildReducer.initial(), log))).toEqual(
      reduceBuild(log),
    )
  })

  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    test(`generated log, seed ${seed}`, () => {
      checkIncremental(buildReducer, randomBuildLog(seed, 40))
    })
  }
})
