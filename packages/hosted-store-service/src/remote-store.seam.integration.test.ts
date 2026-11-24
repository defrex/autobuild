/**
 * The seam test the remote store exists for (SPEC §7.2 adapter 2): the full
 * BuildStore contract runs against RemoteBuildStore → real HTTP →
 * MemoryBuildStore in the hosted token posture, plus the properties that only
 * exist over a socket — held reads, their clamps and prompt teardown, and the
 * hosted frontend read budget. Request/response shape over the same handler
 * is pinned in memory by remote-store-server.test.ts.
 */
import { describe, expect, test } from 'bun:test'
import {
  AUTOBUILD_VERSION,
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
  RemoteBuildStore,
  mintToken,
} from '@defrex/autobuild/remote-store'
import { humanActor } from '@defrex/autobuild/testing'
import {
  describeBuildStoreContract,
  MemoryBuildStore,
  sampleBuildInput,
  sampleEventWrite,
} from '@defrex/autobuild/plugin-sdk'
import { startStoreServer } from './remote-store-server'

// ── The contract, over the wire ──────────────────────────────────────────────
//
// The server authorizes with a via-less admin token — the hosted harness's
// posture (SPEC §15.1), and the only one production runs. `viaAuthority: {}`
// tells the via contract that delegated writes reject with 403 AuthError
// before catalog validation, so the pinned 403 branch runs in every run, not
// only in the self-skipping live suite. The via-absent catalog branch is the
// local-adapter posture, covered by the MemoryBuildStore and SqliteBuildStore
// contract runs in core. The clock goes to the BACKING store so the suite's
// store-assigned-ts and lease-expiry assertions hold; the token's exp is
// checked against the server's system clock, so it is minted far in the real
// future.
describeBuildStoreContract('remote (HTTP → MemoryBuildStore, via-less token)', async (opts) => {
  const backing = new MemoryBuildStore({
    ...(opts?.clock ? { clock: opts.clock } : {}),
    ...(opts?.retention ? { retention: opts.retention } : {}),
  })
  const secret = 'contract-secret'
  const server = startStoreServer({ store: backing, secret })
  const store = new RemoteBuildStore({
    url: server.url,
    token: mintToken(secret, {
      version: 1,
      ownerAdmin: { user: 'owner' },
      exp: Date.now() + 100 * 365 * 24 * 60 * 60 * 1000,
    }),
  })
  return { store, viaAuthority: {}, cleanup: server.stop }
})

// ── The event-read bounded wait over the wire (AUT-334) ────────────────

