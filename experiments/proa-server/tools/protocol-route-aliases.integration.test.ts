/** Assert successful scoped stream aliases over actual native HTTP. */
import { strict as assert } from 'node:assert'
import { RemoteBuildStore } from '../../../packages/core/src/store/remote/client'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import type { StreamScope } from '../../../packages/core/src/store/streams/types'
import { openPostgresBuildStoreFromEnv } from '../../../packages/postgres-store/src/config'
import { createStoreServer } from '../../../packages/hosted-store-service/src/remote-store-server'
import * as frozen from '../../../packages/hosted-store-service/src/compatibility-fixtures/store-v0.9'
import { withDataServices } from './data-services'
import { withProtocolDatabase } from './protocol-harness'
import { startProtocolServer } from './protocol-server-harness'

export async function proveProtocolRouteAliases(executable: string) {
  let assertions = 0
  await withDataServices(async (admin, environment) =>
    withProtocolDatabase(admin, environment, async (env) => {
      const clock = () => new Date('2030-01-01T00:00:00.000Z'),
        ts = await openPostgresBuildStoreFromEnv(env, { clock })
      let server: Awaited<ReturnType<typeof startProtocolServer>> | undefined, failure: unknown
      try {
        server = await startProtocolServer({ executable, env, clock })
        const native = server,
          store = new RemoteBuildStore({ url: native.url, fetchFn: native.fetch }),
          oracle = createStoreServer({ store: ts, clock })
        await store.ensureRepo('alias-repo')
        await store.createBuild({ slug: 'alias-build', repo: 'alias-repo' })
        const session = await store.createSession({ repo: 'alias-repo', operator: 'proof' })
        const scopes: StreamScope[] = [
          { kind: 'build', build: 'alias-build' },
          { kind: 'repo', repo: 'alias-repo' },
          { kind: 'session', session: session.id },
        ]
        const headers = {
          'content-type': 'application/json',
          'x-autobuild-version': AUTOBUILD_VERSION,
          'x-autobuild-protocol-version': REMOTE_STORE_PROTOCOL_VERSION,
        }
        for (const scope of scopes) {
          const prefix =
            scope.kind === 'build'
              ? `/builds/${scope.build}`
              : scope.kind === 'repo'
                ? `/repos/${scope.repo}`
                : `/sessions/${scope.session}`
          const stream = await store.createStream(scope, 'scoped-route-alias'),
            path = `${prefix}/streams/${stream.id}`
          const get = async (suffix: string) => {
            const actual = await native.fetch(`${native.url}${path}${suffix}`, { headers }),
              expected = await oracle.fetch(
                new Request(`http://oracle${path}${suffix}`, { headers }),
              )
            assert.equal(actual.status, 200)
            assert.deepEqual(
              { status: actual.status, body: await actual.json() },
              { status: expected.status, body: await expected.json() },
            )
            assertions++
          }
          await get('')
          const response = await native.fetch(`${native.url}${path}/chunks`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              parts: [
                { type: 'start', messageId: 'alias' },
                { type: 'text-start', id: 't' },
                { type: 'text-delta', id: 't', delta: 'alias text' },
                { type: 'text-end', id: 't' },
                { type: 'finish' },
              ],
            }),
          })
          assert.equal(response.status, 201)
          const chunk = frozen.streamChunkWireSchema.parse(await response.json())
          assert.deepEqual((await ts.readStream(stream.id)).chunks, [chunk])
          assertions++
          await get('/chunks?since=0')
          const close = await native.fetch(`${native.url}${path}/close`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ outcome: 'completed' }),
          })
          assert.equal(close.status, 200)
          const closed = await close.json()
          frozen.streamRecordWireSchema.parse(closed)
          assert.deepEqual(closed, await ts.getStream(stream.id))
          assertions++
          await get('')
          await get('/chunks?since=0')
        }
      } catch (error) {
        failure = error
      } finally {
        await server?.close().catch((error) => {
          failure ??= error
        })
        await ts.close().catch((error) => {
          failure ??= error
        })
      }
      if (failure) throw failure
    }),
  )
  return {
    assertions,
    checks: [
      'all three scoped stream record/chunk-read/chunk-append/close aliases assert real successful HTTP responses and persisted TypeScript read parity',
    ],
  }
}
