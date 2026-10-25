/** Native HTTP tick evidence; invoked explicitly by the maintained gate. */
import { strict as assert } from 'node:assert'
import { SQL } from 'bun'
import { RemoteBuildStore } from '../../../packages/core/src/store/remote/client'
import { emptyTickReport } from '../../../packages/core/src/processes/dispatcher'
import { openPostgresBuildStoreFromEnv } from '../../../packages/postgres-store/src/config'
import { createStoreServer } from '../../../packages/hosted-store-service/src/remote-store-server'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import { withDataServices } from './data-services'
import { withProtocolDatabase } from './protocol-harness'
import { startProtocolServer } from './protocol-server-harness'
import { tickFixtures } from './protocol-tick-fixtures'

export async function proveProtocolTicks(executable: string) {
  const checks: string[] = []
  let differential = 0
  await withDataServices(async (admin, environment) => {
    await withProtocolDatabase(admin, environment, async (env) => {
      let now = new Date('2026-01-01T00:00:00.000Z')
      const clock = () => now
      const ts = await openPostgresBuildStoreFromEnv(env, { clock })
      const sql = new SQL(env.AB_POSTGRES_URL!, { max: 1 })
      const server = await startProtocolServer({ executable, env, clock })
      const store = new RemoteBuildStore({ url: server.url, fetchFn: server.fetch })
      const oracle = createStoreServer({ store: ts, clock })
      const headers = {
        'content-type': 'application/json',
        'x-autobuild-version': AUTOBUILD_VERSION,
        'x-autobuild-protocol-version': REMOTE_STORE_PROTOCOL_VERSION,
      }
      const compare = async (path: string, body: unknown) => {
        const init = { method: 'POST', headers, body: JSON.stringify(body) }
        const native = await server.fetch(`${server.url}${path}`, init)
        const expected = await oracle.fetch(new Request(`http://oracle${path}`, init))
        assert.deepEqual(
          { status: native.status, body: await native.json() },
          { status: expected.status, body: await expected.json() },
          `${path} ${JSON.stringify(body)}`,
        )
        differential++
      }
      try {
        await store.ensureRepo('ticks')
        assert.equal(await store.beginRepoTick('ticks', 'owner'), null)
        await store.claimRepoLease('ticks', 'owner', 60_000)
        const beforeStart = await store.getRepo('ticks')
        const position = await store.getRepoChangePosition('ticks')
        assert.equal(await store.beginRepoTick('ticks', 'owner'), now.toISOString())
        assert.deepEqual(await store.getRepo('ticks'), await ts.getRepo('ticks'))
        assert.equal(await store.getRepoChangePosition('ticks'), position)
        const started = await store.getRepo('ticks')
        assert.equal(started!.lease?.expiresAt, beforeStart!.lease?.expiresAt)
        assert.equal(started!.heartbeatAt, beforeStart!.heartbeatAt)
        checks.push('begin requires a live matching lease and changes observation only')

        for (const item of tickFixtures().cases) {
          // Tick wire events strip supplied compatibility before core validation.
          if ('accepted' in (item.oracle as object) || item.id === 'compatibility') continue
          await compare('/repos/ticks/tick/finish', item)
          assert.deepEqual(await store.getRepo('ticks'), started)
          assert.deepEqual(await store.getRepoEvents('ticks'), [])
          assert.equal(await store.getRepoChangePosition('ticks'), position)
        }
        await compare('/repos/ticks/tick/finish', { holder: '', completion: {}, events: [] })
        await compare('/repos/ticks/tick/finish', {
          holder: 'owner',
          completion: {},
          events: 'invalid',
        })
        checks.push(
          'invalid completion and boundary batches match exact oracle refusals without mutation',
        )
        const failure = tickFixtures().cases.find((item) => item.id === 'failed')!
        const foreign = {
          ...failure,
          holder: 'foreign',
          events: failure.events.map((event) => {
            const fact = event as { payload: Record<string, unknown> }
            return { ...fact, payload: { ...fact.payload, run: 'foreign' } }
          }),
        }
        await compare('/repos/ticks/tick/finish', foreign)
        assert.deepEqual(await store.getRepo('ticks'), started)
        now = new Date(now.getTime() + 1000)
        const finished = await store.finishRepoTick(
          'ticks',
          'owner',
          failure.completion as never,
          failure.events as never,
        )
        assert.deepEqual(finished!.events, await ts.getRepoEvents('ticks'))
        assert.deepEqual(
          finished!.events.map((event) => event.seq),
          [1, 2],
        )
        assert(finished!.events.every((event) => !Object.hasOwn(event, 'compatibility')))
        assert.deepEqual(finished!.observation, (await ts.getRepo('ticks'))!.tick)
        assert.equal(finished!.observation.finished!.startedAt, started!.tick!.open!.startedAt)
        assert.equal(finished!.observation.finished!.completedAt, now.toISOString())
        const tickDone = await store.getRepo('ticks')
        assert.equal(tickDone!.lease?.expiresAt, started!.lease?.expiresAt)
        assert.equal(tickDone!.heartbeatAt, started!.heartbeatAt)
        await compare('/repos/ticks/tick/finish', failure)
        checks.push(
          'atomic two-event finish shares timestamp, preserves absent compatibility and closes exactly once',
        )

        const {
          queued,
          janitorDiagnostics,
          blockedDiagnostics,
          ticketDiagnostics,
          creationDiagnostics,
          dependencyDiagnostics,
          ...counters
        } = emptyTickReport()
        const quietPosition = await store.getRepoChangePosition('ticks')
        for (let i = 0; i < 3; i++) {
          await store.beginRepoTick('ticks', 'owner')
          const opened = (await store.getRepo('ticks'))!.tick!
          assert.equal(opened.finished!.outcome, i ? 'completed' : 'failed')
          now = new Date(now.getTime() + 1000)
          const quiet = await store.finishRepoTick(
            'ticks',
            'owner',
            { outcome: 'completed', counters: { ...counters, merged: i } },
            [],
          )
          assert.deepEqual(quiet!.events, [])
          assert.deepEqual((await store.getRepo('ticks'))!.tick, quiet!.observation)
          assert.equal(await store.getRepoChangePosition('ticks'), quietPosition)
          assert.equal((await store.getRepo('ticks'))!.lease?.expiresAt, started!.lease?.expiresAt)
        }
        checks.push(
          'quiet finishes preserve journal position and heartbeat while replacing bounded completion',
        )

        await store.beginRepoTick('ticks', 'owner')
        const preFailure = await store.getRepo('ticks')
        const preFailureEvents = await store.getRepoEvents('ticks')
        await sql.unsafe(
          `CREATE FUNCTION protocol_tick_fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='dispatcher.tick-failed' THEN RAISE EXCEPTION 'tick commit proof'; END IF; RETURN NEW; END $$`,
        )
        await sql.unsafe(
          `CREATE CONSTRAINT TRIGGER protocol_tick_commit AFTER INSERT ON repo_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION protocol_tick_fail_commit()`,
        )
        await compare('/repos/ticks/tick/finish', failure)
        assert.deepEqual(await store.getRepo('ticks'), preFailure)
        assert.deepEqual(await store.getRepoEvents('ticks'), preFailureEvents)
        assert.equal(await store.getRepoChangePosition('ticks'), quietPosition)
        await sql.unsafe('DROP TRIGGER protocol_tick_commit ON repo_events')
        await sql.unsafe('DROP FUNCTION protocol_tick_fail_commit()')
        const raced = await Promise.allSettled([
          store.finishRepoTick(
            'ticks',
            'owner',
            failure.completion as never,
            failure.events as never,
          ),
          ts.finishRepoTick('ticks', 'owner', failure.completion as never, failure.events as never),
        ])
        assert.equal(raced.filter((result) => result.status === 'fulfilled').length, 1)
        assert.equal((await store.getRepoEvents('ticks')).length, preFailureEvents.length + 2)
        checks.push(
          'deferred commit refusal rolls back both boundaries, tick, timestamp and position; mixed writers finish once',
        )

        // Hand off each half in both directions, including a completed fact with
        // its diagnostic fields and forged-request counter normalization.
        const completed = tickFixtures().cases.find((item) => item.id === 'forge-completed')!
        await ts.beginRepoTick('ticks', 'owner')
        const completedNative = await store.finishRepoTick(
          'ticks',
          'owner',
          completed.completion as never,
          completed.events as never,
        )
        assert.equal(completedNative!.observation.finished!.outcome, 'completed')
        assert.deepEqual(completedNative!.events, (await ts.getRepoEvents('ticks')).slice(-2))
        await store.beginRepoTick('ticks', 'owner')
        const completedTs = await ts.finishRepoTick(
          'ticks',
          'owner',
          completed.completion as never,
          completed.events as never,
        )
        assert.deepEqual(
          JSON.parse(JSON.stringify(completedTs!.events)),
          (await store.getRepoEvents('ticks')).slice(-2),
        )
        assert.deepEqual(completedTs!.observation, (await store.getRepo('ticks'))!.tick)
        checks.push(
          'TypeScript begin to Rust completed finish and Rust begin to TypeScript finish share tick and event representation',
        )

        assert(started!.lease)
        now = new Date(Date.parse(started!.lease.expiresAt))
        const expired = await store.getRepo('ticks')
        assert.equal(await store.beginRepoTick('ticks', 'owner'), null)
        assert.equal(
          await store.finishRepoTick(
            'ticks',
            'owner',
            failure.completion as never,
            failure.events as never,
          ),
          null,
        )
        assert.deepEqual(await store.getRepo('ticks'), expired)
        checks.push(
          'lease expiry equality fences begin/finish without renewal or observation mutation',
        )
      } finally {
        await server.close()
        await ts.close()
        await sql.close()
      }
    })
  })
  return { differential, checks }
}
