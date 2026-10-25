import type { z } from 'zod'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  catalog,
  eventSchemas,
  experiment,
  oracleOutcome,
  unknownEvent,
  schemas,
  sources,
  type Scope,
  type Corpus,
  readCorpus,
  reducerVersions,
} from './fixture-core'
export function checkFixtures(
  corpus: Corpus,
  sourceHashes = sources(),
  currentCatalog = catalog(),
) {
  if (!isDeepStrictEqual(corpus.manifest.sources, sourceHashes))
    throw new Error('fixture source closure changed; regenerate fixtures')
  if (!isDeepStrictEqual(corpus.manifest.catalog, currentCatalog))
    throw new Error('fixture event catalog changed; regenerate fixtures')
  if (!isDeepStrictEqual(corpus.manifest.versions, reducerVersions()))
    throw new Error('fixture reducer versions changed; regenerate fixtures')
  for (const scope of Object.keys(schemas) as Scope[]) {
    const seen = new Set<string>()
    for (const { event } of (corpus.decodingWitnesses ?? []).filter(
      (item) => item.scope === scope,
    )) {
      const schema = (schemas[scope] as Record<string, z.ZodType>)[event.type]
      if (!schema) throw new Error(`unknown decoding witness ${event.type}`)
      schema.parse(event.payload)
      seen.add(event.type)
    }

    for (const fixture of corpus.fixtures.filter((fixture) => fixture.scope === scope)) {
      for (const event of fixture.events) {
        const schema = (schemas[scope] as Record<string, z.ZodType>)[event.type]
        if (schema) seen.add(event.type)
      }
      const outcome = oracleOutcome(scope, fixture.events)
      if (
        !isDeepStrictEqual(
          {
            ...(fixture.expected !== undefined ? { expected: fixture.expected } : {}),
            ...(fixture.expectedError !== undefined
              ? { expectedError: fixture.expectedError }
              : {}),
          },
          outcome,
        )
      )
        throw new Error(`${fixture.id}: stale TypeScript reducer output`)
      if (!isDeepStrictEqual(fixture.rustUnreadable, unknownEvent(scope, fixture.events)))
        throw new Error(`${fixture.id}: incorrect unknown-event classification`)
    }
    for (const name of currentCatalog[scope]!)
      if (!seen.has(name)) throw new Error(`${scope}: missing decoding witness ${name}`)
  }
}
export function checkEventSchemas(stored: unknown) {
  if (!isDeepStrictEqual(stored, eventSchemas()))
    throw new Error('stale event decoding schemas; regenerate fixtures')
}
if (import.meta.main) {
  const corpus = readCorpus()
  const manifest = JSON.parse(readFileSync(resolve(experiment, 'fixtures/manifest.json'), 'utf8'))
  if (!isDeepStrictEqual(manifest, corpus.manifest))
    throw new Error('corpus manifest differs from published manifest')
  checkFixtures(corpus)
  checkEventSchemas(
    JSON.parse(readFileSync(resolve(experiment, 'fixtures/event-schemas.json'), 'utf8')),
  )
  console.log(
    `freshness passed: ${corpus.fixtures.length} fixtures, all current catalog names witnessed`,
  )
}
