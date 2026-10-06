import { describe, expect, test } from 'bun:test'
import type { AbEvent } from '../events/catalog'
import {
  buildLog,
  checkAgainstReference,
  generatedLogs,
  randomBuildItem,
} from '../kernel/incremental-fixtures'
import {
  infrastructureFailureResetReducer,
  infrastructureFailureResetSeq,
} from './infrastructure-failure-budget'

function reference(events: readonly AbEvent[]): number {
  const escalations = new Set<string>()
  let resetSeq = 0
  for (const event of events) {
    if (
      event.type === 'escalation.raised' &&
      event.payload.policyCause === 'infrastructure-failure-limit'
    ) {
      escalations.add(event.payload.id)
    } else if (
      event.type === 'execution.ended' ||
      (event.type === 'escalation.answered' &&
        event.payload.resolution === 'retry' &&
        escalations.has(event.payload.id))
    ) {
      resetSeq = event.seq
    }
  }
  return resetSeq
}

describe('infrastructureFailureResetSeq reducer', () => {
  test('matches the original, ordered and shuffled', () => {
    checkAgainstReference(
      infrastructureFailureResetReducer,
      generatedLogs(buildLog, randomBuildItem),
      reference,
    )
  })
  test('a retry answer to the policy escalation re-arms the budget', () => {
    const log = buildLog([
      [
        'escalation.raised',
        {
          id: 'e',
          phase: 'setup',
          source: 'policy',
          policyCause: 'infrastructure-failure-limit',
          question: 'q',
        },
      ],
      ['escalation.answered', { id: 'e', answer: 'a', resolution: 'retry' }],
    ])
    expect(infrastructureFailureResetSeq(log)).toBe(2)
  })
})
