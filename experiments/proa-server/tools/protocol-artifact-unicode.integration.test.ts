/** Explicit lossless artifact/deposit HTTP parity, including SQL error ordering. */
import { strict as assert } from 'node:assert'
import { sampleEventWrite } from '../../../packages/core/src/store/contract'
import { openPostgresBuildStoreFromEnv } from '../../../packages/postgres-store/src/config'
import { createStoreServer } from '../../../packages/hosted-store-service/src/remote-store-server'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import { withDataServices } from './data-services'
import { withProtocolDatabase } from './protocol-harness'
import { startProtocolServer } from './protocol-server-harness'
export async function proveProtocolArtifactUnicode(executable: string) {
  let comparisons = 0
  await withDataServices(async (admin, environment) =>
    withProtocolDatabase(admin, environment, async (env) => {
      const clock = () => new Date('2030-01-01T00:00:00.000Z'),
        ts = await openPostgresBuildStoreFromEnv(env, { clock })
      const native = await startProtocolServer({ executable, env, clock }),
        oracle = createStoreServer({ store: ts, clock })
      const headers = {
        'content-type': 'application/json',
        'x-autobuild-version': AUTOBUILD_VERSION,
        'x-autobuild-protocol-version': REMOTE_STORE_PROTOCOL_VERSION,
      }
      try {
        await ts.ensureRepo('unicode-artifacts')
        for (const slug of ['artifact-native', 'artifact-source'])
          await ts.createBuild({ slug, repo: 'unicode-artifacts' })
        const compare = async (suffix: string, input: unknown, status: number) => {
          const request = { method: 'POST', headers, body: JSON.stringify(input) }
          const actualResponse = await native.fetch(
            `${native.url}/builds/artifact-native/${suffix}`,
            request,
          )
          const expectedResponse = await oracle.fetch(
            new Request(`http://oracle/builds/artifact-source/${suffix}`, request),
          )
          const actual = { status: actualResponse.status, body: await actualResponse.json() },
            expected = { status: expectedResponse.status, body: await expectedResponse.json() }
          // Independent scope keys are the only intended response difference.
          const normalize = (value: unknown) =>
            JSON.parse(
              JSON.stringify(value)
                .replaceAll('artifact-native', 'artifact')
                .replaceAll('artifact-source', 'artifact'),
            )
          assert.deepEqual(
            normalize(actual),
            normalize(expected),
            `${suffix}: ${JSON.stringify(input)}`,
          )
          assert.equal(actual.status, status)
          comparisons++
          return actual.body
        }
        const artifact = { kind: 'unicode', contentBase64: 'YQ==' }
        for (const metadata of [
          { value: '\ud800' },
          { '\udfff': 'value' },
          { nested: ['a', '\ud800'] },
          { value: '\u0000' },
        ]) {
          await compare('artifacts', { ...artifact, metadata }, 500)
          assert.deepEqual(await ts.listArtifacts('artifact-native'), [])
        }
        const event = sampleEventWrite()
        await compare(
          'deposits/conditional',
          { expectedSeq: 9, artifacts: [{ ...artifact, metadata: { value: '\ud800' } }], event },
          200,
        )
        await compare(
          'deposits',
          {
            artifacts: [artifact, { ...artifact, kind: 'second', metadata: { value: '\ud800' } }],
            event,
          },
          500,
        )
        assert.deepEqual(await ts.listArtifacts('artifact-native'), [])
        assert.deepEqual(await ts.listArtifacts('artifact-source'), [])
        assert.deepEqual(await ts.getEvents('artifact-native'), [])
        await compare('artifacts', { ...artifact, kind: '\ud800', metadata: { valid: '💩' } }, 201)
        const stored = await ts.listArtifacts('artifact-native')
        assert.equal(stored[0]?.kind, '�')
        await compare(
          'deposits',
          {
            artifacts: [{ ...artifact, kind: 'normal' }],
            event: { ...event, actor: { kind: 'agent', role: 'implement', session: '\ud800' } },
          },
          500,
        )
        assert.equal((await ts.listArtifacts('artifact-native')).length, 1)
        assert.deepEqual(await ts.getEvents('artifact-native'), [])
      } finally {
        await native.close()
        await ts.close()
      }
    }),
  )
  return {
    comparisons,
    groups: [
      'JSONB rejection after preparation',
      'stale CAS before metadata rejection',
      'batch rollback',
      'TEXT replacement with lossless immediate kind',
      'event actor SQL rollback',
    ],
  }
}
