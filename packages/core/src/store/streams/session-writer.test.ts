/**
 * The session-stream batching writer: cadence and ordering, batch splitting
 * at the store ceiling, retry-then-defunct on persistent append failure,
 * truncation parts, and idempotent first-outcome-wins close. Real timers
 * with a short flush cadence.
 */
import { describe, expect, test } from 'bun:test'
import type { StreamChunk, StreamOutcome, StreamPart, StreamRecord, StreamScope } from './types'
import { STREAM_BATCH_MAX_BYTES } from './types'
import { createSessionStreamSink } from './session-writer'

interface FakeStore {
  chunks: Array<{ stream: string; parts: StreamPart[] }>
  failAppends: number
  closed: StreamOutcome[]
  createStream(scope: StreamScope, label: string): Promise<StreamRecord>
  appendStreamParts(streamId: string, parts: StreamPart[]): Promise<StreamChunk>
  closeStream(streamId: string, outcome: StreamOutcome): Promise<StreamRecord>
}

function fakeStore(over: Partial<FakeStore> = {}): FakeStore & { store: FakeStore } {
  const store: FakeStore = {
    chunks: [],
    failAppends: 0,
    closed: [],
    async createStream(_scope, label) {
      return {
        id: 'st_test',
        scope: { kind: 'build', build: 'b' },
        label,
        format: 'ai-ui-message-stream/v1',
        status: 'open',
        createdAt: 't',
      }
    },
    async appendStreamParts(streamId, parts) {
      if (store.failAppends > 0) {
        store.failAppends -= 1
        throw new Error('store down')
      }
      store.chunks.push({ stream: streamId, parts })
      return { stream: streamId, seq: store.chunks.length, ts: 't', parts }
    },
    async closeStream(_streamId, outcome) {
      store.closed.push(outcome)
      return {
        id: 'st_test',
        scope: { kind: 'build', build: 'b' },
        label: 'l',
        format: 'ai-ui-message-stream/v1',
        status: 'closed',
        createdAt: 't',
        closedAt: 't',
        outcome,
      }
    },
    ...over,
  }
  return { ...store, store }
}

function manualScheduler(): {
  schedule: (flush: () => void, ms: number) => () => void
  tick(): Promise<void>
} {
  let flush: (() => void) | undefined
  return {
    schedule(f) {
      flush = f
      return () => {
        flush = undefined
      }
    },
    async tick() {
      flush?.()
      // Let pending promise chains settle.
      await Bun.sleep(0)
      await Bun.sleep(0)
    },
  }
}

const SCOPE: StreamScope = { kind: 'build', build: 'b' }

