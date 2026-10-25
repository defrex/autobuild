/** Issuance validates targets, not the stricter future token-verification schema. */
import { strict as assert } from 'node:assert'
import { SQL } from 'bun'
import { openPostgresBuildStoreFromEnv } from '../../../packages/postgres-store/src/config'
import { PostgresProjectRegistry } from '../../../packages/postgres-store/src/projects'
import { PostgresCredentialStore } from '../../../packages/postgres-store/src/credentials'
import { createMachineAuth } from '../../../packages/hosted-store-service/src/machine-auth'
import { createStoreServer } from '../../../packages/hosted-store-service/src/remote-store-server'
import { sampleEventWrite } from '../../../packages/core/src/store/contract'
import { verifyToken } from '../../../packages/core/src/store/remote/token'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import { withDataServices } from './data-services'
import { withProtocolDatabase } from './protocol-harness'
import { startProtocolServer } from './protocol-server-harness'
export async function proveProtocolDelegationEdges(executable: string) {
  let comparisons = 0
  await withDataServices(async (admin, environment) =>
    withProtocolDatabase(admin, environment, async (env) => {
      const clock = () => new Date('2030-01-01T00:00:00.000Z'),
        secret = 'isolated-delegation-edge-secret',
        repo = 'https://github.com/proa/delegation-edges'
      const ts = await openPostgresBuildStoreFromEnv(env, { clock }),
        sql = new SQL(env.AB_POSTGRES_URL!, { max: 1 }),
        projects = new PostgresProjectRegistry(sql),
        credentials = new PostgresCredentialStore(sql, projects)
      let native: Awaited<ReturnType<typeof startProtocolServer>> | undefined, failure: unknown
      try {
        await projects.add(repo, 'proof')
        const owner = await credentials.issue(repo, 'proof')
        // Existing imported records retain exact legacy slugs; authenticated new
        // writes allocate fresh identities and cannot manufacture this fixture.
        await ts.createBuild({ slug: '*', repo })
        await ts.append('*', sampleEventWrite())
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
        const init = {
          method: 'POST',
          headers,
          body: JSON.stringify({ kind: 'build-runner', id: '*' }),
        }
        const actual = await native.fetch(`${native.url}/credentials/delegate`, init),
          expected = await oracle.fetch(new Request('http://oracle/credentials/delegate', init))
        const a = (await actual.json()) as { token: string },
          e = (await expected.json()) as { token: string }
        assert.equal(actual.status, 200)
        assert.equal(expected.status, 200)
        assert.deepEqual(a, e)
        assert.equal(typeof a.token, 'string')
        comparisons++
        assert.equal(verifyToken(secret, a.token, clock()), null)
        const read = { headers: { ...headers, authorization: `Bearer ${a.token}` } }
        const denied = await native.fetch(`${native.url}/builds/%2A`, read),
          source = await oracle.fetch(new Request('http://oracle/builds/%2A', read))
        assert.equal(denied.status, 401)
        assert.deepEqual(
          { status: denied.status, body: await denied.json() },
          { status: source.status, body: await source.json() },
        )
        comparisons++
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
    comparisons,
    checks: [
      'existing literal-star build receives exact source issuance bytes; its issued credential remains rejected by both strict token verifiers and HTTP authentication',
    ],
  }
}
