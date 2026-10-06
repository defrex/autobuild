import { describe, expect, test } from 'bun:test'
import type { AbEvent } from '../events/catalog'
import {
  buildLog,
  checkAgainstReference,
  generatedLogs,
  randomBuildItem,
} from '../kernel/incremental-fixtures'
import { recordedBaseSha, recordedBaseShaReducer } from './pipeline-source'

function reference(events: readonly AbEvent[]): string | undefined {
  let base: string | undefined
  for (const event of events) {
    if (event.type === 'workspace.provisioned') base = event.payload.base.sha
  }
  return base
}

describe('recordedBaseSha reducer', () => {
  test('matches the original, ordered and shuffled', () => {
    checkAgainstReference(
      recordedBaseShaReducer,
      generatedLogs(buildLog, randomBuildItem),
      reference,
    )
  })
  test('the newest provisioned base wins', () => {
    const log = buildLog([
      [
        'workspace.provisioned',
        { provider: 'p', ref: 'r', branch: 'b', base: { source: 'remote', sha: 'one' } },
      ],
      [
        'workspace.provisioned',
        { provider: 'p', ref: 'r', branch: 'b', base: { source: 'remote', sha: 'two' } },
      ],
    ])
    expect(recordedBaseSha(log)).toBe('two')
  })
})