describe('createSessionStreamSink', () => {
  test('buffers appends and flushes them in order on the cadence', async () => {
    const fake = fakeStore()
    const timer = manualScheduler()
    const sink = createSessionStreamSink({
      store: fake.store,
      scope: SCOPE,
      schedule: timer.schedule,
      flushMs: 1,
    })
    const id = await sink.open('session:s1')
    expect(id).toBe('st_test')
    sink.append([
      { type: 'start', messageId: 'm' },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'hello' },
      { type: 'text-delta', id: 't', delta: ' world' },
    ])
    expect(fake.chunks).toHaveLength(0)
    await timer.tick()
    expect(fake.chunks).toHaveLength(1)
    expect(fake.chunks[0]!.parts.map((p) => p.type)).toEqual([
      'start',
      'text-start',
      'text-delta',
      'text-delta',
    ])
    await sink.close('completed')
  })

  test('append never throws before open or after close', async () => {
    const fake = fakeStore()
    const timer = manualScheduler()
    const sink = createSessionStreamSink({
      store: fake.store,
      scope: SCOPE,
      schedule: timer.schedule,
    })
    expect(() => sink.append([{ type: 'start' }])).not.toThrow()
    await sink.open('session:s1')
    await sink.close('completed')
    expect(() => sink.append([{ type: 'start' }])).not.toThrow()
  })

  test('close flushes pending parts before closing', async () => {
    const fake = fakeStore()
    const timer = manualScheduler()
    const sink = createSessionStreamSink({
      store: fake.store,
      scope: SCOPE,
      schedule: timer.schedule,
    })
    await sink.open('session:s1')
    sink.append([{ type: 'start', messageId: 'm' }, { type: 'finish' }])
    await sink.close('completed')
    expect(fake.chunks).toHaveLength(1)
    expect(fake.closed).toEqual(['completed'])
  })

  test('close is idempotent with first outcome winning', async () => {
    const fake = fakeStore()
    const timer = manualScheduler()
    const sink = createSessionStreamSink({
      store: fake.store,
      scope: SCOPE,
      schedule: timer.schedule,
    })
    await sink.open('session:s1')
    await sink.close('completed')
    await sink.close('aborted')
    expect(fake.closed).toEqual(['completed'])
  })

  test('an append failure retries on the next tick and delivers the parts', async () => {
    const fake = fakeStore({ failAppends: 1 })
    const timer = manualScheduler()
    const sink = createSessionStreamSink({
      store: fake.store,
      scope: SCOPE,
      schedule: timer.schedule,
    })
    await sink.open('session:s1')
    sink.append([{ type: 'start', messageId: 'm' }])
    await timer.tick()
    expect(fake.chunks).toHaveLength(0)
    sink.append([{ type: 'finish' }])
    await timer.tick()
    expect(fake.chunks).toHaveLength(1)
    expect(fake.chunks[0]!.parts.map((p) => p.type)).toEqual(['start', 'finish'])
    await sink.close('completed')
    expect(fake.closed).toEqual(['completed'])
  })

  test('three consecutive failed flushes stop streaming, close aborted, and report once', async () => {
    const fake = fakeStore()
    fake.store.failAppends = Number.POSITIVE_INFINITY
    const timer = manualScheduler()
    const diagnostics: string[] = []
    const sink = createSessionStreamSink({
      store: fake.store,
      scope: SCOPE,
      schedule: timer.schedule,
      onDiagnostic: (message) => diagnostics.push(message),
    })
    await sink.open('session:s1')
    sink.append([{ type: 'start', messageId: 'm' }])
    await timer.tick()
    await timer.tick()
    await timer.tick()
    expect(fake.closed).toEqual(['aborted'])
    expect(diagnostics).toHaveLength(1)
    // Subsequent appends are inert and never throw.
    expect(() => sink.append([{ type: 'finish' }])).not.toThrow()
    await timer.tick()
    expect(fake.closed).toEqual(['aborted'])
  })

  test('truncates oversized text deltas with a data-ab-truncation part', async () => {
    const fake = fakeStore()
    const timer = manualScheduler()
    const sink = createSessionStreamSink({
      store: fake.store,
      scope: SCOPE,
      schedule: timer.schedule,
    })
    await sink.open('session:s1')
    const big = 'x'.repeat(70_000)
    sink.append([{ type: 'text-delta', id: 't', delta: big }])
    await sink.close('completed')
    const parts = fake.chunks.flatMap((c) => c.parts)
    expect(parts).toHaveLength(2)
    const delta = parts[0] as { type: string; delta: string }
    expect(delta.delta.length).toBeLessThan(big.length)
    // Multi-byte safe: the cut lands on a valid UTF-8 boundary.
    expect(new TextEncoder().encode(delta.delta).byteLength).toBeLessThanOrEqual(65_536)
    expect(parts[1]).toEqual({ type: 'data-ab-truncation', data: { omittedBytes: 4464 } })
  })

  test('truncation counts omitted bytes, not characters', async () => {
    const fake = fakeStore()
    const timer = manualScheduler()
    const sink = createSessionStreamSink({
      store: fake.store,
      scope: SCOPE,
      schedule: timer.schedule,
    })
    await sink.open('session:s1')
    // Each 'é' is two UTF-8 bytes.
    const big = 'é'.repeat(40_000)
    sink.append([{ type: 'text-delta', id: 't', delta: big }])
    await sink.close('completed')
    const parts = fake.chunks.flatMap((c) => c.parts)
    const truncation = parts.at(-1) as { type: string; data: { omittedBytes: number } }
    expect(truncation.type).toBe('data-ab-truncation')
    expect(truncation.data.omittedBytes).toBe(80_000 - 65_536)
  })

  test('tool payload truncation keeps the payload kind (objects stay objects)', async () => {
    const fake = fakeStore()
    const timer = manualScheduler()
    const sink = createSessionStreamSink({
      store: fake.store,
      scope: SCOPE,
      schedule: timer.schedule,
    })
    await sink.open('session:s1')
    // Object input: JSON serialization is {"blob":"…"} = 70_011 bytes.
    sink.append([
      {
        type: 'tool-input-available',
        toolCallId: 't1',
        toolName: 'shell',
        input: { blob: 'x'.repeat(70_000) },
      },
    ])
    // String output truncates as a string.
    sink.append([{ type: 'tool-output-available', toolCallId: 't1', output: 'y'.repeat(70_000) }])
    await sink.close('completed')
    const parts = fake.chunks.flatMap((c) => c.parts)
    expect(parts).toHaveLength(4)
    const input = parts[0] as { type: string; input: unknown }
    expect(input.type).toBe('tool-input-available')
    expect(typeof input.input).toBe('object')
    const truncated = (input.input as { truncated: string }).truncated
    expect(new TextEncoder().encode(truncated).byteLength).toBeLessThanOrEqual(65_536)
    expect(parts[1]).toEqual({
      type: 'data-ab-truncation',
      data: { omittedBytes: 70_011 - 65_536 },
    })
    const output = parts[2] as { type: string; output: unknown }
    expect(output.type).toBe('tool-output-available')
    expect(typeof output.output).toBe('string')
    expect(parts[3]).toEqual({ type: 'data-ab-truncation', data: { omittedBytes: 4_464 } })
  })

  test('concurrent flush requests never overlap and close drains what lands mid-flush', async () => {
    let inAppends = 0
    let maxConcurrent = 0
    const delivered: string[] = []
    const fake = fakeStore()
    const realAppend = fake.store.appendStreamParts.bind(fake.store)
    const realClose = fake.store.closeStream.bind(fake.store)
    fake.store.appendStreamParts = async (streamId, parts) => {
      inAppends += 1
      maxConcurrent = Math.max(maxConcurrent, inAppends)
      await Bun.sleep(2)
      inAppends -= 1
      delivered.push(...parts.map((p) => p.type))
      return realAppend(streamId, parts)
    }
    fake.store.closeStream = async (streamId, outcome) => {
      delivered.push('CLOSED')
      return realClose(streamId, outcome)
    }
    const timer = manualScheduler()
    const sink = createSessionStreamSink({
      store: fake.store,
      scope: SCOPE,
      schedule: timer.schedule,
      flushMs: 1,
    })
    await sink.open('session:s1')
    sink.append([
      { type: 'start', messageId: 'm' },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'a' },
    ])
    const draining = timer.tick()
    // Parts appended while the first drain is still in flight.
    sink.append([
      { type: 'text-delta', id: 't', delta: 'b' },
      { type: 'text-end', id: 't' },
    ])
    await draining
    await sink.close('completed')
    // Single-flight: appends never overlapped, order is the append order,
    // and everything landed before the stream closed.
    expect(maxConcurrent).toBe(1)
    expect(delivered).toEqual([
      'start',
      'text-start',
      'text-delta',
      'text-delta',
      'text-end',
      'CLOSED',
    ])
    expect(fake.closed).toEqual(['completed'])
  })

  test('splits batches that would exceed the store ceiling', async () => {
    const fake = fakeStore()
    const timer = manualScheduler()
    const sink = createSessionStreamSink({
      store: fake.store,
      scope: SCOPE,
      schedule: timer.schedule,
    })
    await sink.open('session:s1')
    // Each delta truncates to ~64 KiB, so ~16 parts fill a 1 MiB batch; 30
    // appends (60 bounded parts) must split.
    for (let i = 0; i < 30; i++) {
      sink.append([{ type: 'text-delta', id: 't', delta: 'y'.repeat(200_000) }])
    }
    await sink.close('completed')
    expect(fake.chunks.length).toBeGreaterThan(1)
    for (const chunk of fake.chunks) {
      expect(JSON.stringify(chunk.parts).length).toBeLessThanOrEqual(STREAM_BATCH_MAX_BYTES)
    }
    const total = fake.chunks.reduce((sum, c) => sum + c.parts.length, 0)
    expect(total).toBe(60)
  })

  test('an open failure propagates to the caller (the runner declines streaming)', async () => {
    const fake = fakeStore()
    fake.store.createStream = async () => {
      throw new Error('store down')
    }
    const timer = manualScheduler()
    const sink = createSessionStreamSink({
      store: fake.store,
      scope: SCOPE,
      schedule: timer.schedule,
    })
    await expect(sink.open('session:s1')).rejects.toThrow('store down')
    expect(() => sink.append([{ type: 'start' }])).not.toThrow()
    await sink.close('completed')
    expect(fake.closed).toHaveLength(0)
  })
})
