/**
 * The reference adapter run against the contract (SPEC §7): MemoryBuildStore's
 * behavior *is* the contract, so it must pass the same suites every other
 * adapter does. Plus the one hazard only this adapter can express directly:
 * appendWithArtifacts must stay atomic (D6, §8.5) under interleaved callers —
 * the remote server drives this store from concurrent HTTP requests.
 */
import { describe, expect, test } from 'bun:test'
import { EventValidationError } from '../events/catalog'
import { KERNEL } from '../events/envelope'
import {
  describeBlobStoreContract,
  describeBuildStoreContract,
  planCompletedWrite,
  sampleBuildInput,
} from './contract'
import { MemoryBlobStore, MemoryBuildStore } from './memory'
import { StreamClosedError } from './streams/types'
import { textContent, type BlobStore } from './types'

describeBuildStoreContract('MemoryBuildStore', async (opts) => ({
  store: new MemoryBuildStore({
    ...(opts?.clock ? { clock: opts.clock } : {}),
    ...(opts?.retention ? { retention: opts.retention } : {}),
  }),
}))

describeBlobStoreContract('MemoryBlobStore', async () => ({
  blobs: new MemoryBlobStore(),
}))

describe('MemoryBuildStore appendWithArtifacts under interleaving (D6, §8.5)', () => {
  test('a concurrent putArtifact inside a failing bundle leaves no orphan deposit', async () => {
    // A BlobStore whose put() can run a queued interloper first — the exact
    // suspension point where a concurrent HTTP request's write lands while
    // a bundle is in flight.
    const backing = new MemoryBlobStore()
    let interloper: (() => Promise<void>) | undefined
    const blobs: BlobStore = {
      put: async (hash, bytes) => {
        const run = interloper
        interloper = undefined
        if (run) await run()
        await backing.put(hash, bytes)
      },
      get: (hash) => backing.get(hash),
    }
    const store = new MemoryBuildStore({ blobs })
    await store.createBuild(sampleBuildInput('interleave'))

    // Fire on the bundle's SECOND blob write, after its `plan` deposit has
    // begun: request B deposits its own `plan` mid-bundle.
    let puts = 0
    const arm = () => {
      interloper = async () => {
        if (++puts < 2) {
          arm() // not yet — re-arm for the next blob write
          return
        }
        await store.putArtifact('interleave', { kind: 'plan', content: 'B plan' })
      }
    }
    arm()

    const err = await store
      .appendWithArtifacts(
        'interleave',
        [
          { kind: 'plan', content: 'A plan' },
          { kind: 'transcript', content: 'A transcript' },
        ],
        // kernel may not emit plan.completed (§15.3) → EventValidationError
        () => ({ ...planCompletedWrite(0), actor: KERNEL }),
      )
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(EventValidationError)

    // Only B's standalone deposit survives; A's failed bundle left nothing —
    // no orphan plan revision, no transcript, no event (D6).
    const plans = await store.listArtifacts('interleave', 'plan')
    expect(plans.map((m) => m.revision)).toEqual([0])
    expect(textContent((await store.getArtifact('interleave', 'plan'))!)).toBe('B plan')
    expect(await store.listArtifacts('interleave', 'transcript')).toEqual([])
    expect(await store.getEvents('interleave')).toEqual([])
  })
})

describe('MemoryBuildStore close/append interleaving (AUT-348)', () => {
  // A BlobStore whose first put() suspends on a gate — the exact suspension
  // point inside closeStream's prepare phase where the evidence places the
  // race. The gate fires before the close's blob write lands, and the test
  // decides when (or whether) the close resumes: forced ordering, no timing.
  function gatedBlobs() {
    const backing = new MemoryBlobStore()
    let signalEntered!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve
    })
    const gateOpen = new Promise<void>((resolve) => {
      release = resolve
    })
    let armed = true
    const blobs: BlobStore = {
      put: async (hash, bytes) => {
        if (armed) {
          armed = false
          signalEntered()
          await gateOpen
        }
        await backing.put(hash, bytes)
      },
      get: (hash) => backing.get(hash),
    }
    return { blobs, entered, release }
  }

  test('an append issued during a close waits for the commit and rejects with StreamClosedError', async () => {
    const { blobs, entered, release } = gatedBlobs()
    const store = new MemoryBuildStore({ blobs })
    await store.createBuild(sampleBuildInput('st-close-race'))
    const stream = await store.createStream({ kind: 'build', build: 'st-close-race' }, 'turn')
    await store.appendStreamParts(stream.id, [{ type: 'start', messageId: 'm' }])
    await store.appendStreamParts(stream.id, [{ type: 'text-start', id: 't' }])
    await store.appendStreamParts(stream.id, [{ type: 'text-delta', id: 't', delta: 'hello' }])

    const closing = store.closeStream(stream.id, 'completed')
    await entered // the close is suspended inside blobs.put — its prepare window
    const pending = store.appendStreamParts(stream.id, [
      { type: 'text-delta', id: 't', delta: 'late' },
    ])
    release()
    await closing
    const err = await pending.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StreamClosedError)

    // The late append persisted nothing: three chunks exist, all pre-close,
    // and the artifact's chunkCount/document cover only those.
    const read = await store.readStream(stream.id)
    expect(read.chunks).toHaveLength(3)
    const artifact = await store.getArtifact('st-close-race', `stream:${stream.id}`)
    expect(artifact?.meta.metadata).toMatchObject({ chunkCount: 3 })
    const document = JSON.parse(textContent(artifact!)) as Array<{
      parts: Array<{ type: string; text?: string; state?: string }>
    }>
    expect(document).toHaveLength(1)
    expect(document[0]?.parts.some((part) => part.type === 'text' && part.text === 'late')).toBe(
      false,
    )
    expect(document[0]?.parts).toContainEqual({ type: 'text', text: 'hello', state: 'streaming' })
  })

  test('a close held on stream A does not serialize an append on stream B', async () => {
    const { blobs, entered, release } = gatedBlobs()
    const store = new MemoryBuildStore({ blobs })
    await store.createBuild(sampleBuildInput('st-two-streams'))
    const a = await store.createStream({ kind: 'build', build: 'st-two-streams' }, 'a')
    const b = await store.createStream({ kind: 'build', build: 'st-two-streams' }, 'b')
    await store.appendStreamParts(a.id, [{ type: 'start', messageId: 'am' }])

    const closing = store.closeStream(a.id, 'completed')
    await entered // A's close holds its lock, suspended inside blobs.put
    const chunk = await store.appendStreamParts(b.id, [{ type: 'start', messageId: 'bm' }])
    expect(chunk.seq).toBe(1)
    release()
    const record = await closing
    expect(record.status).toBe('closed')
    expect((await store.readStream(b.id)).chunks).toHaveLength(1)
  })
})
