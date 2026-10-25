/** Offline display oracle. Runtime Rust never invokes this module. */
import { createHash } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { gunzipSync } from 'node:zlib'
import type { Config } from '../../../packages/core/src/config/schema'
import { parseConfig } from '../../../packages/core/src/config/load'
import { buildReducer } from '../../../packages/core/src/kernel/reducer'
import { dashboardFactsReducer } from '../../../packages/core/src/cli/dashboard/facts'
import { projectBuild } from '../../../packages/core/src/cli/dashboard/model'
import { landingPolicyDisplay } from '../../../packages/core/src/cli/dashboard/landing-display'
import { displayText, cellWidth, splitCells } from '../../../packages/core/src/cli/dashboard/cells'
import type { AbEvent } from '../../../packages/core/src/events/catalog'
import type { BuildRecord, StreamRecord } from '../../../packages/core/src/store/types'
import { experiment, root, readCorpus, gzipCorpus, sources } from './fixture-core'

export const configuration = parseConfig(`
[tickets]
source = "file"
readyState = "ready"
[commands]
lint = "bun lint"
test = "bun test"
[verify]
steps = ["lint", "test"]
[verify.lint]
kind = "check"
command = "lint"
[verify.test]
kind = "check"
command = "test"
`)

export function projectionOutcome(
  record: BuildRecord,
  events: AbEvent[],
  streams?: readonly StreamRecord[],
  pinnedConfig?: Config,
) {
  try {
    const state = buildReducer.reduce(events)
    return {
      row: projectBuild(record, state, configuration, events, streams, pinnedConfig),
      facts: dashboardFactsReducer.reduce(events),
      landing: landingPolicyDisplay(state.landing),
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export function generateProjection() {
  const corpus = readCorpus()
  const inputs = [
    ...new Set([
      ...Object.keys(sources()),
      'experiments/proa-server/fixtures/corpus.json.gz',
      'experiments/proa-server/tools/projection-fixtures.ts',
    ]),
  ].sort()
  const hashes = Object.fromEntries(
    inputs.map((path) => [
      path,
      createHash('sha256')
        .update(readFileSync(resolve(root, path)))
        .digest('hex'),
    ]),
  )
  const clock = '2026-10-24T12:00:00.000Z'
  return {
    manifest: {
      format: 1,
      clock,
      sources: hashes,
      oracle: 'projectBuild(record, buildReducer.reduce(events), config, events, streams)',
    },
    config: configuration,
    fixtures: corpus.fixtures
      .filter((fixture) => fixture.scope === 'build')
      .map((fixture) => {
        const record: BuildRecord = {
          slug: `projection-${createHash('sha256').update(fixture.id).digest('hex').slice(0, 16)}`,
          repo: 'projection',
          createdAt: clock,
          updatedAt: clock,
        }
        const events = fixture.events as unknown as AbEvent[]
        return {
          id: fixture.id,
          aliases: fixture.aliases,
          record,
          events,
          boundaries: fixture.boundaries,
          unreadable: fixture.rustUnreadable,
          expected: projectionOutcome(record, events),
        }
      }),
    sessionCases: corpus.fixtures
      .filter(
        (fixture) =>
          fixture.scope === 'build' &&
          fixture.events.some((event) => event.type === 'session.started'),
      )
      .sort((a, b) => b.events.length - a.events.length)
      .slice(0, 8)
      .flatMap((fixture, index) => {
        const record: BuildRecord = {
          slug: `session-case-${index}`,
          repo: 'projection',
          createdAt: clock,
          updatedAt: clock,
        }
        const events = fixture.events as unknown as AbEvent[]
        const labels = [
          ...new Set(
            events
              .filter((event) => event.type === 'session.started')
              .map((event) => `session:${event.payload.session}`),
          ),
        ]
        const open: StreamRecord[] = labels.map((label, index) => ({
          id: `stream-${index}`,
          scope: { kind: 'build', build: record.slug },
          label,
          format: 'ai-ui-message-stream/v1',
          status: 'open',
          createdAt: clock,
        }))
        open.push({
          id: 'unmatched',
          scope: { kind: 'build', build: record.slug },
          label: 'session:unmatched',
          format: 'ai-ui-message-stream/v1',
          status: 'open',
          createdAt: clock,
        })
        const closed: StreamRecord[] = open.map((stream) => ({
          ...stream,
          status: 'closed',
          closedAt: clock,
          outcome: 'completed',
          artifact: { kind: 'stream-document', revision: 0, blobRef: 'fixture-reference' },
        }))
        return [undefined, [], open, closed].map((streams, variant) => {
          const pinnedConfig =
            variant === 3
              ? { ...configuration, verify: { ...configuration.verify, steps: ['test'] } }
              : undefined
          return {
            id: `${fixture.id}/streams-${variant}`,
            record,
            events,
            streams,
            pinnedConfig,
            expected: projectionOutcome(record, events, streams, pinnedConfig),
          }
        })
      }),
    cells: ['', 'ASCII', '日本語', 'é', '👩‍💻', 'A\nB\u001b[31m', 'עברית', '🇨🇦'].map((value) => ({
      value,
      text: displayText(value),
      width: cellWidth(displayText(value)),
      rows: splitCells(displayText(value), 4),
    })),
  }
}

export function checkProjection(stored: unknown) {
  // The oracle contract is JSON, matching the reducer corpus and Rust wire values.
  // Optional TypeScript properties whose value is undefined are omitted on disk.
  if (!isDeepStrictEqual(stored, JSON.parse(JSON.stringify(generateProjection()))))
    throw new Error(
      'stale projection oracle; regenerate explicitly with tools/projection-fixtures.ts --write',
    )
}

if (import.meta.main) {
  const path = resolve(experiment, 'fixtures/projection.json.gz')
  if (process.argv.includes('--write')) {
    const corpus = generateProjection()
    writeFileSync(`${path}.tmp`, gzipCorpus(corpus))
    renameSync(`${path}.tmp`, path)
    writeFileSync(
      resolve(experiment, 'fixtures/projection-manifest.json'),
      `${JSON.stringify(corpus.manifest, null, 2)}\n`,
    )
    console.log(`generated ${corpus.fixtures.length} projection fixtures`)
  } else {
    checkProjection(JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')))
    console.log('projection oracle is fresh')
  }
}
