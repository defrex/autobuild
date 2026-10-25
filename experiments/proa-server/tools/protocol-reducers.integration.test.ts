/** Explicit native named-value checkpoint. The complete registry remains required. */
import { strict as assert } from 'node:assert'
import { SQL } from 'bun'
import { RemoteBuildStore } from '../../../packages/core/src/store/remote/client'
import { sampleEventWrite } from '../../../packages/core/src/store/contract'
import { REDUCERS } from '../../../packages/core/src/kernel/reducer-registry'
import { resolveReducerValue } from '../../../packages/core/src/store/reducer-values'
import { openPostgresBuildStoreFromEnv } from '../../../packages/postgres-store/src/config'
import { createStoreServer } from '../../../packages/hosted-store-service/src/remote-store-server'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import { withDataServices } from './data-services'
import { withProtocolDatabase } from './protocol-harness'
import { startProtocolServer } from './protocol-server-harness'
import { readReducerFixtures, supportedReducers } from './protocol-reducer-fixtures'

export async function proveProtocolReducers(executable: string) {
  const checks: string[] = []
  let comparisons = 0
  await withDataServices(async (admin, environment) =>
    withProtocolDatabase(admin, environment, async (env) => {
      const clock = () => new Date('2030-01-01T00:00:00.000Z')
      const ts = await openPostgresBuildStoreFromEnv(env, { clock })
      const sql = new SQL(env.AB_POSTGRES_URL!, { max: 1 })
      const servers: Awaited<ReturnType<typeof startProtocolServer>>[] = []
      const start = async () => {
        const server = await startProtocolServer({ executable, env, clock })
        servers.push(server)
        return { server, store: new RemoteBuildStore({ url: server.url, fetchFn: server.fetch }) }
      }
      let failure: unknown
      try {
        const a = await start(),
          b = await start()
        const oracle = createStoreServer({ store: ts, clock })
        const headers = {
          'content-type': 'application/json',
          'x-autobuild-version': AUTOBUILD_VERSION,
          'x-autobuild-protocol-version': REMOTE_STORE_PROTOCOL_VERSION,
        }
        const compare = async (path: string, method: string, raw?: string) => {
          const init = { method, headers, ...(raw === undefined ? {} : { body: raw }) }
          const actual = await a.server.fetch(`${a.server.url}${path}`, init),
            expected = await oracle.fetch(new Request(`http://oracle${path}`, init))
          assert.deepEqual(
            {
              status: actual.status,
              body: await actual.json(),
              catalog: actual.headers.get('x-autobuild-catalog-identity'),
            },
            {
              status: expected.status,
              body: await expected.json(),
              catalog: expected.headers.get('x-autobuild-catalog-identity'),
            },
            `${method} ${path} ${raw}`,
          )
          comparisons++
        }
        await ts.createBuild({ slug: 'values-build', repo: 'values-repo' })
        await ts.ensureRepo('values-repo')
        for (const row of readReducerFixtures().validation) {
          if ('rejected' in row)
            await compare(
              `/${row.scope === 'repo' ? 'repos/values-repo' : 'builds/values-build'}/reducer-values`,
              'POST',
              row.raw,
            )
        }
        await compare('/builds/values-build/reducer-values', 'GET')
        await compare('/repos/values-repo/reducer-values', 'GET')
        await compare('/builds/values-build/reducer-values', 'POST', ' '.repeat(4097))
        await compare('/repos/values-repo/reducer-values', 'POST', ' '.repeat(4097))
        checks.push(
          'all catalog exclusions/unknown names/scope/args/wire refusals, syntax errors,4KiB ceiling and exact catalog header parity',
        )
        const values = async () => {
          for (const name of supportedReducers) {
            const entry = REDUCERS[name]!.valueRead
            if ('excluded' in entry) throw new Error(name)
            const scope =
              entry.scope === 'repo'
                ? { kind: 'repo' as const, repo: 'values-repo' }
                : { kind: 'build' as const, slug: 'values-build' }
            const variants =
              name === 'dispatchFailureBudget'
                ? [{ infrastructureOwnsWorkspace: false }, { infrastructureOwnsWorkspace: true }]
                : name === 'phaseFailures'
                  ? [
                      { phase: 'plan', round: 1 },
                      { phase: 'implement', round: 2 },
                    ]
                  : name === 'terminalGuard'
                    ? [
                        { phase: 'plan', round: 1, session: 'session-a' },
                        { phase: 'implement', round: 2, session: 'session-b' },
                      ]
                    : [
                        ['dispatcherRunFacts', 'dispatchStatus', 'openTick'].includes(name)
                          ? { run: 'run-a' }
                          : {},
                      ]
            for (const args of variants) {
              const request = {
                reducer: name,
                args: args as Record<string, string | boolean | number>,
              }
              const expected = await ts.getReducerValue(scope, request)
              assert.deepEqual(await a.store.getReducerValue(scope, request), expected, name)
              assert.deepEqual(
                await b.store.getReducerValue(scope, request),
                expected,
                `${name} second native process`,
              )
              comparisons += 2
            }
          }
        }
        await values()
        await ts.append('values-build', sampleEventWrite('first'))
        await ts.appendRepo('values-repo', {
          actor: { kind: 'human', user: 'operator' },
          type: 'dispatcher.intake-set',
          payload: { enabled: false },
        })
        await values()
        const scope = { kind: 'build' as const, slug: 'values-build' },
          request = { reducer: 'build' }
        const resolved = resolveReducerValue(scope, request)
        await sql`INSERT INTO reducer_snapshots(scope_kind,scope_key,reducer,version,cursor,state,updated_at) VALUES('build','values-build',${resolved.key},${resolved.reducer.version},999,${JSON.stringify({ identity: resolved.identity, acc: { poison: true } })},${clock().toISOString()}) ON CONFLICT(scope_kind,scope_key,reducer) DO UPDATE SET state=EXCLUDED.state,cursor=EXCLUDED.cursor`
        await compare('/builds/values-build/reducer-values', 'POST', JSON.stringify(request))
        checks.push(
          `${supportedReducers.length} native named values match empty/populated TS replay, independent process reads and poisoned private cache fallback`,
        )
        const position = await a.store.getRepoChangePosition('values-repo')
        const before = await ts.getBuild('values-build')
        await values()
        assert.equal(await a.store.getRepoChangePosition('values-repo'), position)
        assert.deepEqual(await ts.getBuild('values-build'), before)
        await compare(
          '/repos/missing/reducer-values',
          'POST',
          JSON.stringify({ reducer: 'dispatchSettings' }),
        )
        await compare(
          '/repos/missing/reducer-values',
          'POST',
          JSON.stringify({ reducer: 'missing' }),
        )
        await compare('/builds/missing/reducer-values', 'POST', '{')
        const restarted = await start()
        assert.deepEqual(
          await restarted.store.getReducerValue(scope, request),
          await ts.getReducerValue(scope, request),
        )
        checks.push(
          'repeated read purity, exact missing scope/validation precedence and fresh native process restart',
        )
        await compare('/repos/values-repo/build-digests', 'GET')
        await compare('/repos/missing/build-digests', 'GET')
        await ts.createBuild({ slug: 'build-only-value', repo: 'no-journal' })
        await compare('/repos/no-journal/build-digests', 'GET')
        await compare('/builds/values-build/reducer-values', 'POST', ' '.repeat(4096))
        // Unknown persisted events are skipped by selector folds but contribute to
        // compatibility-bearing current-state answers and the authoritative cursor.
        await sql`INSERT INTO events(build,seq,ts,actor,type,payload,compatibility) VALUES('values-build',2,${clock().toISOString()},${{ kind: 'kernel' }},'future.advisory',${{ note: 'future' }},${{ writerVersion: 'future', classification: 'advisory' }})`
        await sql`INSERT INTO repo_events(repo,seq,ts,actor,type,payload,compatibility) VALUES('values-repo',2,${clock().toISOString()},${{ kind: 'kernel' }},'future.decisive',${{ note: 'future' }},${{ writerVersion: 'future', classification: 'decisive' }})`
        await values()
        checks.push(
          'unknown future facts preserve compatibility and cursor while known selectors ignore opaque vocabulary',
        )
      } catch (error) {
        failure = error
      } finally {
        for (const server of servers.reverse())
          await server.close().catch((error) => {
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
    fullReducerCatalog: Object.entries(REDUCERS).every(
      ([name, entry]) =>
        'excluded' in entry.valueRead || supportedReducers.some((supported) => supported === name),
    ),
    supported: supportedReducers,
    comparisons,
    checks,
  }
}
