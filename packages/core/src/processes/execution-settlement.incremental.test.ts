import { describe, expect, test } from 'bun:test'
import type { AbEvent } from '../events/catalog'
import {
  checkAgainstReference,
  buildLog,
  generatedLogs,
  randomBuildItem,
} from '../kernel/incremental-fixtures'
import {
  lastExecutionOutcome,
  lastExecutionOutcomeReducer,
  openExecution,
  openExecutionReducer,
} from './execution-settlement'

// Verbatim originals, the oracle for generated and shuffled logs.
function referenceOpenExecution(events: readonly AbEvent[]) {
  let open: Record<string, unknown> | null = null
  for (const event of events) {
    if (event.type === 'execution.started') {
      const payload = event.payload
      open = {
        instance: payload.instance,
        workspaceRef: payload.workspaceRef,
        provider: payload.provider,
        ...(payload.environmentId !== undefined ? { environmentId: payload.environmentId } : {}),
        ...(payload.sessionId !== undefined ? { sessionId: payload.sessionId } : {}),
        ...(payload.commandId !== undefined ? { commandId: payload.commandId } : {}),
      }
    } else if (event.type === 'execution.ended' && open !== null) {
      if (event.payload.instance === open.instance) open = null
    }
  }
  return open
}

function referenceOutcome(events: readonly AbEvent[]) {
  let state: string = 'none'
  for (const event of events) {
    if (event.type === 'execution.started') state = 'open'
    else if (event.type === 'execution.ended' && state === 'open') state = event.payload.outcome
  }
  return state
}

const logs = generatedLogs(buildLog, randomBuildItem)

describe('execution settlement reducers', () => {
  test('openExecution matches the original, ordered and shuffled', () => {
    checkAgainstReference(openExecutionReducer, logs, referenceOpenExecution as never)
  })
  test('lastExecutionOutcome matches the original, ordered and shuffled', () => {
    checkAgainstReference(lastExecutionOutcomeReducer, logs, referenceOutcome as never)
  })
  test('wrappers keep their results', () => {
    const log = buildLog([
      ['execution.started', { provider: 'p', workspaceRef: 'w', instance: 'i', commandId: 'c' }],
    ])
    expect(openExecution(log)).toEqual({
      instance: 'i',
      workspaceRef: 'w',
      provider: 'p',
      commandId: 'c',
    })
    expect(lastExecutionOutcome(log)).toBe('open')
    expect(
      lastExecutionOutcome([
        ...log,
        ...buildLog([]),
        {
          ...log[0],
          seq: 2,
          type: 'execution.ended',
          payload: { instance: 'i', workspaceRef: 'w', outcome: 'lost' },
        } as AbEvent,
      ]),
    ).toBe('lost')
  })
})
