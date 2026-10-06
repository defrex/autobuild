/**
 * Incremental contract for the dashboard row facts, and the snapshot-path
 * equivalence of the row projection: a row rendered from facts advanced in
 * arbitrary splits (and revived through JSON, as a stored snapshot is) equals
 * the row `projectBuild` renders from the whole event array.
 */
import { describe, expect, test } from 'bun:test'
import { parseConfig } from '../../config/load'
import type { AbEvent } from '../../events/catalog'
import { currentDeferralObservationReducer } from '../../kernel/auto-merge'
import { randomBuildLog } from '../../kernel/generators/build-log'
import { checkIncremental } from '../../kernel/incremental-contract'
import { buildLog, generatedLogs, randomBuildItem } from '../../kernel/incremental-fixtures'
import { indexLog, logIndexReducer } from '../../kernel/log-index'
import { buildReducer, reduceBuild } from '../../kernel/reducer'
import type { BuildRecord } from '../../store/types'
import { dashboardFactsReducer } from './facts'
import { projectBuild, projectBuildFromFacts } from './model'

const CONFIG = parseConfig(`
[tickets]
source = "file"
readyState = "ready"
[verify]
steps = []
`)

const RECORD: BuildRecord = {
  slug: 'b',
  repo: 'o/r',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

describe('dashboardFacts reducer', () => {
  test('satisfies the incremental contract over generated build logs', () => {
    for (const log of generatedLogs(buildLog, randomBuildItem, [1, 2, 3, 4, 5, 6])) {
      checkIncremental(dashboardFactsReducer, log)
    }
    for (const seed of [1, 2, 3]) checkIncremental(dashboardFactsReducer, randomBuildLog(seed, 60))
  })

  test('a row from facts advanced in splits through JSON equals the whole-array row', () => {
    let rows = 0
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const events: AbEvent[] = randomBuildLog(seed, 120)
      for (const chunk of [1, 7, 25]) {
        let build = buildReducer.initial()
        let dashboard = dashboardFactsReducer.initial()
        let log = logIndexReducer.initial()
        let deferral = currentDeferralObservationReducer.initial()
        for (let at = 0; at < events.length; at += chunk) {
          const slice = events.slice(at, at + chunk)
          build = roundTrip(buildReducer.advance(build, slice))
          dashboard = roundTrip(dashboardFactsReducer.advance(dashboard, slice))
          log = roundTrip(logIndexReducer.advance(log, slice))
          deferral = roundTrip(currentDeferralObservationReducer.advance(deferral, slice))
          const prefix = events.slice(0, at + slice.length)
          const state = buildReducer.finish(build)
          expect(state).toEqual(reduceBuild(prefix))
          const expected = projectBuild(RECORD, state, CONFIG, prefix)
          const actual = projectBuildFromFacts(
            RECORD,
            state,
            {
              dashboard: dashboardFactsReducer.finish(dashboard),
              log: logIndexReducer.finish(log),
              deferral: currentDeferralObservationReducer.finish(deferral),
            },
            CONFIG,
          )
          expect(actual).toEqual(expected)
          if (expected !== null) rows += 1
        }
      }
      // The whole-array wrapper is the same projection over the reducers.
      expect(indexLog(events)).toEqual(logIndexReducer.reduce(events))
    }
    expect(rows).toBeGreaterThan(0)
  })
})
