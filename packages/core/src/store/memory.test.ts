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
import { textContent, type BlobStore } from './types'

describeBuildStoreContract('MemoryBuildStore', async (opts) => ({
  store: new MemoryBuildStore(opts?.clock ? { clock: opts.clock } : {}),
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
