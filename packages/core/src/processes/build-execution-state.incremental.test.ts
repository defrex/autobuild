import { describe, expect, test } from 'bun:test'
import type { AbEvent } from '../events/catalog'
import {
  buildLog,
  checkAgainstReference,
  generatedLogs,
  randomBuildItem,
} from '../kernel/incremental-fixtures'
import { openWorkspaceReducer, selectOpenWorkspace } from './build-execution-state'

function reference(events: readonly AbEvent[]) {
  let open: { ref: string; path: string; branch: string } | null = null
  for (const event of events) {
    if (event.type === 'workspace.provisioned') {
      open = {
        ref: event.payload.ref,
        path: event.payload.path ?? event.payload.ref,
        branch: event.payload.branch,
      }
    } else if (event.type === 'workspace.released') {
      open = null
    }
  }
  return open
}

describe('selectOpenWorkspace reducer', () => {
  test('matches the original, ordered and shuffled', () => {
    checkAgainstReference(openWorkspaceReducer, generatedLogs(buildLog, randomBuildItem), reference)
  })
  test('falls back to the ref for the path', () => {
    const log = buildLog([
      [
        'workspace.provisioned',
        { provider: 'p', ref: '/r', branch: 'b', base: { source: 'remote', sha: 's' } },
      ],
    ])
    expect(selectOpenWorkspace(log)).toEqual({ ref: '/r', path: '/r', branch: 'b' })
  })
})
