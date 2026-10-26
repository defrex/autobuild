/** Source/native route-tail decoding and missing-resource refusal regressions. */
import { strict as assert } from 'node:assert'
import { openPostgresBuildStoreFromEnv } from '../../../packages/postgres-store/src/config'
import { createStoreServer } from '../../../packages/hosted-store-service/src/remote-store-server'
import { sampleEventWrite } from '../../../packages/core/src/store/contract'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import type { StreamScope } from '../../../packages/core/src/store/streams/types'
import { withDataServices } from './data-services'
import { withProtocolDatabase } from './protocol-harness'
import { startProtocolServer } from './protocol-server-harness'

export async function proveProtocolRouteParity(executable: string) {
  const cases: { method: string; path: string; status: number }[] = []
  await withDataServices(async (admin, environment) =>
    withProtocolDatabase(admin, environment, async (env) => {
      const clock = () => new Date('2030-01-01T00:00:00.000Z'),
        store = await openPostgresBuildStoreFromEnv(env, { clock })
      let server: Awaited<ReturnType<typeof startProtocolServer>> | undefined
      let failure: unknown
      try {
        server = await startProtocolServer({ executable, env, clock })
        const native = server,
          oracle = createStoreServer({ store, clock }),
          repo = 'https://github.com/proa/route-parity',
          encodedRepo = encodeURIComponent(repo),
          slug = 'route/parity'
        await store.ensureRepo(repo)
        await store.createBuild({ slug, repo })
        await store.append(slug, sampleEventWrite())
        const session = await store.createSession({ repo, operator: 'route-parity' })
        const prefixes = {
          build: `/builds/${encodeURIComponent(slug)}`,
          repo: `/repos/${encodedRepo}`,
          session: `/sessions/${session.id}`,
        }
        const headers = {
          'content-type': 'application/json',
          'x-autobuild-version': AUTOBUILD_VERSION,
          'x-autobuild-protocol-version': REMOTE_STORE_PROTOCOL_VERSION,
        }
        const compare = async (
          path: string,
          method = 'GET',
          body?: unknown,
          expectedStatus = 200,
        ) => {
          const init = {
            method,
            headers,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }
          const actual = await native.fetch(`${native.url}${path}`, init),
            expected = await oracle.fetch(new Request(`http://oracle${path}`, init))
          const actualWire = { status: actual.status, body: await actual.json() },
            sourceWire = { status: expected.status, body: await expected.json() }
          assert.equal(sourceWire.status, expectedStatus, `${method} ${path}: valid source fixture`)
          assert.deepEqual(actualWire, sourceWire, `${method} ${path}`)
          cases.push({ method, path, status: sourceWire.status })
          return sourceWire.body
        }
        // Encoded slashes in resource IDs remain part of that ID. Only the
        // source's joined route tail is split again by its subroute handlers.
        await compare(prefixes.build)
        await compare(prefixes.repo)
        await compare(`${prefixes.repo}/operator-presence/id%2Fwith%252Fslash`, 'DELETE')
        await compare(`${prefixes.repo}/operator-presence%2Fid`, 'DELETE', undefined, 404)
        await compare(`${prefixes.repo}/operator-presence/id/extra`, 'DELETE', undefined, 404)
        await compare(`${prefixes.repo}/operator-presence/id`, 'GET', undefined, 404)
        for (const id of ['%20', 'x'.repeat(257)])
          await compare(`${prefixes.repo}/operator-presence/${id}`, 'DELETE', undefined, 500)
        const missingRepo = 'absent/route-repo'
        for (const method of ['GET', 'DELETE']) {
          const missing = await compare(
            `/repos/${encodeURIComponent(missingRepo)}/reducer-values`,
            method,
            undefined,
            404,
          )
          assert.deepEqual(missing, { kind: 'not-found', error: `unknown repo "${missingRepo}"` })
          for (const prefix of [prefixes.repo, prefixes.build]) {
            const path = `${prefix}/reducer-values`
            const fallback = await compare(path, method, undefined, 404)
            assert.deepEqual(fallback, {
              kind: 'not-found',
              error: `no route: ${method} reducer-values`,
            })
          }
        }
        for (const method of ['DELETE', 'PATCH']) {
          for (const repoPath of [prefixes.repo, `/repos/${encodeURIComponent(missingRepo)}`]) {
            const refusal = await compare(`${repoPath}/sessions`, method, undefined, 404)
            assert.deepEqual(refusal, {
              kind: 'not-found',
              error: `no route: ${method} /repos/:repo/sessions`,
            })
          }
        }
        // Stale comparisons traverse the full append/deposit handlers while
        // leaving shared database state unchanged for the oracle's request.
        const event = sampleEventWrite()
        for (const tail of ['events%2Fconditional', 'events%2fconditional']) {
          assert.equal(
            await compare(`${prefixes.build}/${tail}`, 'POST', { expectedSeq: 999, event }),
            null,
          )
          assert.equal(
            await compare(`${prefixes.session}/${tail}`, 'POST', {
              expectedSeq: 999,
              event: {
                actor: { kind: 'human', user: 'route-proof' },
                type: 'message.posted',
                payload: { text: 'proof' },
              },
            }),
            null,
          )
        }
        assert.equal(
          await compare(`${prefixes.build}/deposits%2Fconditional`, 'POST', {
            expectedSeq: 999,
            event,
            artifacts: [],
          }),
          null,
        )
        await compare(`${prefixes.build}/deposits%2Fconditional`, 'POST', {}, 400)
        await compare(`${prefixes.repo}/events%2Fconditional`, 'POST', {}, 404)
        assert.deepEqual(
          await compare(`${prefixes.repo}/lease%2Fheartbeat`, 'POST', { holder: 'absent' }),
          { ok: false },
        )
        await compare(`${prefixes.repo}/tick%2Fbegin`, 'POST', {}, 400)
        for (const prefix of [prefixes.build, prefixes.repo]) {
          await compare(`${prefix}/snapshots%2Froute-proof?version=1`)
          await compare(`${prefix}/snapshots/route%2Fproof?version=1`, 'GET', undefined, 404)
        }
        // Repository special cases run against the original decoded segments,
        // before the ordinary family handler joins and re-splits its tail.
        for (const tail of [
          'operator-presence%2F',
          'sessions%2F',
          'change-position%2F',
          'builds%2F',
          'build-digests%2F',
          'ticket-asset-limits%2F',
          'tickets%2FT-1/assets/list',
        ]) {
          await compare(`${prefixes.repo}/${tail}`, 'GET', undefined, 404)
        }
        for (const prefix of [prefixes.build, prefixes.repo, prefixes.session]) {
          for (const tail of ['%2Fevents', 'events%2F', 'events%252Fconditional']) {
            await compare(`${prefix}/${tail}`, 'GET', undefined, 404)
          }
        }
        const scopes: StreamScope[] = [
          { kind: 'build', build: slug },
          { kind: 'repo', repo },
          { kind: 'session', session: session.id },
        ]
        for (const scope of scopes) {
          const stream = await store.createStream(scope, 'route-parity'),
            prefix = prefixes[scope.kind]
          // Globally addressed streams do not pass through the family join.
          await compare(`/streams/${stream.id}%2Fchunks`, 'GET', undefined, 404)
          await compare(`/streams/${stream.id}%2Fclose`, 'POST', { outcome: 'completed' }, 404)
          await compare(`/streams/${stream.id}/chunks%2Funknown`, 'GET', undefined, 404)
          await compare(`${prefix}/streams%2F${stream.id}`)
          await compare(`${prefix}/streams%2F${stream.id}%2Fchunks`)
          await compare(`${prefix}/streams/${stream.id}%2Fchunks`)
          await compare(
            `${prefix}/streams%2F${stream.id}%2Fchunks`,
            'POST',
            { parts: 'invalid' },
            400,
          )
          await compare(`${prefix}/streams%2F${stream.id}%2Fclose`, 'POST', {
            outcome: 'completed',
          })
        }
        for (const prefix of [prefixes.build, prefixes.repo, prefixes.session]) {
          await compare(`${prefix}/unknown%2Ftail`, 'GET', undefined, 404)
          await compare(`${prefix}/events%2Fconditional`, 'GET', undefined, 404)
        }
        assert.equal(
          (await store.getEvents(slug)).length,
          1,
          'stale/invalid route probes allocate no event sequence',
        )
      } catch (error) {
        failure = error
      } finally {
        await server?.close().catch((error) => {
          failure ??= error
        })
        await store.close().catch((error) => {
          failure ??= error
        })
      }
      if (failure) throw failure
    }),
  )
  return {
    comparisons: cases.length,
    cases,
    checks: [
      'missing repository existence precedes GET/DELETE reducer-values fallback, while known scopes retain the source value-handler refusal text',
      'decoded resource IDs retain slashes while joined route tails match conditional append, deposit, lease, tick, snapshot and scoped stream handlers',
      'encoded-tail unknown methods preserve source fallback text without consuming journal sequences',
    ],
  }
}
