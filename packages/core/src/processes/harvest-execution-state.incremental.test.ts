import { describe, expect, test } from 'bun:test'
import type { RepositoryEvent } from '../events/repository'
import {
  checkAgainstReference,
  generatedLogs,
  randomRepoItem,
  repoLog,
  type Rand,
} from '../kernel/incremental-fixtures'
import { pick } from '../kernel/incremental-contract'
import {
  hostedHarvestAuthorityReducer,
  openHarvestExecutions,
  openHarvestExecutionsReducer,
} from './harvest-execution-state'

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

// A whole-array oracle for the current-authority projection: the latest
// authorization of a different execution wins; only the current execution's
// ending or release marks it released.
function authorityReference(events: readonly RepositoryEvent[]) {
  let current: Record<string, unknown> | undefined
  for (const event of events) {
    if (event.type === 'harvest.execution.authorized') {
      if (current?.execution !== event.payload.execution)
        current = {
          execution: event.payload.execution,
          run: event.payload.run,
          leaseHolder: event.payload.leaseHolder,
          released: false,
        }
    } else if (
      (event.type === 'harvest.execution.released' || event.type === 'harvest.execution.ended') &&
      current?.execution === event.payload.execution
    ) {
      current = { ...current, released: true }
    }
  }
  return current ? { current } : {}
}

function authorityItem(rand: Rand): readonly [string, Record<string, unknown>] {
  const execution = pick(rand, ['x1', 'x2', 'x3'])
  const run = pick(rand, ['h1', 'h2'])
  return pick(rand, [
    () =>
      [
        'harvest.execution.authorized',
        { execution, run, launch: 'started', leaseHolder: pick(rand, ['inv-1', 'inv-2']) },
      ] as const,
    () => ['harvest.execution.ended', { execution, run }] as const,
    () => randomRepoItem(rand),
  ])()
}

describe('hostedHarvestAuthority reducer', () => {
  test('folding in chunks equals the whole-array oracle, ordered and shuffled', () => {
    checkAgainstReference(
      hostedHarvestAuthorityReducer,
      generatedLogs(repoLog, authorityItem),
      authorityReference as never,
    )
  })
})
