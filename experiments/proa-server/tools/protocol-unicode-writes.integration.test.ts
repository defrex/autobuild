/** Independent databases make mutation responses directly comparable without
 * double-applying one operation to a shared state. Setup adapters are fixtures. */
import { strict as assert } from 'node:assert'
import { buildCreatedWrite, sampleEventWrite } from '../../../packages/core/src/store/contract'
import { openPostgresBuildStoreFromEnv } from '../../../packages/postgres-store/src/config'
import { createStoreServer } from '../../../packages/hosted-store-service/src/remote-store-server'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import { withDataServices } from './data-services'
import { withProtocolDatabase } from './protocol-harness'
import { startProtocolServer } from './protocol-server-harness'

export async function proveProtocolUnicodeWrites(executable: string) {
  let comparisons = 0
  await withDataServices(async (admin, environment) =>
    withProtocolDatabase(admin, environment, async (nativeEnv) =>
      withProtocolDatabase(admin, environment, async (sourceEnv) => {
        const clock = () => new Date('2030-01-01T00:00:00.000Z')
        const repo = 'unicode-write-repo',
          build = 'unicode-write-build'
        const fixtures = await openPostgresBuildStoreFromEnv(nativeEnv, { clock })
        const source = await openPostgresBuildStoreFromEnv(sourceEnv, { clock })
        let native: Awaited<ReturnType<typeof startProtocolServer>> | undefined
        let oracle: ReturnType<typeof Bun.serve> | undefined
        try {
          for (const store of [fixtures, source]) {
            await store.ensureRepo(repo)
            const created = buildCreatedWrite()
            created.payload.repo = repo
            await store.createBuild({ slug: build, repo, created })
          }
          native = await startProtocolServer({ executable, env: nativeEnv, clock })
          const service = createStoreServer({ store: source, clock })
          oracle = Bun.serve({
            hostname: '127.0.0.1',
            port: 0,
            fetch: (request) => service.fetch(request),
          })
          const headers = {
            'content-type': 'application/json',
            'x-autobuild-version': AUTOBUILD_VERSION,
            'x-autobuild-protocol-version': REMOTE_STORE_PROTOCOL_VERSION,
          }
          const compare = async (path: string, method = 'GET', body?: unknown, status?: number) => {
            const init = {
              method,
              headers,
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }
            const [a, b] = await Promise.all([
              native!.fetch(`${native!.url}${path}`, init),
              fetch(new URL(path, oracle!.url), init),
            ])
            const actual = { status: a.status, body: await a.json() }
            const expected = { status: b.status, body: await b.json() }
            assert.deepEqual(actual, expected, `${method} ${path}`)
            if (status !== undefined) assert.equal(actual.status, status, `${method} ${path}`)
            comparisons++
            return actual.body
          }
          const compareRaw = async (path: string, bytes: Uint8Array, status: number) => {
            const init = { method: 'PUT', headers, body: Buffer.from(bytes) }
            const [a, b] = await Promise.all([
              native!.fetch(`${native!.url}${path}`, init),
              fetch(new URL(path, oracle!.url), init),
            ])
            const actual = { status: a.status, body: await a.json() },
              expected = { status: b.status, body: await b.json() }
            assert.deepEqual(actual, expected, `raw snapshot boundary ${status}`)
            assert.equal(actual.status, status)
            comparisons++
          }
          const bp = `/builds/${build}`,
            rp = `/repos/${repo}`
          const state = {
            '\ud800': ['\udfff', '\ufffd', '😀', { '$serde_json::private::Number': 'ordinary' }],
          }
          await compare(`${bp}/snapshots/unicode`, 'PUT', { version: 1, cursor: 1, state }, 200)
          assert.deepEqual(
            await fixtures.getReducerSnapshot({ kind: 'build', slug: build }, 'unicode', 1),
            { version: 1, cursor: 1, state },
          )
          for (const store of [fixtures, source])
            await store.putReducerSnapshot({ kind: 'build', slug: build }, 'from-typescript', {
              version: 1,
              cursor: 1,
              state,
            })
          assert.deepEqual(await compare(`${bp}/snapshots/from-typescript?version=1`), {
            version: 1,
            cursor: 1,
            state,
          })
          assert.deepEqual(await compare(`${bp}/snapshots/unicode?version=1`), {
            version: 1,
            cursor: 1,
            state,
          })
          await compare(
            `${bp}/snapshots/unicode`,
            'PUT',
            { version: 1, cursor: 1, state: '\ud800' },
            200,
          )
          await compare(`${bp}/snapshots/unicode?version=1`)
          await compare(
            `${rp}/operator-presence`,
            'POST',
            { id: '\ud800', host: '\udfff', pid: 1, startedAt: clock().toISOString() },
            200,
          )
          await compare(`${rp}/operator-presence`)
          await compare(`${bp}/lease/claim`, 'POST', { holder: '\ud800', ttlMs: 10000 }, 200)
          assert.deepEqual(await compare(`${bp}/lease/heartbeat`, 'POST', { holder: '\ud800' }), {
            ok: false,
          })
          assert.deepEqual(await compare(`${bp}/lease/heartbeat`, 'POST', { holder: '\ufffd' }), {
            ok: true,
          })
          await compare(`${bp}/lease/release`, 'POST', { holder: '\ud800' }, 200)
          await compare(bp)
          await compare(`${bp}/lease/release`, 'POST', { holder: '\ufffd' }, 200)
          await compare(bp)
          await compare(
            '/builds',
            'POST',
            { slug: 'new-\ud800', repo, branch: 'branch-\udfff', repoOrigin: 'origin-\ud800' },
            201,
          )
          await compare('/builds', 'POST', { slug: 'new-\ud800', repo }, 409)
          await compare(`${rp}/sessions`, 'POST', { repo, operator: '\ud800' }, 500)
          await compare(`${rp}/sessions`, 'POST', { repo, operator: 'human', title: '\udfff' }, 500)
          const event = sampleEventWrite('unpaired actor')
          event.actor = { kind: 'agent', role: 'implement', session: '\ud800' }
          await compare(`${bp}/events`, 'POST', event, 500)
          await compare(`${bp}/events/conditional`, 'POST', { expectedSeq: 999, event }, 200)
          await compare(`${bp}/events`)
          await compare(`${rp}/tick/begin`, 'POST', { holder: '\ud800' }, 200)
          const max = 16 * 1024 * 1024
          const empty = JSON.stringify({ version: 1, cursor: 1, state: '' })
          const atLimit = Buffer.from(
            JSON.stringify({ version: 1, cursor: 1, state: 'x'.repeat(max - empty.length) }),
          )
          await compareRaw(
            `${bp}/snapshots/unicode`,
            Buffer.concat([Buffer.from([239, 187, 191]), atLimit]),
            200,
          )
          const expanded = Buffer.from(atLimit)
          expanded[expanded.length - 3] = 255
          await compareRaw(`${bp}/snapshots/unicode`, expanded, 413)
          await native.close()
          native = await startProtocolServer({ executable, env: nativeEnv, clock })
          assert.deepEqual(await compare(`${bp}/snapshots/unicode?version=1`), {
            version: 1,
            cursor: 1,
            state,
          })
        } finally {
          oracle?.stop(true)
          await native?.close()
          await fixtures.close()
          await source.close()
        }
      }),
    ),
  )
  return {
    comparisons,
    checks: [
      'separate-database native/source Unicode mutations, exact UTF16 errors, snapshot string envelopes/restart, nonaliasing lease holders, TEXT projections, direct JSONB errors and stale CAS precedence',
    ],
  }
}
