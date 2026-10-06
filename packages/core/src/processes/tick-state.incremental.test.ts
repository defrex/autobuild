import { describe, expect, test } from 'bun:test'
import {
  checkAgainstReference,
  generatedLogs,
  randomRepoItem,
  repoLog,
} from '../kernel/incremental-fixtures'
import type { RepositoryEvent } from '../events/repository'
import { hasOpenTick, openTickReducer } from './tick-state'

// The original `findLast` implementation from cli/dispatch-process.ts.
function reference(events: readonly RepositoryEvent[], run: string): boolean {
  const boundary = events.findLast(
    (event) =>
      'run' in event.payload &&
      event.payload.run === run &&
      (event.type === 'dispatcher.tick-started' ||
        event.type === 'dispatcher.tick-completed' ||
        event.type === 'dispatcher.tick-failed'),
  )
  return boundary?.type === 'dispatcher.tick-started'
}

describe('hasOpenTick reducer', () => {
  test('matches the original for each run, ordered and shuffled', () => {
    const logs = generatedLogs(repoLog, randomRepoItem)
    for (const run of ['r1', 'r2', 'r3']) {
      checkAgainstReference(openTickReducer(run), logs, (events) => reference(events, run))
    }
  })
  test('a started tick is open until a later boundary for the same run', () => {
    const open = repoLog([['dispatcher.tick-started', { run: 'r' }]])
    expect(hasOpenTick(open, 'r')).toBe(true)
    expect(hasOpenTick(open, 'other')).toBe(false)
    expect(
      hasOpenTick(
        repoLog([
          ['dispatcher.tick-started', { run: 'r' }],
          ['dispatcher.tick-failed', { run: 'r', error: 'x' }],
        ]),
        'r',
      ),
    ).toBe(false)
  })
})
