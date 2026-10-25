/** Benign discarded JSON must not depend on the native worker's call-stack size. */
import { strict as assert } from 'node:assert'
import { SQL } from 'bun'
import { openPostgresBuildStoreFromEnv } from '../../../packages/postgres-store/src/config'
import { PostgresProjectRegistry } from '../../../packages/postgres-store/src/projects'
import { PostgresCredentialStore } from '../../../packages/postgres-store/src/credentials'
import { createMachineAuth } from '../../../packages/hosted-store-service/src/machine-auth'
import { createStoreServer } from '../../../packages/hosted-store-service/src/remote-store-server'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import { withDataServices } from './data-services'
import { withProtocolDatabase } from './protocol-harness'
import { startProtocolServer } from './protocol-server-harness'
export async function proveProtocolJsonNesting(executable: string) {
  const depths = [32, 128, 512, 2048, 8192],
    witnesses: { depth: number; bodyBytes: number; status: number }[] = []
  await withDataServices(async (admin, environment) =>
    withProtocolDatabase(admin, environment, async (env) => {
      const clock = () => new Date('2030-01-01T00:00:00.000Z'),
        secret = 'isolated-json-nesting-secret',
        repo = 'https://github.com/proa/json-nesting'
      const ts = await openPostgresBuildStoreFromEnv(env, { clock }),
        sql = new SQL(env.AB_POSTGRES_URL!, { max: 1 }),
        projects = new PostgresProjectRegistry(sql),
        credentials = new PostgresCredentialStore(sql, projects)
      let native: Awaited<ReturnType<typeof startProtocolServer>> | undefined, failure: unknown
      try {
        await projects.add(repo, 'proof')
        const owner = await credentials.issue(repo, 'proof')
        native = await startProtocolServer({
          executable,
          env: { ...env, PROA_TEST_AUTH: 'project', PROA_TEST_SECRET: secret },
          clock,
        })
        const oracle = createStoreServer({
          store: ts,
          clock,
          secret,
          auth: createMachineAuth({ secret, credentials, projects, store: ts, clock }),
        })
        const headers = {
          'content-type': 'application/json',
          'x-autobuild-version': AUTOBUILD_VERSION,
          'x-autobuild-protocol-version': REMOTE_STORE_PROTOCOL_VERSION,
          authorization: `Bearer ${owner.token}`,
        }
        for (const depth of depths) {
          const body = `{"repo":${JSON.stringify(repo)},"discarded":${'['.repeat(depth)}0${']'.repeat(depth)}}`
          const init = { method: 'POST', headers, body, signal: AbortSignal.timeout(8000) }
          const actual: Response = await native.fetch(`${native.url}/repos`, init),
            expected: Response = await oracle.fetch(new Request('http://oracle/repos', init))
          assert.equal(actual.status, 200, `native depth ${depth}`)
          assert.deepEqual(
            {
              status: actual.status,
              contentType: actual.headers.get('content-type'),
              body: await actual.json(),
            },
            {
              status: expected.status,
              contentType: expected.headers.get('content-type'),
              body: await expected.json(),
            },
            `depth ${depth}`,
          )
          witnesses.push({ depth, bodyBytes: Buffer.byteLength(body), status: actual.status })
        }
      } catch (error) {
        failure = error
      } finally {
        await native?.close().catch((error) => {
          failure ??= error
        })
        await ts.close().catch((error) => {
          failure ??= error
        })
        await sql.close().catch((error) => {
          failure ??= error
        })
      }
      if (failure) throw failure
    }),
  )
  return {
    comparisons: witnesses.length,
    witnesses,
    checks: [
      'valid authenticated repo ensures strip discarded arrays at depths32/128/512/2048/8192, with complete source/native status/content-type/body equality and no native process failure',
    ],
  }
}
