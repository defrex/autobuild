/**
 * Incremental contract for the repository-journal reducers (harvest, dispatch
 * settings, dispatch status, sandbox states) over seeded generated journals.
 */
import { describe, expect, test } from 'bun:test'
import { sandboxStatesReducer } from '../processes/sandbox-state'
import { dispatchSettingsReducer } from './dispatch-settings'
import { dispatchStatusReducer, reduceDispatchStatus } from './dispatch-status'
import { harvestReducer } from './harvest'
import {
  randomHarvestJournal,
  randomSandboxJournal,
  randomSettingsJournal,
  randomStatusJournal,
} from './generators/repository-journals'
import { checkIncremental, seededRandom, shuffled } from './incremental-contract'
import { journalViewReducer, projectRepositoryStateEvents } from '../store/repo-state-events'

const SEEDS = [1, 2, 3, 4, 5, 6]

describe('repository reducers: incremental contract over generated journals', () => {
  for (const seed of SEEDS) {
    test(`harvest, seed ${seed}`, () => {
      checkIncremental(harvestReducer, randomHarvestJournal(seed, 40))
    })
    test(`dispatch settings, seed ${seed}`, () => {
      checkIncremental(dispatchSettingsReducer, randomSettingsJournal(seed, 30))
    })
    test(`dispatch status, seed ${seed}`, () => {
      const journal = randomStatusJournal(seed, 30)
      checkIncremental(dispatchStatusReducer('run-a'), journal)
      // The factory's reduce is the unchanged whole-array function.
      expect(dispatchStatusReducer('run-b').reduce(journal)).toEqual(
        reduceDispatchStatus(journal, 'run-b'),
      )
    })
    test(`sandbox states, seed ${seed}`, () => {
      checkIncremental(sandboxStatesReducer, randomSandboxJournal(seed, 30))
    })
    test(`journal view equals the bounded read, seed ${seed}`, () => {
      // A mixed, seq-ordered journal: durable and run-scoped facts interleaved,
      // with several run-started anchors.
      const rand = seededRandom(seed)
      const mixed = shuffled(rand, [
        ...randomHarvestJournal(seed, 20),
        ...randomStatusJournal(seed, 30),
        ...randomSettingsJournal(seed, 15),
      ]).map((event, index) => ({ ...event, seq: index + 1 }))
      // The reducer is held to the oracle whole, and over every split with a
      // JSON round trip in between (checkIncremental's contract).
      checkIncremental(journalViewReducer, mixed)
      expect(journalViewReducer.reduce(mixed)).toEqual(projectRepositoryStateEvents(mixed))
    })
  }
})
