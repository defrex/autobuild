/** Native stream lifecycle evidence; never implicit database unit tests. */
import { strict as assert } from 'node:assert'
import { SQL } from 'bun'
import { RemoteBuildStore } from '../../../packages/core/src/store/remote/client'
import { openPostgresBuildStoreFromEnv } from '../../../packages/postgres-store/src/config'
import { createStoreServer } from '../../../packages/hosted-store-service/src/remote-store-server'
import { assembleUIMessageDocument } from '../../../packages/core/src/store/streams/assemble'
import {
  streamArtifactInput,
  type StreamScope,
} from '../../../packages/core/src/store/streams/types'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import { PostgresCredentialStore } from '../../../packages/postgres-store/src/credentials'
import { PostgresProjectRegistry } from '../../../packages/postgres-store/src/projects'
import { createMachineAuth } from '../../../packages/hosted-store-service/src/machine-auth'
import { withDataServices } from './data-services'
import { withProtocolDatabase } from './protocol-harness'
import { startProtocolServer } from './protocol-server-harness'

export async function proveProtocolStreams(executable: string) {
  const checks: string[] = []
  let differential = 0
  await withDataServices(async (admin, environment) =>
    withProtocolDatabase(admin, environment, async (env) => {
      let now = new Date('2030-01-01T00:00:00.000Z')
      const clock = () => now
      const ts = await openPostgresBuildStoreFromEnv(env, { clock })
      const inspect = new SQL(env.AB_POSTGRES_URL!, { max: 1 })
      const running: Awaited<ReturnType<typeof startProtocolServer>>[] = []
      const start = async (auth = false, overrides: Record<string, string | undefined> = {}) => {
        const server = await startProtocolServer({
          executable,
          env: { ...env, ...overrides, ...(auth ? { PROA_TEST_AUTH: 'project' } : {}) },
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
        await a.store.createBuild({ slug: 'stream-build', repo: 'stream-repo' })
        await a.store.ensureRepo('stream-repo')
        const session = await a.store.createSession({ repo: 'stream-repo', operator: 'operator' })
        const scopes: StreamScope[] = [
          { kind: 'build', build: 'stream-build' },
          { kind: 'repo', repo: 'stream-repo' },
          { kind: 'session', session: session.id },
        ]
        const oracle = createStoreServer({ store: ts, clock })
        const compare = async (path: string, method: string, body?: unknown) => {
          const init = {
            method,
            headers,
            ...(body === undefined
              ? {}
              : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
          }
          const [native, expected] = await Promise.all([
            a.server.fetch(`${a.server.url}${path}`, init),
            oracle.fetch(new Request(`http://oracle${path}`, init)),
          ])
          const actual = { status: native.status, body: await native.json() },
            wanted = { status: expected.status, body: await expected.json() }
          assert.deepEqual(actual, wanted, `${method} ${path}`)
          differential++
          return actual
        }
        for (const [index, scope] of scopes.entries()) {
          const prefix =
            scope.kind === 'build'
              ? '/builds/stream-build'
              : scope.kind === 'repo'
                ? '/repos/stream-repo'
                : `/sessions/${session.id}`
          const ownerBefore =
            scope.kind === 'build'
              ? await ts.getBuild(scope.build)
              : scope.kind === 'repo'
                ? await ts.getRepo(scope.repo)
                : await ts.getSession(scope.session)
          const stream = await a.store.createStream(scope, `proof-${index}`)
          assert.deepEqual(await b.store.getStream(stream.id), await ts.getStream(stream.id))
          assert.equal((await ts.listStreams(scope)).at(-1)!.id, stream.id)
          assert.deepEqual(
            scope.kind === 'build'
              ? await ts.getBuild(scope.build)
              : scope.kind === 'repo'
                ? await ts.getRepo(scope.repo)
                : await ts.getSession(scope.session),
            ownerBefore,
          )
          const initial = [
            { type: 'start', messageId: `msg-${index}` },
            { type: 'text-start', id: 't' },
            { type: 'text-delta', id: 't', delta: 'héllo' },
          ]
          const first = await a.store.appendStreamParts(stream.id, initial)
          assert.equal(first.seq, 1)
          assert.deepEqual(await ts.readStream(stream.id), await b.store.readStream(stream.id))
          await ts.appendStreamParts(stream.id, [
            { type: 'text-delta', id: 't', delta: ' world' },
            { type: 'text-end', id: 't' },
            { type: 'finish' },
          ])
          const races = await Promise.all([
            a.store.appendStreamParts(stream.id, [{ type: 'unknown-race', n: 1 }]),
            b.store.appendStreamParts(stream.id, [{ type: 'unknown-race', n: 2 }]),
            ts.appendStreamParts(stream.id, [{ type: 'unknown-race', n: 3 }]),
          ])
          assert.deepEqual(
            races.map((c) => c.seq).sort((a, b) => a - b),
            [3, 4, 5],
          )
          const read = await a.store.readStream(stream.id)
          assert.deepEqual(read, await ts.readStream(stream.id))
          assert.deepEqual(
            read.chunks.map((c) => c.seq),
            [1, 2, 3, 4, 5],
          )
          assert.deepEqual(
            (await a.store.readStream(stream.id, { since: 2 })).chunks.map((c) => c.seq),
            [3, 4, 5],
          )
          const assembled = await assembleUIMessageDocument(read.chunks.flatMap((c) => c.parts))
          const expected = streamArtifactInput(
            stream.id,
            scope,
            stream.label,
            'completed',
            assembled.document,
            read.chunks.length,
            assembled.droppedPartCount,
          )
          now = new Date(now.getTime() + 1)
          const closed = await a.store.closeStream(stream.id, 'completed')
          assert.equal(closed.status, 'closed')
          assert.equal(closed.outcome, 'completed')
          assert.deepEqual(closed, await ts.getStream(stream.id))
          assert.deepEqual(await b.store.closeStream(stream.id, 'aborted'), closed)
          const artifact =
            scope.kind === 'build'
              ? await ts.getArtifact(scope.build, expected.kind)
              : scope.kind === 'repo'
                ? await ts.getRepoArtifact(scope.repo, expected.kind)
                : await ts.getSessionArtifact(scope.session, expected.kind)
          assert.ok(artifact)
          assert.equal(new TextDecoder().decode(artifact.content), expected.content)
          assert.deepEqual(artifact.meta.metadata, expected.metadata)
          assert.equal(artifact.meta.createdAt, closed.closedAt)
          assert.deepEqual(await a.store.readStream(stream.id), await ts.readStream(stream.id))
          await compare(`/streams/${stream.id}/chunks`, 'POST', { parts: [{ type: 'anything' }] })
          for (const parts of [[], [null], [{}], [{ type: '' }], ['text']])
            await compare(`${prefix}/streams/${stream.id}/chunks`, 'POST', { parts })
          await compare(`${prefix}/streams/${stream.id}/chunks?since=1.2`, 'GET')
          await compare(`${prefix}/streams/${stream.id}/chunks?wait=1.0`, 'GET')
          await compare(`${prefix}/streams/${stream.id}/close`, 'POST', { outcome: 'bad' })
          await compare(`${prefix}/streams/${stream.id}/unknown`, 'POST', '{')
          await compare(`${prefix}/streams/${stream.id}/x/y`, 'GET')
          const foreign =
            prefix === '/repos/stream-repo' ? '/builds/stream-build' : '/repos/stream-repo'
          await compare(`${foreign}/streams/${stream.id}/chunks`, 'POST', '{')
          await compare('/streams/missing/chunks', 'POST', '{')
        }
        checks.push(
          'all three scopes: UUID identities, persisted order, mixed native/TypeScript chunk sequencing, exact SDK documents/artifact metadata, idempotent close and typed errors',
        )
        await compare('/repos/missing/streams', 'POST', '{')
        await compare('/repos/missing/streams', 'GET')
        await compare('/sessions/missing/streams', 'GET')
        await compare('/sessions/missing/streams', 'POST', { label: 'missing' })
        const scope = scopes[0]!
        const utf16 = await a.store.createStream(scope, 'lossless-tool-json')
        const toolParts = [
          { type: 'start', messageId: 'utf16' },
          { type: 'tool-input-start', toolCallId: 'tc', toolName: 'echo' },
          {
            type: 'tool-input-delta',
            toolCallId: 'tc',
            inputTextDelta: '{"q":"\\ud800","\\udc00":"value"}',
          },
          { type: 'finish' },
        ]
        await a.store.appendStreamParts(utf16.id, toolParts)
        const utf16Expected = await assembleUIMessageDocument(toolParts)
        const utf16Input = streamArtifactInput(
          utf16.id,
          scope,
          utf16.label,
          'completed',
          utf16Expected.document,
          1,
          utf16Expected.droppedPartCount,
        )
        const utf16Closed = await a.store.closeStream(utf16.id, 'completed')
        const utf16Artifact = await ts.getArtifact('stream-build', utf16Closed.artifact!.kind)
        assert.ok(utf16Artifact)
        assert.equal(new TextDecoder().decode(utf16Artifact.content), utf16Input.content)
        checks.push(
          'partial tool JSON with escaped lone UTF16 units in keys and strings preserves exact SDK artifact bytes through PostgreSQL and blob finalization',
        )
        const waiting = await a.store.createStream(scope, 'held')
        const pending = b.store.readStream(waiting.id, { waitSeconds: 30 })
        await Bun.sleep(100)
        await ts.appendStreamParts(waiting.id, [
          { type: 'data-test', data: { nested: { '$serde_json::private::Number': '1e400' } } },
        ])
        assert.equal((await pending).chunks.length, 1)
        const startTime = Date.now()
        assert.deepEqual(
          (await a.store.readStream(waiting.id, { since: 999, waitSeconds: 1 })).chunks,
          [],
        )
        assert.ok(Date.now() - startTime >= 950)
        const wakeClose = b.store.readStream(waiting.id, { since: 999, waitSeconds: 30 })
        await Bun.sleep(100)
        await a.store.closeStream(waiting.id, 'aborted')
        assert.equal((await wakeClose).status, 'closed')
        const immediate = Date.now()
        await b.store.readStream(waiting.id, { since: 999, waitSeconds: 30 })
        assert.ok(Date.now() - immediate < 1000)
        const cancel = await a.store.createStream(scope, 'cancel')
        const controller = new AbortController()
        const held = a.server.fetch(`${a.server.url}/streams/${cancel.id}/chunks?wait=999999`, {
          headers,
          signal: controller.signal,
        })
        await Bun.sleep(100)
        controller.abort()
        await assert.rejects(held)
        assert.equal((await b.store.getStream(cancel.id))!.status, 'open')
        checks.push(
          'held reads wake after foreign-process append/close, honor monotonic timeout, immediate closed reply, clamp and cancellation without holding pool connections',
        )
        // Closed chunk pruning retains the newest closed stream and every open one.
        const old = await a.store.createStream(scope, 'old')
        await a.store.appendStreamParts(old.id, [{ type: 'text-start', id: 'x' }])
        await a.store.closeStream(old.id, 'completed')
        now = new Date(now.getTime() + 1)
        const newer = await a.store.createStream(scope, 'newer')
        await a.store.appendStreamParts(newer.id, [{ type: 'text-start', id: 'y' }])
        await a.store.closeStream(newer.id, 'completed')
        now = new Date(now.getTime() + 1)
        const open = await a.store.createStream(scope, 'open')
        await a.store.appendStreamParts(open.id, [{ type: 'text-start', id: 'z' }])
        await b.store.createStream(scope, 'prune')
        assert.equal((await ts.readStream(old.id)).chunks.length, 0)
        assert.equal((await ts.readStream(newer.id)).chunks.length, 1)
        assert.equal((await ts.readStream(open.id)).chunks.length, 1)
        assert.equal((await ts.getStream(old.id))!.status, 'closed')
        checks.push(
          'create-time chunk retention keeps newest closed and all open streams; records and finalized artifacts remain',
        )
        const limit = await a.store.createStream(scope, 'batch-limit')
        const size = 1024 * 1024
        const overhead = Buffer.byteLength(JSON.stringify([{ type: 'unknown-size', text: '' }]))
        await a.store.appendStreamParts(limit.id, [
          { type: 'unknown-size', text: 'x'.repeat(size - overhead) },
        ])
        await compare(`/streams/${limit.id}/chunks`, 'POST', {
          parts: [{ type: 'unknown-size', text: 'x'.repeat(size - overhead + 1) }],
        })
        await compare(`/streams/${limit.id}/chunks`, 'POST', {
          parts: [{ type: 'unknown-size', text: 'é'.repeat(size / 2) }],
        })
        checks.push(
          'serialized UTF8 batch ceiling accepts exact1MiB and refuses larger batches without consuming sequence',
        )
        const rollback = await a.store.createStream(scope, 'rollback')
        await a.store.appendStreamParts(rollback.id, [{ type: 'text-start', id: 'r' }])
        const original = await ts.getBuild('stream-build')
        await inspect.unsafe(
          `CREATE FUNCTION protocol_stream_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.label='rollback' AND NEW.status='closed' THEN RAISE EXCEPTION 'proof stream commit failure'; END IF; RETURN NEW; END $$`,
        )
        await inspect.unsafe(
          `CREATE CONSTRAINT TRIGGER protocol_stream_commit AFTER UPDATE ON streams DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION protocol_stream_commit_failure()`,
        )
        await compare(`/streams/${rollback.id}/close`, 'POST', { outcome: 'completed' })
        assert.equal((await ts.getStream(rollback.id))!.status, 'open')
        assert.deepEqual(await ts.listArtifacts('stream-build', `stream:${rollback.id}`), [])
        assert.deepEqual(await ts.getBuild('stream-build'), original)
        await inspect.unsafe('DROP TRIGGER protocol_stream_commit ON streams')
        const repaired = await a.store.closeStream(rollback.id, 'completed')
        assert.equal(repaired.artifact!.revision, 0)
        // Hold a real TypeScript append inside its SQL trigger. Close observes
        // the old snapshot and uploads, then waits on the writer's stream lock.
        // Committing that acknowledged append must force close to reassemble.
        const late = await a.store.createStream(scope, 'late-append')
        await a.store.appendStreamParts(late.id, [
          { type: 'start', messageId: 'late' },
          { type: 'text-start', id: 'late' },
          { type: 'text-delta', id: 'late', delta: 'before' },
        ])
        await inspect.unsafe(
          `CREATE FUNCTION protocol_hold_stream_append() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.stream='${late.id}' THEN PERFORM pg_advisory_xact_lock(181326761); END IF; RETURN NEW; END $$`,
        )
        await inspect.unsafe(
          `CREATE TRIGGER protocol_hold_stream_append BEFORE INSERT ON stream_chunks FOR EACH ROW EXECUTE FUNCTION protocol_hold_stream_append()`,
        )
        const monitor = new SQL(env.AB_POSTGRES_URL!, { max: 1 })
        let release = () => {}
        let ready = () => {}
        const unlocked = new Promise<void>((resolve) => {
          release = resolve
        })
        const locked = new Promise<void>((resolve) => {
          ready = resolve
        })
        const heldLock = inspect.begin(async (tx) => {
          await tx`SELECT pg_advisory_xact_lock(181326761)`
          ready()
          await unlocked
        })
        await locked
        let closing: ReturnType<typeof a.store.closeStream> | undefined
        const appending = ts.appendStreamParts(late.id, [
          { type: 'text-delta', id: 'late', delta: ' after' },
          { type: 'text-end', id: 'late' },
          { type: 'finish' },
        ])
        void appending.catch(() => {})
        const waitFor = async (pattern: string) => {
          const deadline = Date.now() + 5000
          while (Date.now() < deadline) {
            const rows =
              await monitor`SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE ${pattern}`
            if (Number(rows[0]!.n) > 0) return
            await Bun.sleep(20)
          }
          throw new Error('Stream race did not reach expected PostgreSQL lock')
        }
        try {
          await waitFor('%INSERT INTO stream_chunks%')
          closing = a.store.closeStream(late.id, 'completed')
          void closing.catch(() => {})
          await waitFor('%SELECT * FROM streams%FOR UPDATE%')
        } finally {
          release()
          await heldLock
          await monitor.close()
        }
        assert.equal((await appending).seq, 2)
        const lateClosed = await closing!
        const lateArtifact = await ts.getArtifact('stream-build', lateClosed.artifact!.kind)
        assert.ok(lateArtifact)
        assert.equal(lateArtifact.meta.metadata.chunkCount, 2)
        assert.ok(new TextDecoder().decode(lateArtifact.content).includes('before after'))
        await inspect.unsafe('DROP TRIGGER protocol_hold_stream_append ON stream_chunks')
        checks.push(
          'close prepare upload racing an acknowledged TypeScript append re-reads locked chunks and publishes the full reassembled document',
        )
        const providerStream = await a.store.createStream(scope, 'provider-refusal')
        await a.store.appendStreamParts(providerStream.id, [{ type: 'text-start', id: 'p' }])
        const stableOwner = await ts.getBuild('stream-build')
        const badProvider = await start(false, { AB_S3_BUCKET: 'proa-missing-stream-bucket' })
        await assert.rejects(badProvider.store.closeStream(providerStream.id, 'completed'))
        assert.equal((await ts.getStream(providerStream.id))!.status, 'open')
        assert.deepEqual(await ts.listArtifacts('stream-build', `stream:${providerStream.id}`), [])
        assert.deepEqual(await ts.getBuild('stream-build'), stableOwner)
        assert.equal(
          (await a.store.closeStream(providerStream.id, 'completed')).artifact!.revision,
          0,
        )
        const failedAppend = await a.store.createStream(scope, 'append-rollback')
        await inspect.unsafe(
          `CREATE FUNCTION protocol_fail_chunk_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.stream='${failedAppend.id}' THEN RAISE EXCEPTION 'proof chunk commit failure'; END IF; RETURN NEW; END $$`,
        )
        await inspect.unsafe(
          `CREATE CONSTRAINT TRIGGER protocol_chunk_commit AFTER INSERT ON stream_chunks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION protocol_fail_chunk_commit()`,
        )
        await compare(`/streams/${failedAppend.id}/chunks`, 'POST', {
          parts: [{ type: 'unknown-failure' }],
        })
        assert.deepEqual((await ts.readStream(failedAppend.id)).chunks, [])
        await inspect.unsafe('DROP TRIGGER protocol_chunk_commit ON stream_chunks')
        assert.equal(
          (await a.store.appendStreamParts(failedAppend.id, [{ type: 'unknown-success' }])).seq,
          1,
        )
        checks.push(
          'real provider close refusal and chunk deferred-commit failure publish no artifact/lifecycle/sequence/timestamp changes; retries allocate revision0 and seq1',
        )
        const closeRace = await a.store.createStream(scope, 'close-race')
        await a.store.appendStreamParts(closeRace.id, [{ type: 'text-start', id: 'c' }])
        const closes = await Promise.all([
          a.store.closeStream(closeRace.id, 'completed'),
          b.store.closeStream(closeRace.id, 'aborted'),
          ts.closeStream(closeRace.id, 'completed'),
        ])
        assert.deepEqual(closes[0], closes[1])
        assert.deepEqual(closes[0], closes[2])
        assert.equal((await ts.listArtifacts('stream-build', `stream:${closeRace.id}`)).length, 1)
        checks.push(
          'deferred close commit failure leaves open stream/no artifact/revision/timestamp change; mixed writer close publishes once',
        )
        const restarted = await start()
        assert.deepEqual(
          await restarted.store.getStream(closeRace.id),
          await ts.getStream(closeRace.id),
        )
        assert.deepEqual(
          await restarted.store.readStream(closeRace.id),
          await ts.readStream(closeRace.id),
        )
        // Project auth resolves actual stream owner before reading body/query.
        const projects = new PostgresProjectRegistry(inspect)
        const ownedRepo = (await projects.add('https://github.com/proa/stream-owner', 'proof')).repo
        const foreignRepo = (await projects.add('https://github.com/proa/stream-foreign', 'proof'))
          .repo
        const credentials = new PostgresCredentialStore(inspect, projects)
        const issued = await credentials.issue(ownedRepo, 'proof')
        const auth = await start(true)
        const authenticated = createStoreServer({
          store: ts,
          clock,
          auth: createMachineAuth({
            secret: 'isolated-stream-proof-secret',
            store: ts,
            projects,
            credentials,
            clock,
          }),
        })
        await ts.createBuild({ slug: 'other-build', repo: foreignRepo })
        const foreignStream = await ts.createStream(
          { kind: 'build', build: 'other-build' },
          'foreign',
        )
        await ts.createBuild({ slug: 'owned-stream-build', repo: ownedRepo })
        const ownedStream = await ts.createStream(
          { kind: 'build', build: 'owned-stream-build' },
          'owned',
        )
        const validInit = { headers: { ...headers, authorization: `Bearer ${issued.token}` } }
        const ownResponse = await auth.server.fetch(
          `${auth.server.url}/streams/${ownedStream.id}`,
          validInit,
        )
        assert.equal(ownResponse.status, 200)
        assert.deepEqual(await ownResponse.json(), await ts.getStream(ownedStream.id))
        for (const path of [`/streams/${foreignStream.id}/chunks`, `/streams/missing/chunks`]) {
          const init = {
            method: 'POST',
            headers: { ...headers, authorization: `Bearer ${issued.token}` },
            body: '{',
          }
          const [n, t] = await Promise.all([
            auth.server.fetch(`${auth.server.url}${path}`, init),
            authenticated.fetch(new Request(`http://oracle${path}`, init)),
          ])
          assert.deepEqual(
            { status: n.status, body: await n.json() },
            { status: t.status, body: await t.json() },
          )
          differential++
        }
        checks.push(
          'restart reconstructs content from storage; authenticated indirect foreign/missing ownership refuses before body parsing',
        )
      } catch (error) {
        failure = error
      } finally {
        for (const server of running.reverse())
          await server.close().catch((error) => {
            failure ??= error
          })
        await ts.close().catch((error) => {
          failure ??= error
        })
        await inspect.close().catch((error) => {
          failure ??= error
        })
      }
      if (failure) throw failure
    }),
  )
  return { differential, checks }
}
