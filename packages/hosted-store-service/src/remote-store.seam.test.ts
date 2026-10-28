/**
 * The seam test the remote store exists for (SPEC §7.2 adapter 2): the full
 * BuildStore contract runs against RemoteBuildStore → in-process HTTP →
 * MemoryBuildStore, plus the properties that only exist over the wire —
 * D8 scoped tokens, D6 validation-as-feedback surviving serialization, and
 * atomic deposits via the placeholder-ref convention.
 */
import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import type { EventWrite } from '@defrex/autobuild/plugin-sdk'
import {
  EventValidationError,
  AUTOBUILD_VERSION,
  AUTOBUILD_VERSION_HEADER,
  RELEASE_LINE_PROTOCOLS,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
} from '@defrex/autobuild/remote-store'
import { agentActor, DISPATCHER, KERNEL, humanActor } from '@defrex/autobuild/testing'
import { textContent } from '@defrex/autobuild/testing'
import {
  CONTRACT_T0,
  describeBuildStoreContract,
  MemoryBuildStore,
  sampleBuildInput,
  sampleEventWrite,
  StreamBatchTooLargeError,
  StreamClosedError,
} from '@defrex/autobuild/plugin-sdk'
import { RemoteBuildStore } from '@defrex/autobuild/remote-store'
import { createStoreServer, startStoreServer } from './remote-store-server'
import { mintToken, verifyToken } from '@defrex/autobuild/remote-store'

function _noopTickCounters() {
  return {
    merged: 0,
    closed: 0,
    conflicted: 0,
    abandoned: 0,
    discarded: 0,
    janitorFailed: 0,
    recovered: 0,
    dispatchFailed: 0,
    resumed: 0,
    swept: 0,
    dispatched: 0,
    authored: 0,
    bounced: 0,
    claimRaces: 0,
    invalidTickets: 0,
    dependencyBlocked: 0,
    harvestStarted: 0,
    harvestResumed: 0,
    harvestCompleted: 0,
    harvestEscalated: 0,
    harvestFailed: 0,
  }
}

// ── The contract, over the wire ──────────────────────────────────────────────
//
// No secret (open server, local-dev mode); the clock goes to the BACKING
// store so the suite's store-assigned-ts and lease-expiry assertions hold.

describeBuildStoreContract('remote (HTTP → MemoryBuildStore)', async (opts) => {
  const backing = new MemoryBuildStore({
    ...(opts?.clock ? { clock: opts.clock } : {}),
    ...(opts?.retention ? { retention: opts.retention } : {}),
  })
  const server = startStoreServer({ store: backing })
  const store = new RemoteBuildStore({ url: server.url })
  return { store, cleanup: server.stop }
})

// The same wire, but the server authorizes with a via-less admin token — the
// hosted harness's posture (SPEC §15.1). `viaAuthority: {}` tells the via
// contract that delegated writes reject with 403 AuthError before catalog
// validation, so the pinned 403 branch runs in every unit run, not only in
// the self-skipping live suite. The clock stays on the backing store; the
// token's exp is checked against the server's system clock, so it is minted
// far in the real future.
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

// ── Tokens (D8) ──────────────────────────────────────────────────────────────

