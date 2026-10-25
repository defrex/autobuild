/** Lossless stream envelopes and close bytes against the pinned TypeScript SDK. */
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { SQL } from 'bun'
import { openPostgresBuildStoreFromEnv } from '../../../packages/postgres-store/src/config'
import { RemoteBuildStore } from '../../../packages/core/src/store/remote/client'
import { assembleUIMessageDocument } from '../../../packages/core/src/store/streams/assemble'
import {
  streamArtifactInput,
  type StreamPart,
} from '../../../packages/core/src/store/streams/types'
import { withDataServices } from './data-services'
import { withProtocolDatabase } from './protocol-harness'
import { startProtocolServer } from './protocol-server-harness'
export async function proveProtocolUnicodeStreams(executable: string) {
  let comparisons = 0
  await withDataServices(async (admin, environment) =>
    withProtocolDatabase(admin, environment, async (env) => {
      const clock = () => new Date('2030-01-01T00:00:00.000Z'),
        source = await openPostgresBuildStoreFromEnv(env, { clock }),
        sql = new SQL(env.AB_POSTGRES_URL!, { max: 1 })
      const servers: Awaited<ReturnType<typeof startProtocolServer>>[] = []
      const start = async () => {
        const server = await startProtocolServer({ executable, env, clock })
        servers.push(server)
        return new RemoteBuildStore({ url: server.url, fetchFn: server.fetch })
      }
      try {
        const native = await start(),
          peer = await start(),
          scope = { kind: 'build' as const, build: 'unicode-stream-build' }
        await native.createBuild({ slug: scope.build, repo: 'unicode-stream-repo' })
        const high = String.fromCharCode(0xd800),
          low = String.fromCharCode(0xdfff),
          replacement = '�'
        const stream = await native.createStream(scope, `label-${high}`),
          oracleLabel = await source.createStream(scope, `label-${high}`)
        assert.deepEqual({ ...stream, id: 'paired' }, { ...oracleLabel, id: 'paired' })
        assert.equal(stream.label, `label-${replacement}`)
        comparisons += 2
        const batches: StreamPart[][] = [
          [
            { type: 'start', messageId: high, messageMetadata: { [high]: low } },
            { type: 'text-start', id: high },
            { type: 'text-start', id: replacement },
            { type: 'text-delta', id: high, delta: high },
            { type: 'text-delta', id: replacement, delta: 'separate' },
            { type: 'text-delta', id: high, delta: low },
            { type: 'text-end', id: high },
            { type: 'text-end', id: replacement },
          ],
          [
            {
              type: 'data-unicode',
              id: low,
              data: { [high]: low, nul: '\u0000', array: [high, low] },
              [high]: { [low]: high },
            },
            { type: 'message-metadata', messageMetadata: { [low]: high } },
          ],
          [
            { type: 'tool-input-start', toolCallId: high, toolName: `tool-${low}` },
            { type: 'tool-input-delta', toolCallId: high, inputTextDelta: `{"${high}":"${low}"}` },
            { type: 'tool-output-available', toolCallId: high, output: { [low]: high } },
          ],
          [
            { type: high, [low]: high },
            { type: 'start', messageId: low },
            { type: 'text-start', id: 'second' },
            { type: 'text-delta', id: 'second', delta: `${high}x${low}` },
            { type: 'text-end', id: 'second' },
          ],
        ]
        const all: StreamPart[] = []
        for (const [index, parts] of batches.entries()) {
          const chunk =
            index % 2 === 0
              ? await native.appendStreamParts(stream.id, parts)
              : await source.appendStreamParts(stream.id, parts)
          assert.deepEqual(chunk.parts, parts)
          comparisons++
          all.push(...parts)
          const expected = await source.readStream(stream.id)
          assert.deepEqual(await peer.readStream(stream.id), expected)
          comparisons++
          const rows =
            await sql`SELECT parts FROM stream_chunks WHERE stream=${stream.id} ORDER BY seq`
          assert.equal(typeof rows.at(-1)!.parts, 'string')
          assert.equal(rows.at(-1)!.parts, JSON.stringify(parts))
          comparisons += 2
        }
        const assembled = await assembleUIMessageDocument(all)
        assert.ok(
          assembled.document.length > 0,
          'The Unicode witness must assemble a nonempty SDK document',
        )
        const expected = streamArtifactInput(
          stream.id,
          scope,
          stream.label,
          'completed',
          assembled.document,
          batches.length,
          assembled.droppedPartCount,
        )
        const closed = await native.closeStream(stream.id, 'completed')
        assert.equal(closed.status, 'closed')
        assert.ok(closed.artifact)
        comparisons += 2
        const artifact = await source.getArtifact(
          scope.build,
          closed.artifact!.kind,
          closed.artifact!.revision,
        )
        assert.ok(artifact)
        assert.equal(new TextDecoder().decode(artifact!.content), expected.content)
        assert.deepEqual(artifact!.meta.metadata, expected.metadata)
        comparisons += 2
        assert.equal(
          artifact!.meta.blobRef,
          createHash('sha256').update(expected.content).digest('hex'),
        )
        comparisons++
        await servers[0]!.close()
        const restarted = await start()
        assert.deepEqual(await restarted.readStream(stream.id), await source.readStream(stream.id))
        comparisons++
        assert.deepEqual(await restarted.closeStream(stream.id, 'aborted'), closed)
        comparisons++
      } finally {
        for (const server of servers) await server.close()
        await source.close()
        await sql.close()
      }
    }),
  )
  return {
    comparisons,
    checks: [
      'mixed native/TypeScript UTF16 chunks survive encoded JSONB envelopes, independent processes and restart',
      'typed SDK text identities, delta concatenation, unknown-data keys, tool fragments and metadata produce exact close artifact bytes/hash',
      'stream label replacement occurs only at PostgreSQL TEXT and is reflected in returned records',
    ],
  }
}
