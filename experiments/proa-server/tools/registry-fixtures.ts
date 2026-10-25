/** Closed HTTP tool registry oracle; no MCP transport is implemented here. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { MemoryBuildStore } from '../../../packages/core/src/store/memory'
import { buildRegistry, RegistryError } from '../../../packages/core/src/operator/registry'
import { operatorClock, operatorRepo } from './operator-fixtures'
import { sources } from './fixture-core'

const path = resolve(import.meta.dir, '../fixtures/registry-corpus.json')
const clock = () => new Date(operatorClock)
export async function registryContract() {
  const registry = buildRegistry({ store: new MemoryBuildStore({ clock }), clock })
  const schemas = Object.fromEntries(
    registry.entries.map((e) => [e.name, e.inputSchema.toJSONSchema({ unrepresentable: 'any' })]),
  )
  const samples: unknown[] = [
    undefined,
    null,
    [],
    {},
    { repo: operatorRepo },
    { repo: operatorRepo, extra: 'unknown' },
    { repo: operatorRepo, slug: 'missing' },
    { repo: operatorRepo, scope: 'unknown' },
    { repo: operatorRepo, action: 'pause' },
    { repo: operatorRepo, resolution: 'retry', slug: 'missing', text: 'forbidden' },
    { repo: operatorRepo, cursor: 0, slug: 'missing' },
    { repo: operatorRepo, document: 'notes\nbytes' },
    { repo: operatorRepo, expectedRevision: ' ', id: 'missing' },
    { repo: operatorRepo, id: 'missing', target: null },
  ]
  samples.push(
    { repo: operatorRepo, slug: 'missing', cursor: -1 },
    { repo: operatorRepo, slug: 'missing', cursor: 0, waitSeconds: 31 },
    { repo: operatorRepo, slug: 'missing', cursor: 0, waitSeconds: 1.5 },
    { repo: operatorRepo, slug: 'missing', kind: 'spec', rev: -1 },
    {
      repo: operatorRepo,
      slug: 'missing',
      resolution: 'review-round-ceiling',
      ceiling: 9007199254740992,
    },
    { repo: operatorRepo, id: 'missing', target: 3 },
  )
  const cases = []
  for (const entry of registry.entries)
    for (const input of samples) {
      const parsed = entry.inputSchema.safeParse(input)
      cases.push({
        name: entry.name,
        ...(input === undefined ? {} : { input }),
        ...(parsed.success
          ? { output: parsed.data }
          : { error: `invalid input for tool "${entry.name}": ${parsed.error.message}` }),
      })
    }
  const outcomes = []
  for (const [name, input] of [
    ['unknown.tool', { repo: operatorRepo }],
    ['sandbox.exec', { repo: operatorRepo }],
    ['builds.list', { repo: operatorRepo }],
    ['builds.events', { repo: operatorRepo, slug: 'missing', cursor: 0 }],
    ['builds.artifact', { repo: operatorRepo, slug: 'missing', kind: 'spec' }],
    ['builds.control', { repo: operatorRepo, slug: 'missing', action: 'pause' }],
    ['notes.read', { repo: operatorRepo }],
    ['notes.write', { repo: operatorRepo, document: 'notes\nbytes' }],
    ['notes.read', { repo: operatorRepo }],
    ['notes.write', { repo: operatorRepo, document: '\uFEFFnotes\nbytes' }],
    ['notes.read', { repo: operatorRepo }],
    ['notes.write', { repo: operatorRepo, document: 'notes\nbytes' }],
    ['notes.read', { repo: operatorRepo }],
  ] as const) {
    try {
      outcomes.push({
        name,
        input,
        result: await registry.call(name, input, { identity: 'operator@example.com' }),
      })
    } catch (error) {
      if (!(error instanceof RegistryError)) throw error
      outcomes.push({ name, input, error: error.body })
    }
  }
  return {
    sourceHash: createHash('sha256')
      .update(JSON.stringify(sources()))
      .update(readFileSync(import.meta.filename))
      .digest('hex'),
    clock: operatorClock,
    schemas,
    cases,
    outcomes,
  }
}
export async function checkRegistryContract() {
  const current = await registryContract()
  if (!isDeepStrictEqual(await Bun.file(path).json(), current))
    throw new Error('Registry corpus drifted; run tools/registry-fixtures.ts --write')
  return current
}
if (import.meta.main) {
  if (process.argv.includes('--write'))
    await Bun.write(
      path,
      `${JSON.stringify(await registryContract(), null, 2).replace(/[^\x00-\x7f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`,
    )
  else await checkRegistryContract()
}
