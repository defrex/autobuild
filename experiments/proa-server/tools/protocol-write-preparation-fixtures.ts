/** Producer-boundary oracles. Generated data is an input, never a runtime TS service. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  buildEventPolicy,
  repositoryEventPolicy,
  compatibilityMetadataSchema,
} from '../../../packages/core/src/events/policy'
import { prepareEventWrite } from '../../../packages/core/src/events/catalog'
import { prepareRepositoryEventWrite } from '../../../packages/core/src/events/repository'
import { validateCreatedEvent } from '../../../packages/core/src/store/new-build'
import { validateExpectedSeq } from '../../../packages/core/src/store/types'
import { AUTOBUILD_VERSION } from '../../../packages/core/src/store/remote/version'
import { readWriteCorpus } from './protocol-fixtures-core'
import { experiment, root, sources } from './fixture-core'

export const preparationFixturePath = resolve(
  experiment,
  'fixtures/protocol-write-preparation.json',
)
function result(call: () => unknown) {
  try {
    return { accepted: call() ?? null }
  } catch (error) {
    return {
      rejected: {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}
function compatibilitySchema() {
  const schema = compatibilityMetadataSchema._zod.def
  if (Object.keys(schema).sort().join(',') !== 'catchall,shape,type')
    throw new Error('Unsupported compatibility object checks')
  const shape = schema.shape
  if (
    Object.keys(shape).join(',') !== 'writerVersion,classification' ||
    schema.catchall?._zod.def.type !== 'never'
  )
    throw new Error('Unsupported compatibility metadata shape')
  const writer = shape.writerVersion._zod.def
  const classification = shape.classification._zod.def
  if (
    Object.keys(writer).sort().join(',') !== 'checks,type' ||
    Object.keys(classification).sort().join(',') !== 'entries,type'
  )
    throw new Error('Unsupported compatibility field checks')
  const checks = writer.checks?.map((check) => check._zod.def)
  if (
    writer.type !== 'string' ||
    JSON.stringify(checks) !== '[{"check":"min_length","minimum":1}]' ||
    classification.type !== 'enum'
  )
    throw new Error('Unsupported compatibility metadata field semantics')
  return {
    type: 'object',
    shape: {
      writerVersion: { type: 'string', checks: [{ check: 'min_length', minimum: 1 }] },
      classification: { type: 'enum', values: Object.values(classification.entries) },
    },
    strict: true,
  }
}
export function preparationFixtures() {
  const corpus = readWriteCorpus()
  const cases: { scope: string; id: string; input: unknown; oracle: ReturnType<typeof result> }[] =
    []
  for (const [scope, prepare, kind] of [
    ['build', prepareEventWrite, 'build.created'],
    ['repository', prepareRepositoryEventWrite, 'harvest.pause-requested'],
  ] as const) {
    const witness = corpus.cases.find(
      (row) => row.scope === scope && row.id === `${scope}/${kind}/valid`,
    )!.input
    for (const [label, metadata] of [
      ['absent', undefined],
      ['null', null],
      ['empty', {}],
      ['extra', { writerVersion: 'historical', classification: 'decisive', extra: true }],
      ['wrong-classification', { writerVersion: 'historical', classification: 'advisory' }],
      ['blank-version', { writerVersion: '', classification: 'decisive' }],
      ['invalid-classification', { writerVersion: 'old', classification: 'other' }],
      ['invalid-types', { writerVersion: 123, classification: null }],
      ['historical', { writerVersion: '0.9.0', classification: 'decisive' }],
    ] as const) {
      const input = { ...witness, ...(metadata === undefined ? {} : { compatibility: metadata }) }
      cases.push({
        scope,
        id: `${scope}/metadata/${label}`,
        input,
        oracle: result(() => prepare(input as never)),
      })
    }
  }
  const escalation = corpus.cases.find(
    (row) => row.scope === 'build' && row.id === 'build/escalation.raised/valid',
  )!.input
  for (const actor of [
    { kind: 'kernel' },
    { kind: 'dispatcher' },
    { kind: 'agent', role: 'implement', session: 's' },
  ]) {
    for (const source of [undefined, 'policy', 'agent', 'kernel'] as const) {
      for (const policyCause of [
        undefined,
        'infrastructure-failure-limit',
        'dispatch-failure-limit',
        'execution-no-progress',
        'verify-attempt-limit',
      ] as const) {
        const payload = { ...(escalation.payload as object) } as Record<string, unknown>
        delete payload.source
        delete payload.policyCause
        if (source !== undefined) payload.source = source
        if (policyCause !== undefined) payload.policyCause = policyCause
        const input = { ...escalation, actor, payload }
        cases.push({
          scope: 'build',
          id: `build/escalation/${actor.kind}/${source}/${policyCause}`,
          input,
          oracle: result(() => prepareEventWrite(input as never)),
        })
      }
    }
  }
  const created = corpus.cases.find(
    (row) => row.scope === 'build' && row.id === 'build/build.created/valid',
  )!.input
  const other = corpus.cases.find(
    (row) => row.scope === 'build' && row.id === 'build/observation.recorded/valid',
  )!.input
  for (const [id, write] of [
    ['absent', undefined],
    ['valid', created],
    ['wrong-type', other],
    ['invalid', { ...created, payload: null }],
  ] as const) {
    const input = {
      slug: 'proof',
      repo: 'proof',
      ...(write === undefined ? {} : { created: write }),
    }
    cases.push({
      scope: 'created',
      id: `created/${id}`,
      input,
      oracle: result(() => validateCreatedEvent(input as never)),
    })
  }
  for (const value of [
    0,
    1,
    9007199254740991,
    9007199254740992,
    1e100,
    -1,
    -1.5,
    -0.000001,
    -0.0000001,
    -2.5e-6,
    -1e-100,
    -1e100,
    0.5,
    '1',
    null,
    {},
    [],
  ])
    cases.push({
      scope: 'expected-seq',
      id: `expected-seq/${JSON.stringify(value)}`,
      input: value,
      oracle: result(() => {
        validateExpectedSeq(value as number)
        return true
      }),
    })
  const generator = 'experiments/proa-server/tools/protocol-write-preparation-fixtures.ts'
  return {
    formatVersion: 1,
    sources: {
      ...sources(),
      [generator]: createHash('sha256')
        .update(readFileSync(resolve(root, generator)))
        .digest('hex'),
    },
    writerVersion: AUTOBUILD_VERSION,
    policies: { build: buildEventPolicy, repository: repositoryEventPolicy },
    compatibilitySchema: compatibilitySchema(),
    cases,
  }
}
export function checkPreparationFixtures() {
  if (
    !isDeepStrictEqual(
      JSON.parse(readFileSync(preparationFixturePath, 'utf8')),
      preparationFixtures(),
    )
  )
    throw new Error(
      'Stale producer preparation fixtures; regenerate protocol-write-preparation-fixtures.ts --generate',
    )
}
if (import.meta.main) {
  if (process.argv.includes('--generate')) {
    const child = Bun.spawnSync(
      [
        resolve(root, 'node_modules/.bin/biome'),
        'format',
        '--stdin-file-path',
        preparationFixturePath,
      ],
      { stdin: Buffer.from(JSON.stringify(preparationFixtures())), stdout: 'pipe', stderr: 'pipe' },
    )
    if (child.exitCode) throw new Error('Could not format preparation fixtures')
    await Bun.write(preparationFixturePath, child.stdout)
  } else checkPreparationFixtures()
  console.log('Producer preparation fixture freshness passed')
}
