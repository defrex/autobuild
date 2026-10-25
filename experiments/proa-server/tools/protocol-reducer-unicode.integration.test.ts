/** Actual source/native argument validation and UTF16 parameter replay. */
import { strict as assert } from 'node:assert'
import { openPostgresBuildStoreFromEnv } from '../../../packages/postgres-store/src/config'
import { createStoreServer } from '../../../packages/hosted-store-service/src/remote-store-server'
import { runStartedWrite } from '../../../packages/core/src/store/contract'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import { withDataServices } from './data-services'
import { withProtocolDatabase } from './protocol-harness'
import { startProtocolServer } from './protocol-server-harness'
import { schemas, witnessEvent } from './fixture-core'
import { reducerUnicodeFixtures } from './protocol-reducer-unicode-fixtures'
export async function proveProtocolReducerUnicode(executable: string) {
  let comparisons = 0
  await withDataServices(async (admin, environment) =>
    withProtocolDatabase(admin, environment, async (env) => {
      const clock = () => new Date('2030-01-01T00:00:00.000Z'),
        ts = await openPostgresBuildStoreFromEnv(env, { clock }),
        native = await startProtocolServer({ executable, env, clock }),
        oracle = createStoreServer({ store: ts, clock }),
        wire = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (r) => oracle.fetch(r) })
      const headers = {
        'content-type': 'application/json',
        'x-autobuild-version': AUTOBUILD_VERSION,
        'x-autobuild-protocol-version': REMOTE_STORE_PROTOCOL_VERSION,
      }
      try {
        await ts.ensureRepo('reader-repo')
        await ts.createBuild({ slug: 'reader-build', repo: 'reader-repo' })
        await ts.appendRepo('reader-repo', runStartedWrite('�', [{ kind: 'config', revision: 0 }]))
        for (const type of ['session.started', 'session.ended', 'implement.completed'] as const) {
          const event = witnessEvent('build', type, schemas.build[type])
          await ts.append('reader-build', {
            actor: event.actor,
            type: event.type,
            payload: {
              ...event.payload,
              ...(type.startsWith('session.') ? { session: '�' } : { round: 1 }),
            },
          } as never)
        }
        const compare = async (scope: string, body: BodyInit) => {
          const path =
              scope === 'repo'
                ? '/repos/reader-repo/reducer-values'
                : '/builds/reader-build/reducer-values',
            init = { method: 'POST', headers, body }
          const a = await fetch(native.url + path, init),
            b = await fetch(new URL(path, wire.url), init)
          assert.deepEqual(
            {
              status: a.status,
              body: await a.json(),
              catalog: a.headers.get('x-autobuild-catalog-identity'),
            },
            {
              status: b.status,
              body: await b.json(),
              catalog: b.headers.get('x-autobuild-catalog-identity'),
            },
            `${scope} ${typeof body === 'string' ? body : 'raw bytes'}`,
          )
          comparisons++
        }
        for (const row of reducerUnicodeFixtures().cases) await compare(row.scope, row.input)
        for (const bytes of [[255], [192, 175], [237, 160, 128], [226, 130], [239, 191, 189]])
          await compare(
            'repo',
            Buffer.concat([
              Buffer.from('{"reducer":"openTick","args":{"run":"'),
              Buffer.from(bytes),
              Buffer.from('"}}'),
            ]),
          )
        const valid = '{"reducer":"openTick","args":{"run":"x"}}'
        for (const length of [4095, 4096, 4097]) {
          const padded = valid + ' '.repeat(length - Buffer.byteLength(valid))
          await compare('repo', Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(padded)]))
        }
        for (const row of reducerUnicodeFixtures().syntax) await compare('repo', row.input)
        for (const count of [1350, 1360])
          await compare(
            'repo',
            Buffer.concat([
              Buffer.from('{"reducer":"openTick","args":{"run":"'),
              Buffer.alloc(count, 255),
              Buffer.from('"}}'),
            ]),
          )
      } finally {
        wire.stop(true)
        await native.close()
        await ts.close()
      }
    }),
  )
  return {
    comparisons,
    groups: [
      'independent Unicode catalog inputs',
      'replacement-run and session nonalias',
      'typed terminal guards',
      'raw UTF8 decoding',
      'decoded BOM byte ceiling',
      'Bun syntax errors with preceding lone units',
    ],
  }
}
