import { strict as assert } from 'node:assert'
import { RemoteBuildStore } from '../../../packages/core/src/store/remote/client'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import { openPostgresBuildStoreFromEnv } from '../../../packages/postgres-store/src/config'
import { openPostgresTicketDatabase } from '../../../packages/postgres-store/src/tickets'
import { createStoreServer } from '../../../packages/hosted-store-service/src/remote-store-server'
import { withDataServices } from './data-services'
import { withProtocolDatabase } from './protocol-harness'
import { startProtocolServer } from './protocol-server-harness'

/** A real-HTTP checkpoint proof for the explicitly supported record/lease subset.
 * This exports no tests automatically and is NOT the unchanged shared contract.
 * Every operation on first/second/restarted crosses the unchanged RemoteBuildStore.
 * The TypeScript adapter is used only as an independent mixed-language writer/oracle.
 */
export async function proveProtocolStore(executable: string) {
  const checks: string[] = []
  await withDataServices(async (admin, environment) => {
    await withProtocolDatabase(admin, environment, async (env) => {
      let now = new Date('2026-07-15T12:00:00.000Z')
      const clock = () => now
      const running: Awaited<ReturnType<typeof startProtocolServer>>[] = []
      const start = async () => {
        const server = await startProtocolServer({ executable, env, clock })
        running.push(server)
        return { server, store: new RemoteBuildStore({ url: server.url, fetchFn: server.fetch }) }
      }
      const ts = await openPostgresBuildStoreFromEnv(env, { clock })
      let failure: unknown
      try {
        const first = await start(),
          second = await start()
        const repo = 'protocol-proof'
        const build = await first.store.createBuild({
          slug: 'proof',
          repo,
          branch: 'ab/proof',
          repoOrigin: 'https://github.com/proa/protocol-proof',
        })
        assert.equal(build.slug, 'proof')
        assert.equal(build.createdAt, now.toISOString())
        assert.equal(build.repoOrigin, 'https://github.com/proa/protocol-proof')
        assert.deepEqual(await second.store.getBuild('proof'), build)
        assert.equal(await first.store.getBuild('unknown'), null)
        assert.equal(await first.store.getRepo('unknown'), null)
        const ensured = await first.store.ensureRepo(repo)
        assert.deepEqual(await second.store.getRepo(repo), ensured)
        assert.deepEqual(await first.store.ensureRepo(repo), ensured)
        assert.equal(
          await first.store.getRepoChangePosition(repo),
          await ts.getRepoChangePosition(repo),
        )
        assert.equal(await first.store.getRepoChangePosition('unknown'), '0')
        await first.store.createBuild({ slug: 'z-same-time', repo })
        await first.store.createBuild({ slug: 'a-same-time', repo })
        await first.store.createBuild({ slug: 'foreign', repo: 'another-repo' })
        assert.deepEqual(await first.store.listBuilds(), await ts.listBuilds())
        assert.deepEqual(
          await second.store.listBuildsForRepo(repo),
          await ts.listBuildsForRepo(repo),
        )
        assert.equal(
          (await first.store.listBuildsForRepo(repo)).some((item) => item.slug === 'foreign'),
          false,
        )
        checks.push(
          'empty build creation, optional fields, reads, repository ensure, stable same-time lists and change positions',
        )
        const emptyOptional = await first.store.createBuild({
          slug: 'empty-origin',
          repo,
          repoOrigin: '',
        })
        assert.equal(Object.hasOwn(emptyOptional, 'repoOrigin'), false)
        assert.equal(Object.hasOwn(emptyOptional, 'branch'), false)
        assert.equal(Object.hasOwn(emptyOptional, 'ticket'), false)
        assert.deepEqual(emptyOptional, await ts.getBuild('empty-origin'))
        const encoded = await first.store.createBuild({
          slug: 'encoded/slash',
          repo: 'repo/encoded',
        })
        assert.deepEqual(await second.store.getBuild('encoded/slash'), encoded)
        assert.deepEqual(await second.store.listBuildsForRepo('repo/encoded'), [encoded])

        // Ticket-source setup is a fixture only. Reads/create still use the real
        // remote client; no TypeScript store operation substitutes for Rust.
        const tickets = await openPostgresTicketDatabase(env.AB_POSTGRES_URL!)
        try {
          const ticket = await tickets
            .source({
              repo,
              teamKey: 'PROOF',
              lifecycle: { triage: 'triage', ready: 'ready', doing: 'doing', done: 'done' },
            })
            .create({ title: 'Projection fixture', body: 'Current readable identity fixture' })
          const rows =
            await tickets.sql`SELECT id FROM ab_tickets WHERE repo=${repo} AND readable_id=${ticket.ref.id}`
          const historical = String(rows[0].id)
          const projected = await first.store.createBuild({
            slug: 'projected-ticket',
            repo,
            ticket: { source: 'hosted', id: historical, title: 'Pinned title' },
          })
          assert.equal(projected.ticket?.id, ticket.ref.id)
          assert.equal(projected.ticket?.title, 'Pinned title')
          assert.deepEqual(
            await first.store.getBuild('projected-ticket'),
            await ts.getBuild('projected-ticket'),
          )
          const lower = await first.store.createBuild({
            slug: 'projected-lowercase',
            repo,
            ticket: { source: 'hosted', id: ticket.ref.id.toLowerCase() },
          })
          assert.equal(lower.ticket?.id, ticket.ref.id)
          const foreign = await first.store.createBuild({
            slug: 'foreign-ticket',
            repo: 'another-repo',
            ticket: { source: 'hosted', id: historical },
          })
          assert.equal(foreign.ticket?.id, historical)
          assert.deepEqual(await first.store.listBuilds(), await ts.listBuilds())
        } finally {
          await tickets.close()
        }
        checks.push(
          'empty optional omission, percent-decoded slash segments, hosted UUID/readable-id projection and repository isolation',
        )

        const cases = [
          {
            name: 'build lease',
            claim: (holder: string, ttl: number) => first.store.claimLease('proof', holder, ttl),
            beat: (holder: string) => first.store.heartbeat('proof', holder),
            release: (holder: string) => first.store.releaseLease('proof', holder),
          },
          {
            name: 'repository lease',
            claim: (holder: string, ttl: number) => first.store.claimRepoLease(repo, holder, ttl),
            beat: (holder: string) => first.store.heartbeatRepo(repo, holder),
            release: (holder: string) => first.store.releaseRepoLease(repo, holder),
          },
          {
            name: 'node writer',
            claim: (holder: string, ttl: number) =>
              first.store.claimNodeWriter('proof', holder, ttl),
            beat: (holder: string) => first.store.renewNodeWriter('proof', holder),
            release: (holder: string) => first.store.releaseNodeWriter('proof', holder),
          },
        ]
        for (const lease of cases) {
          assert.equal(await lease.claim('zero', 0), true, lease.name)
          assert.equal(await lease.beat('zero'), false, lease.name)
          assert.equal(await lease.claim('owner', 100), true, lease.name)
          const before = [await first.store.getBuild('proof'), await first.store.getRepo(repo)]
          now = new Date(now.getTime() + 1)
          assert.equal(await lease.claim('stranger', 100), false, lease.name)
          assert.equal(await lease.beat('stranger'), false, lease.name)
          await lease.release('stranger')
          assert.deepEqual(
            [await first.store.getBuild('proof'), await first.store.getRepo(repo)],
            before,
            `${lease.name} wrong holder mutated metadata`,
          )
          assert.equal(await lease.beat('owner'), true, lease.name)
          now = new Date(now.getTime() + 100)
          assert.equal(await lease.beat('owner'), false, `${lease.name} equality must expire`)
          assert.equal(await lease.claim('replacement', 200), true, lease.name)
          now = new Date(now.getTime() + 50)
          assert.equal(
            await lease.claim('replacement', 300),
            true,
            `${lease.name} same-holder renewal`,
          )
          now = new Date(now.getTime() + 201)
          assert.equal(
            await lease.claim('stranger', 100),
            false,
            `${lease.name} renewal was not preserved`,
          )
          await lease.release('replacement')
          assert.equal(await lease.claim('stranger', 100), true, lease.name)
          await lease.release('stranger')
          checks.push(
            `${lease.name}: zero TTL, expiry equality, renewal, wrong-holder immutability and release`,
          )
        }
        await assert.rejects(first.store.claimLease('missing', 'holder', 100), /unknown build/)
        await assert.rejects(first.store.claimRepoLease('missing', 'holder', 100), /unknown repo/)
        await assert.rejects(first.store.claimNodeWriter('missing', 'holder', 100), /unknown build/)
        assert.equal(await first.store.claimLease('proof', 'execution', 1000), true)
        assert.equal(await second.store.claimNodeWriter('proof', 'writer', 1000), true)
        await first.store.releaseLease('proof', 'execution')
        await second.store.releaseNodeWriter('proof', 'writer')
        checks.push('missing-scope refusal and independent execution/node-writer authority')

        const created = await Promise.allSettled([
          first.store.createBuild({ slug: 'concurrent', repo }),
          second.store.createBuild({ slug: 'concurrent', repo }),
          ts.createBuild({ slug: 'concurrent', repo }),
        ])
        assert.equal(created.filter((result) => result.status === 'fulfilled').length, 1)
        assert.equal(
          (await first.store.listBuildsForRepo(repo)).filter((item) => item.slug === 'concurrent')
            .length,
          1,
        )
        const claims = await Promise.all([
          first.store.claimLease('concurrent', 'rust-one', 1000),
          second.store.claimLease('concurrent', 'rust-two', 1000),
          ts.claimLease('concurrent', 'typescript', 1000),
        ])
        assert.equal(claims.filter(Boolean).length, 1)
        const owner = ['rust-one', 'rust-two', 'typescript'][claims.indexOf(true)]!
        assert.equal((await ts.getBuild('concurrent'))?.lease?.holder, owner)
        await ts.releaseLease('concurrent', owner)
        assert.equal(await second.store.claimLease('concurrent', 'after-release', 1000), true)
        assert.equal(await ts.heartbeat('concurrent', 'after-release'), true)
        assert.deepEqual(await first.store.getBuild('concurrent'), await ts.getBuild('concurrent'))
        checks.push(
          'two independent Rust processes plus TypeScript: create race, exclusive lease race and cross-language heartbeat',
        )

        const oracle = createStoreServer({ store: ts })
        const identity = {
          'x-autobuild-version': AUTOBUILD_VERSION,
          'x-autobuild-protocol-version': REMOTE_STORE_PROTOCOL_VERSION,
        }
        const requests: { method: string; path: string; body?: string; identity?: boolean }[] = [
          { method: 'GET', path: '/health', identity: false },
          { method: 'POST', path: '/builds', body: '{', identity: false },
          { method: 'POST', path: '/builds', body: '{' },
          { method: 'POST', path: '/builds', body: '{}' },
          {
            method: 'POST',
            path: '/builds',
            body: JSON.stringify({ slug: 'invalid-branch', repo, branch: '' }),
          },
          { method: 'POST', path: '/builds/proof/lease/claim', body: '{"holder":"x","ttlMs":-1}' },
          { method: 'POST', path: '/builds/proof/lease/claim', body: '{"holder":"x"}' },
          { method: 'DELETE', path: '/builds/proof' },
          { method: 'DELETE', path: '/builds/missing' },
          { method: 'POST', path: '/builds/missing/lease/claim', body: '{' },
          { method: 'GET', path: '/builds/missing/events?wait=bad' },
          { method: 'DELETE', path: '/builds/proof/lease/claim' },
          { method: 'PUT', path: `/repos/${repo}/lease/claim` },
          { method: 'PUT', path: '/repos/missing/lease/claim' },
          { method: 'DELETE', path: '/repos/missing/sessions' },
          { method: 'DELETE', path: '/sessions/missing/events' },

          { method: 'GET', path: '/unknown-machine-path' },
          {
            method: 'POST',
            path: '/repos/missing/lease/claim',
            body: '{"holder":"x","ttlMs":100}',
          },
        ]
        for (const item of requests) {
          const init = {
            method: item.method,
            headers: item.identity === false ? {} : identity,
            ...(item.body === undefined ? {} : { body: item.body }),
          }
          const actual = await first.server.fetch(`${first.server.url}${item.path}`, init)
          const expected = await oracle.fetch(new Request(`http://127.0.0.1${item.path}`, init))
          assert.equal(actual.status, expected.status, `${item.method} ${item.path}`)
          assert.deepEqual(
            await actual.json(),
            await expected.json(),
            `${item.method} ${item.path}`,
          )
          assert.equal(actual.headers.get('content-type'), expected.headers.get('content-type'))
        }
        checks.push(
          `${requests.length} exact TypeScript HTTP status/body/header comparisons: identity precedence, invalid JSON/schema, wrong methods and missing scopes`,
        )

        const durable = await first.store.getBuild('concurrent')
        await first.server.close()
        await second.server.close()
        const restarted = await start()
        assert.deepEqual(await restarted.store.getBuild('concurrent'), durable)
        assert.deepEqual(
          await restarted.store.listBuildsForRepo(repo),
          await ts.listBuildsForRepo(repo),
        )
        assert.equal(await restarted.store.claimLease('concurrent', 'intruder', 1000), false)
        now = new Date(now.getTime() + 1000)
        assert.equal(await restarted.store.claimLease('concurrent', 'after-restart', 1000), true)
        checks.push('restart continuity for records, listing, held lease and exact expiry takeover')
      } catch (error) {
        failure = error
      } finally {
        const cleanup = await Promise.allSettled([
          ...running.map((server) => server.close()),
          ts.close(),
        ])
        const failures = cleanup.filter((result) => result.status === 'rejected')
        if (failures.length)
          failure = new AggregateError(
            [
              ...(failure === undefined ? [] : [failure]),
              ...failures.map((result) => (result as PromiseRejectedResult).reason),
            ],
            'Protocol proof cleanup failed',
          )
      }
      if (failure !== undefined) throw failure
    })
  })
  return { kind: 'record-lease-checkpoint', fullBuildStoreContract: false, checks }
}
