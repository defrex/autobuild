/** Real TS writes and SELECT-only Rust dashboard reads, including independent stream suffixes. */
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withCaptureSeed } from './capture-seed'
import { buildNative, bridge } from './data-integration'

export async function dashboardIntegration() {
  await withCaptureSeed(async (env, evidence, store) => {
    const native = await buildNative(env)
    const runtime = await mkdtemp(join(tmpdir(), 'proa-dashboard-proof-'))
    const readers: Awaited<ReturnType<typeof bridge>>[] = []
    try {
      readers.push(
        await bridge(env, runtime, [native.reader]),
        await bridge(env, runtime, [native.reader]),
      )
      const { project, slug } = evidence.detail
      const read = async (index: number, command: Record<string, unknown>) => {
        const reply = await readers[index]!.request({ repo: project, id: slug, ...command })
        assert.equal(reply.error, undefined)
        return reply.value
      }
      const dashboard = await read(0, { op: 'dashboard' })
      assert(dashboard.rows.some((row: { slug: string }) => row.slug === 'root-node'))
      assert(
        dashboard.rows.some(
          (row: { slug: string; status: string }) =>
            row.slug === 'unreadable-neighbor' && row.status === 'unreadable',
        ),
      )
      const detail = await read(0, { op: 'detail' })
      assert(
        detail.artifacts.some(
          (a: { kind: string; text: string }) => a.kind === 'spec' && a.text.includes('<script>'),
        ),
      )
      assert.equal(detail.frames.length, 1)
      assert(
        detail.sessions.some((s: { text: { text: string } }) =>
          s.text.text?.includes('completed transcript'),
        ),
      )
      await read(0, { op: 'detail' })
      await read(0, { op: 'detail' })
      await read(1, { op: 'detail' })
      const before = await read(0, { op: 'counts' })
      const buildReads = before.filter((r: { scope: string }) => r.scope === `build:${slug}`)
      assert.deepEqual(
        buildReads.slice(-2).map((r: { rows: number }) => r.rows),
        [0, 0],
      )
      const stream = (await store.listStreams({ kind: 'build', build: slug })).find(
        (s) => s.label === 'session:detail-session',
      )!
      const streamReads = before.filter((r: { scope: string }) => r.scope === `stream:${stream.id}`)
      assert(streamReads.some((r: { after: number; rows: number }) => r.after > 0 && r.rows === 0))
      await store.append(slug, {
        actor: { kind: 'agent', role: 'implement', session: 'detail-session' },
        type: 'observation.recorded',
        payload: { id: 'proof-append', kind: 'followup', summary: 'New durable fact' },
      })
      await store.appendStreamParts(stream.id, [
        { type: 'text-delta', id: 'text', delta: ' Newly streamed suffix.' },
      ])
      for (let index = 0; index < 2; index++) {
        const updated = await read(index, { op: 'detail' })
        assert(
          updated.state.observations.some(
            (observation: { id: string }) => observation.id === 'proof-append',
          ),
        )
        assert(
          updated.sessions.some((s: { text: { text: string } }) =>
            s.text.text?.includes('Newly streamed suffix'),
          ),
        )
      }
      const events = (await store.getEvents(slug)).length
      await store.appendStreamParts(stream.id, [
        { type: 'text-end', id: 'text' },
        { type: 'finish' },
      ])
      await store.closeStream(stream.id, 'completed')
      assert.equal((await store.getEvents(slug)).length, events)
      const closed = await read(0, { op: 'detail' })
      const session = closed.sessions.find((s: { id: string }) => s.id === 'detail-session')
      assert.equal(session.streamStatus, 'closed')
      assert(session.text.text.includes('Newly streamed suffix'))
      await read(0, { op: 'detail' })
      const after = await read(0, { op: 'counts' })
      const blobs = after.filter((r: { scope: string }) => r.scope.startsWith('artifact:'))
      assert.equal(
        new Set(blobs.map((r: { scope: string }) => r.scope)).size,
        blobs.length,
        'old artifact bytes fetched again',
      )
      const forbidden = await readers[0]!.request({
        op: 'detail',
        repo: evidence.producers[0]!.project,
        id: slug,
      })
      assert.match(forbidden.error, /scope does not exist/)
      await read(0, { op: 'clear' })
      const restarted = await read(0, { op: 'detail' })
      assert.equal(
        restarted.sessions.find((s: { id: string }) => s.id === 'detail-session').text.text,
        session.text.text,
      )
      console.log(
        'Dashboard TS-write/Rust-read proof passed: project isolation, unreadable neighbor, artifacts, closed/live transcripts, idle suffixes, concurrent readers, stream-only closure, immutable blobs and reader restart',
      )
    } finally {
      await Promise.all(readers.map((reader) => reader.close()))
      await rm(runtime, { recursive: true, force: true })
    }
  })
}
if (import.meta.main) await dashboardIntegration()
