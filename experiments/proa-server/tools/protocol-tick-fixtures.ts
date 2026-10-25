/** Atomic tick boundary oracle; only the generated fixtures enter Rust. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { EventValidationError } from '../../../packages/core/src/events/catalog'
import { validateTickFinish } from '../../../packages/core/src/store/repo-tick'
import { emptyTickReport } from '../../../packages/core/src/processes/dispatcher'
import type { RepositoryEventWrite } from '../../../packages/core/src/events/repository'
import type { RepoTickCompletion } from '../../../packages/core/src/store/types'
import { experiment, root } from './fixture-core'

export const tickFixturePath = resolve(experiment, 'fixtures/protocol-ticks.json')
export function tickFixtures() {
  const {
    queued,
    janitorDiagnostics,
    blockedDiagnostics,
    ticketDiagnostics,
    creationDiagnostics,
    dependencyDiagnostics,
    ...counters
  } = emptyTickReport()
  const complete = { outcome: 'completed', counters }
  const failure = { outcome: 'failed', error: 'failure' }
  const start = {
    actor: { kind: 'dispatcher' },
    type: 'dispatcher.tick-started',
    payload: { run: 'owner', startedAt: '2026-01-01T00:00:00.000Z' },
  }
  const completed = {
    actor: { kind: 'dispatcher' },
    type: 'dispatcher.tick-completed',
    payload: {
      run: 'owner',
      queued,
      counters,
      janitorDiagnostics,
      ticketDiagnostics,
      dependencyDiagnostics,
    },
  }
  const failed = {
    actor: { kind: 'dispatcher' },
    type: 'dispatcher.tick-failed',
    payload: { run: 'owner', error: 'failure' },
  }
  const inputs: { id: string; holder: string; completion: unknown; events: unknown[] }[] = []
  const add = (id: string, completion: unknown, events: unknown[], holder = 'owner') =>
    inputs.push({ id, holder, completion, events })
  add('quiet', complete, [])
  add('completed', complete, [start, completed])
  add('failed', failure, [start, failed])
  add('missing-failed', failure, [])
  add('start-only', failure, [start])
  add('too-many', failure, [start, failed, failed])
  add('wrong-order', failure, [failed, start])
  add('wrong-outcome', failure, [start, completed])
  add('wrong-holder', failure, [start, failed], 'foreign')
  add('error-mismatch', { ...failure, error: 'other' }, [start, failed])
  add('counter-mismatch', complete, [
    start,
    { ...completed, payload: { ...completed.payload, counters: { ...counters, merged: 1 } } },
  ])
  add('unknown-event', failure, [start, { ...failed, type: 'not-a-type' }])
  add('invalid-actor', failure, [start, { ...failed, actor: { kind: 'kernel' } }])
  add('via', failure, [{ ...start, actor: { kind: 'dispatcher', via: 'operator' } }, failed])
  add('payload', failure, [start, { ...failed, payload: {} }])
  add('start-optional-time', failure, [{ ...start, payload: { run: 'owner' } }, failed])
  add('invalid-start-time', failure, [
    { ...start, payload: { run: 'owner', startedAt: 'wrong' } },
    failed,
  ])
  add('invalid-completion', { outcome: 'failed', error: '' }, [start, failed])
  add('unknown-completion', { outcome: 'other' }, [])
  add('null-completion', null, [])
  add('missing-counters', { outcome: 'completed' }, [])
  add('null-counters', { outcome: 'completed', counters: null }, [])
  add('extra-counter', { outcome: 'completed', counters: { ...counters, extra: 1 } }, [])
  add('bad-counter', { outcome: 'completed', counters: { ...counters, merged: -1 } }, [])
  add('compatibility', failure, [
    start,
    { ...failed, compatibility: { writerVersion: '1.0.0-beta.0', classification: 'advisory' } },
  ])
  const forgeRequests = {
    total: 1,
    restPrimary: 1,
    restNotModified: 0,
    graphql: 0,
    unattributed: 0,
    builds: [{ build: 'build', requests: 1 }],
    complete: true,
  }
  add('forge-failed', { ...failure, forgeRequests }, [start, failed])
  add('forge-completed', { ...complete, counters: { ...counters, forgeRequests } }, [
    start,
    { ...completed, payload: { ...completed.payload, counters: { ...counters, forgeRequests } } },
  ])
  return {
    sources: Object.fromEntries(
      [
        'packages/core/src/store/repo-tick.ts',
        'packages/core/src/events/repository.ts',
        'packages/core/src/ports/forge-telemetry.ts',
        'packages/core/src/processes/dispatcher.ts',
        'experiments/proa-server/tools/protocol-tick-fixtures.ts',
      ].map((name) => [
        name,
        createHash('sha256')
          .update(readFileSync(resolve(root, name)))
          .digest('hex'),
      ]),
    ),
    cases: inputs.map((input) => {
      let oracle: unknown
      try {
        oracle = {
          accepted: validateTickFinish(
            input.holder,
            input.completion as RepoTickCompletion,
            input.events as RepositoryEventWrite[],
          ),
        }
      } catch (error) {
        oracle = {
          rejected: {
            status: error instanceof EventValidationError ? 422 : 500,
            message: error instanceof Error ? error.message : String(error),
          },
        }
      }
      return { ...input, oracle }
    }),
  }
}
export function checkTickFixtures() {
  if (!isDeepStrictEqual(tickFixtures(), JSON.parse(readFileSync(tickFixturePath, 'utf8'))))
    throw new Error(
      'Stale tick validation fixtures; regenerate protocol-tick-fixtures.ts --generate',
    )
}
if (import.meta.main) {
  if (process.argv.includes('--generate')) {
    const formatted = Bun.spawnSync(
      [resolve(root, 'node_modules/.bin/biome'), 'format', '--stdin-file-path', tickFixturePath],
      { stdin: Buffer.from(JSON.stringify(tickFixtures())), stdout: 'pipe', stderr: 'pipe' },
    )
    if (formatted.exitCode) throw new Error(formatted.stderr.toString())
    await Bun.write(tickFixturePath, formatted.stdout)
  } else checkTickFixtures()
  console.log('Tick validation fixture freshness passed')
}
