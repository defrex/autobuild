import { gzipSync, gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { z } from 'zod'
import { validateEventWrite } from '../../../packages/core/src/events/catalog'
import { validateRepositoryEventWrite } from '../../../packages/core/src/events/repository'
import { validateSessionEventWrite } from '../../../packages/core/src/events/sessions'
import { eventPayloadSchemas } from '../../../packages/core/src/events/payloads'
import { repositoryEventPayloadSchemas } from '../../../packages/core/src/events/repository'
import { sessionEventPayloadSchemas } from '../../../packages/core/src/events/sessions'
import { buildReducer } from '../../../packages/core/src/kernel/reducer'
import {
  repositoryStateEventsReducer,
  journalViewReducer,
} from '../../../packages/core/src/store/repo-state-events'
import { repositoryReadFactsReducer } from '../../../packages/core/src/kernel/read-facts'
import { encodeReducerValue } from '../../../packages/core/src/store/reducer-value-validation'
import { sessionReducer } from '../../../packages/core/src/store/session-reducer'
import { reducerValueSchema } from '../../../packages/hosted-store-service/src/compatibility-fixtures/reducer-values-v1.0.0-beta.0'
export const root = resolve(import.meta.dir, '../../..')
export const experiment = resolve(import.meta.dir, '..')
export const schemas = {
  build: eventPayloadSchemas,
  repository: repositoryEventPayloadSchemas,
  session: sessionEventPayloadSchemas,
}
export type Scope = keyof typeof schemas

export interface FixtureEvent {
  type: string
  seq: number
  payload: unknown
  [key: string]: unknown
}
export interface Fixture {
  id: string
  scope: string
  events: FixtureEvent[]
  expected?: unknown
  expectedError?: unknown
  rustUnreadable?: unknown
  boundaries?: number[]
  aliases?: string[]
}
export interface Corpus {
  manifest: {
    sources: Record<string, string>
    catalog: Record<string, string[]>
    versions?: Record<string, Record<string, number>>
  }
  fixtures: Fixture[]
  decodingWitnesses?: { scope: string; event: FixtureEvent }[]
}
interface JsonSchema {
  const?: unknown
  enum?: unknown[]
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  type?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  minItems?: number
  minimum?: number
  exclusiveMinimum?: number
  format?: string
  pattern?: string
  minLength?: number
}

export const reducers = {
  build: { build: buildReducer },
  repository: {
    repositoryStateEvents: repositoryStateEventsReducer,
    journalView: journalViewReducer,
    repositoryReadFacts: repositoryReadFactsReducer,
  },
  session: { session: sessionReducer },
}
export function expected(scope: Scope, events: unknown[]) {
  return Object.fromEntries(
    Object.entries(reducers[scope]).map(([name, reducer]) => {
      // A reducer's public wire value is JSON; ordinary JSON omission semantics apply.
      const value = encodeReducerValue(reducer.reduce(events as never))
      reducerValueSchema.parse({ version: reducer.version, cursor: events.length, value })
      return [name, value]
    }),
  )
}
export function catalog() {
  return Object.fromEntries(
    Object.entries(schemas).map(([scope, types]) => [scope, Object.keys(types).sort()]),
  )
}
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(resolve(directory, entry.name))
      : /\.(?:[cm]?[jt]sx?|json)$/.test(entry.name)
        ? [resolve(directory, entry.name)]
        : [],
  )
}
export function sources() {
  const paths = [
    ...files(resolve(root, 'packages/core/src')),
    ...files(resolve(root, 'packages/hosted-store-service/src')),
    ...files(resolve(root, 'packages/postgres-store/src')),
    ...[
      'client-compatibility.contract.test.ts',
      'remote-store.seam.test.ts',
      'mixed-version.test.ts',
    ].map((name) => resolve(root, 'packages/hosted-store-service/src', name)),
  ]
  paths.push(
    ...[
      'package.json',
      'bun.lock',
      'packages/core/package.json',
      'packages/hosted-store-service/package.json',
      'packages/postgres-store/package.json',
      'experiments/proa-server/package.json',
      'experiments/proa-server/bun.lock',
    ].map((name) => resolve(root, name)),
  )
  paths.push(
    ...['capture-scenario-logs.ts', 'fixture-core.ts', 'generate-fixtures.ts'].map((name) =>
      resolve(import.meta.dir, name),
    ),
  )
  return Object.fromEntries(
    [...new Set(paths)]
      .sort()
      .map((path) => [
        relative(root, path),
        createHash('sha256').update(readFileSync(path)).digest('hex'),
      ]),
  )
}
export function boundaries(length: number) {
  return length <= 20
    ? Array.from({ length: length + 1 }, (_, i) => i)
    : [
        ...new Set([
          0,
          1,
          2,
          Math.floor(length / 4),
          Math.floor(length / 2),
          length - 2,
          length - 1,
          length,
        ]),
      ]
}
// Generate from the authoritative runtime schemas, then validate every witness.
export function witness(schema: z.ZodType): unknown {
  const json = z.toJSONSchema(schema, { unrepresentable: 'any' }) as JsonSchema
  function sample(node: JsonSchema, key = ''): unknown {
    if (node.const !== undefined) return node.const
    if (node.enum) return node.enum[0]
    if (node.anyOf || node.oneOf) return sample((node.anyOf ?? node.oneOf)![0]!, key)
    if (node.type === 'object' || node.properties)
      return Object.fromEntries(
        (node.required ?? []).map((name: string) => [name, sample(node.properties![name]!, name)]),
      )
    if (node.type === 'array')
      return Array.from({ length: node.minItems ?? 0 }, () => sample(node.items ?? {}, key))
    if (node.type === 'number' || node.type === 'integer')
      return Math.max(
        node.minimum ?? 1,
        node.exclusiveMinimum !== undefined ? node.exclusiveMinimum + 1 : 1,
      )
    if (node.type === 'boolean') return false
    if (node.type === 'null') return null
    if (key === 'phase') return 'plan'
    if (key === 'workspacePath') return '/tmp/proa-witness'
    if (key === 'mediaType') return 'image/png'
    if (key === 'repository') return 'owner/repository'
    if (node.format === 'uuid') return '00000000-0000-4000-8000-000000000001'
    if (node.pattern?.includes('{40}')) return 'a'.repeat(40)
    if (node.format === 'date-time') return '2026-01-01T00:00:00.000Z'
    if (node.format === 'uri' || /url/i.test(key)) return 'https://example.test/value'
    if (/sha|hash|checksum/i.test(key)) return 'a'.repeat(64)
    return 'witness'.padEnd(node.minLength ?? 0, 'x')
  }
  const value = sample(json) as Record<string, unknown>
  if ('landing' in value && 'landingHead' in value && value.landing === value.landingHead)
    value.landingHead = 'b'.repeat(40)
  if (Object.hasOwn((json.properties ?? {}) as object, 'decisionSeq')) value.decisionSeq = 1
  return schema.parse(value)
}

