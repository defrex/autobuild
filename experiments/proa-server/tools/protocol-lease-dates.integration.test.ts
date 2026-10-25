/** Native lease Date formatting and node-writer SQL string-boundary evidence. */
import { strict as assert } from 'node:assert'
import { SQL } from 'bun'
import { withDataServices } from './data-services'
import { withProtocolDatabase } from './protocol-harness'
import { startProtocolServer } from './protocol-server-harness'
import { openPostgresBuildStoreFromEnv } from '../../../packages/postgres-store/src/config'
import { createStoreServer } from '../../../packages/hosted-store-service/src/remote-store-server'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
export async function proveProtocolLeaseDates(executable: string) {
  let comparisons = 0
  await withDataServices(async (admin, environment) =>
    withProtocolDatabase(admin, environment, async (env) => {
      const clock = () => new Date('2030-01-01T00:00:00.000Z'),
        store = await openPostgresBuildStoreFromEnv(env, { clock }),
        sql = new SQL(env.AB_POSTGRES_URL!, { max: 1 }),
        server = await startProtocolServer({ executable, env, clock }),
        oracle = createStoreServer({ store, clock })
      const headers = {
        'content-type': 'application/json',
        'x-autobuild-version': AUTOBUILD_VERSION,
        'x-autobuild-protocol-version': REMOTE_STORE_PROTOCOL_VERSION,
      }
      const compare = async (path: string, body: unknown) => {
        const init = { method: 'POST', headers, body: JSON.stringify(body) }
        const actual: Response = await server.fetch(server.url + path, init)
        const expected: Response = await oracle.fetch(new Request(`http://oracle${path}`, init))
        const a = { status: actual.status, body: await actual.json() },
          e = { status: expected.status, body: await expected.json() }
        assert.deepEqual(a, e, `${path} ${JSON.stringify(body)}`)
        comparisons++
        return a
      }
      try {
        const ttls = [
          Number.MAX_SAFE_INTEGER,
          8.4e15,
          8e15,
          Date.parse('+010000-01-01T00:00:00Z') - clock().getTime(),
          Date.parse('9999-12-31T23:59:59.999Z') - clock().getTime(),
          10000,
        ]
        for (const [index, ttlMs] of ttls.entries())
          for (const family of ['build', 'repo', 'node-writer']) {
            const id = `lease-date-${family}-${index}`
            if (family === 'repo') await store.ensureRepo(id)
            else await store.createBuild({ slug: id, repo: 'lease-date-repo' })
            const base =
              family === 'repo'
                ? `/repos/${id}/lease`
                : `/builds/${id}/${family === 'node-writer' ? 'node-writer' : 'lease'}`
            const actual = await compare(`${base}/claim`, { holder: 'same-holder', ttlMs })
            if (actual.status !== 200) {
              const rows =
                family === 'repo'
                  ? await sql`SELECT lease_holder AS holder FROM repo_streams WHERE repo=${id}`
                  : family === 'node-writer'
                    ? await sql`SELECT node_writer_holder AS holder FROM builds WHERE slug=${id}`
                    : await sql`SELECT lease_holder AS holder FROM builds WHERE slug=${id}`
              assert.equal(
                rows[0]!.holder,
                null,
                'failed date conversion/SQL cast must leave holder untouched',
              )
              comparisons++
            } else {
              const denied = await compare(`${base}/claim`, {
                holder: 'foreign',
                ttlMs: Number.MAX_SAFE_INTEGER,
              })
              assert.deepEqual(denied, { status: 200, body: { ok: false } })
            }
          }
        for (const family of ['build', 'repo', 'node-writer']) {
          const id = `lease-beat-${family}`
          if (family === 'repo') await store.ensureRepo(id)
          else await store.createBuild({ slug: id, repo: 'lease-date-repo' })
          const base =
            family === 'repo'
              ? `/repos/${id}/lease`
              : `/builds/${id}/${family === 'node-writer' ? 'node-writer' : 'lease'}`
          await compare(`${base}/claim`, { holder: 'same-holder', ttlMs: 10000 })
          if (family === 'repo')
            await sql`UPDATE repo_streams SET lease_ttl_ms=${Number.MAX_SAFE_INTEGER} WHERE repo=${id}`
          else if (family === 'node-writer')
            await sql`UPDATE builds SET node_writer_ttl_ms=${Number.MAX_SAFE_INTEGER} WHERE slug=${id}`
          else await sql`UPDATE builds SET lease_ttl_ms=${Number.MAX_SAFE_INTEGER} WHERE slug=${id}`
          await compare(`${base}/heartbeat`, { holder: 'same-holder' })
          assert.deepEqual(await compare(`${base}/heartbeat`, { holder: 'foreign' }), {
            status: 200,
            body: { ok: false },
          })
        }
        await store.createBuild({ slug: 'node-release-unicode', repo: 'lease-date-repo' })
        const path = '/builds/node-release-unicode/node-writer'
        assert.equal(
          await store.claimNodeWriter('node-release-unicode', String.fromCharCode(0xd800), 10000),
          true,
        )
        // Compare the shared-table native and source release from independently
        // reestablished rows; the returned ok alone cannot detect accidental no-ops.
        const init = {
          method: 'POST',
          headers,
          body: JSON.stringify({ holder: String.fromCharCode(0xd800) }),
        }
        const a = await server.fetch(`${server.url}${path}/release`, init)
        assert.equal(a.status, 200)
        assert.equal(
          (await sql`SELECT node_writer_holder FROM builds WHERE slug='node-release-unicode'`)[0]!
            .node_writer_holder,
          null,
        )
        comparisons += 2
        await store.claimNodeWriter('node-release-unicode', String.fromCharCode(0xd800), 10000)
        const b = await oracle.fetch(new Request(`http://oracle${path}/release`, init))
        assert.equal(b.status, 200)
        assert.equal(
          (await sql`SELECT node_writer_holder FROM builds WHERE slug='node-release-unicode'`)[0]!
            .node_writer_holder,
          null,
        )
        comparisons += 2
        await compare(`${path}/release`, { holder: '\u0000' })
      } finally {
        await server.close()
        await store.close()
        await sql.close()
      }
    }),
  )
  return {
    comparisons,
    checks: [
      'full JS Date TimeClip/expanded ISO source formatting and PostgreSQL TEXT cast errors, including held-holder fencing before conversion',
      'node-writer release follows source SQL TEXT equality/rejection while execution and repository leases retain original JavaScript equality',
    ],
  }
}
