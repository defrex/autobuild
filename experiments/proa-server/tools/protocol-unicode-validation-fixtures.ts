/** Executable Zod oracle. Embedded JSON text transports isolated UTF-16 units. */
import { gunzipSync, gzipSync } from 'node:zlib'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { requestSchemas, schemaNode } from './protocol-fixtures-schema'
import { prepareEventWrite } from '../../../packages/core/src/events/catalog'
import { prepareRepositoryEventWrite } from '../../../packages/core/src/events/repository'
import {
  validateSessionEventWrite,
  sessionEventPayloadSchemas,
} from '../../../packages/core/src/events/sessions'
import { validateExpectedSeq } from '../../../packages/core/src/store/types'
import { validateCreatedEvent } from '../../../packages/core/src/store/new-build'
import { eventPayloadSchemas } from '../../../packages/core/src/events/payloads'
import { repositoryEventPayloadSchemas } from '../../../packages/core/src/events/repository'
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Path = (string | number)[]
const path = resolve(import.meta.dir, '../fixtures/protocol-unicode-validation.json.gz')
export async function unicodeValidationFixtures() {
  const corpus = JSON.parse(
    gunzipSync(
      await Bun.file(new URL('../fixtures/protocol-writes.json.gz', import.meta.url)).arrayBuffer(),
    ).toString(),
  ) as {
    requests: { name: string; input: Json; oracle: { accepted?: unknown } }[]
    cases: {
      id: string
      scope: string
      input: { type: string; payload: Json }
      oracle: { accepted?: unknown }
    }[]
  }
  const schemas: Record<string, unknown> = {},
    cases: { name: string; schema: string; raw: string; accepted?: string; rejected?: string }[] =
      []
  const add = (name: string, schemaName: string, schema: z.ZodType, input: Json) => {
    const raw = JSON.stringify(input)
    const parsed = schema.safeParse(JSON.parse(raw))
    cases.push({
      name,
      schema: schemaName,
      raw,
      ...(parsed.success
        ? { accepted: JSON.stringify(parsed.data) }
        : { rejected: JSON.stringify(parsed.error.message) }),
    })
  }
  const clone = (v: Json): Json => JSON.parse(JSON.stringify(v)) as Json
  const replace = (base: Json, at: Path, next: Json) => {
    if (at.length === 0) return next
    const result = clone(base)
    let target = result as Record<string | number, Json>
    for (const key of at.slice(0, -1)) target = target[key] as Record<string | number, Json>
    target[at.at(-1)!] = next
    return result
  }
  const strings = (value: Json, at: Path = []): Path[] =>
    typeof value === 'string'
      ? [at]
      : value !== null && typeof value === 'object'
        ? Object.entries(value).flatMap(([key, child]) =>
            strings(child, [...at, Array.isArray(value) ? Number(key) : key]),
          )
        : []
  const arrays = (value: Json, at: Path = []): Path[] =>
    value !== null && typeof value === 'object'
      ? [
          ...(Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string')
            ? [at]
            : []),
          ...Object.entries(value).flatMap(([key, child]) =>
            arrays(child, [...at, Array.isArray(value) ? Number(key) : key]),
          ),
        ]
      : []
  const seeds = [
    String.fromCharCode(0xd800),
    String.fromCharCode(0xdfff),
    '💩',
    '�',
    ` \ufeff${String.fromCharCode(0xd800)} \t`,
    `${String.fromCharCode(0xd800)}x`,
    `owner/${String.fromCharCode(0xd800)}`,
  ]
  const visit = (name: string, schema: z.ZodType, base: Json) => {
    schemas[name] = schemaNode(schema, name.replace(/^(?:request|build|repository|session)\//, ''))
    add(`${name}/base`, name, schema, base)
    for (const at of strings(base))
      for (const [i, seed] of seeds.entries())
        add(`${name}/${JSON.stringify(at)}/${i}`, name, schema, replace(base, at, seed))
    for (const at of arrays(base))
      add(
        `${name}/duplicate/${JSON.stringify(at)}`,
        name,
        schema,
        replace(base, at, [seeds[0]!, seeds[0]!]),
      )
    if (base !== null && !Array.isArray(base) && typeof base === 'object')
      add(`${name}/unknown-key`, name, schema, { ...base, [seeds[0]!]: seeds[1]! })
  }
  for (const [name, schema] of Object.entries(requestSchemas)) {
    const witness = corpus.requests.find((c) => c.name === name && c.oracle.accepted !== undefined)
    if (!witness) throw Error(`No request witness ${name}`)
    visit(`request/${name}`, schema, witness.input)
  }
  for (const [scope, catalog] of Object.entries({
    build: eventPayloadSchemas,
    repository: repositoryEventPayloadSchemas,
    session: sessionEventPayloadSchemas,
  }))
    for (const [name, schema] of Object.entries(catalog)) {
      const witness = corpus.cases.find(
        (c) =>
          c.scope === scope &&
          c.input.type === name &&
          c.id.endsWith('/valid') &&
          c.oracle.accepted !== undefined,
      )
      if (!witness) throw Error(`No payload witness ${scope}/${name}`)
      visit(`${scope}/${name}`, schema, witness.input.payload)
    }
  for (const [name, schema, input] of [
    [
      'record-key',
      z.record(z.string().max(1), z.string().min(2)),
      Object.fromEntries([
        [seeds[0]!, 'x'],
        [seeds[1]!, seeds[0]!],
        ['💩', 'ok'],
      ]),
    ],
    ['strip', z.object({ kept: z.string() }), { kept: 'ok', [seeds[0]!]: seeds[1]! }],
    ['strict', z.strictObject({ kept: z.string() }), { kept: 'ok', [seeds[0]!]: seeds[1]! }],
    ['url', z.url(), `https://example.com/${seeds[0]!}`],
    ['trim', z.string().trim().min(2).max(3), seeds[4]!],
  ] as const)
    visit(`custom/${name}`, schema, input)
  const writes: {
    name: string
    scope: string
    raw: string
    accepted?: string
    rejected?: string
  }[] = []
  const addWrite = (name: string, scope: string, input: Json) => {
    const raw = JSON.stringify(input)
    try {
      const decoded = JSON.parse(raw)
      const out =
        scope === 'build'
          ? prepareEventWrite(decoded)
          : scope === 'repository'
            ? prepareRepositoryEventWrite(decoded)
            : scope === 'session'
              ? validateSessionEventWrite(decoded)
              : scope === 'created'
                ? validateCreatedEvent(decoded)
                : (() => {
                    validateExpectedSeq(decoded)
                    return true
                  })()
      writes.push({ name, scope, raw, accepted: JSON.stringify(out ?? null) })
    } catch (error) {
      writes.push({
        name,
        scope,
        raw,
        rejected: JSON.stringify(error instanceof Error ? error.message : String(error)),
      })
    }
  }
  for (const witness of corpus.cases.filter(
    (c) => c.id.endsWith('/valid') && c.oracle.accepted !== undefined,
  )) {
    const input = witness.input as unknown as Json
    const object = input as Record<string, Json>
    for (const at of strings(object.actor!))
      for (const [index, seed] of seeds.entries())
        addWrite(
          `${witness.id}/actor/${JSON.stringify(at)}/${index}`,
          witness.scope,
          replace(input, ['actor', ...at], seed),
        )
    if (witness.scope !== 'session') {
      const prepared =
        witness.scope === 'build'
          ? prepareEventWrite(witness.input as never)
          : prepareRepositoryEventWrite(witness.input as never)
      for (const [index, seed] of seeds.entries())
        addWrite(`${witness.id}/metadata/${index}`, witness.scope, {
          ...object,
          compatibility: { ...prepared.compatibility!, writerVersion: seed },
        })
    }
  }
  for (const [index, seed] of seeds.entries()) {
    addWrite(`expected/${index}`, 'expected-seq', seed)
    for (const scope of ['build', 'repository', 'session'])
      addWrite(`unknown-type/${scope}/${index}`, scope, {
        actor: { kind: 'kernel' },
        type: seed,
        payload: {},
      })
  }
  return { schemas, cases, writes }
}
export async function checkUnicodeValidationFixtures() {
  const generated = await unicodeValidationFixtures()
  const stored = JSON.parse(gunzipSync(await Bun.file(path).arrayBuffer()).toString())
  if (!isDeepStrictEqual(generated, stored))
    throw Error('Unicode validation fixtures stale; regenerate --generate')
  return generated.cases.length
}
if (import.meta.main) {
  const generated = await unicodeValidationFixtures()
  if (process.argv.includes('--generate'))
    await Bun.write(path, gzipSync(JSON.stringify(generated)))
  else await checkUnicodeValidationFixtures()
  console.log(`${generated.cases.length} Unicode Zod validation comparisons`)
}