describe('scoped tokens (D8)', () => {
  const now = new Date(CONTRACT_T0)
  const later = Date.parse(CONTRACT_T0) + 60_000

  test('mint → verify round-trips the scope (build AND session, §8.1)', () => {
    const token = mintToken('secret', { build: 'build-a', session: 's_9f2', exp: later })
    expect(verifyToken('secret', token, now)).toEqual({
      build: 'build-a',
      session: 's_9f2',
      exp: later,
    })
  })

  test('a token minted with another secret → null', () => {
    const token = mintToken('other-secret', { build: 'build-a', session: 's_9f2', exp: later })
    expect(verifyToken('secret', token, now)).toBeNull()
  })

  test('expired (exp <= now) → null', () => {
    const atNow = mintToken('secret', { build: 'build-a', session: 's_9f2', exp: now.getTime() })
    expect(verifyToken('secret', atNow, now)).toBeNull()
    const past = mintToken('secret', {
      build: 'build-a',
      session: 's_9f2',
      exp: now.getTime() - 1,
    })
    expect(verifyToken('secret', past, now)).toBeNull()
  })

  test('a tampered payload fails the signature check', () => {
    const token = mintToken('secret', { build: 'build-a', session: 's_9f2', exp: later })
    const signature = token.split('.')[1]!
    const forged = Buffer.from(
      JSON.stringify({ build: 'build-b', session: 's_9f2', exp: later }),
      'utf8',
    ).toString('base64url')
    expect(verifyToken('secret', `${forged}.${signature}`, now)).toBeNull()
  })

  test('a well-signed scope missing the session dimension → null (D8: build AND session)', () => {
    const payload = Buffer.from(JSON.stringify({ build: 'build-a', exp: later }), 'utf8').toString(
      'base64url',
    )
    const signature = createHmac('sha256', 'secret').update(payload).digest('base64url')
    expect(verifyToken('secret', `${payload}.${signature}`, now)).toBeNull()
  })

  test('malformed tokens → null', () => {
    for (const bad of ['', 'nodot', 'a.b.c', '..', '!!.@@']) {
      expect(verifyToken('secret', bad, now)).toBeNull()
    }
    // A well-signed token over a non-scope payload → null too.
    const payload = Buffer.from('"just a string"', 'utf8').toString('base64url')
    const signature = createHmac('sha256', 'secret').update(payload).digest('base64url')
    expect(verifyToken('secret', `${payload}.${signature}`, now)).toBeNull()
  })
})

// ── D8 scope enforcement over the wire ───────────────────────────────────────

// Retired signed resource scopes are decoded above for compatibility diagnosis.
// Current authorization is exercised by the two-project matrix in machine-auth.test.ts.

interface OpenCtx {
  store: RemoteBuildStore
  backing: MemoryBuildStore
}

async function withOpenStore(run: (ctx: OpenCtx) => Promise<void>): Promise<void> {
  const backing = new MemoryBuildStore()
  const server = startStoreServer({ store: backing })
  const store = new RemoteBuildStore({ url: server.url })
  try {
    await run({ store, backing })
  } finally {
    await store.close()
    await server.stop()
  }
}

// ── Validation over the wire (D6) ────────────────────────────────────────────

describe('validation over the wire (D6)', () => {
  test('disallowed actor kind → EventValidationError with the server message; log unchanged', async () => {
    await withOpenStore(async ({ store }) => {
      await store.createBuild(sampleBuildInput('val-wire'))
      await store.append('val-wire', sampleEventWrite())
      const err = await store
        .append('val-wire', {
          actor: agentActor('code-review', 's_9f2'),
          type: 'pr.merged',
          payload: { sha: 'abc1234' },
        })
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(EventValidationError)
      expect((err as Error).message).toContain('actor kind "agent" may not emit "pr.merged"')
      expect((await store.getEvents('val-wire')).length).toBe(1)
    })
  })

  test('malformed payload → EventValidationError with the server message; log unchanged', async () => {
    await withOpenStore(async ({ store }) => {
      await store.createBuild(sampleBuildInput('val-payload'))
      await store.append('val-payload', sampleEventWrite())
      const malformed = {
        actor: DISPATCHER,
        type: 'build.created',
        payload: { repo: 'acme/rate-limiter' },
      } as unknown as EventWrite
      const err = await store.append('val-payload', malformed).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(EventValidationError)
      expect((err as Error).message).toContain('invalid payload for "build.created"')
      expect((await store.getEvents('val-payload')).length).toBe(1)
    })
  })
})

// ── Atomic deposits over the wire (D6, §8.5) ─────────────────────────────────

