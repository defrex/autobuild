/**
 * The session view's live-read cycle (session-feed.ts) — pure with respect to
 * the store (an injected double), so the follow/close/fallback/fence
 * semantics are unit-testable without a terminal.
 */
import { describe, expect, test } from 'bun:test'
import type { UIMessage } from 'ai'
import type { StreamChunk, StreamRead } from '../../store/streams/types'
import {
  applySessionFeedUpdate,
  SessionStreamFeed,
  type PollableSessionView,
  type SessionFeedUpdate,
} from './session-feed'
import type { StreamPart } from '../../store/streams/types'

function sessionView(overrides: Partial<PollableSessionView> = {}): PollableSessionView {
  return {
    kind: 'session',
    slug: 'build-a',
    sessionId: 's1',
    stream: 'st_1',
    status: 'open',
    source: { kind: 'parts', parts: [], lastSeq: 0 },
    follow: true,
    scroll: 0,
    ...overrides,
  }
}

function chunk(seq: number, parts: StreamPart[]): StreamChunk {
  return { stream: 'st_1', seq, ts: '2026-09-15T00:00:00Z', parts }
}

/** Read script: each call shifts one canned read (or a thrown error). */
function scriptedStore(reads: Array<StreamRead | Error>, artifacts: Array<unknown | Error> = []) {
  const store = {
    async readStream(): Promise<StreamRead> {
      const next = reads.shift()
      if (next === undefined) throw new Error('no scripted read left')
      if (next instanceof Error) throw next
      return next
    },
    async getArtifact(): Promise<{ content: string } | null> {
      const next = artifacts.shift()
      if (next === undefined) throw new Error('no scripted artifact left')
      if (next instanceof Error) throw next
      return next as { content: string } | null
    },
  }
  return store
}

function emptyRead(status: 'open' | 'closed' = 'open'): StreamRead {
  return { chunks: [], status, ...(status === 'closed' ? { outcome: 'completed' as const } : {}) }
}

describe('SessionStreamFeed', () => {
  test('appended chunks advance lastSeq and accumulate parts append-only', async () => {
    const store = scriptedStore([
      { chunks: [chunk(1, [{ type: 'text-delta', id: 't', delta: 'hello' }])], status: 'open' },
    ])
    const feed = new SessionStreamFeed(store, 'build-a')
    const view = sessionView({
      source: { kind: 'parts', parts: [{ type: 'start', messageId: 'm' }], lastSeq: 0 },
    })
    const update = await feed.poll(view)
    expect(update).not.toBeUndefined()
    expect(update!.since).toBe(0)
    expect(update!.fields.source).toEqual({
      kind: 'parts',
      parts: [
        { type: 'start', messageId: 'm' },
        { type: 'text-delta', id: 't', delta: 'hello' },
      ],
      lastSeq: 1,
    })
    // The polled view's own parts array is untouched (append-only semantics).
    expect(view.source.kind === 'parts' && view.source.parts).toHaveLength(1)
  })

  test('a poll with no new chunks and no change returns undefined', async () => {
    const store = scriptedStore([emptyRead('open')])
    const feed = new SessionStreamFeed(store, 'build-a')
    const view = sessionView()
    expect(await feed.poll(view)).toBeUndefined()
  })

  test('close mid-poll switches status and outcome while preserving parts', async () => {
    const store = scriptedStore([
      {
        chunks: [chunk(2, [{ type: 'finish', finishReason: 'stop' }])],
        status: 'closed',
        outcome: 'completed',
      },
    ])
    const feed = new SessionStreamFeed(store, 'build-a')
    const view = sessionView({
      source: { kind: 'parts', parts: [{ type: 'start', messageId: 'm' }], lastSeq: 1 },
    })
    const update = await feed.poll(view)
    expect(update!.fields.status).toBe('closed')
    expect(update!.fields.outcome).toBe('completed')
    expect(update!.fields.source.kind === 'parts' && update!.fields.source.lastSeq).toBe(2)
  })

  test('the pruned-chunk fallback reads the deposited document artifact', async () => {
    const document: UIMessage[] = [
      { id: 'm', role: 'assistant', parts: [{ type: 'text', text: 'final' }] },
    ]
    const store = scriptedStore(
      [{ chunks: [], status: 'closed', outcome: 'completed' }],
      [{ content: JSON.stringify(document) }],
    )
    const feed = new SessionStreamFeed(store, 'build-a')
    const view = sessionView({ status: 'closed', source: { kind: 'parts', parts: [], lastSeq: 9 } })
    const update = await feed.poll(view)
    expect(update!.fields.source).toEqual({ kind: 'document', document })
    expect(update!.fields.status).toBe('closed')
    expect(update!.fields.outcome).toBe('completed')
  })

  test('a closed-session view opened to an empty log falls back to the artifact', async () => {
    const document: UIMessage[] = [{ id: 'm', role: 'assistant', parts: [] }]
    const store = scriptedStore(
      [{ chunks: [], status: 'closed', outcome: 'aborted' }],
      [{ content: JSON.stringify(document) }],
    )
    const feed = new SessionStreamFeed(store, 'build-a')
    const update = await feed.poll(sessionView({ status: 'closed', outcome: 'aborted' }))
    expect(update!.fields.source).toEqual({ kind: 'document', document })
    expect(update!.fields.outcome).toBe('aborted')
  })

  test('an unreadable artifact keeps the parts source and carries the error', async () => {
    const store = scriptedStore([{ chunks: [], status: 'closed', outcome: 'completed' }], [null])
    const feed = new SessionStreamFeed(store, 'build-a')
    const view = sessionView({ status: 'closed', source: { kind: 'parts', parts: [], lastSeq: 3 } })
    const update = await feed.poll(view)
    expect(update!.fields.source).toEqual({ kind: 'parts', parts: [], lastSeq: 3 })
    expect(update!.fields.error).toContain('not retrievable')
  })

  test('a failed read sets error and the next poll retries', async () => {
    const store = scriptedStore([
      new Error('store unreachable'),
      { chunks: [chunk(1, [{ type: 'text-delta', id: 't', delta: 'ok' }])], status: 'open' },
    ])
    const feed = new SessionStreamFeed(store, 'build-a')
    const failed = await feed.poll(sessionView())
    expect(failed!.fields.error).toBe('store unreachable')
    expect(failed!.fields.status).toBe('open')
    // Retry succeeds and clears the error.
    const recovered = await feed.poll(sessionView({ error: 'store unreachable' }))
    expect(recovered!.fields.error).toBeUndefined()
    expect(recovered!.fields.source.kind === 'parts' && recovered!.fields.source.lastSeq).toBe(1)
  })

  test('reads are immediate (waitSeconds: 0), never a long poll', async () => {
    const seen: Array<{ since?: number; waitSeconds?: number } | undefined> = []
    const store = {
      async readStream(_streamId: string, opts?: { since?: number; waitSeconds?: number }) {
        seen.push(opts)
        return emptyRead('open')
      },
      async getArtifact() {
        return null
      },
    }
    const feed = new SessionStreamFeed(store, 'build-a')
    await feed.poll(sessionView({ source: { kind: 'parts', parts: [], lastSeq: 4 } }))
    expect(seen[0]).toEqual({ since: 4, waitSeconds: 0 })
  })

  test('a document-source view without an error is final and never polled', async () => {
    let reads = 0
    const store = {
      async readStream() {
        reads += 1
        return emptyRead('open')
      },
      async getArtifact() {
        return null
      },
    }
    const feed = new SessionStreamFeed(store, 'build-a')
    const view = sessionView({
      source: { kind: 'document', document: [{ id: 'm', role: 'assistant' as const, parts: [] }] },
    })
    expect(await feed.poll(view)).toBeUndefined()
    expect(reads).toBe(0)
  })
})

