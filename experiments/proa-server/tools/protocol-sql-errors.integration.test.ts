/** Server diagnostics at TEXT/JSONB boundaries and atomic rollback. */
import { strict as assert } from 'node:assert'
import { withDataServices } from './data-services'
import { withProtocolDatabase } from './protocol-harness'
import { startProtocolServer } from './protocol-server-harness'
import { openPostgresBuildStoreFromEnv } from '../../../packages/postgres-store/src/config'
import { createStoreServer } from '../../../packages/hosted-store-service/src/remote-store-server'
import { buildCreatedWrite } from '../../../packages/core/src/store/contract'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
export async function proveProtocolSqlErrors(executable: string) {
  let comparisons = 0
  await withDataServices(async (admin, environment) =>
    withProtocolDatabase(admin, environment, async (env) => {
      const clock = () => new Date('2030-01-01T00:00:00.000Z'),
        store = await openPostgresBuildStoreFromEnv(env, { clock }),
        server = await startProtocolServer({ executable, env, clock }),
        oracle = createStoreServer({ store, clock })
      const headers = {
        'content-type': 'application/json',
        'x-autobuild-version': AUTOBUILD_VERSION,
        'x-autobuild-protocol-version': REMOTE_STORE_PROTOCOL_VERSION,
      }
      const compare = async (path: string, method = 'GET', body?: unknown) => {
        const init = {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }
        const a = await server.fetch(`${server.url}${path}`, init),
          b = await oracle.fetch(new Request(`http://oracle${path}`, init))
        const actual = { status: a.status, body: await a.json() },
          expected = { status: b.status, body: await b.json() }
        assert.deepEqual(actual, expected, `${method} ${path}`)
        assert.equal(actual.status, 500)
        comparisons++
        return actual
      }
      try {
        await compare('/repos', 'POST', { repo: 'bad\u0000repo' })
        for (const path of [
          '/builds/a%00',
          '/sessions/a%00',
          '/repos/a%00/events',
          '/streams/a%00',
        ])
          await compare(path)
        await store.createBuild({ slug: 'sql-error-lease', repo: 'sql-error-repo' })
        await compare('/builds/sql-error-lease/lease/claim', 'POST', {
          holder: '\u0000',
          ttlMs: 10000,
        })
        await compare('/builds/sql-error-lease/node-writer/release', 'POST', { holder: '\u0000' })
        const created = { ...buildCreatedWrite(), actor: { kind: 'human', user: '\u0000' } }
        await compare('/builds', 'POST', {
          slug: 'sql-error-initial',
          repo: 'sql-error-repo',
          created,
        })
        assert.equal(
          await store.getBuild('sql-error-initial'),
          null,
          'record and initial event must roll back together',
        )
        assert.deepEqual(
          await store.getEvents('sql-error-lease'),
          [],
          'rejected SQL boundaries must not allocate journal positions',
        )
        comparisons += 2
      } finally {
        await server.close()
        await store.close()
      }
    }),
  )
  return {
    comparisons,
    checks: [
      'PostgreSQL TEXT NUL and JSONB Unicode diagnostics match TypeScript without exposing transport/query text',
      'failed initial-event JSONB persistence rolls back the new record and journal allocation',
    ],
  }
}
