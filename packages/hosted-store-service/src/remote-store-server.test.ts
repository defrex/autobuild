/**
 * The remote store server's request/response seam, driven in memory: the
 * RemoteBuildStore client talks to `createStoreServer().fetch` through a
 * `fetchFn` bridge, so serialization, status mapping, headers and client
 * rehydration are exercised without a socket. Socket-only behavior (held
 * reads, aborts, disconnect teardown) and the over-the-wire BuildStore
 * contract live in remote-store.seam.integration.test.ts.
 */
import { describe, expect, test } from 'bun:test'
import type { EventWrite } from '@defrex/autobuild/plugin-sdk'
import {
  EventValidationError,
  AUTOBUILD_VERSION,
  AUTOBUILD_VERSION_HEADER,
  RELEASE_LINE_PROTOCOLS,
  RELEASED_CLIENTS,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
  RemoteBuildStore,
  classifyClient,
  mintToken,
  supportedClientRange,
} from '@defrex/autobuild/remote-store'
import { agentActor, DISPATCHER, KERNEL, humanActor, textContent } from '@defrex/autobuild/testing'
import {
  CONTRACT_T0,
  MemoryBuildStore,
  sampleBuildInput,
  sampleEventWrite,
  StreamBatchTooLargeError,
  StreamClosedError,
} from '@defrex/autobuild/plugin-sdk'
import { createStoreServer, type StoreServerOptions } from './remote-store-server'

const headers = {
  [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
  [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
}

/** A store server and a client bridged to its fetch handler, no socket. */
function bridge(opts: StoreServerOptions, clientOpts: { token?: string } = {}) {
  const server = createStoreServer(opts)
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) =>
    server.fetch(new Request(input, init))) as typeof fetch
  const store = new RemoteBuildStore({
    url: 'http://store.test',
    fetchFn,
    ...clientOpts,
  })
  return { server, store }
}

interface OpenCtx {
  store: RemoteBuildStore
  backing: MemoryBuildStore
}

async function withOpenStore(run: (ctx: OpenCtx) => Promise<void>): Promise<void> {
  const backing = new MemoryBuildStore()
  const { store } = bridge({ store: backing })
  try {
    await run({ store, backing })
  } finally {
    await store.close()
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
        [
          {
            kind: 'implement-notes',
            content: '# notes',
            metadata: { round: 1 },
          },
        ],
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
      expect(event.payload.artifact).toEqual({
        kind: 'implement-notes',
        rev: 0,
      })

      // Server-side, the *stored* payload carries the real revision — the
      // negative placeholder never reaches the log.
      const [stored] = await backing.getEvents('deposit-ok')
      if (stored?.type !== 'implement.completed') throw new Error('unreachable')
      expect(stored.payload.artifact).toEqual({
        kind: 'implement-notes',
        rev: 0,
      })
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
              artifact: {
                kind: deposited[0]!.kind,
                rev: deposited[0]!.revision,
              },
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
    const { store: clientOne } = bridge({ store: backing })
    await clientOne.createBuild(sampleBuildInput('robust'))
    await clientOne.append('robust', sampleEventWrite('before restart'))

    // A restarted server is a new handler over the same backing store, and
    // a new client points at it — continuity lives in the store, not the
    // server or the connection.
    const { store: clientTwo } = bridge({ store: backing })
    const envelope = await clientTwo.append('robust', sampleEventWrite('after restart'))
    expect(envelope.seq).toBe(2)
    expect((await clientTwo.getEvents('robust')).map((e) => e.seq)).toEqual([1, 2])
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

  test('open-builds answers before the existence gate and only for GET', async () => {
    const backing = new MemoryBuildStore()
    const server = createStoreServer({ store: backing })
    const call = (method: string) =>
      server.fetch(
        new Request('http://store.test/repos/acme%2Fopen/open-builds', { method, headers }),
      )
    const empty = await call('GET')
    expect(empty.status).toBe(200)
    expect(await empty.json()).toEqual([])
    const post = await call('POST')
    expect(post.status).toBe(404)
    expect(await post.json()).toMatchObject({
      kind: 'not-found',
      error: 'no route: POST /repos/:repo/open-builds',
    })
    await backing.createBuild(sampleBuildInput('open-1', { repo: 'acme/open' }))
    const { store } = bridge({ store: backing })
    expect(await store.listOpenBuilds('acme/open')).toEqual(
      await backing.listOpenBuilds('acme/open'),
    )
  })

  test('unknown routes → 404 {kind: "not-found"}', async () => {
    const server = createStoreServer({ store: new MemoryBuildStore() })
    const response = await server.fetch(new Request('http://store.test/nope'))
    expect(response.status).toBe(404)
    expect(((await response.json()) as { kind: string }).kind).toBe('not-found')
  })
})

