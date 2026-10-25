/** Pure status projections generated from the shipping TypeScript core. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { summarizeFrom } from '../../../packages/core/src/cli/status'
import { reduceBuild } from '../../../packages/core/src/kernel/reducer'
import type { AbEvent } from '../../../packages/core/src/events/catalog'
import type { BuildRecord } from '../../../packages/core/src/store/types'
import { operatorClock } from './operator-fixtures'

const path = resolve(import.meta.dir, '../fixtures/operator-queries.json')
export async function queryContract() {
  const corpus = (await Bun.file(
    resolve(import.meta.dir, '../fixtures/control-corpus.json'),
  ).json()) as {
    fixtures: {
      scenario: { id: string }
      seed: { record: BuildRecord; events: AbEvent[] }
      after: { record: BuildRecord; events: AbEvent[] }
    }[]
  }
  const now = new Date(operatorClock)
  return {
    source: createHash('sha256')
      .update(readFileSync(resolve(import.meta.dir, '../../../packages/core/src/cli/status.ts')))
      .update(
        readFileSync(resolve(import.meta.dir, '../../../packages/core/src/cli/build-progress.ts')),
      )
      .digest('hex'),
    now: operatorClock,
    cases: corpus.fixtures
      .filter((f) => !f.scenario.id.startsWith('tool-'))
      .flatMap((f) =>
        ['seed', 'after'].map((k) => {
          const input = f[k as 'seed' | 'after']
          const state = reduceBuild(input.events)
          return {
            id: `${f.scenario.id}:${k}`,
            record: input.record,
            state,
            expected: summarizeFrom(input.record, state, now),
          }
        }),
      ),
  }
}
if (import.meta.main) {
  const current = await queryContract()
  if (process.argv.includes('--write'))
    await Bun.write(path, `${JSON.stringify(current, null, 2)}\n`)
  else if (!isDeepStrictEqual(await Bun.file(path).json(), JSON.parse(JSON.stringify(current))))
    throw new Error('Operator query corpus drifted; regenerate query-fixtures.ts --write')
}
