/** Draft for experiments/proa-server/tools. Imports are relative to that final location.
 * Successful mutations run once through native HTTP; populated reads and all refusals
 * compare full wire responses with the real TS/Postgres server over the same database.
 * Importing this module does not start services. */
import { strict as assert } from 'node:assert'
import semver from 'semver'
import { z } from 'zod'
import * as old from '../../../packages/hosted-store-service/src/compatibility-fixtures/store-v0.9'
import { reducerValueSchema as betaReducerValueSchema } from '../../../packages/hosted-store-service/src/compatibility-fixtures/reducer-values-v1.0.0-beta.0'
import { createStoreServer } from '../../../packages/hosted-store-service/src/remote-store-server'
import { openPostgresBuildStoreFromEnv } from '../../../packages/postgres-store/src/config'
import { sampleEventWrite } from '../../../packages/core/src/store/contract'
import { READ_CATALOG_IDENTITY } from '../../../packages/core/src/events/compatibility'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import {
  supportedClientRange,
  classifyClient,
  clientIdentityError,
  RELEASE_LINE_PROTOCOLS,
} from '../../../packages/core/src/store/remote/compatibility'
import { withDataServices } from './data-services'
import { withProtocolDatabase } from './protocol-harness'
import { startProtocolServer } from './protocol-server-harness'

const snapshot = z
  .object({
    version: z.number().int().positive(),
    cursor: z.number().int().nonnegative(),
    state: z.json(),
  })
  .nullable()
const position = z.object({ seq: z.number().int().nonnegative() })
type Decoder<T = unknown> = { parse(value: unknown): T }

/** Preserve major as well as minor; the old contract's `0.${minor}` generator
 * silently exercises zero supported releases after a major transition. */
export function compatibilityIdentities() {
  const range = supportedClientRange(),
    low = semver.parse(range.minVersion)!,
    high = semver.parse(range.maxVersionExclusive)!
  const supported = new Set<string>([AUTOBUILD_VERSION])
  for (let major = low.major; major <= high.major; major++) {
    const start = major === low.major ? low.minor : 0,
      end = major === high.major ? high.minor : low.minor + 3
    for (let minor = start; minor <= end; minor++)
      for (const patch of [0, 999]) {
        const version = `${major}.${minor}.${patch}`
        if (classifyClient(version, range) === 'supported') supported.add(version)
      }
  }
  // This frozen released decoder genuinely belongs to an admitted historical client.
  if (classifyClient('1.0.0-beta.0', range) === 'supported') supported.add('1.0.0-beta.0')
  assert.ok(supported.size > 0)
  for (const version of supported)
    assert.equal(clientIdentityError(version, REMOTE_STORE_PROTOCOL_VERSION), undefined)
  const refused = Object.entries(RELEASE_LINE_PROTOCOLS)
    .map(([line, protocol]) => ({ version: `${line}.0`, protocol }))
    .filter(({ version }) => classifyClient(version, range) !== 'supported')
  refused.push({ version: range.maxVersionExclusive, protocol: REMOTE_STORE_PROTOCOL_VERSION })
  return { range, supported: [...supported], refused }
}

