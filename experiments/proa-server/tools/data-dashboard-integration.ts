/** Real TS writes and SELECT-only Rust dashboard reads, including independent stream suffixes. */
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCreatedWrite } from '../../../packages/core/src/store/contract'
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
      // Match a mature project: 509 hidden builds and 5,090 stream records.
      // Actual TS writes, not fabricated Rust snapshots. Warm once, then prove
      // per-build reads and returned metadata do not grow with hidden history.
      for (let n = 0; n < 509; n++) {
        const historical = `history-${n}`
        const created = buildCreatedWrite()
        created.payload.repo = project
        await store.createBuild({ slug: historical, repo: project, created })
        await store.append(historical, {
          actor: { kind: 'dispatcher' },
          type: 'build.completed',
          payload: { outcome: 'discarded' },
        })
        for (let i = 0; i < 10; i++) {
          const stream = await store.createStream(
            { kind: 'build', build: historical },
            `session:old-${i}`,
          )
          await store.closeStream(stream.id, 'completed')
        }
      }
      await read(0, { op: 'dashboard' })
      await read(0, { op: 'reset-counts' })
      const idleStarted = performance.now()
      for (let i = 0; i < 3; i++) await read(0, { op: 'dashboard' })
      const idle = await read(0, { op: 'counts' })
      assert(
        !idle.some((r: { scope: string }) => r.scope.includes('history-')),
        'hidden history was read again',
      )
      assert.equal(
        idle.filter((r: { scope: string }) => r.scope === 'metadata:build-discovery').length,
        3,
      )
      assert(
        idle
          .filter((r: { scope: string }) => r.scope === 'metadata:build-discovery')
          .every((r: { rows: number }) => r.rows === 0),
      )
      assert(
        !idle.some((r: { scope: string }) => r.scope.includes('build-runner-effective-config')),
        'pinned metadata repeated on idle poll',
      )
      assert(
        idle
          .filter((r: { scope: string }) => r.scope === 'metadata:streams:detail-case')
          .every((r: { rows: number }) => r.rows === 0),
        'closed stream metadata replayed',
      )
      const idleMs = performance.now() - idleStarted
      await store.append(slug, {
        actor: { kind: 'agent', role: 'implement', session: 'detail-session' },
        type: 'observation.recorded',
        payload: { id: 'scale-live', kind: 'followup', summary: 'Scale live append' },
      })
      const scaleStarted = performance.now()
      await read(0, { op: 'dashboard' })
      const fresh = await read(0, { op: 'detail' })
      assert(fresh.state.observations.some((o: { id: string }) => o.id === 'scale-live'))
      assert(performance.now() - scaleStarted < 5000, 'mature project update exceeded five seconds')
      const liveMs = performance.now() - scaleStarted
      const newlyCreated = buildCreatedWrite()
      newlyCreated.payload.repo = project
      await store.createBuild({ slug: 'discovered-later', repo: project, created: newlyCreated })
      await store.append('root-node', {
        actor: { kind: 'dispatcher' },
        type: 'build.completed',
        payload: { outcome: 'discarded' },
      })
      const discovered = await read(0, { op: 'dashboard' })
      assert(
        discovered.rows.some((r: { slug: string }) => r.slug === 'discovered-later'),
        'new build was missed by delta discovery',
      )
      assert(
        discovered.rows.some(
          (r: { slug: string; status: string }) => r.slug === 'root-node' && r.status === 'done',
        ),
        'terminal ancestor of live node was lost',
      )
      console.log(
        `Mature-project proof: 509 hidden builds / 5090 streams; three idle polls ${idleMs.toFixed(0)}ms; live update ${liveMs.toFixed(0)}ms; metadata queries instrumented`,
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
