import { strict as assert } from 'node:assert'
import { RemoteBuildStore } from '../../../packages/core/src/store/remote/client'
import { openPostgresBuildStoreFromEnv } from '../../../packages/postgres-store/src/config'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import { withDataServices } from './data-services'
import { withProtocolDatabase } from './protocol-harness'
import { startProtocolServer } from './protocol-server-harness'
import { readWriteCorpus } from './protocol-fixtures-core'

/** Checkpoint proof only. The complete shared BuildStore suite is still required. */
export async function proveProtocolSessions(executable: string) {
  let differential = 0
  await withDataServices(async (admin, environment) => {
    await withProtocolDatabase(admin, environment, async (env) => {
      const now = new Date('2026-01-01T00:00:00.000Z')
      const clock = () => now
      const running: Awaited<ReturnType<typeof startProtocolServer>>[] = []
      let ts: Awaited<ReturnType<typeof openPostgresBuildStoreFromEnv>> | undefined
      let failure: unknown
      const headers = {
        'content-type': 'application/json',
        'x-autobuild-version': AUTOBUILD_VERSION,
        'x-autobuild-protocol-version': REMOTE_STORE_PROTOCOL_VERSION,
      }
      try {
        const first = await startProtocolServer({ executable, env, clock })
        running.push(first)
        const second = await startProtocolServer({ executable, env, clock })
        running.push(second)
        const a = new RemoteBuildStore({ url: first.url, fetchFn: first.fetch })
        const b = new RemoteBuildStore({ url: second.url, fetchFn: second.fetch })
        ts = await openPostgresBuildStoreFromEnv(env, { clock })
        const initial = await a.createSession({
          repo: 'sessions',
          operator: ' \ufeffoperator\t ',
          title: 'First',
        })
        assert.equal(initial.operator, 'operator')
        assert.deepEqual(await b.getSession(initial.id), initial)
        assert.equal(await a.getSession('unknown'), null)
        const absent = await first.fetch(`${first.url}/sessions/unknown`, { headers })
        assert.equal(absent.status, 200)
        assert.equal(await absent.json(), null)
        const created = await b.getSessionEvents(initial.id)
        assert.equal(created.length, 1)
        assert.equal(created[0]!.type, 'session.created')
        assert.deepEqual(created, await ts.getSessionEvents(initial.id))
        const next = await b.createSession({ repo: 'sessions', operator: 'operator' })
        assert.deepEqual(
          (await a.listSessions('sessions')).map((s) => s.id),
          [initial.id, next.id],
        )
        const message = {
          actor: { kind: 'human' as const, user: 'operator' },
          type: 'message.posted' as const,
          payload: { text: 'hello' },
        }
        const decimal = await first.fetch(`${first.url}/sessions/${next.id}/events/conditional`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ expectedSeq: 1, event: message }).replace(
            '"expectedSeq":1',
            '"expectedSeq":1.0',
          ),
        })
        assert.equal(decimal.status, 201)
        assert.equal(((await decimal.json()) as { seq: number }).seq, 2)
        const writes = await Promise.all([
          a.appendSessionEvent(initial.id, message),
          b.appendSessionEvent(initial.id, message),
          ts.appendSessionEvent(initial.id, message),
        ])
        assert.deepEqual(
          writes.map((e) => e.seq).sort((x, y) => x - y),
          [2, 3, 4],
        )
        const races = await Promise.all([
          a.appendSessionEventIfCurrent(initial.id, 4, message),
          b.appendSessionEventIfCurrent(initial.id, 4, message),
          ts.appendSessionEventIfCurrent(initial.id, 4, message),
        ])
        assert.equal(races.filter(Boolean).length, 1)
        assert.equal((await a.getSessionEvents(initial.id)).at(-1)!.seq, 5)
        await assert.rejects(
          a.appendSessionEventIfCurrent(initial.id, 0, { ...message, payload: { text: '' } }),
        )
        assert.equal((await a.getSessionEvents(initial.id)).at(-1)!.seq, 5)
        assert.equal(await a.appendSessionEventIfCurrent(initial.id, 0, message), null)
        const witness = await a.createSession({ repo: 'sessions', operator: 'witness' })
        for (const row of readWriteCorpus().cases.filter((row) => row.scope === 'session')) {
          const response = await first.fetch(`${first.url}/sessions/${witness.id}/events`, {
            method: 'POST',
            headers,
            body: JSON.stringify(row.input),
          })
          const body = (await response.json()) as Record<string, unknown>
          if (response.status === 201) for (const key of ['session', 'seq', 'ts']) delete body[key]
          assert.deepEqual({ status: response.status, body }, row.http, row.id)
          differential++
        }
        assert.ok(differential >= 340, 'session oracle coverage shrank')
        const tail = (await a.getSessionEvents(initial.id)).at(-1)!.seq
        const started = performance.now()
        const held = a.getSessionEvents(initial.id, tail, { waitSeconds: 2 })
        await Bun.sleep(100)
        const appended = await b.appendSessionEvent(initial.id, message)
        assert.deepEqual(await held, [appended])
        assert.ok(performance.now() - started < 2500)
        const timeout = performance.now()
        assert.deepEqual(await a.getSessionEvents(initial.id, appended.seq, { waitSeconds: 1 }), [])
        assert.ok(performance.now() - timeout >= 900, 'frozen clock shortened monotonic wait')
        const malformed = await first.fetch(`${first.url}/sessions/${initial.id}/events?wait=1.0`, {
          headers,
        })
        assert.deepEqual(
          { status: malformed.status, body: await malformed.json() },
          {
            status: 400,
            body: {
              kind: 'validation',
              error: 'query parameter "wait" must be a whole number of seconds, got "1.0"',
            },
          },
        )
        const immediate = await first.fetch(
          `${first.url}/sessions/${initial.id}/events?since=0x0&wait=9999999999999999999999999999999`,
          { headers },
        )
        assert.equal(immediate.status, 200)
        assert.ok(((await immediate.json()) as unknown[]).length > 0)
        const controller = new AbortController()
        const cancelled = a.getSessionEvents(initial.id, appended.seq, {
          waitSeconds: 30,
          signal: controller.signal,
        })
        await Bun.sleep(100)
        controller.abort()
        assert.deepEqual(await cancelled, [])
        // Close must not wait thirty seconds for the disconnected held read.
        const close = performance.now()
        await first.close()
        assert.ok(
          performance.now() - close < 2000,
          'cancelled request continued holding server drain',
        )
        assert.deepEqual(
          await b.getSessionEvents(initial.id),
          await ts.getSessionEvents(initial.id),
        )
      } catch (error) {
        failure = error
      } finally {
        const cleanup = await Promise.allSettled([
          ...running.map((server) => server.close()),
          ts?.close(),
        ])
        const errors = cleanup.filter(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        )
        if (errors.length)
          failure = new AggregateError(
            [...(failure === undefined ? [] : [failure]), ...errors.map((result) => result.reason)],
            'Session proof cleanup failed',
          )
      }
      if (failure !== undefined) throw failure
    })
  })
  return {
    kind: 'session-event-checkpoint',
    fullBuildStoreContract: false,
    differential,
    heldRead: 'cross-instance wake, monotonic timeout, clamp, cancellation and drain',
  }
}