export async function proveProtocolCompatibility(executable: string) {
  const identities = compatibilityIdentities(),
    checks: string[] = [],
    witnesses: Record<string, Record<string, number>> = {}
  let comparisons = 0,
    mutationWitnesses = 0,
    refusals = 0
  await withDataServices(async (admin, environment) =>
    withProtocolDatabase(admin, environment, async (env) => {
      const clock = () => new Date('2030-01-01T00:00:00.000Z')
      const ts = await openPostgresBuildStoreFromEnv(env, { clock }),
        servers: Awaited<ReturnType<typeof startProtocolServer>>[] = []
      let failure: unknown
      try {
        const native = await startProtocolServer({ executable, env, clock })
        servers.push(native)
        const oracle = createStoreServer({ store: ts, clock })
        const headers = (version: string, protocol = REMOTE_STORE_PROTOCOL_VERSION) => ({
          'content-type': 'application/json',
          'x-autobuild-version': version,
          'x-autobuild-protocol-version': protocol,
        })
        const wire = async (response: Response) => ({
          status: response.status,
          contentType: response.headers.get('content-type'),
          catalogIdentity: response.headers.get('x-autobuild-catalog-identity'),
          body: (await response.json()) as unknown,
        })
        const read = async (
          version: string,
          family: string,
          path: string,
          decoder: Decoder,
          method = 'GET',
          body?: unknown,
        ) => {
          const init = {
            method,
            headers: headers(version),
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }
          const actual = await wire(await native.fetch(`${native.url}${path}`, init)),
            expected = await wire(await oracle.fetch(new Request(`http://oracle${path}`, init)))
          assert.deepEqual(actual, expected, `${version} ${method} ${path}`)
          assert.equal(actual.status, 200, `${version} ${path}`)
          decoder.parse(actual.body)
          comparisons++
          witnesses[version] ??= {}
          const counter = witnesses[version]
          counter[family] = (counter[family] ?? 0) + 1
          return actual.body
        }
        const write = async <D extends Decoder>(
          version: string,
          path: string,
          body: unknown,
          decoder: D,
          method = 'POST',
          status = 201,
        ) => {
          const response = await native.fetch(`${native.url}${path}`, {
            method,
            headers: headers(version),
            body: JSON.stringify(body),
          })
          const result = await response.json()
          assert.equal(
            response.status,
            status,
            `${version} ${method} ${path}: ${JSON.stringify(result)}`,
          )
          const decoded = decoder.parse(result)
          mutationWitnesses++
          return decoded as ReturnType<D['parse']>
        }
        for (const [index, version] of identities.supported.entries()) {
          const repo = `historical-repo-${index}`,
            build = `historical-build-${index}`,
            bp = `/builds/${build}`,
            rp = `/repos/${repo}`
          await write(
            version,
            '/repos',
            old.ensureRepoBodySchema.parse({ repo }),
            old.repositoryRecordWireSchema,
            'POST',
            200,
          )
          await write(
            version,
            '/builds',
            old.newBuildBodySchema.parse({ slug: build, repo }),
            old.buildRecordWireSchema,
          )
          await write(
            version,
            `${bp}/events`,
            old.eventWriteWireSchema.parse({
              actor: { kind: 'dispatcher' },
              type: 'build.created',
              payload: { ticket: { source: 'file', id: 'T-1' }, repo, baseBranch: 'main' },
            }),
            old.eventEnvelopeWireSchema,
          )
          await write(
            version,
            `${bp}/events`,
            {
              actor: { kind: 'dispatcher' },
              type: 'integration.landed',
              payload: {
                operation: 'audit-op',
                head: 'head',
                landed: 'landed',
                provenance: 'kernel',
                verified: true,
                fenced: false,
              },
            },
            old.eventEnvelopeWireSchema,
          )
          await write(
            version,
            `${rp}/events`,
            {
              actor: { kind: 'human', user: 'old' },
              type: 'dispatcher.intake-set',
              payload: { enabled: true },
            },
            old.repositoryEventEnvelopeWireSchema,
          )
          const session = await write(
              version,
              `${rp}/sessions`,
              old.newSessionBodySchema.parse({
                repo,
                operator: 'old',
                title: 'Historical session',
              }),
              old.sessionRecordWireSchema,
            ),
            sp = `/sessions/${encodeURIComponent(session.id)}`
          await write(
            version,
            `${sp}/events`,
            {
              actor: { kind: 'human', user: 'old' },
              type: 'message.posted',
              payload: { text: 'Historical session' },
            },
            old.sessionEventEnvelopeWireSchema,
          )
          await read(version, 'records', bp, old.buildRecordWireSchema)
          await read(
            version,
            'records',
            `/builds?repo=${encodeURIComponent(repo)}`,
            old.buildRecordListSchema,
          )
          await read(version, 'records', rp, old.repositoryRecordWireSchema)
          await read(version, 'records', sp, old.sessionRecordWireSchema)
          await read(version, 'records', `${rp}/sessions`, old.sessionRecordListSchema)
          await read(version, 'events', `${bp}/events?since=0`, old.eventListSchema)
          await read(version, 'events', `${rp}/events?since=0`, old.repositoryEventListSchema)
          await read(version, 'events', `${sp}/events?since=0`, old.sessionEventListSchema)
          await write(
            version,
            `${bp}/events/conditional`,
            old.conditionalEventBodySchema.parse({
              expectedSeq: 2,
              event: sampleEventWrite('historical-conditional'),
            }),
            old.conditionalEventResponseSchema,
          )
          await read(
            version,
            'events',
            `${bp}/events/conditional`,
            old.conditionalEventResponseSchema,
            'POST',
            { expectedSeq: 0, event: sampleEventWrite('stale') },
          )
          await write(
            version,
            `${sp}/events/conditional`,
            {
              expectedSeq: 2,
              event: {
                actor: { kind: 'human', user: 'old' },
                type: 'message.posted',
                payload: { text: 'conditional' },
              },
            },
            old.conditionalSessionEventResponseSchema,
          )
          await read(
            version,
            'events',
            `${sp}/events/conditional`,
            old.conditionalSessionEventResponseSchema,
            'POST',
            {
              expectedSeq: 0,
              event: {
                actor: { kind: 'human', user: 'old' },
                type: 'message.posted',
                payload: { text: 'stale' },
              },
            },
          )
          const digest = (await read(
            version,
            'digests',
            `${rp}/build-digests`,
            old.buildDigestListSchema,
          )) as { slug: string; integrationAuditPending?: boolean }[]
          assert.ok(digest.some((row) => row.slug === build))
          assert.equal(digest[0]!.integrationAuditPending, true)
          // These are additive installed routes, not fictitious frozen v0.9 schemas.
          await read(version, 'snapshots', `${rp}/high-water`, position)
          for (const prefix of [bp, rp]) {
            const state = {
              version: 1,
              cursor: 1,
              state: { historical: true, nested: [null, 1, 'héllo'] },
            }
            await write(
              version,
              `${prefix}/snapshots/historical-cache`,
              state,
              z.object({ written: z.boolean() }),
              'PUT',
              200,
            )
            const stored = await read(
              version,
              'snapshots',
              `${prefix}/snapshots/historical-cache?version=1`,
              snapshot,
            )
            assert.deepEqual(stored, state)
            await read(
              version,
              'snapshots',
              `${prefix}/snapshots/historical-cache?version=2`,
              snapshot,
            )
          }
          await write(
            version,
            `${bp}/lease/claim`,
            old.leaseClaimBodySchema.parse({ holder: 'old', ttlMs: 10000 }),
            old.okResponseSchema,
            'POST',
            200,
          )
          await read(version, 'records', bp, old.buildRecordWireSchema)
          await write(
            version,
            `${bp}/lease/heartbeat`,
            { holder: 'old' },
            old.okResponseSchema,
            'POST',
            200,
          )
          await write(
            version,
            `${bp}/lease/release`,
            { holder: 'old' },
            old.okResponseSchema,
            'POST',
            200,
          )
          const families = [
            {
              prefix: bp,
              meta: old.artifactMetaWireSchema,
              list: old.artifactMetaListSchema,
              get: old.artifactGetResponseSchema,
              deposit: old.depositsResponseSchema,
              event: sampleEventWrite('historical-deposit'),
            },
            {
              prefix: rp,
              meta: old.repositoryArtifactMetaWireSchema,
              list: old.repositoryArtifactMetaListSchema,
              get: old.repositoryArtifactGetResponseSchema,
              deposit: old.repoDepositsResponseSchema,
              event: {
                actor: { kind: 'human', user: 'old' },
                type: 'dispatcher.intake-set',
                payload: { enabled: false },
              },
            },
            {
              prefix: sp,
              meta: old.sessionArtifactMetaWireSchema,
              list: old.sessionArtifactMetaListSchema,
              get: old.sessionArtifactGetResponseSchema,
              deposit: old.sessionDepositsResponseSchema,
              event: {
                actor: { kind: 'human', user: 'old' },
                type: 'message.posted',
                payload: { text: 'deposit' },
              },
            },
          ]
          for (const family of families) {
            const meta = await write(
              version,
              `${family.prefix}/artifacts`,
              old.putArtifactBodySchema.parse({
                kind: 'historical-note',
                contentBase64: 'aGVsbG8=',
                metadata: { unicode: 'héllo' },
              }),
              family.meta,
            )
            await read(version, 'artifacts', `${family.prefix}/artifact-list`, family.list)
            const artifact = (await read(
              version,
              'artifacts',
              `${family.prefix}/artifacts?kind=historical-note&rev=${meta.revision}`,
              family.get,
            )) as { contentBase64: string }
            assert.equal(artifact.contentBase64, 'aGVsbG8=')
            await write(
              version,
              `${family.prefix}/deposits`,
              {
                artifacts: [{ kind: 'historical-deposit', contentBase64: 'aGVsbG8=' }],
                event: family.event,
              },
              family.deposit,
            )
            await read(
              version,
              'artifacts',
              `${family.prefix}/artifacts?kind=historical-deposit`,
              family.get,
            )
            const stream = await write(
              version,
              `${family.prefix}/streams`,
              old.createStreamBodySchema.parse({ label: 'historical' }),
              old.streamRecordWireSchema,
            )
            const streamPath = `/streams/${encodeURIComponent(stream.id)}`
            await write(
              version,
              `${streamPath}/chunks`,
              old.appendStreamBodySchema.parse({
                parts: [
                  { type: 'start', messageId: 'm' },
                  { type: 'text-start', id: 't' },
                  { type: 'text-delta', id: 't', delta: 'héllo' },
                ],
              }),
              old.streamChunkWireSchema,
            )
            await write(
              version,
              `${streamPath}/chunks`,
              { parts: [{ type: 'text-end', id: 't' }, { type: 'finish' }] },
              old.streamChunkWireSchema,
            )
            await read(version, 'streams', streamPath, old.streamRecordWireSchema)
            await read(version, 'streams', `${family.prefix}/streams`, old.streamRecordListSchema)
            const chunks = (await read(
              version,
              'streams',
              `${streamPath}/chunks?since=0`,
              old.streamReadWireSchema,
            )) as { chunks: unknown[] }
            assert.equal(chunks.chunks.length, 2)
            await read(version, 'streams', `${streamPath}/chunks?since=1`, old.streamReadWireSchema)
            await write(
              version,
              `${streamPath}/close`,
              old.closeStreamBodySchema.parse({ outcome: 'completed' }),
              old.streamRecordWireSchema,
              'POST',
              200,
            )
            await read(version, 'streams', streamPath, old.streamRecordWireSchema)
            await read(version, 'streams', `${streamPath}/chunks?since=0`, old.streamReadWireSchema)
            const materialized = (await read(
              version,
              'artifacts',
              `${family.prefix}/artifacts?kind=${encodeURIComponent(`stream:${stream.id}`)}`,
              family.get,
            )) as { contentBase64: string }
            assert.equal(
              JSON.parse(Buffer.from(materialized.contentBase64, 'base64').toString())[0].parts[0]
                .text,
              'héllo',
            )
          }
          for (const [prefix, reducer] of [
            [bp, 'build'],
            [bp, 'buildReadFacts'],
            [rp, 'dispatchSettings'],
            [rp, 'repositoryReadFacts'],
          ]) {
            const value = (await read(
              version,
              'reducers',
              `${prefix}/reducer-values`,
              betaReducerValueSchema,
              'POST',
              { reducer },
            )) as { cursor: number }
            assert.deepEqual(Object.keys(value).sort(), ['cursor', 'value', 'version'])
            assert.ok(value.cursor > 0)
            const response = await native.fetch(`${native.url}${prefix}/reducer-values`, {
              method: 'POST',
              headers: headers(version),
              body: JSON.stringify({ reducer }),
            })
            assert.equal(
              response.headers.get('x-autobuild-catalog-identity'),
              READ_CATALOG_IDENTITY,
            )
          }
          for (const family of [
            'records',
            'events',
            'digests',
            'artifacts',
            'snapshots',
            'streams',
            'reducers',
          ])
            assert.ok(witnesses[version]![family]! > 0, `${version} missing ${family}`)
        }
        const rejected = [
          ...identities.refused,
          ...['3', '4', '999']
            .filter((protocol) => protocol !== REMOTE_STORE_PROTOCOL_VERSION)
            .map((protocol) => ({ version: AUTOBUILD_VERSION, protocol })),
          ...['v1.0.0', '1.0.0+build', '1.0.00'].map((version) => ({
            version,
            protocol: REMOTE_STORE_PROTOCOL_VERSION,
          })),
        ]
        for (const identity of rejected) {
          const error = clientIdentityError(identity.version, identity.protocol)
          assert.ok(error)
          for (const [path, method, body] of [
            ['/builds', 'GET', undefined],
            ['/builds', 'POST', '{'],
            ['/repos/missing/reducer-values', 'POST', '{'],
            ['/repos/missing/operator-presence/operator', 'DELETE', undefined],
          ] as const) {
            const init = {
              method,
              headers: headers(identity.version, identity.protocol),
              ...(body === undefined ? {} : { body }),
            }
            const actual = await wire(await native.fetch(`${native.url}${path}`, init)),
              expected = await wire(await oracle.fetch(new Request(`http://oracle${path}`, init)))
            assert.deepEqual(
              actual,
              expected,
              `${identity.version}/${identity.protocol} ${method} ${path}`,
            )
            assert.equal(
              actual.status,
              409,
              `${identity.version}/${identity.protocol} ${method} ${path}`,
            )
            old.errorBodySchema.parse(actual.body)
            assert.equal(old.errorBodySchema.parse(actual.body).error, error)
            comparisons++
            refusals++
          }
        }
        for (const identity of [
          undefined,
          ...identities.supported,
          ...identities.refused.map((row) => row.version),
        ]) {
          const init = identity === undefined ? {} : { headers: headers(identity) }
          const actual = await wire(await native.fetch(`${native.url}/health`, init)),
            expected = await wire(await oracle.fetch(new Request('http://oracle/health', init)))
          assert.deepEqual(actual, expected, `public health ${identity ?? 'no identity'}`)
          assert.equal(actual.status, 200)
          comparisons++
        }
        const missing = { method: 'GET' }
        assert.deepEqual(
          await wire(await native.fetch(`${native.url}/builds`, missing)),
          await wire(await oracle.fetch(new Request('http://oracle/builds', missing))),
        )
        comparisons++
        refusals++
        const restarted = await startProtocolServer({ executable, env, clock })
        servers.push(restarted)
        const restartInit = { headers: headers(identities.supported[0]!) }
        assert.deepEqual(
          await wire(
            await restarted.fetch(
              `${restarted.url}/builds/historical-build-0/events?since=0`,
              restartInit,
            ),
          ),
          await wire(
            await oracle.fetch(
              new Request('http://oracle/builds/historical-build-0/events?since=0', restartInit),
            ),
          ),
        )
        comparisons++
        checks.push(
          'all admitted release identities execute every populated family through real native HTTP and frozen decoders',
          'full populated read and refused-request status/content-type/catalog/body TS/Postgres differentials',
          'retired0.9–0.14 remain refused; beta strict reducer body accepts exactly three keys',
          'fresh native restart retains populated historical log',
        )
      } catch (error) {
        failure = error
      } finally {
        for (const server of servers.reverse())
          await server.close().catch((error) => {
            failure ??= error
          })
        await ts.close().catch((error) => {
          failure ??= error
        })
      }
      if (failure) throw failure
    }),
  )
  return {
    range: identities.range,
    admitted: identities.supported,
    refused: identities.refused,
    decoderReferences: [
      'store-v0.9.ts@58268333ad4e2ea4b37f86a9086ec1324417623f (shape baseline, not0.9 admission)',
      'reducer-values-v1.0.0-beta.0.ts (admitted historical strict reducer decoder)',
    ],
    witnesses,
    comparisons,
    mutationWitnesses,
    refusals,
    checks,
  }
}