// ── Held-read wait grammar (AUT-334, AUT-384) ────────────────────────────────

describe('held-read wait grammar', () => {
  test('wait query values are digits only on every held-read route', async () => {
    const server = createStoreServer({ store: new MemoryBuildStore() })
    const post = (path: string, body: unknown) =>
      server.fetch(
        new Request(`https://store.test${path}`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      )
    await post('/builds', sampleBuildInput('wait-grammar'))
    await post('/repos', { repo: 'acme/wait' })
    const session = await post('/repos/acme%2Fwait/sessions', {
      repo: 'acme/wait',
      operator: 'op',
    })
    expect(session.status).toBe(201)
    const { id: sessionId } = (await session.json()) as { id: string }
    const stream = await post('/builds/wait-grammar/streams', { label: 'g' })
    expect(stream.status).toBe(201)
    const { id: streamId } = (await stream.json()) as { id: string }
    // Negative, decimal, signed, whitespace-padded, hex, empty, and
    // non-numeric text: one rejection matrix on every route family.
    for (const path of [
      '/builds/wait-grammar/events',
      `/sessions/${sessionId}/events`,
      `/builds/wait-grammar/streams/${streamId}/chunks`,
    ]) {
      for (const raw of ['abc', '0x10', '', ' 1', '1.5', '-1', '+1']) {
        const response = await server.fetch(
          new Request(`https://store.test${path}?since=0&wait=${encodeURIComponent(raw)}`, {
            headers,
          }),
        )
        expect(response.status, `${path} wait=${JSON.stringify(raw)}`).toBe(400)
        expect(((await response.json()) as { kind: string }).kind).toBe('validation')
      }
    }
    const repoResponse = await server.fetch(
      new Request('https://store.test/repos/acme%2Fwait/events?since=0&wait=abc', { headers }),
    )
    expect(repoResponse.status).toBe(400)
    // The top-level stream route is the same parse site across both families.
    const top = await server.fetch(
      new Request(`https://store.test/streams/${streamId}/chunks?since=0&wait=-1`, { headers }),
    )
    expect(top.status).toBe(400)
    expect(((await top.json()) as { kind: string }).kind).toBe('validation')
  })

  test('the repository events route bounds its read by through and passes it to the store', async () => {
    const store = new MemoryBuildStore()
    const server = createStoreServer({ store })
    await server.fetch(
      new Request('https://store.test/repos', {
        method: 'POST',
        headers,
        body: JSON.stringify({ repo: 'acme/through' }),
      }),
    )
    for (let i = 0; i < 5; i++)
      await store.appendRepo('acme/through', {
        actor: humanActor('operator'),
        type: 'dispatcher.intake-set',
        payload: { enabled: true },
      })
    const tail = store.getRepositoryTail.bind(store)
    const received: unknown[] = []
    store.getRepositoryTail = (repo, since, opts) => {
      received.push(opts?.through)
      return tail(repo, since, opts)
    }
    const response = await server.fetch(
      new Request('https://store.test/repos/acme%2Fthrough/events?since=1&through=3', { headers }),
    )
    expect(response.status).toBe(200)
    expect(((await response.json()) as { seq: number }[]).map((event) => event.seq)).toEqual([2, 3])
    expect(received).toEqual([3])
  })
})

// ── Stream wire specifics (SPEC §7.6) ────────────────────────────────────
// Beyond the shared contract: cross-scope addressing, and the typed error
// mappings (413 ceiling, 409 closed append).

describe('stream wire specifics', () => {
  test('the ceiling is 413 and a closed append is 409, with typed rehydration; family routes 404 on cross-scope addressing', async () => {
    const { server, store } = bridge({ store: new MemoryBuildStore() })
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
      const raw = await server.fetch(
        new Request(`http://store.test/builds/wire-map/streams/${other.id}`, {
          headers,
        }),
      )
      expect(raw.status).toBe(404)
      expect(((await raw.json()) as { kind: string }).kind).toBe('not-found')
      const unknown = await server.fetch(
        new Request('http://store.test/builds/wire-map/streams/st_missing', {
          headers,
        }),
      )
      expect(unknown.status).toBe(404)
    } finally {
      await store.close()
    }
  })

  test('append rejection precedence: an unknown stream is 404 before the body is parsed (SPEC §7.6)', async () => {
    // The server resolves and authorizes the stream BEFORE readBody, so a
    // malformed or oversized batch on an unknown stream is 404 not-found —
    // the deliberate opposite of the local adapters' order, which validate
    // the batch first (pinned in memory.integration.test.ts and local/store.integration.test.ts).
    // Both orders write nothing.
    const { server, store } = bridge({ store: new MemoryBuildStore() })
    try {
      await store.createBuild(sampleBuildInput('wire-ghost'))

      // Malformed batches (empty; a part without a type) on an unknown
      // stream: 404 unknown stream, not 400 validation.
      for (const body of ['{"parts":[]}', '{"parts":[{"delta":"x"}]}']) {
        const raw = await server.fetch(
          new Request('http://store.test/builds/wire-ghost/streams/st_missing/chunks', {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body,
          }),
        )
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
    }
  })
})

// Package/protocol identity is a gate ahead of authentication and lookup.
describe('remote identity and artifact policy', () => {
  test('the client emits both identities and skew diagnostics name both sides', async () => {
    let sent: Headers | undefined
    const client = new RemoteBuildStore({
      url: 'http://store.test',
      fetchFn: (async (_input, init) => {
        sent = new Headers(init?.headers)
        return Response.json([])
      }) as typeof fetch,
    })
    await client.listBuilds()
    expect(sent?.get('x-autobuild-version')).toBe(AUTOBUILD_VERSION)
    expect(sent?.get('x-autobuild-protocol-version')).toBe(REMOTE_STORE_PROTOCOL_VERSION)

    const server = createStoreServer({
      store: new MemoryBuildStore(),
      secret: 'secret',
    })
    const missing = await server.fetch(new Request('http://store.test/builds'))
    expect(missing.status).toBe(409)
    expect(await missing.text()).toContain('client Autobuild (missing)')

    const skewed = new RemoteBuildStore({
      url: 'http://store.test',
      identity: { protocolVersion: '999' },
      fetchFn: (async (input, init) => server.fetch(new Request(input, init))) as typeof fetch,
    })
    const error = await skewed.listBuilds().catch((value: unknown) => value)
    expect((error as Error).message).toContain('client Autobuild')
    expect((error as Error).message).toContain('protocol 999')
    expect((error as Error).message).toContain(`server Autobuild ${AUTOBUILD_VERSION}`)
  })

  test('oversize bundled build and repository deposits mutate nothing', async () => {
    const backing = new MemoryBuildStore()
    const { store: client } = bridge({ store: backing, maxArtifactBytes: 2 })
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
  })
})

describe('remote store internal diagnostics', () => {
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
      new Request('https://store.example/builds', {
        method: 'POST',
        headers,
        body: '{}',
      }),
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
    {
      resource: { kind: 'repo' as const, id: 'a' },
      session: '*',
      exp: now.getTime() + 60000,
    },
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
  const client = new RemoteBuildStore({
    url: 'http://old.test',
    fetchFn: (async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ error: 'no route', kind: 'not-found' }), {
        status: 404,
      })) as typeof fetch,
  })
  expect(await client.getReducerSnapshot({ kind: 'build', slug: 'a' }, 'build', 1)).toBeNull()
  expect(
    await client.putReducerSnapshot({ kind: 'build', slug: 'a' }, 'build', {
      version: 1,
      cursor: 0,
      state: {},
    }),
  ).toBe(false)
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
          body: JSON.stringify({
            reducer: 'openTick',
            args: { run: 'a'.repeat(5000) },
          }),
        }),
      )
    ).status,
  ).toBe(413)
  await backing.close()
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

