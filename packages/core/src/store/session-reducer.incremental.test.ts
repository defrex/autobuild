/** Incremental contract for the session reducer over seeded generated logs,
 * including `session.archived` mid-log with events after it. */
import { describe, expect, test } from 'bun:test'
import { checkIncremental } from '../kernel/incremental-contract'
import { randomSessionLog } from '../kernel/generators/session-log'
import { reduceSession, sessionReducer } from './session-reducer'

describe('sessionReducer incremental contract', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    test(`generated log, seed ${seed}`, () => {
      checkIncremental(sessionReducer, randomSessionLog(seed, 30, seed % 2 === 0))
    })
  }

  test('an advance after archive stays frozen', () => {
    const log = randomSessionLog(2, 30, true)
    const archivedAt = log.findIndex((event) => event.type === 'session.archived')
    const frozen = sessionReducer.advance(sessionReducer.initial(), log.slice(0, archivedAt + 1))
    const later = sessionReducer.advance(frozen, log.slice(archivedAt + 1))
    expect(sessionReducer.finish(later)).toEqual(sessionReducer.finish(frozen))
    expect(sessionReducer.finish(later).status).toBe('archived')
    expect(sessionReducer.reduce(log)).toEqual(reduceSession(log))
  })
})
