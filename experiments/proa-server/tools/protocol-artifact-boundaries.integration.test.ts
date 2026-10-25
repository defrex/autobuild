/** Explicit adversarial HTTP evidence, never automatic database tests. */
import { strict as assert } from 'node:assert'
import { SQL } from 'bun'
import { RemoteBuildStore } from '../../../packages/core/src/store/remote/client'
import { sampleEventWrite } from '../../../packages/core/src/store/contract'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import { openPostgresBuildStoreFromEnv } from '../../../packages/postgres-store/src/config'
import { PostgresCredentialStore } from '../../../packages/postgres-store/src/credentials'
import { PostgresProjectRegistry } from '../../../packages/postgres-store/src/projects'
import { createStoreServer } from '../../../packages/hosted-store-service/src/remote-store-server'
import { createMachineAuth } from '../../../packages/hosted-store-service/src/machine-auth'
import { withDataServices } from './data-services'
import { withProtocolDatabase } from './protocol-harness'
import { startProtocolServer } from './protocol-server-harness'

export async function proveProtocolArtifactBoundaries(executable: string) {
  const checks: string[] = []
  let differential = 0
  await withDataServices(async (admin, environment) => {
    await withProtocolDatabase(admin, environment, async (env) => {
      const clock = () => new Date('2030-01-01T00:00:00.000Z')
      const ts = await openPostgresBuildStoreFromEnv(env, { clock })
      const sql = new SQL(env.AB_POSTGRES_URL!, { max: 1 })
      const running: Awaited<ReturnType<typeof startProtocolServer>>[] = []
      const start = async (overrides: Record<string, string | undefined> = {}) => {
        const server = await startProtocolServer({
          executable,
          env: { ...env, ...overrides },
          clock,
          retention: { maxRevisions: 1 },
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
        const open = await start()
        const oracle = createStoreServer({ store: ts, clock, maxArtifactBytes: 1024 * 1024 })
        const compare = async (path: string, raw: string) => {
          const init = { method: 'POST', headers, body: raw }
          const [native, expected] = await Promise.all([
            open.server.fetch(`${open.server.url}${path}`, init),
            oracle.fetch(new Request(`http://oracle${path}`, init)),
          ])
          assert.deepEqual(
            { status: native.status, body: await native.json() },
            { status: expected.status, body: await expected.json() },
            `POST ${path}`,
          )
          differential++
        }
        for (const scope of ['builds/unknown', 'repos/unknown', 'sessions/unknown']) {
          for (const suffix of ['artifacts', 'deposits']) {
            await compare(`/${scope}/${suffix}`, '{')
            for (const contentBase64 of ['a', 'YQ==']) {
              const artifact = { kind: 'notes', contentBase64 }
              await compare(
                `/${scope}/${suffix}`,
                JSON.stringify(
                  suffix === 'artifacts'
                    ? artifact
                    : { artifacts: [artifact], event: sampleEventWrite() },
                ),
              )
            }
          }
        }
        checks.push(
          'unknown build/repo/session malformed JSON, invalid base64 and valid upload preserve existence/body ordering',
        )
        await open.store.createBuild({ slug: 'boundary', repo: 'boundary-repo' })
        const successful = await open.store.appendWithArtifacts(
          'boundary',
          [
            { kind: 'build-runner-effective-config', content: 'first' },
            { kind: 'build-runner-effective-config', content: 'second' },
          ],
          () => sampleEventWrite('same-kind retained batch'),
        )
        assert.deepEqual(
          successful.artifacts.map((meta) => meta.revision),
          [0, 1],
        )
        assert.deepEqual(
          (await ts.listArtifacts('boundary', 'build-runner-effective-config')).map(
            (meta) => meta.revision,
          ),
          [1],
        )
        assert.equal(
          await open.store.getArtifact('boundary', 'build-runner-effective-config', 0),
          null,
        )
        assert.equal((await ts.getEvents('boundary')).at(-1)!.seq, successful.event.seq)
        checks.push(
          'successful retained same-kind batch returns all metas although retention atomically prunes an earlier sibling',
        )
        const state = async () => ({
          build: await ts.getBuild('boundary'),
          artifacts: await ts.listArtifacts('boundary'),
          events: await ts.getEvents('boundary'),
          position: await ts.getRepoChangePosition('boundary-repo'),
        })
        const before = await state()
        const unavailable = await start({ AB_S3_BUCKET: 'proa-protocol-deliberately-absent' })
        const rejectUpload = async (path: string, body: unknown) => {
          const response = await unavailable.server.fetch(`${unavailable.server.url}${path}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
          })
          assert.deepEqual(
            { status: response.status, body: await response.json() },
            { status: 500, body: { kind: 'internal', error: 'internal server error' } },
          )
        }
        await rejectUpload('/builds/boundary/artifacts', {
          kind: 'provider-refused',
          contentBase64: 'YQ==',
        })
        const deposit = {
          artifacts: [{ kind: 'provider-refused', contentBase64: 'YQ==' }],
          event: sampleEventWrite(),
        }
        await rejectUpload('/builds/boundary/deposits', deposit)
        await rejectUpload('/builds/boundary/deposits/conditional', { ...deposit, expectedSeq: 0 })
        assert.deepEqual(await state(), before)
        assert.equal(
          (
            await open.store.putArtifact('boundary', {
              kind: 'provider-refused',
              content: 'recovered',
            })
          ).revision,
          0,
        )
        checks.push(
          'real S3 NoSuchBucket refusal precedes mutation and stale CAS; metadata/events/revision/timestamps/change position remain unchanged and provider detail is sanitized',
        )
        const projects = new PostgresProjectRegistry(sql)
        const credentials = new PostgresCredentialStore(sql, projects)
        const repo = (await projects.add('https://github.com/proa/artifact-boundaries', 'proof'))
          .repo
        const owner = await credentials.issue(repo, 'owner')
        await ts.createBuild({ slug: 'owned-boundary', repo })
        await ts.ensureRepo(repo)
        const session = await ts.createSession({ repo, operator: 'proof' })
        const authenticated = await start({ PROA_TEST_AUTH: 'project' })
        const authenticatedOracle = createStoreServer({
          store: ts,
          clock,
          maxArtifactBytes: 1024 * 1024,
          auth: createMachineAuth({
            secret: 'isolated-proof-secret',
            credentials,
            projects,
            store: ts,
            clock,
          }),
        })
        const authHeaders = { ...headers, authorization: `Bearer ${owner.token}` }
        for (const scope of [
          'builds/owned-boundary',
          `repos/${encodeURIComponent(repo)}`,
          `sessions/${session.id}`,
        ]) {
          const path = `/${scope}/deposits`
          const init = {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({
              artifacts: [{ kind: 'notes', contentBase64: 'a' }],
              event: {
                ...sampleEventWrite(),
                actor: { kind: 'human', user: 'owner', via: { kind: 'mcp', client: 'untrusted' } },
              },
            }),
          }
          const [native, expected] = await Promise.all([
            authenticated.server.fetch(`${authenticated.server.url}${path}`, init),
            authenticatedOracle.fetch(new Request(`http://oracle${path}`, init)),
          ])
          const result = { status: native.status, body: await native.json() }
          assert.deepEqual(
            result,
            { status: expected.status, body: await expected.json() },
            `authenticated ${scope}`,
          )
          assert.equal(result.status, scope.startsWith('sessions/') ? 400 : 403)
          differential++
        }
        checks.push(
          'project human-via refusal precedes invalid base64 for build/repo deposits; sessions retain decode-first behavior',
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
        await sql.close().catch((error) => {
          failure ??= error
        })
      }
      if (failure) throw failure
    })
  })
  return { differential, checks }
}
