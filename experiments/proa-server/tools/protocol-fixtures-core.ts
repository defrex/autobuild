import { requestSchemas, producerPayloadVariants } from './protocol-fixtures-schema'
/** Strict new-write oracles, deliberately separate from stored-log decoding. */
import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { validateEventWrite } from '../../../packages/core/src/events/catalog'
import { validateRepositoryEventWrite } from '../../../packages/core/src/events/repository'
import { validateSessionEventWrite } from '../../../packages/core/src/events/sessions'
import { MemoryBuildStore } from '../../../packages/core/src/store/memory'
import { createStoreServer } from '../../../packages/hosted-store-service/src/remote-store-server'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import { schemas, sources, witnessEvent, experiment, type Scope } from './fixture-core'

export type Write = { actor: unknown; type: string; payload: unknown; compatibility?: unknown }
export type Outcome = { accepted: unknown } | { rejected: { name: string; message: string } }
export type WriteCase = {
  id: string
  scope: Scope
  input: Write
  oracle: Outcome
  http: { status: number; body: unknown }
}
export type WriteCorpus = {
  formatVersion: 1
  sources: Record<string, string>
  cases: WriteCase[]
  requests: { name: string; id: string; input: unknown; oracle: Outcome }[]
  actorRules: Record<Scope, Record<string, string[]>>
}
export function protocolSources() {
  return {
    ...sources(),
    'packages/core/src/store/repo-tick.ts': createHash('sha256')
      .update(
        readFileSync(resolve(import.meta.dir, '../../../packages/core/src/store/repo-tick.ts')),
      )
      .digest('hex'),
    ...Object.fromEntries(
      [
        'protocol-fixtures-core.ts',
        'protocol-fixtures-schema.ts',
        'generate-protocol-fixtures.ts',
        'check-protocol-fixtures.ts',
      ].map((name) => [
        `experiments/proa-server/tools/${name}`,
        createHash('sha256')
          .update(readFileSync(resolve(import.meta.dir, name)))
          .digest('hex'),
      ]),
    ),
  }
}
const validators = {
  build: validateEventWrite,
  repository: validateRepositoryEventWrite,
  session: validateSessionEventWrite,
}
export function oracle(scope: Scope, input: Write): Outcome {
  try {
    return { accepted: validators[scope](input) }
  } catch (error) {
    return {
      rejected: {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}
const actors = [
  { kind: 'kernel' },
  { kind: 'agent', role: 'implement', session: 'witness' },
  { kind: 'human', user: 'witness' },
  { kind: 'dispatcher' },
  { kind: 'ingester', source: 'witness' },
]
const clock = () => new Date('2026-01-01T00:00:00.000Z')
export async function httpOracle(scope: Scope, input: unknown) {
  const store = new MemoryBuildStore({ clock })
  let path: string
  if (scope === 'build') {
    await store.createBuild({ slug: 'witness', repo: 'witness' })
    path = '/builds/witness/events'
  } else if (scope === 'repository') {
    await store.ensureRepo('witness')
    path = '/repos/witness/events'
  } else {
    const session = await store.createSession({ repo: 'witness', operator: 'witness' })
    path = `/sessions/${session.id}/events`
  }
  const response = await createStoreServer({ store, clock }).fetch(
    new Request(`http://oracle${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-autobuild-version': AUTOBUILD_VERSION,
        'x-autobuild-protocol-version': REMOTE_STORE_PROTOCOL_VERSION,
      },
      body: JSON.stringify(input),
    }),
  )
  const body = (await response.json()) as Record<string, unknown>
  // Store-assigned fields are not validation output. Session IDs are random.
  if (response.status === 201) {
    delete body.build
    delete body.repo
    delete body.session
    delete body.seq
    delete body.ts
  }
  return { status: response.status, body }
}
/** Replace a member while retaining all unrelated inputs. undefined means removal. */
function replace(input: unknown, path: (string | number)[], value: unknown): unknown {
  if (!path.length) return value
  const copy = structuredClone(input) as Record<string | number, unknown>
  let cursor = copy
  for (const part of path.slice(0, -1)) cursor = cursor[part] as Record<string | number, unknown>
  const key = path.at(-1)!
  if (value === undefined) delete cursor[key]
  else cursor[key] = value
  return copy
}
function payloadMutations(payload: unknown): { name: string; payload: unknown }[] {
  const out: { name: string; payload: unknown }[] = []
  function visit(value: unknown, path: (string | number)[]) {
    const label = path.join('.') || 'root'
    for (const [name, mutation] of [
      ['null', null],
      ['missing', undefined],
    ] as const)
      if (path.length || mutation !== undefined)
        out.push({ name: `${label}/${name}`, payload: replace(payload, path, mutation) })
    if (Array.isArray(value)) {
      out.push({ name: `${label}/wrong-type`, payload: replace(payload, path, {}) })
      value.forEach((child, index) => {
        visit(child, [...path, index])
      })
    } else if (typeof value === 'object' && value !== null) {
      out.push({
        name: `${label}/extra-key`,
        payload: replace(payload, path, { ...value, __unknown: true }),
      })
      for (const [key, child] of Object.entries(value)) visit(child, [...path, key])
    } else {
      const candidates: unknown[] =
        typeof value === 'number'
          ? [-1, 0, 0.5, 9007199254740992, 'number']
          : typeof value === 'string'
            ? ['', 1, '__invalid_union_member']
            : ['boolean', 1]
      for (const [index, candidate] of candidates.entries())
        out.push({ name: `${label}/boundary-${index}`, payload: replace(payload, path, candidate) })
    }
  }
  visit(payload, [])
  return out
}
export async function generateWriteCorpus(): Promise<WriteCorpus> {
  const cases: WriteCase[] = []
  const actorRules = {} as WriteCorpus['actorRules']
  for (const scope of Object.keys(schemas) as Scope[]) {
    actorRules[scope] = {}
    for (const [type, schema] of Object.entries(schemas[scope])) {
      const event = witnessEvent(scope, type, schema)
      const input: Write = { actor: event.actor, type, payload: event.payload }
      const variants: { name: string; input: Write }[] = [{ name: 'valid', input }]
      variants.push(
        ...producerPayloadVariants(scope, type, event.payload).map(({ name, payload }) => ({
          name,
          input: { ...input, payload },
        })),
      )
      // Exercise optional session fields as well as the minimal required witness.
      // Session schemas are entirely covered by the closed producer interpreter.
      if (scope === 'session') {
        function enrich(schema: unknown, current: unknown): unknown {
          const def = (schema as { _zod: { def: Record<string, unknown> } })._zod.def
          if (def.type === 'optional') return enrich(def.innerType, current)
          if (def.type === 'object')
            return Object.fromEntries(
              Object.entries(def.shape as Record<string, unknown>).map(([key, child]) => [
                key,
                enrich(child, (current as Record<string, unknown> | undefined)?.[key]),
              ]),
            )
          if (def.type === 'array') {
            const values = current as unknown[] | undefined
            return (values?.length ? values : [undefined]).map((value) =>
              enrich(def.element, value),
            )
          }
          if (def.type === 'union') {
            const options = def.options as {
              _zod: { def: { shape: Record<string, { _zod: { def: { values: unknown[] } } }> } }
            }[]
            const kind = (current as { kind?: unknown } | undefined)?.kind
            const option =
              options.find((option) =>
                option._zod.def.shape.kind!._zod.def.values.includes(kind),
              ) ?? options[0]
            return enrich(option, current)
          }
          if (current !== undefined) return current
          if (def.type === 'string') return 'witness'
          if (def.type === 'number') return 1
          if (def.type === 'literal') return (def.values as unknown[])[0]
          if (def.type === 'enum') return Object.values(def.entries as object)[0]
          if (def.type === 'record' || def.type === 'unknown') return {}
          throw new Error(`Unsupported optional session witness ${def.type}`)
        }
        const enriched = enrich(schema, event.payload)
        variants.push({ name: 'optional-fields', input: { ...input, payload: enriched } })
        for (const mutation of payloadMutations(enriched))
          variants.push({
            name: `optional-payload/${mutation.name}`,
            input: { ...input, payload: mutation.payload },
          })
      }

      actorRules[scope][type] = []
      for (const actor of actors) {
        const outcome = oracle(scope, { ...input, actor })
        if (!('rejected' in outcome) || !outcome.rejected.message.startsWith('actor kind '))
          actorRules[scope][type]!.push(actor.kind)
        variants.push({ name: `actor/${actor.kind}`, input: { ...input, actor } })
      }
      // The refusal's allowed list is an ordered part of the protocol text.
      // Probe a forbidden kind rather than inferring order from candidate order.
      for (const actor of actors) {
        const result = oracle(scope, { ...input, actor })
        if ('rejected' in result) {
          const allowed = /^actor kind .*\(allowed: (.*)\)$/.exec(result.rejected.message)
          if (allowed) {
            actorRules[scope][type] = allowed[1]!.split(', ')
            break
          }
        }
      }
      for (const [name, actor] of Object.entries({
        null: null,
        empty: {},
        unknown: { kind: 'unknown' },
        extra: { ...(event.actor as object), __unknown: true },
        via: { ...(event.actor as object), via: { kind: 'session', id: 'delegate' } },
        emptyHuman: { kind: 'human', user: '' },
        extraHuman: { kind: 'human', user: 'witness', z: 1, a: 2 },
        extraVia: {
          kind: 'human',
          user: 'witness',
          via: { kind: 'mcp', client: 'witness', extra: true },
        },
      }))
        variants.push({ name: `actor/${name}`, input: { ...input, actor } })
      for (const mutation of payloadMutations(event.payload))
        variants.push({
          name: `payload/${mutation.name}`,
          input: { ...input, payload: mutation.payload },
        })
      for (const [name, compatibility] of Object.entries({
        valid: { writerVersion: '1.0.0', classification: 'advisory' },
        empty: {},
        null: null,
        extra: { writerVersion: '1.0.0', classification: 'decisive', extra: true },
        invalid: { writerVersion: '', classification: 'unknown' },
      }))
        variants.push({ name: `compatibility/${name}`, input: { ...input, compatibility } })
      const seen = new Set<string>()
      for (const variant of variants) {
        const encoded = JSON.stringify(variant.input)
        if (seen.has(encoded)) continue
        seen.add(encoded)
        cases.push({
          id: `${scope}/${type}/${variant.name}`,
          scope,
          input: variant.input,
          oracle: oracle(scope, variant.input),
          http: await httpOracle(scope, variant.input),
        })
      }
    }
    if (scope === 'session') {
      for (const [name, trigger] of Object.entries({
        neither: { kind: 'wake', seq: 1, type: 'event' },
        both: { kind: 'wake', build: 'witness', journal: true, seq: 1, type: 'event' },
        build: { kind: 'wake', build: 'witness', seq: 1, type: 'event' },
        journal: { kind: 'wake', journal: true, seq: 1, type: 'event' },
        wrong: { kind: 'other', seq: 1, type: 'event' },
      })) {
        const input = {
          actor: { kind: 'kernel' },
          type: 'turn.started',
          payload: { turn: 'witness', stream: 'witness', trigger },
        }
        cases.push({
          id: `session/turn.started/wake-${name}`,
          scope,
          input,
          oracle: oracle(scope, input),
          http: await httpOracle(scope, input),
        })
      }
    }
    const input = { type: '__unknown', actor: { kind: 'kernel', via: {} }, payload: {} }
    cases.push({
      id: `${scope}/unknown-type-before-via`,
      scope,
      input,
      oracle: oracle(scope, input),
      http: await httpOracle(scope, input),
    })
  }
  const requests: WriteCorpus['requests'] = []
  for (const [name, schema] of Object.entries(requestSchemas)) {
    const special: Record<string, unknown> = {
      createStream: { label: 'witness' },
      appendStream: { parts: [{ type: 'data-witness', data: { key: 'value' }, other: true }] },
      closeStream: { outcome: 'completed' },
      putTicketAsset: {
        kind: 'design',
        name: 'witness',
        layout: 'tree',
        entries: [
          { type: 'dir', path: 'dir' },
          { type: 'file', path: 'dir/file.txt', contentBase64: 'AAE=' },
        ],
      },
      removeTicketAsset: { kind: 'design', name: 'witness' },
    }
    const input =
      special[name] ??
      (name === 'finishRepoTick'
        ? { holder: 'witness', completion: { outcome: 'failed', error: 'failure' }, events: [] }
        : name === 'tickCompletion'
          ? { outcome: 'failed', error: 'failure' }
          : name === 'putArtifact'
            ? { kind: 'witness', contentBase64: 'AAE=', metadata: { version: 1 } }
            : name === 'deposits'
              ? {
                  expectedSeq: 0,
                  artifacts: [{ kind: 'witness', contentBase64: 'AAE=', metadata: { version: 1 } }],
                  event: { actor: { kind: 'kernel' }, type: 'witness', payload: {} },
                }
              : name === 'snapshotPut'
                ? { version: 1, cursor: 0, state: { ready: true } }
                : name === 'operatorPresence'
                  ? {
                      id: 'witness',
                      host: 'loopback',
                      pid: 1,
                      startedAt: '2026-01-01T00:00:00.000Z',
                    }
                  : name === 'newSession'
                    ? { repo: 'witness', operator: 'witness', title: 'title' }
                    : name === 'eventWrite'
                      ? {
                          actor: { kind: 'kernel' },
                          type: 'witness',
                          payload: {},
                          compatibility: { writerVersion: '1.0.0', classification: 'decisive' },
                        }
                      : name === 'conditionalEvent'
                        ? {
                            expectedSeq: 1,
                            event: { actor: { kind: 'kernel' }, type: 'witness', payload: {} },
                          }
                        : name === 'newBuild'
                          ? {
                              slug: 'witness',
                              repo: 'witness',
                              repoOrigin: 'origin',
                              ticket: { source: 'file', id: 'witness', url: 'url', title: 'title' },
                              branch: 'ab/witness',
                              created: {
                                actor: { kind: 'kernel' },
                                type: 'witness',
                                payload: {},
                                compatibility: {
                                  writerVersion: '1.0.0',
                                  classification: 'decisive',
                                },
                              },
                            }
                          : name === 'ensureRepo'
                            ? { repo: 'witness' }
                            : name === 'leaseClaim'
                              ? { holder: 'witness', ttlMs: 1 }
                              : { holder: 'witness' })
    for (const variant of [
      { name: 'valid', payload: input },
      { name: 'null', payload: null },
      ...payloadMutations(input),
    ]) {
      // Request oracles describe JSON transport: array holes become null.
      const transported = JSON.parse(JSON.stringify(variant.payload))
      const result = schema.safeParse(transported)
      requests.push({
        name,
        id: `${name}/${variant.name}`,
        input: transported,
        oracle: result.success
          ? { accepted: result.data }
          : { rejected: { name: result.error.name, message: result.error.message } },
      })
    }
  }
  return { formatVersion: 1, sources: protocolSources(), cases, actorRules, requests }
}
export const corpusPath = resolve(experiment, 'fixtures/protocol-writes.json.gz')
export const payloadSchemasPath = resolve(experiment, 'fixtures/protocol-payload-schemas.json')
export const requestSchemasPath = resolve(experiment, 'fixtures/protocol-request-schemas.json')
export const sessionSchemasPath = resolve(experiment, 'fixtures/protocol-session-schemas.json')
export const rulesPath = resolve(experiment, 'fixtures/protocol-write-rules.json')
export function encodeCorpus(corpus: WriteCorpus) {
  return gzipSync(JSON.stringify(corpus), { level: 9 })
}
export function readWriteCorpus(): WriteCorpus {
  return JSON.parse(gunzipSync(readFileSync(corpusPath)).toString()) as WriteCorpus
}