export function witnessEvent(scope: Scope, type: string, schema: z.ZodType) {
  const payload = witness(schema)
  const validate = {
    build: validateEventWrite,
    repository: validateRepositoryEventWrite,
    session: validateSessionEventWrite,
  }[scope]
  for (const actor of [
    { kind: 'kernel' },
    { kind: 'dispatcher' },
    { kind: 'human', user: 'witness' },
    { kind: 'agent', role: 'implement', session: 'witness' },
  ]) {
    try {
      const validated = validate({ type, actor, payload })
      return {
        [scope === 'repository' ? 'repo' : scope]: 'witness',
        seq: 1,
        ts: '2026-01-01T00:00:00.000Z',
        ...validated,
      }
    } catch {}
  }
  throw new Error(`no valid actor for ${scope}/${type}`)
}

export function eventSchemas() {
  return Object.fromEntries(
    Object.entries(schemas).map(([scope, entries]) => [
      scope,
      Object.fromEntries(
        Object.entries(entries).map(([name, schema]) => [
          name,
          z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }),
        ]),
      ),
    ]),
  )
}

export function oracleOutcome(scope: Scope, events: unknown[]) {
  try {
    return { expected: expected(scope, events) }
  } catch (error) {
    return {
      expectedError: {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}
export function unknownEvent(scope: Scope, events: { type: string; seq: number }[]) {
  const event = events.find((event) => !Object.hasOwn(schemas[scope], event.type))
  return event ? { type: event.type, seq: event.seq } : undefined
}

export function deduplicateFixtures(fixtures: Fixture[]): Fixture[] {
  const unique = new Map<string, Fixture>()
  for (const fixture of fixtures) {
    const identity = createHash('sha256')
      .update(
        JSON.stringify([fixture.scope, fixture.events, fixture.expected, fixture.expectedError]),
      )
      .digest('hex')
    const prior = unique.get(identity)
    if (prior) prior.aliases!.push(...(fixture.aliases ?? [fixture.id]))
    else unique.set(identity, { ...fixture, aliases: [...(fixture.aliases ?? [fixture.id])] })
  }
  return [...unique.values()]
}
export function gzipCorpus(corpus: unknown) {
  return gzipSync(JSON.stringify(corpus), { level: 9 })
}
export function readCorpus(path = resolve(experiment, 'fixtures/corpus.json.gz')): Corpus {
  const bytes = readFileSync(path)
  return JSON.parse((path.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8'))
}

export function reducerVersions() {
  return Object.fromEntries(
    Object.entries(reducers).map(([scope, entries]) => [
      scope,
      Object.fromEntries(Object.entries(entries).map(([name, reducer]) => [name, reducer.version])),
    ]),
  )
}
