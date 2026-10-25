import { resolve } from 'node:path'
import type { Delegation } from '../../../packages/hosted-store-service/src/delegated-authority'
import type { AbEvent } from '../../../packages/core/src/events/catalog'
import type { RepositoryEvent } from '../../../packages/core/src/events/repository'
import { evaluateDelegationFacts } from '../../../packages/hosted-store-service/src/delegated-authority'
import {
  buildDelegationReducer,
  harvestDelegationReducer,
} from '../../../packages/core/src/kernel/service-facts'
const origin = Date.parse('2026-01-01T00:00:00.000Z')
const event = (seq: number, type: string, payload: unknown, offset = 0) => ({
  seq,
  type,
  payload,
  ts: new Date(origin + offset).toISOString(),
  actor: { kind: 'kernel' },
})
const build = [
  event(1, 'build.created', {}),
  event(2, 'session.started', { session: 's' }),
  event(3, 'session.suspended', { session: 's' }),
  event(4, 'session.ended', { session: 's' }),
  event(5, 'build.completed', {}),
  event(6, 'session.started', { session: 'later' }),
]
const harvest = [
  event(1, 'harvest.started', { run: 'r' }),
  event(2, 'harvest.execution.authorized', { run: 'r', execution: 'e', leaseHolder: 'h' }),
  event(3, 'harvest.session.started', { run: 'r', session: 's' }),
  event(4, 'harvest.failed', { run: 'r', willRetry: true }),
  event(5, 'harvest.session.suspended', { run: 'r', session: 's' }),
  event(6, 'harvest.session.started', { run: 'r', session: 's' }),
  event(7, 'harvest.execution.released', { execution: 'e' }),
  event(8, 'harvest.completed', { run: 'r' }),
]
const fixtures: unknown[] = []
for (const [name, events] of [
  ['build', build],
  ['harvest', harvest],
] as const) {
  for (let size = 0; size <= events.length; size++) {
    const facts =
      name === 'build'
        ? buildDelegationReducer.finish(
            buildDelegationReducer.advance(
              buildDelegationReducer.initial(),
              events.slice(0, size) as unknown as AbEvent[],
            ),
          )
        : harvestDelegationReducer.finish(
            harvestDelegationReducer.advance(
              harvestDelegationReducer.initial(),
              events.slice(0, size) as unknown as RepositoryEvent[],
            ),
          )
    const claims: Delegation[] =
      name === 'build'
        ? [
            { repo: 'a/b', kind: 'build-runner', id: 'b', anchor: 1 },
            { repo: 'a/b', kind: 'build-phase', id: 'b', anchor: 2, session: 's' },
            { repo: 'a/b', kind: 'build-phase', id: 'b', anchor: 6, session: 'later' },
          ]
        : [
            {
              repo: 'a/b',
              kind: 'harvest-runner',
              id: 'r',
              anchor: 2,
              execution: 'e',
              leaseHolder: 'h',
            },
            {
              repo: 'a/b',
              kind: 'harvest-phase',
              id: 'r',
              anchor: 3,
              execution: 'e',
              session: 's',
            },
            {
              repo: 'a/b',
              kind: 'harvest-runner',
              id: 'r',
              anchor: 2,
              execution: 'e',
              leaseHolder: 'wrong',
            },
          ]
    for (const base of claims)
      for (const anchor of [0, base.anchor, size, size + 1])
        for (const offset of [-1, 0, 59999, 60000, 60001, 120000]) {
          const c = { ...base, anchor }
          const now = origin + offset
          fixtures.push({
            name: `${name}/${size}/${c.kind}/${anchor}/${offset}`,
            claims: c,
            facts,
            now,
            active: evaluateDelegationFacts(c, facts, new Date(now)),
          })
        }
  }
}
const output = new URL('../fixtures/protocol-delegation-lifecycle.json', import.meta.url)
const format = Bun.spawnSync(
  [
    resolve(import.meta.dir, '../../../node_modules/.bin/biome'),
    'format',
    '--stdin-file-path',
    output.pathname,
  ],
  { stdin: Buffer.from(JSON.stringify(fixtures, null, 2)) },
)
if (format.exitCode !== 0) throw new Error(format.stderr.toString())
const encoded = format.stdout.toString()
if (process.argv.includes('--generate')) await Bun.write(output, encoded)
else if ((await Bun.file(output).text()) !== encoded)
  throw new Error('Delegation fixture drift; regenerate protocol-delegation-fixtures.ts')
console.log(`${fixtures.length} actual TS delegation comparisons fresh`)
