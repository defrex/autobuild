/** Equality proof for the general JSON string boundary. Export only until the
 * native lossless model is integrated; no implicit integration test execution. */
import { SQL } from 'bun'
import { strict as assert } from 'node:assert'
import { withDataServices } from './data-services'
import { withProtocolDatabase } from './protocol-harness'
import { startProtocolServer } from './protocol-server-harness'
import { openPostgresBuildStoreFromEnv } from '../../../packages/postgres-store/src/config'
import { PostgresProjectRegistry } from '../../../packages/postgres-store/src/projects'
import { PostgresCredentialStore } from '../../../packages/postgres-store/src/credentials'
import { createMachineAuth } from '../../../packages/hosted-store-service/src/machine-auth'
import { createStoreServer } from '../../../packages/hosted-store-service/src/remote-store-server'
import { mintToken } from '../../../packages/core/src/store/remote/token'
import { sampleEventWrite } from '../../../packages/core/src/store/contract'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
export async function proveProtocolUnicode(executable: string) {
  const cases: unknown[] = []
  await withDataServices(async (admin, environment) =>
    withProtocolDatabase(admin, environment, async (env) => {
      const secret = 'isolated-utf16-fake-secret',
        clock = () => new Date('2030-01-01T00:00:00.000Z'),
        ts = await openPostgresBuildStoreFromEnv(env, { clock }),
        sql = new SQL(env.AB_POSTGRES_URL!, { max: 1 }),
        projects = new PostgresProjectRegistry(sql),
        credentials = new PostgresCredentialStore(sql, projects)
      const repo = (await projects.add('https://github.com/proa/utf16-proof', 'proof')).repo,
        owner = await credentials.issue(repo, 'proof')
      const server = await startProtocolServer({
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
      }
      const wireOracle = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: (r) => oracle.fetch(r),
      })
      try {
        const body = `{"repo":${JSON.stringify(repo)},"discarded":"\\ud800"}`
        const init = {
          method: 'POST',
          headers: { ...headers, authorization: `Bearer ${owner.token}` },
          body,
        }
        const [native, source] = await Promise.all([
          server.fetch(`${server.url}/repos`, init),
          oracle.fetch(new Request('http://source/repos', init)),
        ])
        assert.equal(native.status, source.status)
        cases.push({
          case: 'discarded-lone-surrogate-field',
          request: {
            path: '/repos',
            method: 'POST',
            body,
            authorization: 'valid issued project credential retained only in memory',
          },
          native: { status: native.status, body: await native.json() },
          source: { status: source.status, body: await source.json() },
        })
        await ts.createBuild({ slug: '\ufffd', repo })
        await ts.append('\ufffd', sampleEventWrite())
        await ts.createBuild({ slug: 'witness', repo })
        let resolved: unknown
        try {
          resolved = await ts.getBuild('\ud800')
        } catch (error) {
          resolved = { error: error instanceof Error ? error.message : String(error) }
        }
        const scope = {
            version: 2 as const,
            delegation: { repo, kind: 'build-runner' as const, id: '\ud800', anchor: 1 },
          },
          token = mintToken(secret, scope)
        const read = { headers: { ...headers, authorization: `Bearer ${token}` } }
        const [a, b] = await Promise.all([
          server.fetch(`${server.url}/builds/witness`, read),
          oracle.fetch(new Request('http://source/builds/witness', read)),
        ])
        assert.equal(a.status, b.status)
        cases.push({
          case: 'lone-surrogate-claim-public-read',
          scope,
          sourceBuildLookup: resolved,
          request: {
            path: '/builds/witness',
            method: 'GET',
            authorization: 'fake-key-signed grant retained only in memory',
          },
          native: { status: a.status, body: await a.json() },
          source: { status: b.status, body: await b.json() },
        })
        const path = '/builds/%EF%BF%BD/events',
          write = {
            method: 'POST',
            headers: read.headers,
            body: JSON.stringify(sampleEventWrite()),
          }
        const [x, y] = await Promise.all([
          server.fetch(`${server.url}${path}`, write),
          oracle.fetch(new Request(`http://source${path}`, write)),
        ])
        assert.equal(x.status, y.status)
        cases.push({
          case: 'lone-surrogate-does-not-own-replacement-identity',
          request: { path, method: 'POST' },
          native: { status: x.status, body: await x.json() },
          source: { status: y.status, body: await y.json() },
        })
        for (const bytes of [[255], [192, 175], [237, 160, 128], [226, 130], [239, 191, 189]]) {
          const rawBody = Buffer.concat([
            Buffer.from(`{"repo":${JSON.stringify(repo)},"discarded":"`),
            Buffer.from(bytes),
            Buffer.from('"}'),
          ])
          const init = {
            method: 'POST',
            headers: { ...headers, authorization: `Bearer ${owner.token}` },
            body: rawBody,
          }
          const nativeResponse = await fetch(`${server.url}/repos`, init)
          const sourceResponse = await fetch(new URL('/repos', wireOracle.url), init)
          const actual = { status: nativeResponse.status, body: await nativeResponse.json() }
          const expected = { status: sourceResponse.status, body: await sourceResponse.json() }
          assert.deepEqual(actual, expected, `UTF8 bytes ${bytes.join(',')}`)
          cases.push({ case: 'raw-utf8-http', bytes, native: actual, source: expected })
        }
        for (const entry of cases) {
          const row = entry as { native: unknown; source: unknown }
          assert.deepEqual(row.native, row.source)
        }
      } finally {
        wireOracle.stop(true)
        await server.close()
        await ts.close()
        await sql.close()
      }
    }),
  )
  return cases
}
