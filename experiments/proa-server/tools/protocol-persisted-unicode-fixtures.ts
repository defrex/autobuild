/** Source permissive stored-payload oracle, independent of strict producers. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { gzipSync, gunzipSync } from 'node:zlib'
import { projectPayload } from '../../../packages/core/src/events/compatibility'
import { experiment, schemas, witnessEvent } from './fixture-core'
export function persistedUnicodeFixtures() {
  const cases: { name: string; scope: string; input: string; expected?: string }[] = []
  for (const scope of ['build', 'repository', 'session'] as const) {
    for (const [kind, schema] of Object.entries(schemas[scope])) {
      const event = witnessEvent(scope, kind, schema)
      const add = (payload: unknown, name: string) => {
        const row: (typeof cases)[number] = {
          name: `${scope}/${kind}/${name}`,
          scope,
          input: JSON.stringify({ ...event, payload }),
        }
        try {
          row.expected = JSON.stringify({ ...event, payload: projectPayload(schema, payload) })
        } catch {}
        cases.push(row)
      }
      add(event.payload, 'witness')
      add({ ...(event.payload as object), '\ud800': { '\udfff': '\ud800' } }, 'additive-lone-keys')
      const walk = (value: unknown, path: (string | number)[]) => {
        if (typeof value === 'string') {
          for (const replacement of ['\ud800', '\udfff', '�', '💩', '\ufeff\ud800\ufeff']) {
            const payload = structuredClone(event.payload) as Record<PropertyKey, unknown>
            let parent = payload
            for (const key of path.slice(0, -1)) parent = parent[key] as typeof parent
            parent[path.at(-1)!] = replacement
            add(payload, `${JSON.stringify(path)}/${JSON.stringify(replacement)}`)
          }
        } else if (value && typeof value === 'object') {
          for (const [key, child] of Object.entries(value))
            walk(child, [...path, Array.isArray(value) ? Number(key) : key])
        }
      }
      walk(event.payload, [])
    }
  }
  return { cases }
}
const path = resolve(experiment, 'fixtures/protocol-persisted-unicode.json.gz')
export function checkPersistedUnicodeFixtures() {
  if (
    !isDeepStrictEqual(
      persistedUnicodeFixtures(),
      JSON.parse(gunzipSync(readFileSync(path)).toString()),
    )
  )
    throw new Error('Persisted Unicode fixtures stale')
}
if (import.meta.main) {
  const fixture = persistedUnicodeFixtures()
  if (process.argv.includes('--generate'))
    await Bun.write(path, gzipSync(JSON.stringify(fixture), { level: 9 }))
  else checkPersistedUnicodeFixtures()
  console.log(
    JSON.stringify({
      cases: fixture.cases.length,
      accepted: fixture.cases.filter((c) => c.expected !== undefined).length,
    }),
  )
}
