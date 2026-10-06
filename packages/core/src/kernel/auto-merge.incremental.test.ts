import { describe, expect, test } from 'bun:test'
import type { AbEvent } from '../events/catalog'
import type { RepositoryEvent } from '../events/repository'
import {
  autoMergeDeferralRef,
  currentDeferralObservation,
  currentDeferralObservationReducer,
  deferralObservationFrom,
} from './auto-merge'
import {
  autoMergeDefaultReducer,
  latestAutoMergeDefault,
  pickAutoMergeDefault,
} from './auto-merge-default'
import { checkIncremental } from './incremental-contract'
import {
  buildLog,
  generatedLogs,
  randomBuildItem,
  randomRepoItem,
  repoLog,
} from './incremental-fixtures'

// The original `currentDeferralObservation`, verbatim, as the oracle.
function referenceDeferral(events: AbEvent[], prNumber: number, commandSeq: number) {
  const marker = autoMergeDeferralRef(prNumber, commandSeq)
  let observation: Extract<AbEvent, { type: 'observation.recorded' }> | undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (
      event !== undefined &&
      event.type === 'observation.recorded' &&
      event.payload.refs?.includes(marker) === true
    ) {
      observation = event
      break
    }
  }
  if (observation === undefined) return undefined

  let headAtObservation: string | undefined
  for (const event of events) {
    if (event.seq >= observation.seq) break
    if (event.type === 'finalize.completed') headAtObservation = event.payload.pr.headSha
  }

  for (const event of events) {
    if (event.seq <= observation.seq) continue
    if (event.type === 'pr.merged' || event.type === 'pr.closed') return undefined
    if (event.type === 'reconcile.completed') return undefined
    if (event.type === 'finalize.completed') {
      if (headAtObservation === undefined) headAtObservation = event.payload.pr.headSha
      else if (event.payload.pr.headSha !== headAtObservation) return undefined
    }
  }
  return observation
}

function referenceDefault(events: RepositoryEvent[], enabled?: boolean) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (
      event?.type === 'dispatcher.auto-merge-default-set' &&
      (enabled === undefined || event.payload.enabled === enabled)
    ) {
      return { enabled: event.payload.enabled, seq: event.seq, actor: event.actor }
    }
  }
  return undefined
}

describe('currentDeferralObservation reducer', () => {
  const logs = generatedLogs(buildLog, randomBuildItem, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])

  test('matches the original for every marker, ordered and shuffled', () => {
    let current = 0
    for (const log of logs) {
      for (const commandSeq of [1, 2, 3]) {
        const view = (ledger: Parameters<typeof deferralObservationFrom>[0]) =>
          deferralObservationFrom(ledger, 7, commandSeq)
        const expected = referenceDeferral(log, 7, commandSeq)
        if (expected !== undefined) current += 1
        expect(currentDeferralObservation(log, 7, commandSeq)).toEqual(expected)
        checkIncremental(currentDeferralObservationReducer, log, {
          compare: (actual, oracle) => {
            expect(view(actual)).toEqual(view(oracle))
            expect(view(actual)).toEqual(expected)
          },
        })
      }
    }
    // The generator must actually reach the "observation is current" outcome.
    expect(current).toBeGreaterThan(0)
  })

  test('an unrelated event with a higher seq ends the head scan (barrier semantics)', () => {
    // Array order: finalize(seq 4, head B) precedes nothing relevant; the
    // observation has seq 3. The unrelated seq-9 event sits before the late
    // finalize in the array, so the head scan stops before reading it.
    const log = buildLog([
      ['finalize.completed', { pr: { number: 7, url: 'u', headSha: 'A' } }],
      ['build.created', { baseBranch: 'main' }],
      [
        'observation.recorded',
        { id: 'o', kind: 'followup', summary: 's', refs: [autoMergeDeferralRef(7, 1)] },
      ],
      ['finalize.completed', { pr: { number: 7, url: 'u', headSha: 'B' } }],
    ])
    const shuffledLog = [log[0], log[3], log[2], log[1]] as AbEvent[]
    for (const events of [log, shuffledLog]) {
      expect(currentDeferralObservation(events, 7, 1)).toEqual(referenceDeferral(events, 7, 1))
      checkIncremental(currentDeferralObservationReducer, events, {
        compare: (a, e) =>
          expect(deferralObservationFrom(a, 7, 1)).toEqual(deferralObservationFrom(e, 7, 1)),
      })
    }
  })
})

describe('latestAutoMergeDefault reducer', () => {
  test('matches the original for every enabled filter, ordered and shuffled', () => {
    for (const log of generatedLogs(repoLog, randomRepoItem)) {
      for (const enabled of [undefined, true, false]) {
        const expected = referenceDefault(log, enabled)
        expect(latestAutoMergeDefault(log, enabled)).toEqual(expected)
        checkIncremental(autoMergeDefaultReducer, log, {
          compare: (actual, oracle) => {
            expect(pickAutoMergeDefault(actual, enabled)).toEqual(
              pickAutoMergeDefault(oracle, enabled),
            )
            expect(pickAutoMergeDefault(actual, enabled)).toEqual(expected)
          },
        })
      }
    }
  })
})
