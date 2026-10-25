/** Executable catalog metadata and independent native reducer replay oracles. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { restackFixtures } from './protocol-restack-fixtures'
import { phaseSpecFor } from '../../../packages/core/src/kernel/phases'
import { POLICY_PHASE_FAILURE_RESET_SCOPES } from '../../../packages/core/src/processes/phase-failure-budget'
import { executionProgress } from '../../../packages/core/src/processes/execution-no-progress'
import { compatibilityMetadataSchema } from '../../../packages/core/src/events/policy'
import { REDUCERS } from '../../../packages/core/src/kernel/reducer-registry'
import {
  reducerValueRequestSchema,
  resolveReducerValue,
} from '../../../packages/core/src/store/reducer-values'
import { encodeReducerValue } from '../../../packages/core/src/store/reducer-value-validation'
import { projectStoredEvents } from '../../../packages/core/src/events/compatibility'
import { schemaNode } from './protocol-fixtures-schema'
import { root, experiment, sources, schemas, witnessEvent, readCorpus } from './fixture-core'

export const reducerCatalogPath = resolve(experiment, 'fixtures/protocol-reducer-catalog.json')
export const reducerFixturePath = resolve(experiment, 'fixtures/protocol-reducers.json.gz')
export const supportedReducers = [
  'build',
  'repositoryReadFacts',
  'ticketMigrations',
  'dispatchUpgrade',
  'repositoryAttention',
  'harvest',
  'dispatchSettings',
  'forgeHealthValue',
  'effectiveConfig',
  'sandboxStates',
  'openHarvestExecutions',
  'autoMergeDefault',
  'dispatcherRunFacts',
  'dispatchStatus',
  'openTick',
  'baseBranchValue',
  'publishedBranchHeadValue',
  'verifyDiffBaseValue',
  'recordedBaseShaValue',
  'openBuildWorkspace',
  'openWorkspace',
  'openExecution',
  'lastExecutionOutcome',
  'setupStreak',
  'pinnedAssets',
  'infrastructureFailureReset',
  'buildDelegation',
  'harvestDelegation',
  'buildDigest',
  'currentPrAttachments',
  'pendingPrAttachmentReclaims',
  'summaryRequests',
  'executionNoProgress',
  'currentDeferralObservation',
  'dispatchFailureBudget',
  'phaseFailures',
  'dashboardFacts',
  'terminalGuard',
  'buildStreamSeed',
  'buildReadFacts',
  'nodeRestack',
  'leafRestack',
] as const
const argsFor = (name: string): Record<string, string | boolean | number> =>
  name === 'dispatchFailureBudget'
    ? { infrastructureOwnsWorkspace: false }
    : name === 'phaseFailures'
      ? { phase: 'plan', round: 1 }
      : name === 'terminalGuard'
        ? { phase: 'plan', round: 1, session: 'session-a' }
        : ['dispatcherRunFacts', 'dispatchStatus', 'openTick'].includes(name)
          ? { run: 'run-a' }
          : {}

export function reducerFixtures() {
  const catalog = Object.fromEntries(
    Object.entries(REDUCERS).map(([name, registration]) => {
      const entry = registration.valueRead
      return [
        name,
        'excluded' in entry
          ? { excluded: entry.excluded, version: registration.reducer.version }
          : {
              scope: entry.scope,
              version: registration.reducer.version,
              args: schemaNode(entry.args, `reducer.${name}.args`),
            },
      ]
    }),
  )
  const request = reducerValueRequestSchema
    .omit({ args: true })
    .extend({ args: z.record(z.string(), z.unknown()).optional() })
  const inputs: { scope: 'build' | 'repo'; raw: string }[] = []
  const add = (scope: 'build' | 'repo', input: unknown) =>
    inputs.push({ scope, raw: JSON.stringify(input) })
  for (const [name, registration] of Object.entries(REDUCERS)) {
    const entry = registration.valueRead,
      scope = 'excluded' in entry ? 'build' : entry.scope
    for (const args of [
      undefined,
      {},
      argsFor(name),
      { extra: true },
      null,
      [],
      { phase: 'bad', round: -1, session: '' },
    ])
      add(scope, { reducer: name, ...(args === undefined ? {} : { args }) })
    add(scope === 'build' ? 'repo' : 'build', { reducer: name, args: argsFor(name) })
  }
  for (const input of [
    null,
    [],
    {},
    { reducer: '' },
    { reducer: 'a'.repeat(65) },
    { reducer: 'missing' },
    { reducer: 'toString' },
    { reducer: '__proto__' },
    { reducer: 4 },
    { reducer: 'build', extra: 1 },
    { reducer: 'build', args: { x: [null, true, {}] } },
  ])
    add('build', input)
  for (const raw of [
    '{"reducer":"build","args":{"x":1e400}}',
    '{"reducer":"build","args":{"x":[1e400]}}',
    '{"reducer":"build","args":{"x":{"y":-1e400}}}',
    '{"reducer":4,"extra":true,"args":{"x":1e400}}',
    '{"reducer":"build","args":{"__proto__":1e400}}',
    '{"reducer":"build","args":{"x":{"__proto__":1e400}}}',
    '{"reducer":"build","args":{"x":[{"__proto__":1e400}]}}',
  ])
    inputs.push({ scope: 'build', raw })
  for (const raw of [
    '',
    '{',
    '[',
    '{bad}',
    'NaN',
    'undefined',
    'truex',
    '[1,]',
    '{"x":}',
    '0 1',
    '{"x":1',
    '{"x":1,}',
    '"abc',
    '{"a" 1}',
    '{"a":tru}',
  ])
    inputs.push({ scope: 'build', raw })
  const validation = inputs.map(({ scope, raw }) => {
    try {
      const resolved = resolveReducerValue(
        scope === 'build' ? { kind: 'build', slug: 'fixture' } : { kind: 'repo', repo: 'fixture' },
        JSON.parse(raw),
      )
      return { scope, raw, accepted: { name: resolved.name, version: resolved.reducer.version } }
    } catch (error) {
      return { scope, raw, rejected: String(error) }
    }
  })
  const replay: object[] = []
  const scenario = readCorpus()
    .fixtures.filter((f) => f.scope !== 'session' && !f.expectedError && !f.rustUnreadable)
    .filter((_, i) => i % 137 === 0)
    .slice(0, 48)
  const event = (type: string, patch: Record<string, unknown> = {}) => {
    const e = witnessEvent('build', type, schemas.build[type as keyof typeof schemas.build])
    return { ...e, payload: { ...(e.payload as object), ...patch } }
  }
  const sequence = (id: string, events: ReturnType<typeof event>[]) => ({
    id,
    events: events.map((e, i) => ({ ...e, seq: i + 1 })),
  })
  const focused = [
    sequence('focused/nullable-head', [
      event('restack.rewritten', { observedHead: null }),
      event('reconcile.rewritten', { observedHead: null }),
    ]),
    sequence('focused/phase-reset', [
      event('phase.failed', { phase: 'plan', round: 1, error: 'first', willRetry: true }),
      event('phase.failed', { phase: 'plan', round: 1, error: 'second', willRetry: false }),
      event('escalation.raised', {
        id: 'phase-reset',
        phase: 'plan',
        round: 1,
        source: 'policy',
        policyCause: 'phase-attempt-limit',
      }),
      event('escalation.answered', { id: 'phase-reset', resolution: 'retry' }),
      event('phase.failed', { phase: 'plan', round: 1, error: 'after-reset', willRetry: true }),
    ]),
    sequence('focused/attachments', [
      event('pr-attachment.designated'),
      event('pr-attachment.hosted', { designationSeq: 1 }),
      event('pr-attachment.reclaimed', { hostedSeq: 2 }),
      event('spec.revised'),
      event('pr-attachment.designated'),
      event('pr-summary.requested'),
      event('pr-summary.settled', { request: 6 }),
    ]),
    sequence('focused/no-progress', [
      event('execution.started', { instance: 'a' }),
      event('execution.ended', { instance: 'a', outcome: 'completed', exitCode: 0 }),
      event('execution.started', { instance: 'b' }),
      event('runner.attached'),
      event('execution.ended', { instance: 'b', outcome: 'completed', exitCode: 0 }),
      event('escalation.raised', {
        id: 'execution-reset',
        phase: 'setup',
        source: 'policy',
        policyCause: 'execution-no-progress',
      }),
      event('escalation.answered', { id: 'execution-reset', resolution: 'retry' }),
      event('execution.started', { instance: 'c' }),
      event('plan.started'),
      event('execution.ended', { instance: 'c', outcome: 'completed', exitCode: 0 }),
    ]),
    sequence('focused/deferral', [
      event('observation.recorded', { refs: ['auto-merge-gate:pr:1:command:1'] }),
      event('observation.recorded'),
      event('plan.started'),
      event('plan.completed'),
      event('pr.closed'),
    ]),
  ]
  for (const name of supportedReducers) {
    const entry = REDUCERS[name]!.valueRead
    if ('excluded' in entry) throw new Error(name)
    const scope = entry.scope === 'repo' ? 'repository' : 'build'
    const histories = [
      { id: 'empty', events: [] },
      ...Object.entries(schemas[scope]).map(([type, schema]) => ({
        id: `witness/${type}`,
        events: [witnessEvent(scope, type, schema)],
      })),
      ...scenario.filter((f) => f.scope === scope).map((f) => ({ id: f.id, events: f.events })),
      ...(scope === 'build'
        ? [
            ...focused,
            ...restackFixtures()
              .cases.filter((c) => 'accepted' in (c.oracle as object))
              .map((c) => ({ id: `restack-positive/${c.id}`, events: c.events as never })),
          ]
        : []),
    ]
    for (const history of histories)
      for (const args of name === 'dispatchFailureBudget'
        ? [{ infrastructureOwnsWorkspace: false }, { infrastructureOwnsWorkspace: true }]
        : [argsFor(name)]) {
        try {
          const resolved = resolveReducerValue(
            entry.scope === 'repo'
              ? { kind: 'repo', repo: 'fixture' }
              : { kind: 'build', slug: 'fixture' },
            { reducer: name, args },
          )
          const projected = projectStoredEvents(history.events as never)
          const value = encodeReducerValue(
            resolved.reducer.reduce(resolved.entry.adapt(projected as never)),
          )
          replay.push({
            id: `${name}/${history.id}/${JSON.stringify(args)}`,
            scope: entry.scope,
            name,
            args,
            events: history.events,
            value,
          })
        } catch {
          /* Some standalone ontology witnesses intentionally require prior state. */
        }
      }
  }
  return {
    sources: {
      ...sources(),
      ...Object.fromEntries(
        [
          'packages/core/src/kernel/reducer-registry.ts',
          'packages/core/src/store/reducer-values.ts',
          'packages/core/src/store/reducer-value-validation.ts',
          'experiments/proa-server/tools/protocol-reducer-fixtures.ts',
        ].map((file) => [
          file,
          createHash('sha256')
            .update(readFileSync(resolve(root, file)))
            .digest('hex'),
        ]),
      ),
    },
    terminalEvents: Object.fromEntries(
      [
        'plan',
        'plan-review',
        'implement',
        'code-review',
        'verify:types',
        'finalize',
        'reconcile',
      ].map((name) => [
        name.startsWith('verify:') ? 'verify' : name,
        phaseSpecFor(name as never).terminalEvent,
      ]),
    ),
    phaseFailureResets: POLICY_PHASE_FAILURE_RESET_SCOPES,
    executionProgress,
    compatibilitySchema: schemaNode(compatibilityMetadataSchema, 'compatibilityMetadata'),
    request: schemaNode(request, 'reducerValue'),
    catalog,
    supported: supportedReducers,
    validation,
    replay,
  }
}
export function readReducerFixtures() {
  return JSON.parse(gunzipSync(readFileSync(reducerFixturePath)).toString()) as ReturnType<
    typeof reducerFixtures
  >
}
export function checkReducerFixtures() {
  if (!isDeepStrictEqual(readReducerFixtures(), reducerFixtures()))
    throw new Error('Stale reducer fixtures; regenerate protocol-reducer-fixtures.ts --generate')
}
function runtimeCatalog(fixtures: ReturnType<typeof reducerFixtures>) {
  return Object.fromEntries(
    (
      [
        'request',
        'catalog',
        'supported',
        'compatibilitySchema',
        'executionProgress',
        'phaseFailureResets',
        'terminalEvents',
      ] as const
    ).map((key) => [key, fixtures[key]]),
  )
}
if (import.meta.main) {
  if (process.argv.includes('--generate')) {
    const fixtures = reducerFixtures()
    await Bun.write(reducerFixturePath, gzipSync(JSON.stringify(fixtures)))
    const formatted = Bun.spawnSync(
      [resolve(root, 'node_modules/.bin/biome'), 'format', '--stdin-file-path', reducerCatalogPath],
      {
        stdin: Buffer.from(JSON.stringify(runtimeCatalog(fixtures))),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    if (formatted.exitCode) throw new Error('Cannot format reducer catalog')
    await Bun.write(reducerCatalogPath, formatted.stdout)
  } else {
    checkReducerFixtures()
    if (
      !isDeepStrictEqual(
        runtimeCatalog(reducerFixtures()),
        JSON.parse(readFileSync(reducerCatalogPath, 'utf8')),
      )
    )
      throw new Error('Stale reducer runtime catalog')
  }
  console.log('Reducer catalog/validation/replay fixtures fresh')
}