describe('applySessionFeedUpdate (the apply fence)', () => {
  const update = (overrides: Partial<SessionFeedUpdate> = {}): SessionFeedUpdate => ({
    slug: 'build-a',
    sessionId: 's1',
    stream: 'st_1',
    since: 0,
    polledSource: 'parts',
    fields: {
      status: 'open',
      source: { kind: 'parts', parts: [{ type: 'start', messageId: 'm' }], lastSeq: 1 },
    },
    ...overrides,
  })

  test('applies to the exact matching session view at the same cursor', () => {
    const view = sessionView()
    const next = applySessionFeedUpdate(view, update())
    expect(next).not.toBeUndefined()
    expect(next!.source).toEqual({
      kind: 'parts',
      parts: [{ type: 'start', messageId: 'm' }],
      lastSeq: 1,
    })
    // follow/scroll survive the apply untouched.
    expect(next!.follow).toBe(true)
  })

  test('rejects a stale cursor (a newer apply already advanced the view)', () => {
    const view = sessionView({
      source: { kind: 'parts', parts: [], lastSeq: 5 },
    })
    expect(applySessionFeedUpdate(view, update({ since: 0 }))).toBeUndefined()
  })

  test('rejects a view that escaped to detail or switched sessions', () => {
    expect(applySessionFeedUpdate(undefined, update())).toBeUndefined()
    const otherSession = sessionView({ sessionId: 's2' })
    expect(applySessionFeedUpdate(otherSession, update())).toBeUndefined()
  })

  test('rejects an update whose polled source no longer matches the view', () => {
    const document: UIMessage[] = [{ id: 'm', role: 'assistant', parts: [] }]
    const documentView = sessionView({
      source: { kind: 'document', document },
      status: 'closed',
    })
    // A parts-poll update cannot land on a document-source view.
    expect(applySessionFeedUpdate(documentView, update())).toBeUndefined()
    // And a document-retry update cannot land on a parts view.
    const partsView = sessionView()
    expect(
      applySessionFeedUpdate(
        partsView,
        update({
          polledSource: 'document',
          fields: { status: 'closed', source: { kind: 'document', document } },
        }),
      ),
    ).toBeUndefined()
  })
})
