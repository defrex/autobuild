/** Deployment retention overrides agree across source and native writers. */
import { strict as assert } from 'node:assert'
import { SQL } from 'bun'
import { openPostgresBuildStoreFromEnv } from '../../../packages/postgres-store/src/config'
import { createStoreServer } from '../../../packages/hosted-store-service/src/remote-store-server'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import { withDataServices } from './data-services'
import { withProtocolDatabase } from './protocol-harness'
import { startProtocolServer } from './protocol-server-harness'
export async function proveProtocolRetentionEnvironment(executable: string) {
  let comparisons = 0
  await withDataServices(async (admin, environment) =>
    withProtocolDatabase(admin, environment, async (databaseEnv) => {
      const clock = () => new Date('2030-01-01T00:00:00.000Z')
      for (const limit of [2, 500]) {
        const env: Record<string, string | undefined> = {
          ...databaseEnv,
          AB_ARTIFACT_RETENTION_MAX_REVISIONS: String(limit),
        }
        const source = await openPostgresBuildStoreFromEnv(env, { clock })
        const sql = new SQL(env.AB_POSTGRES_URL!, { max: 1 })
        const native = await startProtocolServer({ executable, env, clock })
        const oracle = createStoreServer({ store: source, clock })
        const repo = `retention-environment-${limit}`
        const headers = {
          'content-type': 'application/json',
          'x-autobuild-version': AUTOBUILD_VERSION,
          'x-autobuild-protocol-version': REMOTE_STORE_PROTOCOL_VERSION,
        }
        try {
          await source.ensureRepo(repo)
          // Shared-schema fixtures need no pretend object storage: only revision
          // metadata is read. New mutations use real whole-object S3 writes.
          await sql.unsafe(
            "INSERT INTO repo_artifacts (repo,kind,revision,blob_ref,metadata,created_at) SELECT $1,'operator-notes',revision,'fixture-unread-blob','{}'::jsonb,$2::timestamptz FROM generate_series(1,205) AS revision",
            [repo, clock().toISOString()],
          )
          const first = await native.fetch(`${native.url}/repos/${repo}/artifacts`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ kind: 'operator-notes', contentBase64: btoa('native') }),
          })
          assert.equal(first.status, 201)
          const afterNative = await source.listRepoArtifacts(repo, 'operator-notes')
          assert.equal(afterNative.length, Math.min(limit, 206))
          assert.equal(
            afterNative.some((meta) => meta.revision === 1),
            limit === 500,
          )
          comparisons += 2
          await source.putRepoArtifact(repo, { kind: 'operator-notes', content: 'source' })
          const path = `/repos/${repo}/artifact-list?kind=operator-notes`
          const actual = await native.fetch(`${native.url}${path}`, { headers })
          const expected = await oracle.fetch(new Request(`http://oracle${path}`, { headers }))
          assert.deepEqual(
            { status: actual.status, body: await actual.json() },
            { status: expected.status, body: await expected.json() },
          )
          const afterBoth = await source.listRepoArtifacts(repo, 'operator-notes')
          assert.equal(afterBoth.length, Math.min(limit, 207))
          comparisons += 2
        } finally {
          await native.close()
          await source.close()
          await sql.close()
        }
      }
    }),
  )
  return {
    comparisons,
    limits: [2, 500],
    checks: [
      'production environment configuration reaches native pruning; mixed writers retain the same revision window',
    ],
  }
}
