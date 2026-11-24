/**
 * The reference adapter run against the contract (SPEC §7): MemoryBuildStore's
 * behavior is the contract, so it passes the same suites as other adapters.
 * Real held-event pacing remains here; atomicity and in-memory read budgets
 * run under the unit IO guard in memory.test.ts.
 */
import { describe, expect, test } from 'bun:test'
import {
  describeBlobStoreContract,
  describeBuildStoreContract,
  harvestStartedWrite,
  messagePostedWrite,
  sampleBuildInput,
  sampleEventWrite,
} from './contract'
import { MemoryBlobStore, MemoryBuildStore } from './memory'

describeBuildStoreContract('MemoryBuildStore', async (opts) => ({
  store: new MemoryBuildStore({
    ...(opts?.clock ? { clock: opts.clock } : {}),
    ...(opts?.retention ? { retention: opts.retention } : {}),
  }),
}))

describeBlobStoreContract('MemoryBlobStore', async () => ({
  blobs: new MemoryBlobStore(),
}))

describe('MemoryBuildStore held event pacing (AUT-383)', () => {
  // Every held event read — build, repository, and session — must poll at
  // the one-second event-wait budget, not the 25 ms STREAM_WAIT_POLL_MS
  // stream default: the writer appends at ~500 ms, so a 1 s poll first
  // observes it at ~1000 ms. The ≥ 900 ms lower bound fails a regression
  // to the stream default (which resolves at ~525 ms); the < 2 s upper
  // bound is the one-poll worst-case convention from the Postgres live
  // suite (1 s poll plus scheduler slack), not a hard delivery guarantee.
  // A scheduler pause can only inflate elapsed time, so the lower bound —
  // the regression guard — is pause-safe.
  test('a held build-event read observes an append within the one-poll worst-case budget, no faster (AUT-383)', async () => {
    const store = new MemoryBuildStore()
    await store.createBuild(sampleBuildInput('pacing'))

    const started = Date.now()
    const pending = store.getEvents('pacing', 0, { waitSeconds: 5 })
    await Bun.sleep(500)
    const event = await store.append('pacing', sampleEventWrite('cross'))
    expect(await pending).toEqual([event])
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test('a held repository-event read observes an append within the one-poll worst-case budget, no faster (AUT-383)', async () => {
    const store = new MemoryBuildStore()
    await store.ensureRepo('acme/pacing')

    const started = Date.now()
    const pending = store.getRepoEvents('acme/pacing', 0, { waitSeconds: 5 })
    await Bun.sleep(500)
    const event = await store.appendRepo('acme/pacing', harvestStartedWrite('h_x'))
    expect(await pending).toEqual([event])
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test('a held session-event read observes an append within the one-poll worst-case budget, no faster (AUT-383)', async () => {
    const store = new MemoryBuildStore()
    const session = await store.createSession({ repo: 'acme/pacing', operator: 'op' })
    // session.created (seq 1) auto-appends; warm the path once so the held
    // read starts from an established initial poll.
    expect((await store.getSessionEvents(session.id)).map((event) => event.seq)).toEqual([1])

    const started = Date.now()
    const pending = store.getSessionEvents(session.id, 1, { waitSeconds: 5 })
    await Bun.sleep(500)
    const event = await store.appendSessionEvent(session.id, messagePostedWrite('cross'))
    expect(await pending).toEqual([event])
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})