describe('event wait over the wire', () => {
  const headers = {
    [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
    [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
  }

  test('a wait above the ceiling clamps on build and session events; each hold still answers an append promptly', async () => {
    const server = startStoreServer({ store: new MemoryBuildStore() })
    try {
      const client = new RemoteBuildStore({ url: server.url })
      await client.createBuild(sampleBuildInput('wait-clamp'))
      await client.ensureRepo('acme/wait-clamp')
      const session = await client.createSession({ repo: 'acme/wait-clamp', operator: 'op' })
      const pendingEvents = client.getEvents('wait-clamp', 0, { waitSeconds: 61 })
      // since=1: the session's own creation event is the backlog; the held
      // window must start AFTER it or the read answers immediately.
      const pendingSession = client.getSessionEvents(session.id, 1, { waitSeconds: 61 })
      await Bun.sleep(100)
      const event = await client.append('wait-clamp', sampleEventWrite('wake'))
      const envelope = await client.appendSessionEvent(session.id, {
        actor: humanActor('op'),
        type: 'message.posted',
        payload: { text: 'wake' },
      })
      const started = Date.now()
      expect(await pendingEvents).toEqual([event])
      expect(await pendingSession).toEqual([envelope])
      // The clamp never stretched either hold to 30 or 61 seconds.
      expect(Date.now() - started).toBeLessThan(5_000)
    } finally {
      await server.stop()
    }
  })

  test('auth failures are answered immediately, never held', async () => {
    const server = startStoreServer({ store: new MemoryBuildStore(), secret: 'wait-secret' })
    try {
      const started = Date.now()
      const response = await fetch(`${server.url}/builds/whatever/events?since=0&wait=25`, {
        headers: { ...headers, authorization: 'Bearer nope' },
      })
      expect(response.status).toBe(401)
      expect(Date.now() - started).toBeLessThan(500)
    } finally {
      await server.stop()
    }
  })

  test('a server answering immediately regardless of wait still pages every event exactly once, in order', async () => {
    // An ignoring server: reads discard the wait option entirely.
    const backing = new MemoryBuildStore()
    const ignoring: MemoryBuildStore = new Proxy(backing, {
      get(target, prop) {
        if (prop === 'getBuildEventPage') {
          return async (slug: string, sinceSeq?: number) =>
            (target as MemoryBuildStore).getBuildEventPage(slug, sinceSeq)
        }
        const value = Reflect.get(target, prop, target) as unknown
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value
      },
    })
    const server = startStoreServer({ store: ignoring })
    try {
      const client = new RemoteBuildStore({ url: server.url })
      await client.createBuild(sampleBuildInput('wait-ignoring'))
      for (const n of [1, 2, 3]) await client.append('wait-ignoring', sampleEventWrite(String(n)))
      // The client sends wait on every subscribe read; the ignoring server's
      // immediate empty answers must not lose or duplicate anything.
      const received: number[] = []
      const unsubscribe = client.subscribe('wait-ignoring', { pollMs: 10 }, (event) =>
        received.push(event.seq),
      )
      await Bun.sleep(150)
      await client.append('wait-ignoring', sampleEventWrite('four'))
      await Bun.sleep(150)
      unsubscribe()
      expect(received).toEqual([1, 2, 3, 4])
    } finally {
      await server.stop()
    }
  })

  test('plain subscribe defaults to the bounded wait: one held request per wait window', async () => {
    const server = startStoreServer({ store: new MemoryBuildStore() })
    try {
      let eventReads = 0
      const countingFetch = (async (input, init) => {
        if (typeof input === 'string' && input.includes('/events?')) eventReads += 1
        return fetch(input, init)
      }) as typeof fetch
      const client = new RemoteBuildStore({
        url: server.url,
        fetchFn: countingFetch,
      })
      await client.createBuild(sampleBuildInput('wait-subscribe'))
      // No waitSeconds: the default bounded window applies. With pollMs 10
      // an interval loop would fire dozens of reads during the hold; the
      // held request stays in flight, so the quiet window costs exactly one.
      const received: number[] = []
      const unsubscribe = client.subscribe('wait-subscribe', { pollMs: 10 }, (event) =>
        received.push(event.seq),
      )
      await Bun.sleep(400)
      expect(eventReads).toBe(1)
      const event = await client.append('wait-subscribe', sampleEventWrite('wake'))
      // The memory-backed server polls held event reads at the one-second
      // EVENT_WAIT_POLL_MS budget (AUT-383), so allow a full poll interval
      // plus round-trip slack for the append to be observed.
      await Bun.sleep(1500)
      unsubscribe()
      expect(received).toEqual([event.seq])
      // The held request resolved on the append and the next one began.
      expect(eventReads).toBe(2)
    } finally {
      await server.stop()
    }
  })
})

// ── The stream-read wait grammar over the wire (AUT-384) ────────────────
// §9's digits-only grammar is server-wide: the stream chunks GET parses
// `wait` with the same digitsParam the event routes use (clamped to the
// 30-second stream ceiling, not the hosted event ceiling), so the protocol
// document and the code agree.

describe('stream wait over the wire', () => {
  test('digit wait values keep the stream read semantics: immediate answers and the 30-second clamp', async () => {
    const server = startStoreServer({ store: new MemoryBuildStore() })
    try {
      const client = new RemoteBuildStore({ url: server.url })
      await client.createBuild(sampleBuildInput('stream-wait-happy'))
      const stream = await client.createStream({ kind: 'build', build: 'stream-wait-happy' }, 'h')
      await client.appendStreamParts(stream.id, [{ type: 'text-delta', id: 't', delta: 'x' }])

      // wait=5 with a chunk already present answers 200 immediately.
      const started = Date.now()
      const read = await client.readStream(stream.id, { since: 0, waitSeconds: 5 })
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(read.chunks).toHaveLength(1)
      expect(read.status).toBe('open')

      // wait=61 clamps to the 30-second stream ceiling (not the hosted
      // event ceiling) and the immediate-return path is unchanged.
      const clamped = await client.readStream(stream.id, { since: 0, waitSeconds: 61 })
      expect(clamped.chunks).toHaveLength(1)
      expect(clamped.status).toBe('open')

      // wait=0 on an open, chunk-less read answers immediately, empty.
      const immediate = await client.readStream(stream.id, { since: 1, waitSeconds: 0 })
      expect(immediate.chunks).toHaveLength(0)
      expect(immediate.status).toBe('open')
    } finally {
      await server.stop()
    }
  })
})

// ── Prompt teardown of held reads (AUT-375) ─────────────────────────────
// Client-side: stop/abort must cancel an in-flight held request (the signal
// reaches the underlying fetch), not wait out the server's hold bound.
// Server-side: the withDisconnect guard on the session-event route and held
// stream reads lets server.stop(true) complete promptly when a client goes
// away mid-hold — and (AUT-380) the disconnect signal also reaches the
// backing store's poll loop, so the polls themselves cease.

import { readStreamWithWait } from '@defrex/autobuild/plugin-sdk'
import { readEventsWithWait } from '@defrex/autobuild/testing'
import type { SessionEvent } from '@defrex/autobuild/remote-store'
import type { StreamRead } from '@defrex/autobuild/plugin-sdk'

/**
 * A MemoryBuildStore whose held-read polls are observable. One held HTTP
 * request makes exactly one backing `getSessionEvents`/`readStream` call —
 * the polling the spec wants to stop happens inside that call's wait loop —
 * so a counter must observe sub-call polls, not held-read invocations.
 * The overrides run the real wait helpers (the same ones the adapters
 * delegate to) with a counting `read` closure that delegates to the
 * immediate, non-waiting form, and forward the full opts — including the
 * signal the server passes — into the loop.
 */
class CountingMemoryStore extends MemoryBuildStore {
  sessionPolls = 0
  streamPolls = 0

  override async getSessionEvents(
    id: string,
    sinceSeq?: number,
    opts?: { waitSeconds?: number; signal?: AbortSignal },
  ): Promise<SessionEvent[]> {
    return readEventsWithWait({
      read: async () => {
        this.sessionPolls++
        return super.getSessionEvents(id, sinceSeq)
      },
      waitSeconds: opts?.waitSeconds,
      signal: opts?.signal,
    })
  }

  override async readStream(
    streamId: string,
    opts?: { since?: number; waitSeconds?: number; signal?: AbortSignal },
  ): Promise<StreamRead> {
    return readStreamWithWait({
      read: async () => {
        this.streamPolls++
        return super.readStream(streamId, { since: opts?.since })
      },
      waitSeconds: opts?.waitSeconds,
      signal: opts?.signal,
    })
  }
}

/**
 * Wait for a poll counter to settle after the disconnect that was supposed to
 * stop it: sample every 150 ms until two consecutive samples agree, and
 * return that settled count. The caller asserts the count stays frozen at the
 * returned value across further windows. The settle-then-freeze shape (not a
 * tolerance against the pre-abort sample) is what survives load: the abort
 * reaches the backing loop only once the server notices the closed socket —
 * promptly on an idle loop, but with a lag under full-suite load that no
 * fixed +1 bound can cover, while a genuinely continuing 25 ms loop adds ~6
 * polls per 150 ms window and can neither settle nor stay frozen.
 */
async function settlePolls(count: () => number, deadlineMs = 2_000): Promise<number> {
  const deadline = Date.now() + deadlineMs
  let prev = count()
  while (Date.now() < deadline) {
    await Bun.sleep(150)
    const now = count()
    if (now === prev) return now
    prev = now
  }
  return prev
}

describe('prompt teardown of held reads', () => {
  const headers = {
    [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
    [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
  }

  test('subscribe unsubscribe aborts a real held fetch promptly', async () => {
    const server = startStoreServer({ store: new MemoryBuildStore() })
    try {
      const inFlight = new Set<Promise<unknown>>()
      const fetchFn = (async (input, init) => {
        const pending = fetch(input, init)
        if (typeof input === 'string' && input.includes('/events?')) inFlight.add(pending)
        try {
          return await pending
        } finally {
          inFlight.delete(pending)
        }
      }) as typeof fetch
      const client = new RemoteBuildStore({ url: server.url, fetchFn })
      await client.createBuild(sampleBuildInput('teardown-sub'))
      const unsubscribe = client.subscribe('teardown-sub', { pollMs: 10_000 }, () => {})
      let held: Promise<unknown> | undefined
      while (held === undefined) {
        await Bun.sleep(10)
        held = [...inFlight][0]
      }
      const started = Date.now()
      unsubscribe()
      const rejection = await (held as Promise<Response>).then(
        () => null,
        (error) => error,
      )
      // The held request was torn down, not served: it rejected with an
      // abort, well inside the 25 s hold bound.
      expect(rejection).not.toBeNull()
      expect((rejection as Error).name).toBe('AbortError')
      expect(Date.now() - started).toBeLessThan(5_000)
    } finally {
      await server.stop()
    }
  })

  test('getEvents forwards the caller signal to fetch, non-aborted at call time', async () => {
    const server = startStoreServer({ store: new MemoryBuildStore() })
    try {
      const seeder = new RemoteBuildStore({ url: server.url })
      await seeder.createBuild(sampleBuildInput('teardown-signal'))

      const seen: AbortSignal[] = []
      // A fetch that answers only when the signal it received aborts: if
      // the signal never reaches the wire, the read hangs until the test
      // times out instead of rejecting promptly on abort.
      const fetchFn = (async (_input, init) => {
        const signal = init?.signal as AbortSignal | undefined
        if (signal === undefined) return new Promise<Response>(() => {})
        seen.push(signal)
        return new Promise<Response>((_, reject) => {
          if (signal.aborted) {
            reject(signal.reason)
            return
          }
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }) as typeof fetch
      const client = new RemoteBuildStore({ url: server.url, fetchFn })

      const controller = new AbortController()
      const pending = client.getEvents('teardown-signal', 0, {
        waitSeconds: 25,
        signal: controller.signal,
      })
      await Bun.sleep(50)
      expect(seen.length).toBe(1)
      expect(seen[0]!.aborted).toBe(false)
      const started = Date.now()
      controller.abort()
      const rejection = await pending.catch((error) => error)
      expect(rejection).not.toBeNull()
      expect(Date.now() - started).toBeLessThan(1_000)
    } finally {
      await server.stop()
    }
  })

  test('a disconnected session-event hold no longer stalls server.stop(true)', async () => {
    const server = startStoreServer({ store: new MemoryBuildStore() })
    try {
      const client = new RemoteBuildStore({ url: server.url })
      await client.createBuild(sampleBuildInput('teardown-session'))
      await client.ensureRepo('acme/teardown')
      const session = await client.createSession({ repo: 'acme/teardown', operator: 'op' })

      const controller = new AbortController()
      // The catch is attached at creation: the abort rejection lands before
      // the assertion below and must never surface as an unhandled error.
      // since=1: the session's own creation event is backlog; the hold must
      // establish past it or there is nothing held to disconnect from.
      const held = fetch(`${server.url}/sessions/${session.id}/events?since=1&wait=25`, {
        headers,
        signal: controller.signal,
      }).catch(() => undefined)
      await Bun.sleep(100)
      // The peer goes away mid-hold.
      controller.abort()

      const started = Date.now()
      await server.stop()
      // Without the guard the handler promise stays pending and stop hangs
      // past the 5 s margin, out to the 25 s hold bound.
      expect(Date.now() - started).toBeLessThan(5_000)
      await held
    } finally {
      await server.stop()
    }
  })

  test('a disconnected held stream read no longer stalls server.stop(true)', async () => {
    const server = startStoreServer({ store: new MemoryBuildStore() })
    try {
      const client = new RemoteBuildStore({ url: server.url })
      await client.createBuild(sampleBuildInput('teardown-stream'))
      const stream = await client.createStream({ kind: 'build', build: 'teardown-stream' }, 's')

      const controller = new AbortController()
      const held = fetch(`${server.url}/streams/${stream.id}/chunks?since=0&wait=25`, {
        headers,
        signal: controller.signal,
      }).catch(() => undefined)
      await Bun.sleep(100)
      controller.abort()

      const started = Date.now()
      await server.stop()
      expect(Date.now() - started).toBeLessThan(5_000)
      await held
    } finally {
      await server.stop()
    }
  })

  test("a disconnected peer's backing session polls cease, not just the handler promise (AUT-380)", async () => {
    const backing = new CountingMemoryStore()
    const server = startStoreServer({ store: backing })
    try {
      const client = new RemoteBuildStore({ url: server.url })
      await client.ensureRepo('acme/teardown-polls')
      const session = await client.createSession({ repo: 'acme/teardown-polls', operator: 'op' })

      const controller = new AbortController()
      const held = fetch(`${server.url}/sessions/${session.id}/events?since=1&wait=25`, {
        headers,
        signal: controller.signal,
      }).catch(() => undefined)
      await Bun.sleep(100)
      // The hold is genuinely polling.
      expect(backing.sessionPolls).toBeGreaterThan(0)
      const pollsAtAbort = backing.sessionPolls
      // The peer goes away mid-hold.
      controller.abort()

      // Prompt-teardown bound (AUT-416): the abort must reach the backing
      // loop well before the 2 s settle deadline. Allow one poll already in
      // flight at sample time (the AUT-389 structural +1) plus five slow
      // scheduler ticks (~125 ms) of socket-close detection headroom — the
      // lag that outran the original exact-equality and +1 forms. A
      // lingering 25 ms loop adds ~12 polls during the 300 ms grace window
      // (40 polls/s), far past this bound, so it fails here ~300 ms after
      // the abort; legit teardown that only settles later is still covered
      // by the settle-then-freeze tail below.
      await Bun.sleep(300)
      expect(backing.sessionPolls).toBeLessThanOrEqual(pollsAtAbort + 6)

      // The count must settle after the disconnect and then stay frozen: on
      // unfixed code it keeps growing through every window (a 25 ms poll
      // adds ~6 per 150 ms window), so settling never returns a count that
      // survives the two frozen windows below. The exact-equality-against-
      // the-pre-abort-sample form of this assertion flaked under a full-suite
      // verify run — the socket-close detection lagged the sample past a
      // tick — which is why the count is settled first (see settlePolls).
      // This settle-then-freeze tail alone pinned prompt teardown only up to
      // its 2 s deadline; the prompt cap above now bounds lingering loops at
      // ~300 ms. The stream twin below now carries the same prompt cap and
      // grace window (AUT-393).
      const settled = await settlePolls(() => backing.sessionPolls)
      await Bun.sleep(150)
      expect(backing.sessionPolls).toBe(settled)
      await Bun.sleep(150)
      expect(backing.sessionPolls).toBe(settled)
      await held
    } finally {
      await server.stop()
    }
  })

  test("a disconnected peer's backing stream polls cease, not just the handler promise (AUT-380)", async () => {
    const backing = new CountingMemoryStore()
    const server = startStoreServer({ store: backing })
    try {
      const client = new RemoteBuildStore({ url: server.url })
      await client.createBuild(sampleBuildInput('teardown-stream-polls'))
      const stream = await client.createStream(
        { kind: 'build', build: 'teardown-stream-polls' },
        's',
      )

      const controller = new AbortController()
      const held = fetch(`${server.url}/streams/${stream.id}/chunks?since=0&wait=25`, {
        headers,
        signal: controller.signal,
      }).catch(() => undefined)
      await Bun.sleep(100)
      expect(backing.streamPolls).toBeGreaterThan(0)
      const pollsAtAbort = backing.streamPolls
      // The peer goes away mid-hold.
      controller.abort()

      // Prompt-teardown bound (AUT-416 shape, carried over per AUT-393): the
      // abort must reach the backing loop well before the 2 s settle deadline.
      // The grace window and +6 headroom mirror the session twin's verbatim
      // because the two counted loops run at the same cadence here — the
      // CountingMemoryStore helpers pass no pollMs, so readEventsWithWait and
      // readStreamWithWait both default to STREAM_WAIT_POLL_MS (25 ms). Allow
      // one poll in flight at sample time plus five slow scheduler ticks of
      // socket-close detection headroom; a lingering 25 ms loop adds ~12 polls
      // in the 300 ms window (40 polls/s), far past this bound. Legit teardown
      // that only settles later is still covered by the settle-then-freeze
      // tail below.
      await Bun.sleep(300)
      expect(backing.streamPolls).toBeLessThanOrEqual(pollsAtAbort + 6)

      // Same guarantee, same shape as the session twin above: the count must
      // settle after the disconnect and then stay frozen. The prompt cap above
      // now bounds lingering loops at ~300 ms; this tail proves they stay
      // stopped. The settle-then-freeze form is kept (rather than an exact-
      // equality-against-the-pre-abort-sample assertion) for the same load
      // robustness reason recorded on the session twin: the socket-close
      // detection can lag the sample past a tick under a full-suite run
      // (see settlePolls).
      const settled = await settlePolls(() => backing.streamPolls)
      await Bun.sleep(150)
      expect(backing.streamPolls).toBe(settled)
      await Bun.sleep(150)
      expect(backing.streamPolls).toBe(settled)
      await held
    } finally {
      await server.stop()
    }
  })
})

// Building the 100,000-event fixture and exercising real HTTP can exceed the
// default five-second limit; the harness asserts read costs independently.
test('hosted frontend read budget stays flat across thousands of journal events', async () => {
  const { dispatchReadBudget } = await import('@defrex/autobuild/testing')
  const backing = new MemoryBuildStore()
  const server = startStoreServer({ store: backing })
  try {
    const normalizedBodies: { bytes: number; status: number; written: boolean }[] = []
    const fetchFn = (async (input, init) => {
      const response = await fetch(input, init)
      if (init?.method === 'PUT' && typeof init.body === 'string') {
        const body = JSON.parse(init.body)
        if (body.state?.acc?.holder === 'old-0') {
          // Identities only: the legacy dashboard-event cache never crosses the wire.
          expect(body.state.acc.identities).toHaveLength(2)
          expect(body.state.acc.retained).toBeUndefined()
          expect(body.state.catalogIdentity).toBeString()
          normalizedBodies.push({
            bytes: Buffer.byteLength(init.body),
            status: response.status,
            written: (await response.clone().json()).written,
          })
        }
      }
      return response
    }) as typeof fetch
    await dispatchReadBudget(new RemoteBuildStore({ url: server.url, fetchFn }), backing)
    // One version-5 replacement per legacy history length, each the same size;
    // the second lands on the first's equal cursor and is refused.
    expect(normalizedBodies).toHaveLength(2)
    expect(normalizedBodies.map((body) => body.bytes)).toEqual([
      normalizedBodies[0]!.bytes,
      normalizedBodies[0]!.bytes,
    ])
    expect(normalizedBodies.map((body) => [body.status, body.written])).toEqual([
      [200, true],
      [200, false],
    ])
  } finally {
    server.stop()
  }
}, 15_000)
