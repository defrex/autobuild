/** Explicit native family evidence. The unchanged full contract remains required. */
import { strict as assert } from 'node:assert'
import { SQL } from 'bun'
import { RemoteBuildStore } from '../../../packages/core/src/store/remote/client'
import {
  sampleEventWrite,
  planCompletedWrite,
  harvestStartedWrite,
} from '../../../packages/core/src/store/contract'
import { openPostgresBuildStoreFromEnv } from '../../../packages/postgres-store/src/config'
import { createStoreServer } from '../../../packages/hosted-store-service/src/remote-store-server'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import { withDataServices } from './data-services'
import { withProtocolDatabase } from './protocol-harness'
import { startProtocolServer } from './protocol-server-harness'

export async function proveProtocolArtifacts(executable: string) {
  const checks: string[] = []
  let differential = 0
  await withDataServices(async (admin, environment) => {
    await withProtocolDatabase(admin, environment, async (env) => {
      let now = new Date('2030-01-01T00:00:00.000Z')
      const clock = () => now
      const ts = await openPostgresBuildStoreFromEnv(env, { clock })
      const sql = new SQL(env.AB_POSTGRES_URL!, { max: 1 })
      const running: Awaited<ReturnType<typeof startProtocolServer>>[] = []
      const start = async () => {
        const server = await startProtocolServer({
          executable,
          env,
          clock,
          retention: { maxRevisions: 2 },
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
        const post = async (path: string, body: unknown) => {
          const response = await a.server.fetch(`${a.server.url}${path}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
          })
          return { status: response.status, body: await response.json() }
        }
        await a.store.createBuild({ slug: 'artifact', repo: 'artifact-repo' })
        await a.store.ensureRepo('artifact-repo')
        const session = await a.store.createSession({ repo: 'artifact-repo', operator: 'operator' })
        const bytes = new Uint8Array([0, 255, 128, 10, 13])
        const meta = await a.store.putArtifact('artifact', {
          kind: 'plan',
          content: bytes,
          metadata: { nested: { ok: true }, list: [1, null] },
        })
        assert.equal(meta.revision, 0)
        assert.deepEqual(await ts.getArtifact('artifact', 'plan'), { meta, content: bytes })
        const fromTS = await ts.putArtifact('artifact', { kind: 'plan', content: 'from TS' })
        assert.deepEqual(
          await b.store.getArtifact('artifact', 'plan'),
          await ts.getArtifact('artifact', 'plan'),
        )
        assert.equal(fromTS.revision, 1)
        const empty = await b.store.putArtifact('artifact', {
          kind: 'empty',
          content: new Uint8Array(),
        })
        assert.equal((await ts.getArtifact('artifact', 'empty'))!.content.length, 0)
        assert.equal(empty.revision, 0)
        assert.equal(await a.store.getArtifact('artifact', 'missing'), null)
        assert.equal(await a.store.getArtifact('artifact', 'plan', 999), null)
        checks.push(
          'whole binary/empty S3 uploads cross-read in both languages; latest/pinned/missing metadata',
        )
        const deposit = await a.store.appendWithArtifacts(
          'artifact',
          [{ kind: 'plan', content: 'third' }],
          (m) => planCompletedWrite(m[0]!.revision),
        )
        assert.equal(deposit.artifacts[0]!.revision, 2)
        assert.deepEqual(deposit.event.payload.artifact, { kind: 'plan', rev: 2 })
        assert.deepEqual(await ts.getEvents('artifact'), await b.store.getEvents('artifact'))
        const position = await a.store.getRepoChangePosition('artifact-repo')
        now = new Date('2030-01-01T01:00:00.000Z')
        const before = await ts.getBuild('artifact')
        assert.equal(
          (
            await post('/builds/artifact/deposits', {
              artifacts: [{ kind: 'plan', contentBase64: 'cm9sbGVkIGJhY2s=' }],
              event: { ...sampleEventWrite(), payload: { bad: true } },
            })
          ).status,
          422,
        )
        assert.deepEqual(await ts.getBuild('artifact'), before)
        assert.equal(await a.store.getRepoChangePosition('artifact-repo'), position)
        assert.deepEqual(
          (await b.store.listArtifacts('artifact', 'plan')).map((m) => m.revision),
          [0, 1, 2],
        )
        const stale = await post('/builds/artifact/deposits/conditional', {
          expectedSeq: 0,
          artifacts: [{ kind: 'plan', contentBase64: 'c3RhbGU=' }],
          event: { ...sampleEventWrite(), payload: { bad: true } },
        })
        assert.deepEqual(stale, { status: 200, body: null })
        assert.equal(
          (await a.store.putArtifact('artifact', { kind: 'plan', content: 'after rollback' }))
            .revision,
          3,
        )
        const winners = await Promise.all([
          a.store.appendWithArtifactsIfCurrent(
            'artifact',
            1,
            [{ kind: 'plan', content: 'race-a' }],
            (m) => planCompletedWrite(m[0]!.revision),
          ),
          b.store.appendWithArtifactsIfCurrent(
            'artifact',
            1,
            [{ kind: 'plan', content: 'race-b' }],
            (m) => planCompletedWrite(m[0]!.revision),
          ),
        ])
        assert.equal(winners.filter(Boolean).length, 1)
        assert.equal((await ts.getEvents('artifact')).length, 2)
        checks.push(
          'atomic deposits: placeholders, invalid rollback, stale-before-validation CAS, two native writer race',
        )
        const repoResult = await a.store.appendRepoWithArtifacts(
          'artifact-repo',
          [{ kind: 'harvest-scan', content: 'scan' }],
          (m) => harvestStartedWrite('h', m[0]!.revision),
        )
        assert.equal(repoResult.event.payload.scan.rev, 0)
        assert.deepEqual(
          await ts.getRepoArtifact('artifact-repo', 'harvest-scan'),
          await b.store.getRepoArtifact('artifact-repo', 'harvest-scan'),
        )
        const sessionResult = await a.store.appendSessionWithArtifacts(
          session.id,
          [{ kind: 'context', content: 'context' }],
          () => ({
            actor: { kind: 'agent', role: 'orchestrator', session: 'os_turn' },
            type: 'turn.started',
            payload: { turn: 't', stream: 'st_t', trigger: { kind: 'message', messageSeq: 1 } },
          }),
        )
        assert.equal(sessionResult.event.seq, 2)
        assert.deepEqual(
          await ts.getSessionArtifact(session.id, 'context'),
          await b.store.getSessionArtifact(session.id, 'context'),
        )
        checks.push(
          'repository/session scoped artifacts and atomic events share existing TS tables',
        )
        for (let i = 0; i < 5; i++) {
          await (i % 2 ? a.store : b.store).putRepoArtifact('artifact-repo', {
            kind: 'dispatcher-config',
            content: String(i),
          })
          await a.store.putArtifact('artifact', {
            kind: 'build-runner-effective-config',
            content: String(i),
          })
          await a.store.putSessionArtifact(session.id, {
            kind: 'dispatcher-config',
            content: String(i),
          })
        }
        assert.deepEqual(
          (await ts.listRepoArtifacts('artifact-repo', 'dispatcher-config')).map((m) => m.revision),
          [3, 4],
        )
        assert.deepEqual(
          (await ts.listArtifacts('artifact', 'build-runner-effective-config')).map(
            (m) => m.revision,
          ),
          [3, 4],
        )
        assert.equal((await ts.listSessionArtifacts(session.id, 'dispatcher-config')).length, 5)
        // A same-kind batch validates before pruning and rolls its entire update back.
        assert.equal(
          (
            await post('/builds/artifact/deposits', {
              artifacts: [
                { kind: 'build-runner-effective-config', contentBase64: 'eA==' },
                { kind: 'build-runner-effective-config', contentBase64: 'eQ==' },
              ],
              event: { ...sampleEventWrite(), payload: { bad: true } },
            })
          ).status,
          422,
        )
        assert.deepEqual(
          (await ts.listArtifacts('artifact', 'build-runner-effective-config')).map(
            (m) => m.revision,
          ),
          [3, 4],
        )
        checks.push(
          'retention constructor honored under deposit locks; sessions exempt; invalid same-kind batch cannot prune',
        )
        // Mixed-language writer locks must allocate disjoint contiguous revisions.
        const mixed = await Promise.all(
          Array.from({ length: 8 }, (_, i) =>
            (i % 2 ? a.store : ts).putArtifact('artifact', { kind: 'mixed', content: String(i) }),
          ),
        )
        assert.deepEqual(
          mixed.map((m) => m.revision).sort((a, b) => a - b),
          [0, 1, 2, 3, 4, 5, 6, 7],
        )
        assert.deepEqual(
          await b.store.listArtifacts('artifact'),
          await ts.listArtifacts('artifact'),
        )
        checks.push('mixed native/TypeScript writers allocate contiguous revisions')
        const oracle = createStoreServer({ store: ts, clock, maxArtifactBytes: 1024 * 1024 })
        const compare = async (path: string, method: string, body?: unknown) => {
          const init = {
            method,
            headers,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }
          const [native, expected] = await Promise.all([
            a.server.fetch(`${a.server.url}${path}`, init),
            oracle.fetch(new Request(`http://oracle${path}`, init)),
          ])
          assert.deepEqual(
            { status: native.status, body: await native.json() },
            { status: expected.status, body: await expected.json() },
            `${method} ${path}`,
          )
          differential++
        }
        for (const scope of ['builds/artifact', 'repos/artifact-repo', `sessions/${session.id}`]) {
          for (const contentBase64 of ['Zg', 'Zh==', ' Zg==', 'Zg==\n', '-___', '===='])
            await compare(`/${scope}/artifacts`, 'POST', { kind: 'plan', contentBase64 })
          await compare(`/${scope}/artifacts`, 'POST', { kind: '', contentBase64: '' })
          await compare(`/${scope}/artifacts`, 'POST', {
            kind: 'plan',
            contentBase64: '',
            metadata: null,
          })
          await compare(`/${scope}/artifacts`, 'GET')
          await compare(`/${scope}/artifacts?kind=plan&rev=1.2`, 'GET')
          await compare(`/${scope}/artifacts?kind=absent&rev=0x10`, 'GET')
          await compare(`/${scope}/deposits`, 'POST', {
            artifacts: [{ kind: 'no', contentBase64: 'a' }],
            event: sampleEventWrite(),
          })
        }
        await compare('/builds/artifact/deposits/conditional', 'POST', {
          artifacts: [],
          event: sampleEventWrite(),
        })
        await compare('/builds/artifact/deposits', 'POST', {
          expectedSeq: 0,
          artifacts: [],
          event: sampleEventWrite(),
        })
        const over = Buffer.alloc(1024 * 1024 + 1).toString('base64')
        await compare('/builds/artifact/artifacts', 'POST', {
          kind: 'too-big',
          contentBase64: over,
        })
        const exact = await a.store.putArtifact('artifact', {
          kind: 'limit',
          content: new Uint8Array(1024 * 1024),
        })
        assert.equal(
          (await ts.getArtifact('artifact', 'limit', exact.revision))!.content.length,
          1024 * 1024,
        )
        checks.push(
          'exact HTTP refusal parity for request schemas/base64/limits/queries/CAS route ordering',
        )
        // SQL failures after successful upload publish neither metadata nor events.
        const eventCount = (await ts.getEvents('artifact')).length
        const stable = await ts.getBuild('artifact')
        await sql.unsafe(
          `CREATE FUNCTION protocol_artifact_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='commit-fail' THEN RAISE EXCEPTION 'proof artifact commit failure'; END IF; RETURN NEW; END $$`,
        )
        await sql.unsafe(
          `CREATE CONSTRAINT TRIGGER protocol_artifact_commit AFTER INSERT ON artifacts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION protocol_artifact_commit_failure()`,
        )
        await compare('/builds/artifact/artifacts', 'POST', {
          kind: 'commit-fail',
          contentBase64: 'YWJj',
        })
        assert.deepEqual(await ts.listArtifacts('artifact', 'commit-fail'), [])
        await compare('/builds/artifact/deposits', 'POST', {
          artifacts: [{ kind: 'commit-fail', contentBase64: 'YWJj' }],
          event: sampleEventWrite(),
        })
        assert.equal((await ts.getEvents('artifact')).length, eventCount)
        assert.deepEqual(await ts.getBuild('artifact'), stable)
        await compare('/builds/artifact/artifacts', 'POST', {
          kind: 'json-fail',
          contentBase64: 'YWJj',
          metadata: { nul: '\u0000' },
        })
        assert.deepEqual(await ts.listArtifacts('artifact', 'json-fail'), [])
        checks.push(
          'PostgreSQL insert and deferred COMMIT failures leave metadata/events/revisions/timestamps unchanged',
        )
        const restarted = await start()
        assert.deepEqual(
          await restarted.store.listArtifacts('artifact'),
          await ts.listArtifacts('artifact'),
        )
        assert.deepEqual(
          await restarted.store.getArtifact('artifact', 'plan'),
          await ts.getArtifact('artifact', 'plan'),
        )
        checks.push('fresh native process reconstructs metadata and bytes without process state')
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
        await sql.close().catch((error) => {
          failure ??= error
        })
      }
      if (failure) throw failure
    })
  })
  return { differential, checks }
}
