/** Native HTTP evidence, explicitly invoked; not a replacement shared contract. */
import { strict as assert } from 'node:assert'
import { SQL } from 'bun'
import { RemoteBuildStore } from '../../../packages/core/src/store/remote/client'
import {
  buildCreatedWrite,
  sampleEventWrite,
  harvestStartedWrite,
} from '../../../packages/core/src/store/contract'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import { openPostgresBuildStoreFromEnv } from '../../../packages/postgres-store/src/config'
import { PostgresProjectRegistry } from '../../../packages/postgres-store/src/projects'
import { PostgresCredentialStore } from '../../../packages/postgres-store/src/credentials'
import { createStoreServer } from '../../../packages/hosted-store-service/src/remote-store-server'
import { withDataServices } from './data-services'
import { withProtocolDatabase } from './protocol-harness'
import { startProtocolServer } from './protocol-server-harness'
import { readWriteCorpus } from './protocol-fixtures-core'

export async function proveProtocolEvents(executable: string) {
  let differential = 0
  const checks: string[] = []
  await withDataServices(async (admin, environment) => {
    await withProtocolDatabase(admin, environment, async (env) => {
      let now = new Date('2026-01-01T00:00:00.000Z')
      const clock = () => now
      const running: Awaited<ReturnType<typeof startProtocolServer>>[] = []
      const ts = await openPostgresBuildStoreFromEnv(env, { clock })
      const sql = new SQL(env.AB_POSTGRES_URL!, { max: 1 })
      const start = async (project = false) => {
        const server = await startProtocolServer({
          executable,
          env: { ...env, ...(project ? { PROA_TEST_AUTH: 'project' } : {}) },
          clock,
        })
        running.push(server)
        return { server, store: new RemoteBuildStore({ url: server.url, fetchFn: server.fetch }) }
      }
      const headers = {
        'content-type': 'application/json',
        'x-autobuild-version': AUTOBUILD_VERSION,
        'x-autobuild-protocol-version': REMOTE_STORE_PROTOCOL_VERSION,
      }
      let failure: unknown
      try {
        const a = await start(),
          b = await start()
        const created = buildCreatedWrite()
        const record = await a.store.createBuild({ slug: 'atomic', repo: 'events', created })
        assert.deepEqual(record, await ts.getBuild('atomic'))
        const initial = await b.store.getEvents('atomic')
        assert.equal(initial.length, 1)
        assert.equal(initial[0]!.type, 'build.created')
        assert.equal(initial[0]!.seq, 1)
        assert.deepEqual(initial, await ts.getEvents('atomic'))
        assert.equal(record.updatedAt, initial[0]!.ts)
        const bad = { ...created, payload: {} } as never
        const invalidCreated = await a.server.fetch(`${a.server.url}/builds`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ slug: 'invalid-created', repo: 'events', created: bad }),
        })
        assert.equal(invalidCreated.status, 422)
        assert.equal(await a.store.getBuild('invalid-created'), null)
        assert.deepEqual(await ts.getBuild('invalid-created'), null)
        await assert.rejects(
          a.store.createBuild({
            slug: 'wrong-initial-type',
            repo: 'events',
            created: sampleEventWrite() as never,
          }),
          /initial event must be/,
        )
        assert.equal(await a.store.getBuild('wrong-initial-type'), null)
        // Existing identity is refused before core initial-event validation, after wire parsing.
        const duplicateCreated = await a.server.fetch(`${a.server.url}/builds`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ slug: 'atomic', repo: 'events', created: bad }),
        })
        assert.deepEqual(
          { status: duplicateCreated.status, body: await duplicateCreated.json() },
          { status: 409, body: { kind: 'conflict', error: 'build "atomic" already exists' } },
        )
        const atomicPosition = await a.store.getRepoChangePosition('events')
        const failedCreate = {
          slug: 'sql-failed-created',
          repo: 'events',
          created: {
            ...created,
            payload: { ...created.payload, ticket: { ...created.payload.ticket, title: '\u0000' } },
          },
        }
        const createInit = { method: 'POST', headers, body: JSON.stringify(failedCreate) }
        const creationOracle = createStoreServer({ store: ts, clock })
        const [failedNative, failedExpected] = await Promise.all([
          a.server.fetch(`${a.server.url}/builds`, createInit),
          creationOracle.fetch(new Request('http://oracle/builds', createInit)),
        ])
        assert.deepEqual(
          { status: failedNative.status, body: await failedNative.json() },
          { status: failedExpected.status, body: await failedExpected.json() },
        )
        assert.equal(failedNative.status, 500)
        assert.equal(await a.store.getBuild('sql-failed-created'), null)
        assert.equal(await a.store.getRepoChangePosition('events'), atomicPosition)
        await sql.unsafe(
          `CREATE FUNCTION protocol_fail_created_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.slug='commit-failed-created' THEN RAISE EXCEPTION 'proof commit failure'; END IF; RETURN NEW; END $$`,
        )
        await sql.unsafe(
          `CREATE CONSTRAINT TRIGGER protocol_created_commit AFTER INSERT ON builds DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION protocol_fail_created_commit()`,
        )
        const commitInit = {
          method: 'POST',
          headers,
          body: JSON.stringify({ slug: 'commit-failed-created', repo: 'events', created }),
        }
        const [commitNative, commitExpected] = await Promise.all([
          a.server.fetch(`${a.server.url}/builds`, commitInit),
          creationOracle.fetch(new Request('http://oracle/builds', commitInit)),
        ])
        assert.deepEqual(
          { status: commitNative.status, body: await commitNative.json() },
          { status: commitExpected.status, body: await commitExpected.json() },
        )
        assert.equal(commitNative.status, 500)
        assert.equal(await a.store.getBuild('commit-failed-created'), null)
        assert.equal(
          (
            await sql`SELECT count(*)::int AS count FROM events WHERE build='commit-failed-created'`
          )[0].count,
          0,
        )
        assert.equal(await a.store.getRepoChangePosition('events'), atomicPosition)
        checks.push(
          'atomic initial build.created, mutation-free invalid/wrong initial event and duplicate ordering',
        )
        now = new Date(now.getTime() + 1000)
        const message = sampleEventWrite('mixed writers')
        const appended = await Promise.all([
          a.store.append('atomic', message),
          b.store.append('atomic', message),
          ts.append('atomic', message),
        ])
        assert.deepEqual(
          appended.map((e) => e.seq).sort((x, y) => x - y),
          [2, 3, 4],
        )
        const conditional = await Promise.all([
          a.store.appendIfCurrent('atomic', 4, message),
          b.store.appendIfCurrent('atomic', 4, message),
          ts.appendIfCurrent('atomic', 4, message),
        ])
        assert.equal(conditional.filter(Boolean).length, 1)
        const before = await a.store.getBuild('atomic')
        assert.equal(await a.store.appendIfCurrent('atomic', 0, message), null)
        assert.deepEqual(await a.store.getBuild('atomic'), before)
        const invalidStale = await a.server.fetch(
          `${a.server.url}/builds/atomic/events/conditional`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({ expectedSeq: 0, event: { ...message, payload: {} } }),
          },
        )
        assert.equal(invalidStale.status, 422)
        assert.equal((await a.store.getEvents('atomic')).at(-1)!.seq, 5)
        const sqlOracle = createStoreServer({ store: ts, clock })
        const poisoned = { ...message, payload: { ...message.payload, summary: '\u0000' } }
        const poisonedInit = { method: 'POST', headers, body: JSON.stringify(poisoned) }
        const [poisonedNative, poisonedExpected] = await Promise.all([
          a.server.fetch(`${a.server.url}/builds/atomic/events`, poisonedInit),
          sqlOracle.fetch(new Request('http://oracle/builds/atomic/events', poisonedInit)),
        ])
        assert.deepEqual(
          { status: poisonedNative.status, body: await poisonedNative.json() },
          { status: poisonedExpected.status, body: await poisonedExpected.json() },
        )
        assert.equal(poisonedNative.status, 500)
        assert.equal((await a.store.getEvents('atomic')).at(-1)!.seq, 5)
        assert.deepEqual(await a.store.getBuild('atomic'), before)
        await sql.unsafe(
          `CREATE FUNCTION protocol_fail_append_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.payload->>'summary'='commit-fails' THEN RAISE EXCEPTION 'proof append commit failure'; END IF; RETURN NEW; END $$`,
        )
        await sql.unsafe(
          `CREATE CONSTRAINT TRIGGER protocol_append_commit AFTER INSERT ON events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION protocol_fail_append_commit()`,
        )
        const appendCommitInit = {
          method: 'POST',
          headers,
          body: JSON.stringify({
            ...message,
            payload: { ...message.payload, summary: 'commit-fails' },
          }),
        }
        const [appendFailed, appendExpected] = await Promise.all([
          a.server.fetch(`${a.server.url}/builds/atomic/events`, appendCommitInit),
          sqlOracle.fetch(new Request('http://oracle/builds/atomic/events', appendCommitInit)),
        ])
        assert.deepEqual(
          { status: appendFailed.status, body: await appendFailed.json() },
          { status: appendExpected.status, body: await appendExpected.json() },
        )
        assert.equal(appendFailed.status, 500)
        assert.equal((await a.store.getEvents('atomic')).at(-1)!.seq, 5)
        assert.deepEqual(await a.store.getBuild('atomic'), before)
        checks.push(
          'two native processes plus TypeScript append/CAS race, validation before stale comparison, no sequence gaps or timestamp mutation',
        )
        await a.store.ensureRepo('events')
        const repoWrite = harvestStartedWrite()
        const repos = await Promise.all([
          a.store.appendRepo('events', repoWrite),
          b.store.appendRepo('events', repoWrite),
          ts.appendRepo('events', repoWrite),
        ])
        assert.deepEqual(
          repos.map((e) => e.seq).sort((x, y) => x - y),
          [1, 2, 3],
        )
        assert.equal(await b.store.getRepoHighWater('events'), 3)
        assert.deepEqual(await a.store.getRepoEvents('events'), await ts.getRepoEvents('events'))
        await a.store.createBuild({ slug: 'corpus', repo: 'events' })
        await a.store.ensureRepo('corpus')
        for (const row of readWriteCorpus().cases.filter((row) => row.scope !== 'session')) {
          const path = row.scope === 'build' ? '/builds/corpus/events' : '/repos/corpus/events'
          const response = await a.server.fetch(`${a.server.url}${path}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(row.input),
          })
          const body = (await response.json()) as Record<string, unknown>
          if (response.status === 201)
            for (const key of ['build', 'repo', 'seq', 'ts']) delete body[key]
          assert.deepEqual({ status: response.status, body }, row.http, row.id)
          differential++
        }
        assert.ok(differential > 9000, 'build/repository differential coverage shrank')
        assert.deepEqual(
          await a.store.getRepoStateEvents('corpus'),
          await ts.getRepoStateEvents('corpus'),
        )
        assert.equal(await a.store.getRepoHighWater('corpus'), await ts.getRepoHighWater('corpus'))
        checks.push(
          'all generated build/repository writes compare exact native status/body, normalized payload and stamped compatibility against TS HTTP oracle; bounded repository state equals TS',
        )
        const tail = (await a.store.getEvents('atomic')).at(-1)!.seq
        const held = a.store.getEvents('atomic', tail, { waitSeconds: 2 })
        await Bun.sleep(100)
        const wake = await ts.append('atomic', message)
        assert.equal(wake.seq, tail + 1)
        assert.deepEqual(await held, [wake])
        const repoTail = await a.store.getRepoHighWater('events')
        const repoHeld = a.store.getRepoEvents('events', repoTail, { waitSeconds: 2 })
        await Bun.sleep(100)
        const repoWake = await b.store.appendRepo('events', repoWrite)
        assert.deepEqual(await repoHeld, [repoWake])
        checks.push('build and repository held reads observe independent TS/native appends')
        const registry = new PostgresProjectRegistry(sql)
        const repo = (await registry.add('https://github.com/proa/event-authority', 'proof')).repo
        const token = (await new PostgresCredentialStore(sql, registry).issue(repo, 'proof')).token
        const authenticated = await start(true)
        const client = new RemoteBuildStore({
          url: authenticated.server.url,
          token,
          fetchFn: authenticated.server.fetch,
        })
        const own = await client.createBuild({ slug: 'authority', repo })
        const via = await authenticated.server.fetch(
          `${authenticated.server.url}/builds/${own.slug}/events`,
          {
            method: 'POST',
            headers: { ...headers, authorization: `Bearer ${token}` },
            body: JSON.stringify({
              actor: { kind: 'human', user: 'who', via: {} },
              type: 'unknown-type',
              payload: {},
            }),
          },
        )
        assert.deepEqual(
          { status: via.status, body: await via.json() },
          {
            status: 403,
            body: {
              kind: 'auth',
              error: 'token carries no via; it may not write delegated events',
            },
          },
        )
        const native = await client.append(own.slug, message)
        assert.equal(native.seq, 1)
        const oracle = createStoreServer({ store: ts, clock })
        for (const request of [
          { method: 'GET', path: '/repos/missing/high-water' },
          { method: 'GET', path: '/repos/missing/state-events' },
          { method: 'POST', path: '/builds/missing/events', body: '{' },
          { method: 'POST', path: '/repos/missing/events', body: '{' },
        ]) {
          const init = {
            method: request.method,
            headers,
            ...(request.body ? { body: request.body } : {}),
          }
          const [rust, expected] = await Promise.all([
            a.server.fetch(`${a.server.url}${request.path}`, init),
            oracle.fetch(new Request(`http://oracle${request.path}`, init)),
          ])
          assert.deepEqual(
            { status: rust.status, body: await rust.json() },
            { status: expected.status, body: await expected.json() },
            request.path,
          )
        }
        checks.push(
          'authenticated human via authority precedes catalog validation; project append and missing-scope gate ordering match TS',
        )
        const durable = await a.store.getEvents('atomic')
        await a.server.close()
        const restarted = await start()
        assert.deepEqual(await restarted.store.getEvents('atomic'), durable)
        assert.deepEqual(
          await restarted.store.getRepoStateEvents('corpus'),
          await ts.getRepoStateEvents('corpus'),
        )
        checks.push(
          'restart continuity for full histories, compatibility envelopes and bounded repository selection',
        )
      } catch (error) {
        failure = error
      } finally {
        const cleanup = await Promise.allSettled([
          ...running.map((server) => server.close()),
          ts.close(),
          sql.close(),
        ])
        const errors = cleanup.filter(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        )
        if (errors.length)
          failure = new AggregateError(
            [...(failure === undefined ? [] : [failure]), ...errors.map((result) => result.reason)],
            'Event proof cleanup failed',
          )
      }
      if (failure !== undefined) throw failure
    })
  })
  return {
    kind: 'build-repository-event-checkpoint',
    fullBuildStoreContract: false,
    differential,
    checks,
  }
}
