import { describe, expect, test } from 'bun:test'
import type { RepositoryEvent } from '../events/repository'
import {
  checkAgainstReference,
  generatedLogs,
  randomRepoItem,
  repoLog,
} from '../kernel/incremental-fixtures'
import { openHarvestExecutions, openHarvestExecutionsReducer } from './harvest-execution-state'

// The original Map-based implementation, verbatim, as the oracle.
function reference(events: readonly RepositoryEvent[]) {
  const open = new Map<string, Record<string, unknown>>()
  for (const event of events) {
    if (event.type === 'harvest.execution.started') {
      open.set(event.payload.execution, {
        execution: event.payload.execution,
        provider: event.payload.provider,
        environmentId: event.payload.environmentId,
        ...(event.payload.sessionId !== undefined ? { sessionId: event.payload.sessionId } : {}),
        ...(event.payload.commandId !== undefined ? { commandId: event.payload.commandId } : {}),
        seq: event.seq,
      })
    } else if (event.type === 'harvest.execution.released') {
      open.delete(event.payload.execution)
    }
  }
  return [...open.values()]
}

describe('openHarvestExecutions reducer', () => {
  test('matches the Map-based original, ordered and shuffled (re-start keeps its slot)', () => {
    checkAgainstReference(
      openHarvestExecutionsReducer,
      generatedLogs(repoLog, randomRepoItem),
      reference as never,
    )
  })
  test('wrapper keeps order and re-start position', () => {
    const log = repoLog([
      ['harvest.execution.started', { execution: 'a', provider: 'p', environmentId: 'e' }],
      ['harvest.execution.started', { execution: 'b', provider: 'p', environmentId: 'e' }],
      ['harvest.execution.started', { execution: 'a', provider: 'p', environmentId: 'e2' }],
    ])
    expect(openHarvestExecutions(log).map((o) => [o.execution, o.environmentId])).toEqual([
      ['a', 'e2'],
      ['b', 'e'],
    ])
  })
})
