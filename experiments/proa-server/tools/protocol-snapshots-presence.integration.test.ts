/** Explicit native HTTP family proof. The complete shared suite remains the
 * completion bar; importing this file never runs a database test implicitly. */
import { SQL } from 'bun'
import { strict as assert } from 'node:assert'
import { RemoteBuildStore } from '../../../packages/core/src/store/remote/client'
import { sampleEventWrite } from '../../../packages/core/src/store/contract'
import { openPostgresBuildStoreFromEnv } from '../../../packages/postgres-store/src/config'
import { createStoreServer } from '../../../packages/hosted-store-service/src/remote-store-server'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import { PostgresProjectRegistry } from '../../../packages/postgres-store/src/projects'
import { PostgresCredentialStore } from '../../../packages/postgres-store/src/credentials'
import { withDataServices } from './data-services'
import { withProtocolDatabase } from './protocol-harness'
import { startProtocolServer } from './protocol-server-harness'

export async function proveProtocolSnapshotsPresence(executable: string) {
  const checks: string[] = []
  let comparisons = 0
  await withDataServices(async (admin, environment) => {
    await withProtocolDatabase(admin, environment, async (env) => {
      let now = new Date('2030-01-01T00:00:00.000Z')
      const clock = () => now
      const running: Awaited<ReturnType<typeof startProtocolServer>>[] = []
      const ts = await openPostgresBuildStoreFromEnv(env, { clock })
      const inspect = new SQL(env.AB_POSTGRES_URL!, { max: 1 })
      let failure: unknown
      const start = async () => {
        const server = await startProtocolServer({ executable, env, clock })
        running.push(server)
        return { server, store: new RemoteBuildStore({ url: server.url, fetchFn: server.fetch }) }
      }
      try {
        const first = await start(),
          second = await start()
        const scope = { kind: 'build' as const, slug: 'snapshot-build' }
        const repoScope = { kind: 'repo' as const, repo: 'snapshot-repo' }
        await ts.createBuild({ slug: scope.slug, repo: repoScope.repo })
        for (let index = 0; index < 12; index++)
          await ts.append(scope.slug, sampleEventWrite(`${index}`))
        await first.store.ensureRepo(repoScope.repo)
        await ts.appendRepo(repoScope.repo, {
          actor: { kind: 'human', user: 'operator' },
          type: 'dispatcher.intake-set',
          payload: { enabled: false },
        })
        assert.equal(await first.store.getReducerSnapshot(scope, 'cache', 1), null)
        assert.equal(
          await first.store.getReducerSnapshot({ kind: 'build', slug: 'missing' }, 'cache', 1),
          null,
        )
        assert.equal(
          await first.store.putReducerSnapshot({ kind: 'build', slug: 'missing' }, 'cache', {
            version: 1,
            cursor: 0,
            state: {},
          }),
          false,
        )
        assert.equal(
          await first.store.getReducerSnapshot({ kind: 'repo', repo: 'missing' }, 'cache', 1),
          null,
        )
        assert.equal(
          await first.store.putReducerSnapshot({ kind: 'repo', repo: 'missing' }, 'cache', {
            version: 1,
            cursor: 0,
            state: {},
          }),
          false,
        )
        assert.equal(await ts.getRepo('missing'), null)
        assert.equal(
          await first.store.putReducerSnapshot(scope, 'cache', {
            version: 1,
            cursor: 13,
            state: {},
          }),
          false,
        )
        const initial = {
          version: 1,
          cursor: 2,
          state: { nested: { count: 1 }, list: [null, true, 'value'] },
        }
        assert.equal(await first.store.putReducerSnapshot(scope, 'cache', initial), true)
        initial.state.nested.count = 99
        const read = await second.store.getReducerSnapshot(scope, 'cache', 1)
        assert.deepEqual(read, {
          version: 1,
          cursor: 2,
          state: { nested: { count: 1 }, list: [null, true, 'value'] },
        })
        ;(read!.state as { nested: { count: number } }).nested.count = 5
        const detached = await first.store.getReducerSnapshot(scope, 'cache', 1)
        assert.equal((detached!.state as { nested: { count: number } }).nested.count, 1)
        assert.equal(
          await first.store.putReducerSnapshot(scope, 'cache', {
            version: 1,
            cursor: 2,
            state: 'same',
          }),
          false,
        )
        assert.equal(
          await first.store.putReducerSnapshot(scope, 'cache', {
            version: 9,
            cursor: 1,
            state: 'older',
          }),
          false,
        )
        assert.equal(
          await first.store.putReducerSnapshot(scope, 'cache', {
            version: 2,
            cursor: 2,
            state: 'upgrade',
          }),
          true,
        )
        assert.equal(
          await first.store.putReducerSnapshot(scope, 'cache', {
            version: 1,
            cursor: 3,
            state: 'downgrade',
          }),
          false,
        )
        assert.deepEqual(await second.store.getReducerSnapshot(scope, 'cache', 2), {
          version: 2,
          cursor: 2,
          state: 'upgrade',
        })
        assert.deepEqual(await ts.getReducerSnapshot(scope, 'cache', 2), {
          version: 2,
          cursor: 2,
          state: 'upgrade',
        })
        assert.equal(await first.store.getReducerSnapshot(scope, 'cache', 1), null)
        assert.equal(
          await first.store.putReducerSnapshot(scope, 'cache', {
            version: 2,
            cursor: 3,
            state: { marker: 'advance' },
          }),
          true,
        )
        assert.deepEqual(await ts.getReducerSnapshot(scope, 'cache', 2), {
          version: 2,
          cursor: 3,
          state: { marker: 'advance' },
        })
        assert.equal(await first.store.getReducerSnapshot(repoScope, 'cache', 2), null)
        assert.equal(
          await first.store.putReducerSnapshot(repoScope, 'cache', {
            version: 1,
            cursor: 1,
            state: null,
          }),
          true,
        )
        assert.deepEqual(await second.store.getReducerSnapshot(repoScope, 'cache', 1), {
          version: 1,
          cursor: 1,
          state: null,
        })
        // The shared adapter persists a JSONB string containing JSON text.
        // Both scalar strings and escaped NUL values must cross languages.
        assert.equal(
          await first.store.putReducerSnapshot(scope, 'nul', {
            version: 1,
            cursor: 0,
            state: '\u0000',
          }),
          true,
        )
        assert.deepEqual(await ts.getReducerSnapshot(scope, 'nul', 1), {
          version: 1,
          cursor: 0,
          state: '\u0000',
        })
        assert.equal(
          await ts.putReducerSnapshot(scope, 'ts-scalar', {
            version: 1,
            cursor: 1,
            state: 'from TS',
          }),
          true,
        )
        assert.deepEqual(await first.store.getReducerSnapshot(scope, 'ts-scalar', 1), {
          version: 1,
          cursor: 1,
          state: 'from TS',
        })
        assert.equal(
          await first.store.putReducerSnapshot(scope, 'legacy-object', {
            version: 1,
            cursor: 1,
            state: { current: true },
          }),
          true,
        )
        await inspect`UPDATE reducer_snapshots SET state=${JSON.stringify({ legacy: true })}::text::jsonb WHERE scope_kind='build' AND scope_key=${scope.slug} AND reducer='legacy-object'`
        assert.deepEqual(await second.store.getReducerSnapshot(scope, 'legacy-object', 1), {
          version: 1,
          cursor: 1,
          state: { legacy: true },
        })
        assert.deepEqual(await ts.getReducerSnapshot(scope, 'legacy-object', 1), {
          version: 1,
          cursor: 1,
          state: { legacy: true },
        })
        checks.push(
          'build/repository cache isolation, detached JSON, absent scopes, tail bounds and monotone cursor/version replacement',
        )

        const writers = [first.store, second.store, ts]
        await Promise.all(
          writers.map(async (writer, index) => {
            for (const cursor of [1 + index, 4 + index, 7 + index, 10 + index]) {
              await writer.putReducerSnapshot(scope, 'race', {
                version: 1,
                cursor,
                state: { cursor },
              })
            }
          }),
        )
        assert.deepEqual(await second.store.getReducerSnapshot(scope, 'race', 1), {
          version: 1,
          cursor: 12,
          state: { cursor: 12 },
        })
        await inspect`UPDATE reducer_snapshots SET cursor=99 WHERE scope_kind='build' AND scope_key=${scope.slug} AND reducer='race'`
        assert.equal(await first.store.getReducerSnapshot(scope, 'race', 1), null)
        assert.equal(await ts.getReducerSnapshot(scope, 'race', 1), null)
        checks.push(
          'two independent Rust writers and TypeScript share atomic snapshot upserts; persisted ahead-of-tail cache is hidden',
        )

        const presenceRepo = 'presence-without-journal'
        const identity = { id: ' alpha ', host: ' host-a ', pid: 42, startedAt: now.toISOString() }
        assert.deepEqual(await first.store.listOperatorPresence(presenceRepo), [])
        const firstPresence = await first.store.upsertOperatorPresence(presenceRepo, identity)
        assert.deepEqual(firstPresence, {
          repo: presenceRepo,
          id: 'alpha',
          host: 'host-a',
          pid: 42,
          startedAt: identity.startedAt,
          heartbeatAt: now.toISOString(),
        })
        assert.equal(await first.store.getRepo(presenceRepo), null)
        assert.equal(await first.store.getRepoChangePosition(presenceRepo), '0')
        now = new Date(now.getTime() + 299999)
        assert.equal((await second.store.listOperatorPresence(presenceRepo)).length, 1)
        now = new Date(now.getTime() + 1)
        assert.deepEqual(await first.store.listOperatorPresence(presenceRepo), [])
        const renewed = await second.store.upsertOperatorPresence(presenceRepo, {
          ...identity,
          host: 'host-b',
          pid: 43,
          startedAt: now.toISOString(),
        })
        assert.equal(renewed.startedAt, identity.startedAt)
        assert.equal(renewed.host, 'host-b')
        assert.equal(renewed.pid, 43)
        const newestHeartbeat = renewed.heartbeatAt
        now = new Date(now.getTime() - 1000)
        assert.equal(
          (
            await first.store.upsertOperatorPresence(presenceRepo, {
              ...identity,
              host: 'host-backwards',
            })
          ).heartbeatAt,
          newestHeartbeat,
        )
        await Promise.all([
          first.store.upsertOperatorPresence(presenceRepo, { ...identity, id: 'zeta' }),
          second.store.upsertOperatorPresence(presenceRepo, { ...identity, id: 'beta' }),
          ts.upsertOperatorPresence(presenceRepo, { ...identity, id: 'gamma' }),
        ])
        assert.deepEqual(
          (await first.store.listOperatorPresence(presenceRepo)).map((row) => row.id),
          ['alpha', 'beta', 'gamma', 'zeta'],
        )
        assert.equal(await ts.getRepo(presenceRepo), null)
        assert.equal(await ts.getRepoChangePosition(presenceRepo), '0')
        const records =
          await inspect`SELECT count(*)::int AS n FROM repo_events WHERE repo=${presenceRepo}`
        assert.equal(records[0].n, 0)
        const snapshotRepo = await first.store.getRepo(repoScope.repo)
        const repoEvents = await first.store.getRepoEvents(repoScope.repo)
        const position = await first.store.getRepoChangePosition(repoScope.repo)
        await first.store.upsertOperatorPresence(repoScope.repo, identity)
        assert.deepEqual(await second.store.getRepo(repoScope.repo), snapshotRepo)
        assert.deepEqual(await second.store.getRepoEvents(repoScope.repo), repoEvents)
        assert.equal(await second.store.getRepoChangePosition(repoScope.repo), position)
        checks.push(
          'presence trimming, stable initial start, monotone heartbeat, exact freshness, sorted concurrent upserts and no journal/event/position writes',
        )

        const oracle = createStoreServer({ store: ts, clock })
        const headers = {
          'content-type': 'application/json',
          'x-autobuild-version': AUTOBUILD_VERSION,
          'x-autobuild-protocol-version': REMOTE_STORE_PROTOCOL_VERSION,
        }
        for (const [name, body] of [
          ['missing-state', JSON.stringify({ version: 1, cursor: 0 })],
          ['null-state', JSON.stringify({ version: 1, cursor: 0, state: null })],
        ]) {
          const rust = await first.server.fetch(
            `${first.server.url}/builds/${scope.slug}/snapshots/${name}-rust`,
            { method: 'PUT', headers, body },
          )
          const tsResponse = await oracle.fetch(
            new Request(`http://oracle/builds/${scope.slug}/snapshots/${name}-ts`, {
              method: 'PUT',
              headers,
              body,
            }),
          )
          assert.deepEqual(
            { status: rust.status, body: await rust.json() },
            { status: tsResponse.status, body: await tsResponse.json() },
            name,
          )
          if (name === 'missing-state') {
            assert.equal(rust.status, 400)
            assert.equal(await first.store.getReducerSnapshot(scope, `${name}-rust`, 1), null)
            assert.equal(await ts.getReducerSnapshot(scope, `${name}-ts`, 1), null)
            comparisons++
            continue
          }
          assert.equal(rust.status, 200)
          assert.deepEqual(await first.store.getReducerSnapshot(scope, `${name}-rust`, 1), {
            version: 1,
            cursor: 0,
            state: null,
          })
          assert.deepEqual(await ts.getReducerSnapshot(scope, `${name}-rust`, 1), {
            version: 1,
            cursor: 0,
            state: null,
          })
          assert.deepEqual(await second.store.getReducerSnapshot(scope, `${name}-ts`, 1), {
            version: 1,
            cursor: 0,
            state: null,
          })
          comparisons++
        }
        const requests: { method: string; path: string; body?: string }[] = [
          { method: 'GET', path: `/builds/${scope.slug}/snapshots/cache` },
          { method: 'GET', path: `/builds/${scope.slug}/snapshots/cache?version=bad` },
          { method: 'GET', path: `/builds/${scope.slug}/snapshots/cache?version=0` },
          { method: 'GET', path: `/builds/${scope.slug}/snapshots/cache?version=0x2` },
          { method: 'GET', path: `/builds/${scope.slug}/snapshots/value.private?version=1` },
          { method: 'PUT', path: `/builds/${scope.slug}/snapshots/value.%21`, body: '{' },
          { method: 'GET', path: `/builds/${scope.slug}/snapshots/a%2Fb?version=1` },
          { method: 'DELETE', path: `/builds/${scope.slug}/snapshots/cache` },
          { method: 'PUT', path: `/builds/${scope.slug}/snapshots/cache`, body: '{' },
          {
            method: 'PUT',
            path: `/builds/${scope.slug}/snapshots/cache`,
            body: JSON.stringify({ version: 1.5, cursor: -1, state: {} }),
          },
          { method: 'PUT', path: `/builds/${scope.slug}/snapshots/cache`, body: 'null' },
          { method: 'GET', path: '/builds/missing/snapshots/cache?version=bad' },
          { method: 'GET', path: '/repos/missing/snapshots/cache?version=1' },
          { method: 'PUT', path: '/repos/missing/snapshots/value.private', body: '{' },
          { method: 'DELETE', path: '/repos/missing/operator-presence' },
        ]
        requests.push({
          method: 'POST',
          path: '/repos/invalid-presence/operator-presence',
          body: JSON.stringify({ ...identity, startedAt: '0000-01-01T00:00:00.000Z' }),
        })
        for (const value of [2147483648, 9007199254740991]) {
          requests.push({
            method: 'GET',
            path: `/builds/${scope.slug}/snapshots/cache?version=${value}`,
          })
          requests.push({
            method: 'PUT',
            path: `/builds/${scope.slug}/snapshots/cache`,
            body: JSON.stringify({ version: value, cursor: 0, state: {} }),
          })
          requests.push({
            method: 'POST',
            path: '/repos/invalid-presence/operator-presence',
            body: JSON.stringify({ ...identity, pid: value }),
          })
        }
        for (const bad of [
          { id: '' },
          { host: '' },
          { pid: 0 },
          { pid: 1.5 },
          { startedAt: 'bad' },
          { id: 'x'.repeat(257) },
          { extra: true },
        ]) {
          requests.push({
            method: 'POST',
            path: '/repos/invalid-presence/operator-presence',
            body: JSON.stringify({ ...identity, ...bad }),
          })
        }
        for (const request of requests) {
          const init = {
            method: request.method,
            headers,
            ...(request.body === undefined ? {} : { body: request.body }),
          }
          const rust = await first.server.fetch(`${first.server.url}${request.path}`, init)
          const tsResponse = await oracle.fetch(new Request(`http://oracle${request.path}`, init))
          assert.deepEqual(
            { status: rust.status, body: await rust.json() },
            { status: tsResponse.status, body: await tsResponse.json() },
            `${request.method} ${request.path}`,
          )
          comparisons++
        }
        assert.deepEqual(await first.store.listOperatorPresence('invalid-presence'), [])
        const projects = new PostgresProjectRegistry(inspect)
        const credentials = new PostgresCredentialStore(inspect, projects)
        const own = (await projects.add('https://github.com/proa/snapshot-own', 'proof')).repo
        const other = (await projects.add('https://github.com/proa/snapshot-other', 'proof')).repo
        const { token } = await credentials.issue(own, 'operator')
        await ts.createBuild({ slug: 'owned-snapshot', repo: own })
        await ts.createBuild({ slug: 'foreign-snapshot', repo: other })
        const authenticated = await startProtocolServer({
          executable,
          env: { ...env, PROA_TEST_AUTH: 'project' },
          clock,
        })
        running.push(authenticated)
        const ownClient = new RemoteBuildStore({
          url: authenticated.url,
          token,
          fetchFn: authenticated.fetch,
        })
        assert.equal(
          await ownClient.putReducerSnapshot({ kind: 'build', slug: 'owned-snapshot' }, 'cache', {
            version: 1,
            cursor: 0,
            state: 'owned',
          }),
          true,
        )
        assert.equal(
          (await ownClient.upsertOperatorPresence(own, { ...identity, id: 'authenticated' })).repo,
          own,
        )
        assert.equal(await ts.getRepo(own), null)
        const authRequest = async (path: string, method: string, body?: string) => {
          const response = await authenticated.fetch(`${authenticated.url}${path}`, {
            method,
            headers: { ...headers, authorization: `Bearer ${token}` },
            ...(body === undefined ? {} : { body }),
          })
          return { status: response.status, body: await response.json() }
        }
        assert.deepEqual(
          await authRequest('/builds/foreign-snapshot/snapshots/value.private', 'PUT', '{'),
          {
            status: 404,
            body: {
              kind: 'not-found',
              error: 'resource unavailable: unknown resource or wrong project',
            },
          },
        )
        assert.deepEqual(
          await authRequest('/builds/unknown-snapshot/snapshots/value.private', 'PUT', '{'),
          {
            status: 404,
            body: {
              kind: 'not-found',
              error: 'resource unavailable: unknown resource or wrong project',
            },
          },
        )
        assert.deepEqual(
          await authRequest(`/repos/${encodeURIComponent(other)}/operator-presence`, 'POST', '{'),
          { status: 403, body: { kind: 'auth', error: 'wrong project' } },
        )
        assert.deepEqual(
          await authRequest(
            `/repos/${encodeURIComponent(other)}/snapshots/value.private`,
            'PUT',
            '{',
          ),
          { status: 403, body: { kind: 'auth', error: 'wrong project' } },
        )
        checks.push(
          'project-authenticated snapshot/presence access and foreign/missing authority gates precede malformed names/bodies',
        )

        const max = 16 * 1024 * 1024
        const wrapper = JSON.stringify({ version: 1, cursor: 0, state: { blob: '' } })
        const exact = JSON.stringify({
          version: 1,
          cursor: 0,
          state: { blob: 'x'.repeat(max - wrapper.length) },
        })
        assert.equal(Buffer.byteLength(exact), max)
        const atCeiling = await first.server.fetch(
          `${first.server.url}/builds/${scope.slug}/snapshots/ceiling`,
          { method: 'PUT', headers, body: exact },
        )
        assert.deepEqual(
          { status: atCeiling.status, body: await atCeiling.json() },
          { status: 200, body: { written: true } },
        )
        assert.equal(
          ((await ts.getReducerSnapshot(scope, 'ceiling', 1))!.state as { blob: string }).blob
            .length,
          max - wrapper.length,
        )
        for (const [path, expected] of [
          [
            `/builds/${scope.slug}/snapshots/over`,
            {
              status: 413,
              body: { kind: 'validation', error: 'snapshot body is over the 16 MiB ceiling' },
            },
          ],
          [
            `/builds/${scope.slug}/snapshots/value.private`,
            {
              status: 400,
              body: { kind: 'validation', error: 'reserved reducer value snapshot namespace' },
            },
          ],
        ] as const) {
          const response = await first.server.fetch(`${first.server.url}${path}`, {
            method: 'PUT',
            headers,
            body: 'é'.repeat(max / 2 + 1),
          })
          assert.deepEqual({ status: response.status, body: await response.json() }, expected)
        }
        assert.equal(await first.store.getReducerSnapshot(scope, 'over', 1), null)
        checks.push(
          `${comparisons} exact HTTP refusal/body comparisons and 16MiB UTF-8 snapshot body boundary with mutation-free refusal`,
        )

        await first.server.close()
        const restarted = await start()
        assert.deepEqual(await restarted.store.getReducerSnapshot(scope, 'cache', 2), {
          version: 2,
          cursor: 3,
          state: { marker: 'advance' },
        })
        assert.deepEqual(
          await restarted.store.listOperatorPresence(presenceRepo),
          await ts.listOperatorPresence(presenceRepo),
        )
        await inspect`ALTER TABLE reducer_snapshots RENAME TO fixture_saved_snapshots`
        assert.equal(await restarted.store.getReducerSnapshot(scope, 'cache', 2), null)
        assert.equal(
          await restarted.store.putReducerSnapshot(scope, 'cache', {
            version: 3,
            cursor: 4,
            state: 'missing table',
          }),
          false,
        )
        await inspect`ALTER TABLE fixture_saved_snapshots RENAME TO reducer_snapshots`
        assert.equal(
          await restarted.store.putReducerSnapshot(scope, 'cache', {
            version: 3,
            cursor: 4,
            state: 'restored table',
          }),
          true,
        )
        assert.deepEqual(await second.store.getReducerSnapshot(scope, 'cache', 3), {
          version: 3,
          cursor: 4,
          state: 'restored table',
        })
        checks.push(
          'restart continuity, additive missing snapshot table degrades to cache miss and recovers without restart',
        )
      } catch (error) {
        failure = error
      } finally {
        const cleanup = await Promise.allSettled([
          ...running.map((server) => server.close()),
          ts.close(),
          inspect.close(),
        ])
        const errors = cleanup.filter(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        )
        if (errors.length)
          failure = new AggregateError(
            [...(failure === undefined ? [] : [failure]), ...errors.map((result) => result.reason)],
            'Snapshot/presence proof cleanup failed',
          )
      }
      if (failure !== undefined) throw failure
    })
  })
  return {
    kind: 'snapshot-presence-checkpoint',
    fullBuildStoreContract: false,
    comparisons,
    checks,
  }
}