describe('atomic deposits over the wire (D6)', () => {
  test('success embeds the real revisions in the stored event payload (§8.7)', async () => {
    await withOpenStore(async ({ store, backing }) => {
      await store.createBuild(sampleBuildInput('deposit-ok'))
      const { event, artifacts } = await store.appendWithArtifacts(
        'deposit-ok',
        [{ kind: 'implement-notes', content: '# notes', metadata: { round: 1 } }],
        (deposited) => ({
          actor: agentActor('implement', 's_impl'),
          type: 'implement.completed',
          payload: {
            round: 1,
            commits: { base: 'base-sha', head: 'head-sha' },
            artifact: { kind: deposited[0]!.kind, rev: deposited[0]!.revision },
          },
        }),
      )
      expect(artifacts.map((m) => [m.kind, m.revision])).toEqual([['implement-notes', 0]])
      expect(event.type).toBe('implement.completed')
      expect(event.payload.artifact).toEqual({ kind: 'implement-notes', rev: 0 })

      // Server-side, the *stored* payload carries the real revision — the
      // negative placeholder never reaches the log.
      const [stored] = await backing.getEvents('deposit-ok')
      if (stored?.type !== 'implement.completed') throw new Error('unreachable')
      expect(stored.payload.artifact).toEqual({ kind: 'implement-notes', rev: 0 })
      const notes = await backing.getArtifact('deposit-ok', 'implement-notes')
      expect(textContent(notes!)).toBe('# notes')
      expect(notes?.meta.metadata).toEqual({ round: 1 })
    })
  })

  test('nested attachment refs replace the wire placeholder with the server-assigned revision', async () => {
    await withOpenStore(async ({ store, backing }) => {
      await store.createBuild(sampleBuildInput('attachment-ok'))
      await store.putArtifact('attachment-ok', {
        kind: 'visual:home',
        content: 'older',
      })
      const { event, artifacts } = await store.appendWithArtifacts(
        'attachment-ok',
        [{ kind: 'visual:home', content: new Uint8Array([1, 2, 3]) }],
        (deposited) => ({
          actor: agentActor('verify:visual', 's_visual'),
          type: 'pr-attachment.designated',
          payload: {
            artifact: {
              kind: deposited[0]!.kind,
              rev: deposited[0]!.revision,
            },
            filename: 'home.png',
            mediaType: 'image/png',
          },
        }),
      )

      expect(artifacts[0]?.revision).toBe(1)
      expect(event.type).toBe('pr-attachment.designated')
      expect(event.payload.artifact).toEqual({ kind: 'visual:home', rev: 1 })
      const stored = (await backing.getEvents('attachment-ok')).at(-1)
      expect(stored?.type).toBe('pr-attachment.designated')
      if (stored?.type !== 'pr-attachment.designated') throw new Error('unreachable')
      expect(stored.payload.artifact).toEqual({ kind: 'visual:home', rev: 1 })
    })
  })

  test('a payload failing event validation persists nothing server-side', async () => {
    await withOpenStore(async ({ store, backing }) => {
      await store.createBuild(sampleBuildInput('deposit-bad'))
      const err = await store
        .appendWithArtifacts(
          'deposit-bad',
          [{ kind: 'implement-notes', content: 'notes' }],
          // kernel may not emit implement.completed (§15.3) → rejected.
          (deposited) => ({
            actor: KERNEL,
            type: 'implement.completed',
            payload: {
              round: 1,
              commits: { base: 'b', head: 'h' },
              artifact: { kind: deposited[0]!.kind, rev: deposited[0]!.revision },
            },
          }),
        )
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(EventValidationError)
      expect((err as Error).message).toContain('may not emit')

      // Nothing persisted: no event, and the artifact deposit rolled back.
      expect(await backing.getEvents('deposit-bad')).toEqual([])
      expect(await backing.listArtifacts('deposit-bad')).toEqual([])
    })
  })
})

// ── Wire robustness ──────────────────────────────────────────────────────────

describe('wire robustness', () => {
  test('a new server over the same backing store continues the log (§7.4)', async () => {
    const backing = new MemoryBuildStore()
    const first = startStoreServer({ store: backing })
    const clientOne = new RemoteBuildStore({ url: first.url })
    await clientOne.createBuild(sampleBuildInput('robust'))
    await clientOne.append('robust', sampleEventWrite('before restart'))
    await first.stop()

    // The client takes a fixed URL by design; after a restart (here on a
    // new port), point a new client at the new URL — continuity lives in
    // the store, not the connection.
    const second = startStoreServer({ store: backing })
    const clientTwo = new RemoteBuildStore({ url: second.url })
    try {
      const envelope = await clientTwo.append('robust', sampleEventWrite('after restart'))
      expect(envelope.seq).toBe(2)
      expect((await clientTwo.getEvents('robust')).map((e) => e.seq)).toEqual([1, 2])
    } finally {
      await second.stop()
    }
  })

  test('getEvents?since= pages equivalently to the backing store', async () => {
    await withOpenStore(async ({ store, backing }) => {
      await store.createBuild(sampleBuildInput('paging'))
      await store.append('paging', sampleEventWrite('one'))
      await store.append('paging', sampleEventWrite('two'))
      await store.append('paging', sampleEventWrite('three'))

      for (const since of [0, 1, 2, 3]) {
        expect(await store.getEvents('paging', since)).toEqual(
          await backing.getEvents('paging', since),
        )
      }
      // Paged reads reassemble the full log.
      const all = await store.getEvents('paging')
      const paged = [
        ...(await store.getEvents('paging', 0)).slice(0, 1),
        ...(await store.getEvents('paging', 1)),
      ]
      expect(paged).toEqual(all)
    })
  })

  test('unknown routes → 404 {kind: "not-found"}', async () => {
    const server = startStoreServer({ store: new MemoryBuildStore() })
    try {
      const response = await fetch(`${server.url}/nope`)
      expect(response.status).toBe(404)
      expect(((await response.json()) as { kind: string }).kind).toBe('not-found')
    } finally {
      await server.stop()
    }
  })
})