// Published releases still inside the installed service's supported client window.
test.each(
  [...new Set([AUTOBUILD_VERSION, ...RELEASED_CLIENTS.map((entry) => entry.version)])].filter(
    (version) => classifyClient(version, supportedClientRange()) === 'supported',
  ),
)('audit capability survives completion and clears on settlement for %s', async (version) => {
  const { verifyAuditCapability } = await import('./testing/audit-capability')
  // Released clients send their own line's protocol identity, not the current one.
  const line = (v: string) => v.split('.').slice(0, 2).join('.')
  const protocol =
    line(version) === line(AUTOBUILD_VERSION)
      ? REMOTE_STORE_PROTOCOL_VERSION
      : RELEASE_LINE_PROTOCOLS[line(version)]!
  await verifyAuditCapability(version, protocol, true)
})

describe('latest artifact metadata route', () => {
  test('validates kind, preserves build scope, and reports unsupported backings explicitly', async () => {
    const store = new MemoryBuildStore()
    await store.createBuild(sampleBuildInput('meta-build'))
    await store.createBuild(sampleBuildInput('other-build'))
    const meta = await store.putArtifact('meta-build', {
      kind: 'pin',
      content: 'body',
    })
    const server = createStoreServer({ store, secret: 'meta-secret' })
    const token = mintToken('meta-secret', {
      version: 1,
      ownerAdmin: { user: 'owner' },
      exp: Date.now() + 60_000,
    })
    const request = (slug: string, query: string) =>
      server.fetch(
        new Request(`http://store.test/builds/${slug}/artifact-meta${query}`, {
          headers: {
            authorization: `Bearer ${token}`,
            [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
            [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
          },
        }),
      )
    expect(await (await request('meta-build', '?kind=pin')).json()).toEqual(meta)
    expect(await (await request('meta-build', '?kind=missing')).json()).toBeNull()
    for (const query of ['', '?kind=', '?kind=%20']) {
      expect((await request('meta-build', query)).status).toBe(400)
    }
    expect(
      (
        await server.fetch(
          new Request('http://store.test/builds/meta-build/artifact-meta?kind=pin', {
            headers: {
              [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
              [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
            },
          }),
        )
      ).status,
    ).toBe(401)

    Reflect.set(store, 'getLatestArtifactMeta', undefined)
    const unsupported = await request('meta-build', '?kind=pin')
    expect(unsupported.status).toBe(501)
    expect(await unsupported.json()).toEqual({
      kind: 'unsupported-operation',
      error: 'latest artifact metadata is unsupported',
    })
  })
})

test('rewrite index validates OIDs and fails closed without a history fallback', async () => {
  const store = new MemoryBuildStore()
  await store.createBuild(sampleBuildInput('rewrite-node'))
  let histories = 0
  const events = store.getEvents.bind(store)
  store.getEvents = async (...args) => {
    histories++
    return events(...args)
  }
  const { store: remote } = bridge({ store })
  expect(await remote.getNodeRewrite('rewrite-node', 'a'.repeat(40))).toBeNull()
  expect(await remote.getNodeRewrite('rewrite-node')).toBeNull()
  await expect(remote.getNodeRewrite('rewrite-node', 'invalid')).rejects.toThrow()
  await expect(remote.getNodeRewrite('rewrite-node', undefined, 'invalid')).rejects.toThrow()
  expect(await remote.getNodeRewrite('rewrite-node', undefined, 'b'.repeat(40))).toBeNull()
  Reflect.set(store, 'getNodeRewrite', undefined)
  await expect(remote.getNodeRewrite('rewrite-node', 'a'.repeat(40))).rejects.toThrow()
  expect(histories).toBe(0)
})

test('placement negotiation, service publication, and external forgery rejection', async () => {
  const store = new MemoryBuildStore()
  const repo = 'https://github.com/acme/placement'
  let publications = 0,
    health = 0
  const server = createStoreServer({
    store,
    placement: async (requested) => {
      expect(requested).toBe(repo)
      publications++
      return {
        status: 'known',
        placement: { hosted: true, origin: 'https://store.test' },
      }
    },
  })
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init)
    if (new URL(req.url).pathname === '/health') health++
    return server.fetch(req)
  }) as typeof fetch
  const client = new RemoteBuildStore({ url: 'https://store.test', fetchFn })
  for (let i = 0; i < 3; i++)
    expect(await client.getDispatchPlacement(repo)).toEqual({
      status: 'known',
      placement: { hosted: true, origin: 'https://store.test' },
    })
  expect(health).toBe(1)
  expect(publications).toBe(3)
  await store.ensureRepo(repo)
  await expect(
    client.appendRepo(repo, {
      actor: KERNEL,
      type: 'dispatcher.placement-set',
      payload: { hosted: false },
    }),
  ).rejects.toThrow('placement is published only by the service')
  await expect(
    client.appendRepoWithArtifacts(repo, [], () => ({
      actor: KERNEL,
      type: 'dispatcher.placement-set',
      payload: { hosted: false },
    })),
  ).rejects.toThrow()
  const oldServer = createStoreServer({ store })
  let routes = 0
  const old = new RemoteBuildStore({
    url: 'https://old.test',
    fetchFn: (async (input, init) => {
      routes++
      return oldServer.fetch(new Request(input, init))
    }) as typeof fetch,
  })
  for (let i = 0; i < 3; i++)
    expect(await old.getDispatchPlacement(repo)).toEqual({
      status: 'unknown',
      reason: 'unsupported-capability',
    })
  expect(routes).toBe(1)
  for (const response of [
    new Response('{}'),
    new Response('{}', { status: 404 }),
    new Response('{}', { status: 500 }),
  ]) {
    const invalid = new RemoteBuildStore({
      url: 'https://bad.test',
      fetchFn: (async (input) =>
        new URL(String(input)).pathname === '/health'
          ? Response.json({ capabilities: ['dispatch-placement-v1'] })
          : response.clone()) as typeof fetch,
    })
    await expect(invalid.getDispatchPlacement(repo)).rejects.toThrow()
  }
})

test('placement service/client budget reads only the incremental tail at 100 and 100,000 events', async () => {
  const { placementReadBudget } = await import('@defrex/autobuild/testing')
  const store = new MemoryBuildStore()
  let registrations = 0,
    calls = 0
  const server = createStoreServer({
    store,
    requireRegistered: async () => {
      registrations++
    },
    placement: async (repo) => {
      calls++
      return (await store.getReducerValue({ kind: 'repo', repo }, { reducer: 'dispatchPlacement' }))
        .value as import('@defrex/autobuild/remote-store').DispatchPlacement
    },
  })
  await placementReadBudget({
    store,
    fresh: async () =>
      new RemoteBuildStore({
        url: 'https://store.test',
        fetchFn: (async (input, init) => server.fetch(new Request(input, init))) as typeof fetch,
      }),
  })
  expect(calls).toBe(14)
  expect(registrations).toBe(14)
})

test('placement requires project authority and registration, including dispatcher credentials', async () => {
  const repo = 'https://github.com/acme/one'
  const other = 'https://github.com/acme/two'
  const store = new MemoryBuildStore()
  let publications = 0
  const client = (kind: 'project' | 'delegated', project: string, registered = true) => {
    const server = createStoreServer({
      store,
      auth: {
        authenticate: async () =>
          ({
            kind,
            repo: project,
            user: 'test',
            credential: { purpose: 'dispatcher' },
          }) as unknown as import('./machine-auth').MachinePrincipal,
      },
      requireRegistered: async () => {
        if (!registered)
          throw new (await import('./machine-auth')).MachineAuthError(403, 'project not registered')
      },
      placement: async () => {
        publications++
        return { status: 'known', placement: { hosted: false } }
      },
    })
    return new RemoteBuildStore({
      url: 'https://store.test',
      token: 'test',
      fetchFn: (async (input, init) => server.fetch(new Request(input, init))) as typeof fetch,
    })
  }
  expect((await client('project', repo).getDispatchPlacement(repo)).status).toBe('known')
  await expect(client('project', other).getDispatchPlacement(repo)).rejects.toThrow('wrong project')
  await expect(client('delegated', repo).getDispatchPlacement(repo)).rejects.toThrow(
    'placement requires project authority',
  )
  await expect(client('project', repo, false).getDispatchPlacement(repo)).rejects.toThrow(
    'project not registered',
  )
  expect(publications).toBe(1)
})

test('placement retries failed health negotiation without masking transport failures', async () => {
  const server = createStoreServer({
    store: new MemoryBuildStore(),
    placement: async () => ({ status: 'known', placement: { hosted: false } }),
  })
  let probes = 0
  const client = new RemoteBuildStore({
    url: 'https://store.test',
    fetchFn: (async (input, init) => {
      if (new URL(String(input)).pathname === '/health' && ++probes === 1)
        throw new TypeError('network unavailable')
      return server.fetch(new Request(input, init))
    }) as typeof fetch,
  })
  await expect(client.getDispatchPlacement('repo')).rejects.toThrow('network unavailable')
  expect(await client.getDispatchPlacement('repo')).toEqual({
    status: 'known',
    placement: { hosted: false },
  })
  expect(await client.getDispatchPlacement('repo')).toEqual({
    status: 'known',
    placement: { hosted: false },
  })
  expect(probes).toBe(2)
})

test('hosted bounds reject old cursors and keep exact seeds across fresh clients', async () => {
  const { CursorTooOldError, CheckpointIntegrityError, IncompleteEventReadError } = await import(
    '@defrex/autobuild/remote-store'
  )
  const backing = new MemoryBuildStore()
  await backing.ensureRepo('bounds')
  await backing.createBuild({ slug: 'bounds', repo: 'bounds' })
  for (let i = 0; i < 1100; i++) {
    await backing.append('bounds', {
      actor: KERNEL,
      type: 'build.paused',
      payload: {},
    })
    await backing.appendRepo('bounds', {
      actor: humanActor('budget'),
      type: 'dispatcher.intake-set',
      payload: { enabled: true },
    })
  }
  const { server, store: client } = bridge({ store: backing })
  try {
    await expect(client.getRepoEvents('bounds', 99)).rejects.toBeInstanceOf(CursorTooOldError)
    expect(await client.getRepoEvents('bounds', 100)).toHaveLength(1000)
    await expect(client.getEvents('bounds')).rejects.toBeInstanceOf(IncompleteEventReadError)
    const seen: number[] = []
    let cursor = 0
    for (;;) {
      const page = await client.getBuildEventPage('bounds', cursor)
      expect(page.events.length).toBeLessThanOrEqual(256)
      seen.push(...page.events.map((e) => e.seq))
      cursor = page.cursor
      if (!page.hasMore) break
    }
    expect(seen).toEqual(Array.from({ length: 1100 }, (_, i) => i + 1))
    const scope = { kind: 'build', slug: 'bounds' } as const
    expect((await client.getStreamSeed(scope, 100)).cursor).toBe(100)
    const fresh = new RemoteBuildStore({
      url: 'http://store.test',
      fetchFn: (async (input, init) => server.fetch(new Request(input, init))) as typeof fetch,
    })
    expect(await fresh.getStreamSeed(scope, 100)).toEqual(await client.getStreamSeed(scope, 100))
    await expect(client.getStreamSeed(scope, 99)).rejects.toBeInstanceOf(CursorTooOldError)
    const maps = Reflect.get(backing, 'seedCheckpoints') as Map<string, Map<number, unknown>>
    for (const entries of maps.values()) entries.delete(100)
    await expect(client.getStreamSeed(scope, 100)).rejects.toBeInstanceOf(CheckpointIntegrityError)
  } finally {
    await client.close()
  }
})

test('explicit harvest history seeks matching events across a gap outside the repository window', async () => {
  const { harvestStartedWrite } = await import('@defrex/autobuild/plugin-sdk')
  const { readHarvestTail } = await import('@defrex/autobuild/remote-store')
  const backing = new MemoryBuildStore()
  await backing.ensureRepo('harvest-pages')
  for (let i = 0; i < 270; i++)
    await backing.appendRepo('harvest-pages', harvestStartedWrite(`h-${i}`))
  for (let i = 0; i < 1200; i++)
    await backing.appendRepo('harvest-pages', {
      actor: humanActor('budget'),
      type: 'dispatcher.intake-set',
      payload: { enabled: true },
    })
  const { store: client } = bridge({ store: backing })
  try {
    const events = await readHarvestTail(client, 'harvest-pages', 260)
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 260 }, (_, i) => i + 11))
    await expect(client.getRepoEvents('harvest-pages')).rejects.toThrow('too old')
  } finally {
    await client.close()
  }
})

