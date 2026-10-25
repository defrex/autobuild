/** Producer-only metadata; the read decoder intentionally tolerates additive fields. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { allowedActorKinds } from '../../../packages/core/src/events/catalog'
import { buildEventPolicy, repositoryEventPolicy } from '../../../packages/core/src/events/policy'

const root = resolve(import.meta.dir, '../../..')
const files = {
  build: 'packages/core/src/events/catalog.ts',
  repository: 'packages/core/src/events/repository.ts',
  session: 'packages/core/src/events/sessions.ts',
  policy: 'packages/core/src/events/policy.ts',
}
function privateActors(path: string) {
  const source = readFileSync(resolve(root, path), 'utf8')
  const section = /const allowedActorKinds:[^=]+?=\s*\{([\s\S]*?)\n\}/.exec(source)?.[1]
  if (!section) throw new Error(`cannot find actor policy in ${path}`)
  return Object.fromEntries(
    [...section.matchAll(/'([^']+)':\s*\[([^\]]+)\]/g)].map((match) => [
      match[1],
      [...match[2]!.matchAll(/'([^']+)'/g)].map((actor) => actor[1]),
    ]),
  )
}
export function writerFixture() {
  return {
    sources: Object.fromEntries(
      Object.values(files).map((path) => [
        path,
        createHash('sha256')
          .update(readFileSync(resolve(root, path)))
          .digest('hex'),
      ]),
    ),
    actors: {
      build: allowedActorKinds,
      repository: privateActors(files.repository),
      session: privateActors(files.session),
    },
    classification: { build: buildEventPolicy, repository: repositoryEventPolicy },
  }
}
export async function checkWriterFixture() {
  const stored = await Bun.file(resolve(import.meta.dir, '../fixtures/writer-policy.json')).json()
  if (!isDeepStrictEqual(stored, writerFixture()))
    throw new Error('writer policy drift; regenerate with tools/writer-fixtures.ts --write')
}
if (import.meta.main) {
  if (process.argv.includes('--write'))
    await Bun.write(
      resolve(import.meta.dir, '../fixtures/writer-policy.json'),
      `${JSON.stringify(writerFixture(), null, 2)}\n`,
    )
  else await checkWriterFixture()
}