// ── The event-read bounded wait over the wire (AUT-334) ────────────────

describe('event wait over the wire', () => {
  const headers = {
    [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
    [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
  }

  test('the digits-only grammar: non-digit wait values are 400 validation', async () => {
    const server = createStoreServer({ store: new MemoryBuildStore() })
    await server.fetch(
      new Request('https://store.test/builds', {
        method: 'POST',
        headers,
        body: JSON.stringify(sampleBuildInput('wait-grammar')),
      }),
    )
    for (const raw of ['abc', '0x10', '', ' 1', '1.5', '-1', '+1']) {
      const response = await server.fetch(
        new Request(
          `https://store.test/builds/wait-grammar/events?since=0&wait=${encodeURIComponent(raw)}`,
          { headers },
        ),
      )
      expect(response.status).toBe(400)
      expect(((await response.json()) as { kind: string }).kind).toBe('validation')
    }
    // The repository form shares the grammar.
    await server.fetch(
      new Request('https://store.test/repos', {
        method: 'POST',
        headers,
        body: JSON.stringify({ repo: 'acme/wait' }),
      }),
    )
    const repoResponse = await server.fetch(
      new Request('https://store.test/repos/acme%2Fwait/events?since=0&wait=abc', { headers }),
    )
    expect(repoResponse.status).toBe(400)
  })

  test('a wait above the ceiling clamps; the hold still answers an append promptly', async () => {
    const server = startStoreServer({ store: new MemoryBuildStore() })
    try {
      const client = new RemoteBuildStore({ url: server.url })
      await client.createBuild(sampleBuildInput('wait-clamp'))
      const pending = client.getEvents('wait-clamp', 0, { waitSeconds: 61 })
      await Bun.sleep(100)
      const event = await client.append('wait-clamp', sampleEventWrite('wake'))
      const started = Date.now()
      expect(await pending).toEqual([event])
      // The clamp never stretched the hold to 30 or 61 seconds.
      expect(Date.now() - started).toBeLessThan(5_000)
    } finally {
      await server.stop()
    }
  })

  test('the session-event route shares the digits-only grammar: non-digit wait values are 400 validation', async () => {
    const server = createStoreServer({ store: new MemoryBuildStore() })
    await server.fetch(
      new Request('https://store.test/repos', {
        method: 'POST',
        headers,
        body: JSON.stringify({ repo: 'acme/wait' }),
      }),
    )
    const createResponse = await server.fetch(
      new Request('https://store.test/repos/acme%2Fwait/sessions', {
        method: 'POST',
        headers,
        body: JSON.stringify({ repo: 'acme/wait', operator: 'op' }),
      }),
    )
    expect(createResponse.status).toBe(201)
    const { id } = (await createResponse.json()) as { id: string }
    for (const raw of ['abc', '0x10', '', ' 1', '1.5', '-1', '+1']) {
      const response = await server.fetch(
        new Request(
          `https://store.test/sessions/${id}/events?since=0&wait=${encodeURIComponent(raw)}`,
          { headers },
        ),
      )
      expect(response.status).toBe(400)
      expect(((await response.json()) as { kind: string }).kind).toBe('validation')
    }
  })

  test('a session-event wait above the ceiling clamps; the hold still answers an append promptly', async () => {
    const server = startStoreServer({ store: new MemoryBuildStore() })
    try {
      const client = new RemoteBuildStore({ url: server.url })
      await client.ensureRepo('acme/wait-clamp')
      const session = await client.createSession({ repo: 'acme/wait-clamp', operator: 'op' })
      // since=1: the session's own creation event is the backlog; the held
      // window must start AFTER it or the read answers immediately.
      const pending = client.getSessionEvents(session.id, 1, { waitSeconds: 61 })
      await Bun.sleep(100)
      const envelope = await client.appendSessionEvent(session.id, {
        actor: humanActor('op'),
        type: 'message.posted',
        payload: { text: 'wake' },
      })
      const started = Date.now()
      expect(await pending).toEqual([envelope])
      // The clamp never stretched the hold to 30 or 61 seconds.
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
        if (prop === 'getEvents') {
          return async (slug: string, sinceSeq?: number) =>
            (target as MemoryBuildStore).getEvents(slug, sinceSeq)
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
  const headers = {
    [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
    [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
  }

  test('the stream routes share the digits-only grammar: non-digit wait values are 400 validation', async () => {
    const server = createStoreServer({ store: new MemoryBuildStore() })
    await server.fetch(
      new Request('https://store.test/builds', {
        method: 'POST',
        headers,
        body: JSON.stringify(sampleBuildInput('stream-wait-grammar')),
      }),
    )
    const createResponse = await server.fetch(
      new Request('https://store.test/builds/stream-wait-grammar/streams', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'g' }),
      }),
    )
    expect(createResponse.status).toBe(201)
    const { id } = (await createResponse.json()) as { id: string }
    // The same rejection matrix the event routes pin: negative, decimal,
    // signed, whitespace-padded, hex, empty, and non-numeric text.
    for (const raw of ['abc', '0x10', '', ' 1', '1.5', '-1', '+1']) {
      const response = await server.fetch(
        new Request(
          `https://store.test/builds/stream-wait-grammar/streams/${id}/chunks?since=0&wait=${encodeURIComponent(raw)}`,
          { headers },
        ),
      )
      expect(response.status).toBe(400)
      expect(((await response.json()) as { kind: string }).kind).toBe('validation')
    }
    // The top-level route is the same parse site; pin it anyway so the
    // grammar holds across both route families.
    const top = await server.fetch(
      new Request(`https://store.test/streams/${id}/chunks?since=0&wait=-1`, {
        headers,
      }),
    )
    expect(top.status).toBe(400)
    expect(((await top.json()) as { kind: string }).kind).toBe('validation')
  })

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

  test('a connected held session-event read still answers an append promptly', async () => {
    const server = startStoreServer({ store: new MemoryBuildStore() })
    try {
      const client = new RemoteBuildStore({ url: server.url })
      await client.createBuild(sampleBuildInput('teardown-connected'))
      await client.ensureRepo('acme/teardown')
      const session = await client.createSession({ repo: 'acme/teardown', operator: 'op' })

      // since=1: the session's own creation event is the backlog; the held
      // window must start AFTER it or the read answers immediately.
      const pending = client.getSessionEvents(session.id, 1, { waitSeconds: 25 })
      await Bun.sleep(100)
      const envelope = await client.appendSessionEvent(session.id, {
        actor: humanActor('op'),
        type: 'message.posted',
        payload: { text: 'wake' },
      })
      const started = Date.now()
      expect(await pending).toEqual([envelope])
      expect(Date.now() - started).toBeLessThan(5_000)
    } finally {
      await server.stop()
    }
  })
})

// ── Stream wire specifics (SPEC §7.6) ────────────────────────────────────
// Beyond the shared contract: token scope on the stream routes, cross-scope
// addressing, and the typed error mappings (413 ceiling, 409 closed append).

describe('stream wire specifics', () => {
  test('the ceiling is 413 and a closed append is 409, with typed rehydration; family routes 404 on cross-scope addressing', async () => {
    const backing = new MemoryBuildStore()
    const server = startStoreServer({ store: backing })
    const store = new RemoteBuildStore({ url: server.url })
    try {
      await store.createBuild(sampleBuildInput('wire-map'))
      const stream = await store.createStream({ kind: 'build', build: 'wire-map' }, 'm')

      const oversized = await store
        .appendStreamParts(stream.id, [
          { type: 'text-delta', id: 't', delta: 'x'.repeat(1_048_600) },
        ])
        .catch((e: unknown) => e)
      expect(oversized).toBeInstanceOf(StreamBatchTooLargeError)
      expect((oversized as Error).message).toContain('1048576')

      await store.closeStream(stream.id, 'completed')
      const closed = await store
        .appendStreamParts(stream.id, [{ type: 'text-delta', id: 't', delta: 'y' }])
        .catch((e: unknown) => e)
      expect(closed).toBeInstanceOf(StreamClosedError)

      // Addressing another resource's stream under a family route — and an
      // unknown id under any route — is the same 404, no existence leak.
      await store.createBuild(sampleBuildInput('wire-map-b'))
      const other = await store.createStream({ kind: 'build', build: 'wire-map-b' }, 'o')
      const headers = {
        [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
        [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
      }
      const raw = await fetch(`${server.url}/builds/wire-map/streams/${other.id}`, { headers })
      expect(raw.status).toBe(404)
      expect(((await raw.json()) as { kind: string }).kind).toBe('not-found')
      const unknown = await fetch(`${server.url}/builds/wire-map/streams/st_missing`, {
        headers,
      })
      expect(unknown.status).toBe(404)
    } finally {
      await store.close()
      await server.stop()
    }
  })

  test('append rejection precedence: an unknown stream is 404 before the body is parsed (SPEC §7.6)', async () => {
    // The server resolves and authorizes the stream BEFORE readBody, so a
    // malformed or oversized batch on an unknown stream is 404 not-found —
    // the deliberate opposite of the local adapters' order, which validate
    // the batch first (pinned in memory.test.ts and local/store.test.ts).
    // Both orders write nothing.
    const backing = new MemoryBuildStore()
    const server = startStoreServer({ store: backing })
    const store = new RemoteBuildStore({ url: server.url })
    try {
      await store.createBuild(sampleBuildInput('wire-ghost'))
      const headers = {
        [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
        [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
      }

      // Malformed batches (empty; a part without a type) on an unknown
      // stream: 404 unknown stream, not 400 validation.
      for (const body of ['{"parts":[]}', '{"parts":[{"delta":"x"}]}']) {
        const raw = await fetch(`${server.url}/builds/wire-ghost/streams/st_missing/chunks`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body,
        })
        expect(raw.status).toBe(404)
        const payload = (await raw.json()) as { kind: string; error: string }
        expect(payload.kind).toBe('not-found')
        expect(payload.error).toContain('resource unavailable')
      }

      // An oversized batch on the same unknown stream is also 404 — the
      // 413 ceiling is never reached because the body is never evaluated.
      const oversized = await store
        .appendStreamParts('st_missing', [
          { type: 'text-delta', id: 't', delta: 'x'.repeat(1_048_600) },
        ])
        .catch((e: unknown) => e)
      expect(oversized).toBeInstanceOf(Error)
      expect((oversized as Error).message).toContain('resource unavailable')
      expect((oversized as Error).message).not.toContain('1048576')

      // Nothing was written on either side of the divergence.
      expect(await store.getStream('st_missing')).toBeNull()
    } finally {
      await store.close()
      await server.stop()
    }
  })
})

// Package/protocol identity is a gate ahead of authentication and lookup.
describe('remote identity and artifact policy', () => {
  test('the client emits both identities and skew diagnostics name both sides', async () => {
    let headers: Headers | undefined
    const client = new RemoteBuildStore({
      url: 'http://store.test',
      fetchFn: (async (_input, init) => {
        headers = new Headers(init?.headers)
        return Response.json([])
      }) as typeof fetch,
    })
    await client.listBuilds()
    expect(headers?.get('x-autobuild-version')).toBe(AUTOBUILD_VERSION)
    expect(headers?.get('x-autobuild-protocol-version')).toBe(REMOTE_STORE_PROTOCOL_VERSION)

    const server = startStoreServer({ store: new MemoryBuildStore(), secret: 'secret' })
    try {
      const missing = await fetch(`${server.url}/builds`)
      expect(missing.status).toBe(409)
      expect(await missing.text()).toContain('client Autobuild (missing)')

      const skewed = new RemoteBuildStore({
        url: server.url,
        identity: { protocolVersion: '999' },
      })
      const error = await skewed.listBuilds().catch((value: unknown) => value)
      expect((error as Error).message).toContain('client Autobuild')
      expect((error as Error).message).toContain('protocol 999')
      expect((error as Error).message).toContain(`server Autobuild ${AUTOBUILD_VERSION}`)
    } finally {
      await server.stop()
    }
  })

  test('oversize bundled build and repository deposits mutate nothing', async () => {
    const backing = new MemoryBuildStore()
    const server = startStoreServer({ store: backing, maxArtifactBytes: 2 })
    const client = new RemoteBuildStore({ url: server.url })
    try {
      await client.createBuild(sampleBuildInput('limited'))
      const buildError = await client
        .appendWithArtifacts('limited', [{ kind: 'large', content: new Uint8Array(3) }], () =>
          sampleEventWrite('not-written'),
        )
        .catch((value: unknown) => value)
      expect((buildError as Error).message).toContain('2 bytes')
      expect(await backing.getEvents('limited')).toEqual([])
      expect(await backing.listArtifacts('limited')).toEqual([])

      await client.ensureRepo('acme/limited')
      const repoError = await client
        .appendRepoWithArtifacts(
          'acme/limited',
          [{ kind: 'large', content: new Uint8Array(3) }],
          () => ({
            actor: { kind: 'human', user: 'operator' },
            type: 'dispatcher.pause-set',
            payload: { enabled: true },
          }),
        )
        .catch((value: unknown) => value)
      expect((repoError as Error).message).toContain('2 bytes')
      expect(await backing.getRepoEvents('acme/limited')).toEqual([])
      expect(await backing.listRepoArtifacts('acme/limited')).toEqual([])
    } finally {
      await server.stop()
    }
  })
})

describe('remote store internal diagnostics', () => {
  const headers = {
    [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
    [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
  }

  test('reports unexpected failures with the original value and request', async () => {
    const failure = new Error('postgres query failed')
    const reports: Array<[unknown, Request]> = []
    const store = new MemoryBuildStore()
    store.listBuilds = async () => {
      throw failure
    }
    const server = createStoreServer({
      store,
      onInternalError: (error, request) => reports.push([error, request]),
    })
    const request = new Request('https://store.example/builds', { headers })

    const response = await server.fetch(request)

    expect(response.status).toBe(500)
    expect(await response.text()).toContain('postgres query failed')
    expect(reports).toEqual([[failure, request]])
  })

  test('does not report expected failures and ignores reporter failures', async () => {
    let reports = 0
    const server = createStoreServer({
      store: new MemoryBuildStore(),
      onInternalError: () => {
        reports++
        throw new Error('logger failed')
      },
    })
    const expected = await server.fetch(
      new Request('https://store.example/builds', { method: 'POST', headers, body: '{}' }),
    )
    expect(expected.status).toBe(400)
    expect(reports).toBe(0)

    const failing = new MemoryBuildStore()
    failing.listBuilds = async () => {
      throw new Error('backend failed')
    }
    const resilient = createStoreServer({
      store: failing,
      onInternalError: () => {
        throw new Error('logger failed')
      },
    })
    const internal = await resilient.fetch(new Request('https://store.example/builds', { headers }))
    expect(internal.status).toBe(500)
    expect(await internal.text()).toContain('backend failed')
  })
})

// ── Operator sessions over the wire: session-scoped tokens and via ──────────

test('all retired resource scopes are refused before raw-store body processing', async () => {
  const now = new Date(CONTRACT_T0)
  const server = createStoreServer({
    store: new MemoryBuildStore(),
    secret: 'secret',
    clock: () => now,
  })
  for (const scope of [
    { build: 'a', session: 's', exp: now.getTime() + 60000 },
    { resource: { kind: 'repo' as const, id: 'a' }, session: '*', exp: now.getTime() + 60000 },
    {
      resource: { kind: 'session' as const, id: 'os_a' },
      session: '*',
      exp: now.getTime() + 60000,
    },
  ]) {
    const response = await server.fetch(
      new Request('http://store/builds', {
        method: 'POST',
        body: 'invalid',
        headers: {
          authorization: `Bearer ${mintToken('secret', scope)}`,
          [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
          [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
        },
      }),
    )
    expect(response.status).toBe(401)
    expect((await response.json()).error).toContain('credential format changed')
  }
})

test('a store that predates the snapshot routes reads as no snapshots, never an error', async () => {
  const old = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(JSON.stringify({ error: 'no route', kind: 'not-found' }), { status: 404 }),
  })
  try {
    const client = new RemoteBuildStore({ url: `http://localhost:${old.port}` })
    expect(await client.getReducerSnapshot({ kind: 'build', slug: 'a' }, 'build', 1)).toBeNull()
    expect(
      await client.putReducerSnapshot({ kind: 'build', slug: 'a' }, 'build', {
        version: 1,
        cursor: 0,
        state: {},
      }),
    ).toBe(false)
  } finally {
    old.stop(true)
  }
})

test('remote value reads send one bounded request and receive only a small JSON answer', async () => {
  const backing = new MemoryBuildStore()
  await backing.ensureRepo('value-wire')
  await backing.createBuild(sampleBuildInput('value-wire'))
  for (let index = 0; index < 3000; index++) {
    await backing.appendRepo('value-wire', {
      actor: humanActor('op'),
      type: 'dispatcher.intake-set',
      payload: { enabled: false },
    })
    await backing.append('value-wire', sampleEventWrite())
  }
  const server = createStoreServer({ store: backing })
  const paths: string[] = []
  let body = ''
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init)
    paths.push(new URL(req.url).pathname)
    const response = await server.fetch(req)
    body = await response.clone().text()
    return response
  }) as typeof fetch
  const remote = new RemoteBuildStore({ url: 'http://test', fetchFn })
  for (const scope of [
    { kind: 'build' as const, slug: 'value-wire' },
    { kind: 'repo' as const, repo: 'value-wire' },
  ]) {
    paths.length = 0
    const answer = await remote.getReducerValue(scope, {
      reducer: scope.kind === 'build' ? 'setupStreak' : 'dispatchSettings',
    })
    expect(answer.cursor).toBe(3000)
    expect(paths).toEqual([
      scope.kind === 'build'
        ? '/builds/value-wire/reducer-values'
        : '/repos/value-wire/reducer-values',
    ])
    expect(body.length).toBeLessThan(200)
    expect(Object.keys(JSON.parse(body)).sort()).toEqual(['cursor', 'value', 'version'])
  }
  const headers = {
    [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
    [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
    'content-type': 'application/json',
  }
  for (const body of [
    { reducer: 'unknown' },
    { reducer: 'journalView' },
    { reducer: 'build' },
    { reducer: 'openTick', args: { run: 7 } },
    { reducer: 'dispatchSettings', state: {} },
  ]) {
    expect(
      (
        await server.fetch(
          new Request('http://test/repos/value-wire/reducer-values', {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
          }),
        )
      ).status,
    ).toBe(400)
  }
  expect(
    (
      await server.fetch(
        new Request('http://test/repos/value-wire/reducer-values', {
          method: 'POST',
          headers,
          body: JSON.stringify({ reducer: 'openTick', args: { run: 'a'.repeat(5000) } }),
        }),
      )
    ).status,
  ).toBe(413)
  await backing.close()
})

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
          expect(body.state.acc.retained).toHaveLength(2)
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
    expect(normalizedBodies).toHaveLength(2)
    expect(normalizedBodies[0]).toEqual(normalizedBodies[1])
    expect(normalizedBodies[0]?.status).toBe(200)
    expect(normalizedBodies[0]?.written).toBe(false)
  } finally {
    server.stop()
  }
})

test('position endpoint reads only the counter and supports build-only and unknown repositories', async () => {
  const backing = new MemoryBuildStore()
  await backing.createBuild({ slug: 'counter-only', repo: 'org/repo' })
  const calls: string[] = []
  const store = new Proxy(backing, {
    get(target, key) {
      const value = Reflect.get(target, key, target)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        calls.push(String(key))
        return Reflect.apply(value, target, args)
      }
    },
  })
  const server = createStoreServer({ store })
  const response = await server.fetch(
    new Request('http://store/repos/org%2Frepo/change-position', {
      headers: {
        [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
        [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
      },
    }),
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ position: '1' })
  expect(calls).toEqual(['getRepoChangePosition'])
  calls.length = 0
  const unknown = await server.fetch(
    new Request('http://store/repos/unknown/change-position', {
      headers: {
        [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
        [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
      },
    }),
  )
  expect(await unknown.json()).toEqual({ position: '0' })
  expect(calls).toEqual(['getRepoChangePosition'])
  expect(await backing.getRepo('org/repo')).toBeNull()
})

test.each([...new Set([AUTOBUILD_VERSION, '1.0.0-beta.0', '1.0.0'])])(
  'audit capability survives completion and clears on settlement for %s',
  async (version) => {
    const { verifyAuditCapability } = await import('./testing/audit-capability')
    // Released clients send their own line's protocol identity, not the current one.
    const line = (v: string) => v.split('.').slice(0, 2).join('.')
    const protocol =
      line(version) === line(AUTOBUILD_VERSION)
        ? REMOTE_STORE_PROTOCOL_VERSION
        : RELEASE_LINE_PROTOCOLS[line(version)]!
    await verifyAuditCapability(version, protocol, true)
  },
)