test('feed and page routes answer journal-less repositories with one store read and reject bad arguments', async () => {
  const backing = new MemoryBuildStore()
  await backing.createBuild({ slug: 'feed-only', repo: 'org/repo' })
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
  const get = (path: string) =>
    server.fetch(
      new Request(`http://store${path}`, {
        headers: {
          [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
          [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
        },
      }),
    )
  const changed = await get('/repos/org%2Frepo/changed-builds?since=0')
  expect(changed.status).toBe(200)
  expect(await changed.json()).toEqual({
    position: '1',
    builds: [{ slug: 'feed-only', position: '1' }],
  })
  expect(calls).toEqual(['listBuildsChangedSince'])
  calls.length = 0
  const page = await get('/repos/org%2Frepo/build-page?limit=1')
  expect(page.status).toBe(200)
  expect(await page.json()).toMatchObject({ builds: [{ slug: 'feed-only' }], next: null })
  expect(calls).toEqual(['listBuildsPage'])
  calls.length = 0
  // A filtered page echoes the normalized filters it applied.
  const filtered = await get(
    '/repos/org%2Frepo/build-page?kind=leaf&outcome=merged&activeSince=2000-01-01T00:00Z',
  )
  expect(filtered.status).toBe(200)
  expect(await filtered.json()).toEqual({
    builds: [],
    next: null,
    filters: { kind: 'leaf', outcome: 'merged', activeSince: '2000-01-01T00:00:00.000Z' },
  })
  expect(
    await (
      await get('/repos/org%2Frepo/build-page?kind=leaf&activeSince=2000-01-01T00:00Z')
    ).json(),
  ).toMatchObject({ builds: [{ slug: 'feed-only' }], filters: { kind: 'leaf' } })
  calls.length = 0
  expect(await (await get('/repos/unknown/changed-builds?since=0')).json()).toEqual({
    position: '0',
    builds: [],
  })
  expect(await (await get('/repos/unknown/build-page')).json()).toEqual({
    builds: [],
    next: null,
  })
  expect(await backing.getRepo('org/repo')).toBeNull()
  expect(await backing.getRepo('unknown')).toBeNull()
  calls.length = 0
  for (const path of [
    '/repos/org%2Frepo/changed-builds',
    '/repos/org%2Frepo/changed-builds?since=01',
    '/repos/org%2Frepo/changed-builds?since=-1',
    '/repos/org%2Frepo/build-page?limit=0',
    '/repos/org%2Frepo/build-page?limit=101',
    '/repos/org%2Frepo/build-page?limit=x',
    '/repos/org%2Frepo/build-page?cursor=!',
    '/repos/org%2Frepo/build-page?kind=work',
    '/repos/org%2Frepo/build-page?kind=',
    '/repos/org%2Frepo/build-page?outcome=abandoned',
    '/repos/org%2Frepo/build-page?activeSince=nope',
  ]) {
    const response = await get(path)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ kind: 'validation' })
  }
  expect(calls.filter((call) => call !== 'listBuildsPage')).toEqual([])
})
