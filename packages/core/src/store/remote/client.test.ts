/**
 * Client-only unit coverage for RemoteBuildStore (SPEC §7.2 adapter 2): the
 * client is driven against a recording fake `fetchFn` whose canned responses
 * are parsed through the same wire schemas in protocol.ts the real server
 * composes, so the fake answers in genuine wire vocabulary. The other half of
 * the seam — client → real HTTP → server over a real socket — runs in
 * packages/hosted-store-service/src/remote-store.seam.test.ts; no server or
 * store fixture is created here.
 *
 * Pinned as core surface: request shape per route family, version/auth header
 * stamping, the D6 deposits convention (sentinel placeholder revisions), D6/D8
 * error rehydration, held-read abort semantics (AUT-380 client mirror), the
 * bounded-wait subscribe default (AUT-334), and scoped-token
 * minting/verification (§8.1 [D8]).
 */
import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { EventValidationError } from '../../events/catalog'
import { agentActor, DISPATCHER, humanActor } from '../../events/envelope'
import {
  harvestStartedWrite,
  messagePostedWrite,
  sampleBuildInput,
  sampleEventWrite,
  turnStartedWrite,
} from '../contract'
import {
  STREAM_FORMAT,
  StreamBatchTooLargeError,
  StreamClosedError,
  type StreamChunk,
  type StreamRead,
  type StreamRecord,
} from '../streams/types'
import { textContent, toBytes } from '../types'
import { AuthError, REMOTE_EVENT_WAIT_SECONDS, RemoteBuildStore } from './client'
import {
  artifactGetResponseSchema,
  artifactMetaWireSchema,
  buildRecordListSchema,
  buildRecordWireSchema,
  conditionalEventResponseSchema,
  depositsResponseSchema,
  encodeBase64,
  errorBodySchema,
  eventEnvelopeWireSchema,
  placeholderRev,
  repoDepositsResponseSchema,
  repositoryArtifactGetResponseSchema,
  repositoryArtifactMetaWireSchema,
  repositoryEventEnvelopeWireSchema,
  repositoryRecordWireSchema,
  sessionArtifactMetaWireSchema,
  sessionDepositsResponseSchema,
  sessionEventEnvelopeWireSchema,
  sessionRecordListSchema,
  sessionRecordWireSchema,
  streamChunkWireSchema,
  streamReadWireSchema,
  streamRecordListSchema,
  streamRecordWireSchema,
} from './protocol'
import { mintToken, verifyToken, type TokenScope } from './token'
import {
  AUTOBUILD_VERSION,
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
} from './version'

// ── The fake fetch ───────────────────────────────────────────────────────────

interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
  signal: AbortSignal | null | undefined
}

interface CannedResponse {
  status?: number
  body?: unknown
  /** Simulate a non-JSON response (a gateway error page): `json()` rejects. */
  jsonThrows?: boolean
}

/** Canned-exchange fetch: dequeues one response per request, records each.
 * Bun's `fetch` type carries a `preconnect` member the fake never uses. */
function fakeFetch(responses: CannedResponse[]) {
  const calls: RecordedCall[] = []
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body !== undefined ? JSON.parse(init.body as string) : undefined,
      signal: init?.signal,
    })
    const next = responses.shift()
    if (!next) throw new Error('fakeFetch: no canned response left')
    const status = next.status ?? 200
    return {
      ok: status < 400,
      status,
      json: async () => {
        if (next.jsonThrows) throw new Error('invalid json')
        return next.body
      },
    } as Response
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}

function makeStore(
  responses: CannedResponse[],
  opts: { token?: string; url?: string } = {},
): { store: RemoteBuildStore; calls: RecordedCall[] } {
  const { fetchFn, calls } = fakeFetch(responses)
  const store = new RemoteBuildStore({
    url: opts.url ?? 'http://store.test',
    ...(opts.token !== undefined ? { token: opts.token } : {}),
    fetchFn,
  })
  return { store, calls }
}

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Error) return error
    throw new Error(`expected an Error rejection, received ${String(error)}`)
  }
  throw new Error('expected promise to reject')
}

/** Predicate poll with a deadline, for the subscribe-loop tests. */
async function waitFor(predicate: () => boolean, message: string, deadlineMs = 2_000) {
  const deadline = performance.now() + deadlineMs
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${message}`)
    await Bun.sleep(2)
  }
}

// ── Canned responses, built with the protocol's wire schemas ─────────────────

const T0 = '2026-07-15T12:00:00.000Z'
const AGENT = agentActor('implement', 's_test')

function wireError(
  error: string,
  kind: 'validation' | 'not-found' | 'auth' | 'conflict' | 'internal',
) {
  return errorBodySchema.parse({ error, kind })
}

function wireBuild(over: Record<string, unknown> = {}) {
  return buildRecordWireSchema.parse({
    slug: 'build-a',
    repo: 'acme/rate-limiter',
    createdAt: T0,
    updatedAt: T0,
    ...over,
  })
}

function wireEvent(over: Record<string, unknown> = {}) {
  return eventEnvelopeWireSchema.parse({
    build: 'build-a',
    seq: 1,
    ts: T0,
    actor: AGENT,
    type: 'observation.recorded',
    payload: { id: 'o_1', kind: 'followup', summary: 'sample observation' },
    ...over,
  })
}

function wireArtifactMeta(over: Record<string, unknown> = {}) {
  return artifactMetaWireSchema.parse({
    build: 'build-a',
    kind: 'plan',
    revision: 0,
    blobRef: 'sha256-plan',
    metadata: {},
    createdAt: T0,
    ...over,
  })
}

function wireRepo(over: Record<string, unknown> = {}) {
  return repositoryRecordWireSchema.parse({
    repo: 'acme/rate-limiter',
    createdAt: T0,
    updatedAt: T0,
    ...over,
  })
}

function wireRepoEvent(over: Record<string, unknown> = {}) {
  return repositoryEventEnvelopeWireSchema.parse({
    repo: 'acme/rate-limiter',
    seq: 1,
    ts: T0,
    actor: DISPATCHER,
    type: 'harvest.started',
    payload: { run: 'h_1' },
    ...over,
  })
}

function wireRepoArtifactMeta(over: Record<string, unknown> = {}) {
  return repositoryArtifactMetaWireSchema.parse({
    repo: 'acme/rate-limiter',
    kind: 'config',
    revision: 0,
    blobRef: 'sha256-config',
    metadata: {},
    createdAt: T0,
    ...over,
  })
}

function wireSession(over: Record<string, unknown> = {}) {
  return sessionRecordWireSchema.parse({
    id: 'os_1',
    repo: 'acme/rate-limiter',
    operator: 'op',
    createdAt: T0,
    updatedAt: T0,
    ...over,
  })
}

function wireSessionEvent(over: Record<string, unknown> = {}) {
  return sessionEventEnvelopeWireSchema.parse({
    session: 'os_1',
    seq: 1,
    ts: T0,
    actor: humanActor('op'),
    type: 'message.posted',
    payload: { text: 'hello' },
    ...over,
  })
}

function wireSessionArtifactMeta(over: Record<string, unknown> = {}) {
  return sessionArtifactMetaWireSchema.parse({
    session: 'os_1',
    kind: 'plan',
    revision: 0,
    blobRef: 'sha256-plan',
    metadata: {},
    createdAt: T0,
    ...over,
  })
}

function wireStream(over: Record<string, unknown> = {}): StreamRecord {
  return streamRecordWireSchema.parse({
    id: 'st_1',
    scope: { kind: 'build', build: 'build-a' },
    label: 'turn',
    format: STREAM_FORMAT,
    status: 'open',
    createdAt: T0,
    ...over,
  }) as StreamRecord
}

function wireChunk(over: Record<string, unknown> = {}): StreamChunk {
  return streamChunkWireSchema.parse({
    stream: 'st_1',
    seq: 1,
    ts: T0,
    parts: [{ type: 'text-delta', id: 't1', delta: 'working' }],
    ...over,
  }) as StreamChunk
}

function wireRead(over: Record<string, unknown> = {}): StreamRead {
  return streamReadWireSchema.parse({
    chunks: [wireChunk()],
    status: 'open',
    ...over,
  }) as StreamRead
}

// ── Request construction ─────────────────────────────────────────────────────

describe('request construction', () => {
  test('createBuild POSTs the wire input with version, auth, and JSON headers', async () => {
    const input = sampleBuildInput('build-a')
    const { store, calls } = makeStore([{ body: wireBuild() }], { token: 't0k' })

    const created = await store.createBuild(input)

    expect(created).toEqual(wireBuild())
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('http://store.test/builds')
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.headers).toEqual({
      [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
      [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
      authorization: 'Bearer t0k',
      'content-type': 'application/json',
    })
    expect(calls[0]?.body).toEqual(input)
  })

  test('a token-less client sends no authorization header', async () => {
    const { store, calls } = makeStore([{ body: wireBuild() }])
    await store.createBuild(sampleBuildInput('build-a'))
    expect(calls[0]?.headers.authorization).toBeUndefined()
    expect(calls[0]?.headers).toEqual({
      [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
      [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
      'content-type': 'application/json',
    })
  })

  test('a trailing slash on the base URL is normalized away', async () => {
    const { store, calls } = makeStore([{ body: wireBuild() }], { url: 'http://store.test/' })
    await store.createBuild(sampleBuildInput('build-a'))
    expect(calls[0]?.url).toBe('http://store.test/builds')
  })

  interface RouteCase {
    responses: CannedResponse[]
    act: (store: RemoteBuildStore) => Promise<unknown>
    path: string
    method: 'GET' | 'POST'
  }

  test('every operation hits its route family with the right method and path', async () => {
    const cases: Record<string, RouteCase> = {
      getBuild: {
        responses: [{ body: wireBuild() }],
        act: (s) => s.getBuild('build-a'),
        path: '/builds/build-a',
        method: 'GET',
      },
      listBuilds: {
        responses: [{ body: [] }],
        act: (s) => s.listBuilds(),
        path: '/builds',
        method: 'GET',
      },
      'append (slug is percent-encoded)': {
        responses: [{ body: wireEvent() }],
        act: (s) => s.append('build a/special', sampleEventWrite()),
        path: '/builds/build%20a%2Fspecial/events',
        method: 'POST',
      },
      appendIfCurrent: {
        responses: [{ body: conditionalEventResponseSchema.parse(wireEvent({ seq: 2 })) }],
        act: (s) => s.appendIfCurrent('build-a', 1, sampleEventWrite('next')),
        path: '/builds/build-a/events/conditional',
        method: 'POST',
      },
      putArtifact: {
        responses: [{ body: wireArtifactMeta() }],
        act: (s) => s.putArtifact('build-a', { kind: 'plan', content: 'p' }),
        path: '/builds/build-a/artifacts',
        method: 'POST',
      },
      getArtifact: {
        responses: [
          {
            body: artifactGetResponseSchema.parse({
              meta: wireArtifactMeta(),
              contentBase64: 'SGk=',
            }),
          },
        ],
        act: (s) => s.getArtifact('build-a', 'plan'),
        path: '/builds/build-a/artifacts?kind=plan',
        method: 'GET',
      },
      'getArtifact at rev': {
        responses: [
          {
            body: artifactGetResponseSchema.parse({
              meta: wireArtifactMeta({ revision: 2 }),
              contentBase64: 'SGk=',
            }),
          },
        ],
        act: (s) => s.getArtifact('build-a', 'plan', 2),
        path: '/builds/build-a/artifacts?kind=plan&rev=2',
        method: 'GET',
      },
      listArtifacts: {
        responses: [{ body: [] }],
        act: (s) => s.listArtifacts('build-a'),
        path: '/builds/build-a/artifact-list',
        method: 'GET',
      },
      'listArtifacts by kind': {
        responses: [{ body: [] }],
        act: (s) => s.listArtifacts('build-a', 'plan'),
        path: '/builds/build-a/artifact-list?kind=plan',
        method: 'GET',
      },
      claimLease: {
        responses: [{ body: { ok: true } }],
        act: (s) => s.claimLease('build-a', 'runner-1', 30_000),
        path: '/builds/build-a/lease/claim',
        method: 'POST',
      },
      heartbeat: {
        responses: [{ body: { ok: true } }],
        act: (s) => s.heartbeat('build-a', 'runner-1'),
        path: '/builds/build-a/lease/heartbeat',
        method: 'POST',
      },
      releaseLease: {
        responses: [{ body: { ok: true } }],
        act: (s) => s.releaseLease('build-a', 'runner-1'),
        path: '/builds/build-a/lease/release',
        method: 'POST',
      },
      ensureRepo: {
        responses: [{ body: wireRepo() }],
        act: (s) => s.ensureRepo('acme/rate-limiter'),
        path: '/repos',
        method: 'POST',
      },
      getRepo: {
        responses: [{ body: wireRepo() }],
        act: (s) => s.getRepo('acme/rate-limiter'),
        path: '/repos/acme%2Frate-limiter',
        method: 'GET',
      },
      appendRepo: {
        responses: [{ body: wireRepoEvent() }],
        act: (s) => s.appendRepo('acme/rate-limiter', harvestStartedWrite()),
        path: '/repos/acme%2Frate-limiter/events',
        method: 'POST',
      },
      appendRepoWithArtifacts: {
        responses: [
          {
            body: repoDepositsResponseSchema.parse({
              event: wireRepoEvent(),
              artifacts: [wireRepoArtifactMeta()],
            }),
          },
        ],
        act: (s) =>
          s.appendRepoWithArtifacts(
            'acme/rate-limiter',
            [{ kind: 'config', content: 'c' }],
            (deposited) => harvestStartedWrite('h_1', deposited[0]!.revision),
          ),
        path: '/repos/acme%2Frate-limiter/deposits',
        method: 'POST',
      },
      putRepoArtifact: {
        responses: [{ body: wireRepoArtifactMeta() }],
        act: (s) => s.putRepoArtifact('acme/rate-limiter', { kind: 'config', content: 'c' }),
        path: '/repos/acme%2Frate-limiter/artifacts',
        method: 'POST',
      },
      getRepoArtifact: {
        responses: [
          {
            body: repositoryArtifactGetResponseSchema.parse({
              meta: wireRepoArtifactMeta(),
              contentBase64: 'SGk=',
            }),
          },
        ],
        act: (s) => s.getRepoArtifact('acme/rate-limiter', 'config'),
        path: '/repos/acme%2Frate-limiter/artifacts?kind=config',
        method: 'GET',
      },
      listRepoArtifacts: {
        responses: [{ body: [] }],
        act: (s) => s.listRepoArtifacts('acme/rate-limiter'),
        path: '/repos/acme%2Frate-limiter/artifact-list',
        method: 'GET',
      },
      claimRepoLease: {
        responses: [{ body: { ok: true } }],
        act: (s) => s.claimRepoLease('acme/rate-limiter', 'harvest-1', 1_000),
        path: '/repos/acme%2Frate-limiter/lease/claim',
        method: 'POST',
      },
      heartbeatRepo: {
        responses: [{ body: { ok: true } }],
        act: (s) => s.heartbeatRepo('acme/rate-limiter', 'harvest-1'),
        path: '/repos/acme%2Frate-limiter/lease/heartbeat',
        method: 'POST',
      },
      releaseRepoLease: {
        responses: [{ body: { ok: true } }],
        act: (s) => s.releaseRepoLease('acme/rate-limiter', 'harvest-1'),
        path: '/repos/acme%2Frate-limiter/lease/release',
        method: 'POST',
      },
      createSession: {
        responses: [{ body: wireSession() }],
        act: (s) => s.createSession({ repo: 'acme/rate-limiter', operator: 'op', title: 'T' }),
        path: '/repos/acme%2Frate-limiter/sessions',
        method: 'POST',
      },
      getSession: {
        responses: [{ body: wireSession() }],
        act: (s) => s.getSession('os_1'),
        path: '/sessions/os_1',
        method: 'GET',
      },
      listSessions: {
        responses: [{ body: [] }],
        act: (s) => s.listSessions('acme/rate-limiter'),
        path: '/repos/acme%2Frate-limiter/sessions',
        method: 'GET',
      },
      appendSessionEvent: {
        responses: [{ body: wireSessionEvent() }],
        act: (s) => s.appendSessionEvent('os_1', messagePostedWrite()),
        path: '/sessions/os_1/events',
        method: 'POST',
      },
      appendSessionWithArtifacts: {
        responses: [
          {
            body: sessionDepositsResponseSchema.parse({
              event: wireSessionEvent(),
              artifacts: [wireSessionArtifactMeta()],
            }),
          },
        ],
        act: (s) =>
          s.appendSessionWithArtifacts('os_1', [{ kind: 'plan', content: 'p' }], (deposited) =>
            turnStartedWrite('t1', `st_${deposited[0]!.revision}`),
          ),
        path: '/sessions/os_1/deposits',
        method: 'POST',
      },
      putSessionArtifact: {
        responses: [{ body: wireSessionArtifactMeta() }],
        act: (s) => s.putSessionArtifact('os_1', { kind: 'plan', content: 'p' }),
        path: '/sessions/os_1/artifacts',
        method: 'POST',
      },
      getSessionArtifact: {
        responses: [
          {
            body: {
              meta: wireSessionArtifactMeta(),
              contentBase64: 'SGk=',
            },
          },
        ],
        act: (s) => s.getSessionArtifact('os_1', 'plan'),
        path: '/sessions/os_1/artifacts?kind=plan',
        method: 'GET',
      },
      listSessionArtifacts: {
        responses: [{ body: [] }],
        act: (s) => s.listSessionArtifacts('os_1'),
        path: '/sessions/os_1/artifact-list',
        method: 'GET',
      },
      'createStream (build scope)': {
        responses: [{ body: wireStream() }],
        act: (s) => s.createStream({ kind: 'build', build: 'build-a' }, 'turn'),
        path: '/builds/build-a/streams',
        method: 'POST',
      },
      'createStream (repo scope)': {
        responses: [
          {
            body: wireStream({ id: 'st_2', scope: { kind: 'repo', repo: 'acme/rate-limiter' } }),
          },
        ],
        act: (s) => s.createStream({ kind: 'repo', repo: 'acme/rate-limiter' }, 'turn'),
        path: '/repos/acme%2Frate-limiter/streams',
        method: 'POST',
      },
      'createStream (session scope)': {
        responses: [
          { body: wireStream({ id: 'st_3', scope: { kind: 'session', session: 'os_1' } }) },
        ],
        act: (s) => s.createStream({ kind: 'session', session: 'os_1' }, 'turn'),
        path: '/sessions/os_1/streams',
        method: 'POST',
      },
      appendStreamParts: {
        responses: [{ body: wireChunk() }],
        act: (s) => s.appendStreamParts('st_1', [{ type: 'text-delta', delta: 'x' }]),
        path: '/streams/st_1/chunks',
        method: 'POST',
      },
      readStream: {
        responses: [{ body: wireRead() }],
        act: (s) => s.readStream('st_1'),
        path: '/streams/st_1/chunks?since=0',
        method: 'GET',
      },
      'readStream (since+wait)': {
        responses: [{ body: wireRead() }],
        act: (s) => s.readStream('st_1', { since: 2, waitSeconds: 5 }),
        path: '/streams/st_1/chunks?since=2&wait=5',
        method: 'GET',
      },
      closeStream: {
        responses: [{ body: wireStream({ status: 'closed', closedAt: T0, outcome: 'completed' }) }],
        act: (s) => s.closeStream('st_1', 'completed'),
        path: '/streams/st_1/close',
        method: 'POST',
      },
      getStream: {
        responses: [{ body: wireStream() }],
        act: (s) => s.getStream('st_1'),
        path: '/streams/st_1',
        method: 'GET',
      },
      'listStreams (build scope)': {
        responses: [{ body: [] }],
        act: (s) => s.listStreams({ kind: 'build', build: 'build-a' }),
        path: '/builds/build-a/streams',
        method: 'GET',
      },
      'listStreams (session scope)': {
        responses: [{ body: [] }],
        act: (s) => s.listStreams({ kind: 'session', session: 'os_1' }),
        path: '/sessions/os_1/streams',
        method: 'GET',
      },
    }

    for (const [name, c] of Object.entries(cases)) {
      try {
        const { store, calls } = makeStore(c.responses)
        await c.act(store)
        expect(calls).toHaveLength(1)
        expect(calls[0]?.url).toBe(`http://store.test${c.path}`)
        expect(calls[0]?.method).toBe(c.method)
      } catch (error) {
        throw new Error(`route case "${name}" failed: ${(error as Error).message}`)
      }
    }
  })

  test('append ships the write as {actor, type, payload}', async () => {
    const { store, calls } = makeStore([{ body: wireEvent() }])
    const write = sampleEventWrite('shipped')
    await store.append('build-a', write)
    expect(calls[0]?.body).toEqual({ actor: write.actor, type: write.type, payload: write.payload })
  })

  test('appendIfCurrent ships the expected seq alongside the write', async () => {
    const { store, calls } = makeStore([
      { body: conditionalEventResponseSchema.parse(wireEvent({ seq: 2 })) },
    ])
    const write = sampleEventWrite('conditional')
    const envelope = await store.appendIfCurrent('build-a', 1, write)
    expect(envelope?.seq).toBe(2)
    expect(calls[0]?.body).toEqual({
      expectedSeq: 1,
      event: { actor: write.actor, type: write.type, payload: write.payload },
    })
  })

  test('a null conditional response means the expected seq moved on', async () => {
    const { store } = makeStore([{ body: conditionalEventResponseSchema.parse(null) }])
    expect(await store.appendIfCurrent('build-a', 0, sampleEventWrite('stale'))).toBeNull()
  })

  test('event reads pass since and an explicit wait through the query', async () => {
    const { store, calls } = makeStore([{ body: [] }, { body: [] }, { body: [] }])
    await store.getEvents('build-a', 7, { waitSeconds: 2 })
    await store.getRepoEvents('acme/rate-limiter', 3)
    await store.getSessionEvents('os_1', 0)
    expect(calls[0]?.url).toBe('http://store.test/builds/build-a/events?since=7&wait=2')
    expect(calls[1]?.url).toBe('http://store.test/repos/acme%2Frate-limiter/events?since=3')
    expect(calls[2]?.url).toBe('http://store.test/sessions/os_1/events?since=0')
  })

  test('artifact bodies carry base64 content and optional metadata', async () => {
    const { store, calls } = makeStore([{ body: wireArtifactMeta() }, { body: wireArtifactMeta() }])
    await store.putArtifact('build-a', { kind: 'plan', content: 'plan', metadata: { round: 1 } })
    await store.putArtifact('build-a', { kind: 'plan', content: toBytes('raw') })
    expect(calls[0]?.body).toEqual({
      kind: 'plan',
      contentBase64: encodeBase64(toBytes('plan')),
      metadata: { round: 1 },
    })
    expect(calls[1]?.body).toEqual({ kind: 'plan', contentBase64: encodeBase64(toBytes('raw')) })
  })
})

// ── Response parsing ─────────────────────────────────────────────────────────

describe('response parsing', () => {
  test('listBuilds parses the wire list', async () => {
    const { store } = makeStore([{ body: buildRecordListSchema.parse([wireBuild()]) }])
    expect(await store.listBuilds()).toEqual([wireBuild()])
  })

  test('getBuild maps 404 to null', async () => {
    const { store } = makeStore([
      { status: 404, body: wireError('unknown build "build-a"', 'not-found') },
    ])
    expect(await store.getBuild('build-a')).toBeNull()
  })

  test('getRepo and getSession map 404 to null, getSession also a JSON null body', async () => {
    const repo = makeStore([{ status: 404 }])
    expect(await repo.store.getRepo('acme/rate-limiter')).toBeNull()
    const session = makeStore([{ status: 404 }])
    expect(await session.store.getSession('os_1')).toBeNull()
    const absent = makeStore([{ body: null }])
    expect(await absent.store.getSession('os_1')).toBeNull()
  })

  test('artifact get decodes base64 content back to bytes and maps null to null', async () => {
    const present = makeStore([
      {
        body: artifactGetResponseSchema.parse({ meta: wireArtifactMeta(), contentBase64: 'SGk=' }),
      },
    ])
    const artifact = await present.store.getArtifact('build-a', 'plan')
    expect(textContent(artifact!)).toBe('Hi')
    expect(artifact?.meta).toEqual(wireArtifactMeta())

    const absent = makeStore([{ body: artifactGetResponseSchema.parse(null) }])
    expect(await absent.store.getArtifact('build-a', 'plan')).toBeNull()
  })

  test('a malformed base64 artifact body is rejected, not silently decoded', async () => {
    const { store } = makeStore([
      {
        body: artifactGetResponseSchema.parse({ meta: wireArtifactMeta(), contentBase64: 'no!!' }),
      },
    ])
    expect(await rejectionOf(store.getArtifact('build-a', 'plan')).then((e) => e.message)).toBe(
      'artifact content is not valid base64',
    )
  })

  test('lease claim and heartbeat read their boolean from the ok response', async () => {
    const won = makeStore([{ body: { ok: true } }, { body: { ok: true } }])
    expect(await won.store.claimLease('build-a', 'runner-1', 30_000)).toBe(true)
    expect(await won.store.heartbeat('build-a', 'runner-1')).toBe(true)
    const lost = makeStore([{ body: { ok: false } }])
    expect(await lost.store.claimLease('build-a', 'runner-2', 30_000)).toBe(false)
  })

  test('listSessions parses the wire list', async () => {
    const { store } = makeStore([{ body: sessionRecordListSchema.parse([wireSession()]) }])
    expect(await store.listSessions('acme/rate-limiter')).toEqual([wireSession()])
  })

  test('stream operations parse records, chunks, and reads', async () => {
    const closed = wireStream({ status: 'closed', closedAt: T0, outcome: 'completed' })
    const { store, calls } = makeStore([
      { body: wireStream() },
      { body: wireChunk() },
      { body: wireRead() },
      { body: closed },
      { body: closed },
      { body: streamRecordListSchema.parse([wireStream()]) },
    ])
    expect(await store.createStream({ kind: 'build', build: 'build-a' }, 'turn')).toEqual(
      wireStream(),
    )
    expect(await store.appendStreamParts('st_1', [{ type: 'text-delta', delta: 'x' }])).toEqual(
      wireChunk(),
    )
    expect(await store.readStream('st_1')).toEqual(wireRead())
    expect(await store.closeStream('st_1', 'completed')).toEqual(closed)
    expect(await store.getStream('st_1')).toEqual(closed)
    expect(await store.listStreams({ kind: 'build', build: 'build-a' })).toEqual([wireStream()])
    expect(calls[2]?.method).toBe('GET')
  })

  test('getStream maps 404 to null', async () => {
    const { store } = makeStore([
      { status: 404, body: wireError('unknown stream "st_404"', 'not-found') },
    ])
    expect(await store.getStream('st_404')).toBeNull()
  })
})

// ── Atomic deposits, client half (D6, §8.7) ──────────────────────────────────

describe('atomic deposits client half (D6, §8.7)', () => {
  test('makeEvent sees sentinel metas with negative placeholder revisions', async () => {
    const realMetas = [
      wireArtifactMeta({ kind: 'plan', revision: 4, blobRef: 'sha256-real-plan' }),
      wireArtifactMeta({ kind: 'notes', revision: 0, blobRef: 'sha256-real-notes' }),
    ]
    const response = depositsResponseSchema.parse({
      event: wireEvent({
        seq: 3,
        type: 'plan.completed',
        payload: { round: 1, artifact: { kind: 'plan', rev: 4 } },
      }),
      artifacts: realMetas,
    })
    const { store, calls } = makeStore([{ body: response }])
    const sentinelsSeen: Array<{ kind: string; revision: number }>[] = []

    const write = await store.appendWithArtifacts(
      'build-a',
      [
        { kind: 'plan', content: 'plan text', metadata: { round: 1 } },
        { kind: 'notes', content: 'notes text' },
      ],
      (deposited) => {
        sentinelsSeen.push(
          structuredClone(deposited.map((meta) => ({ kind: meta.kind, revision: meta.revision }))),
        )
        return {
          actor: AGENT,
          type: 'plan.completed',
          payload: {
            round: 1,
            artifact: { kind: deposited[0]!.kind, rev: deposited[0]!.revision },
            note: deposited[1]!.revision,
          },
        }
      },
    )

    expect(sentinelsSeen).toEqual([
      [
        { kind: 'plan', revision: placeholderRev(0) },
        { kind: 'notes', revision: placeholderRev(1) },
      ],
    ])
    expect(calls[0]?.url).toBe('http://store.test/builds/build-a/deposits')
    expect(calls[0]?.body).toEqual({
      artifacts: [
        { kind: 'plan', contentBase64: encodeBase64(toBytes('plan text')), metadata: { round: 1 } },
        { kind: 'notes', contentBase64: encodeBase64(toBytes('notes text')) },
      ],
      event: {
        actor: AGENT,
        type: 'plan.completed',
        payload: {
          round: 1,
          artifact: { kind: 'plan', rev: placeholderRev(0) },
          note: placeholderRev(1),
        },
      },
    })
    // The response's real metas and event pass through unchanged.
    expect(write.event).toEqual(response.event as typeof write.event)
    expect(write.artifacts).toEqual(realMetas)
  })

  test('repo and session deposits scope their sentinels and pass the response through', async () => {
    const repoMeta = wireRepoArtifactMeta({ revision: 3 })
    const repoResponse = repoDepositsResponseSchema.parse({
      event: wireRepoEvent({ seq: 2 }),
      artifacts: [repoMeta],
    })
    const repo = makeStore([{ body: repoResponse }])
    const repoRevisions: number[] = []
    const repoWrite = await repo.store.appendRepoWithArtifacts(
      'acme/rate-limiter',
      [{ kind: 'config', content: 'c' }],
      (deposited) => {
        repoRevisions.push(deposited[0]!.revision)
        return harvestStartedWrite('h_1', deposited[0]!.revision)
      },
    )
    expect(repoRevisions).toEqual([placeholderRev(0)])
    expect(repo.calls[0]?.url).toBe('http://store.test/repos/acme%2Frate-limiter/deposits')
    const repoBody = repo.calls[0]?.body as { event: { payload: unknown } } | undefined
    expect(repoBody?.event.payload).toEqual(harvestStartedWrite('h_1', -1).payload)
    expect(repoWrite.event).toEqual(repoResponse.event as typeof repoWrite.event)
    expect(repoWrite.artifacts).toEqual([repoMeta])

    const sessionMeta = wireSessionArtifactMeta()
    const sessionResponse = sessionDepositsResponseSchema.parse({
      event: wireSessionEvent(),
      artifacts: [sessionMeta],
    })
    const session = makeStore([{ body: sessionResponse }])
    const sessionRevisions: number[] = []
    const sessionWrite = await session.store.appendSessionWithArtifacts(
      'os_1',
      [{ kind: 'plan', content: 'p' }],
      (deposited) => {
        sessionRevisions.push(deposited[0]!.revision)
        return turnStartedWrite('t1', `st_${deposited[0]!.revision}`)
      },
    )
    expect(sessionRevisions).toEqual([placeholderRev(0)])
    expect(session.calls[0]?.url).toBe('http://store.test/sessions/os_1/deposits')
    expect(sessionWrite.event).toEqual(sessionResponse.event as typeof sessionWrite.event)
    expect(sessionWrite.artifacts).toEqual([sessionMeta])
  })
})

// ── Error rehydration (D6/D8 client halves) ──────────────────────────────────

describe('error rehydration (D6/D8 client halves)', () => {
  test('401 and 403 rehydrate as AuthError with the server message (D8)', async () => {
    for (const status of [401, 403]) {
      const { store } = makeStore([
        { status, body: wireError('token scoped to build "other"', 'auth') },
      ])
      const err = await rejectionOf(store.append('build-a', sampleEventWrite()))
      expect(err).toBeInstanceOf(AuthError)
      expect(err.message).toBe('token scoped to build "other"')
    }
  })

  test('422 rehydrates as EventValidationError with the server message (D6)', async () => {
    const { store } = makeStore([
      {
        status: 422,
        body: wireError(
          'event "plan.completed" payload invalid: round must be a number',
          'validation',
        ),
      },
    ])
    const err = await rejectionOf(store.append('build-a', sampleEventWrite()))
    expect(err).toBeInstanceOf(EventValidationError)
    expect(err.message).toBe('event "plan.completed" payload invalid: round must be a number')
  })

  test('404 on a generic route rehydrates as a plain Error with the server message', async () => {
    const { store } = makeStore([
      { status: 404, body: wireError('unknown build "build-a"', 'not-found') },
    ])
    const err = await rejectionOf(store.append('build-a', sampleEventWrite()))
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(AuthError)
    expect(err).not.toBeInstanceOf(EventValidationError)
    expect(err.message).toBe('unknown build "build-a"')
  })

  test('typed stream rejections rehydrate by the server message shape', async () => {
    const batch = makeStore([
      {
        status: 413,
        body: wireError(
          'stream batch of 2000000 bytes exceeds the 1048576-byte ceiling',
          'validation',
        ),
      },
    ])
    const batchErr = await rejectionOf(
      batch.store.appendStreamParts('st_1', [{ type: 'text-delta', delta: 'x' }]),
    )
    expect(batchErr).toBeInstanceOf(StreamBatchTooLargeError)

    const closed = makeStore([
      { status: 409, body: wireError('stream "st_1" is closed', 'conflict') },
    ])
    const closedErr = await rejectionOf(
      closed.store.appendStreamParts('st_1', [{ type: 'text-delta', delta: 'x' }]),
    )
    expect(closedErr).toBeInstanceOf(StreamClosedError)

    // A 409 that is not a closed-stream append stays the generic conflict.
    const dupe = makeStore([
      { status: 409, body: wireError('build "build-a" already exists', 'conflict') },
    ])
    const dupeErr = await rejectionOf(dupe.store.append('build-a', sampleEventWrite()))
    expect(dupeErr).not.toBeInstanceOf(StreamClosedError)
    expect(dupeErr.message).toBe('build "build-a" already exists')
  })

  test('a non-protocol error body falls back to the status line', async () => {
    const { store } = makeStore([{ status: 500, body: { boom: true } }])
    expect((await rejectionOf(store.getBuild('build-a'))).message).toBe(
      'store server responded 500',
    )
  })

  test('a non-JSON gateway response also falls back to the status line', async () => {
    const { store } = makeStore([{ status: 502, jsonThrows: true }])
    expect((await rejectionOf(store.listBuilds())).message).toBe('store server responded 502')
  })
})

// ── Held reads and abort (AUT-380, client mirror) ────────────────────────────

describe('held reads and abort (AUT-380 client mirror)', () => {
  function abortingFetch(): typeof fetch {
    return (async () => {
      throw new DOMException('This operation was aborted', 'AbortError')
    }) as unknown as typeof fetch
  }

  function abortedSignal(): AbortSignal {
    const controller = new AbortController()
    controller.abort()
    return controller.signal
  }

  test('an aborted held read resolves empty on every held family', async () => {
    const cases = {
      getEvents: async (store: RemoteBuildStore, signal: AbortSignal) =>
        store.getEvents('build-a', 0, { signal }),
      getRepoEvents: async (store: RemoteBuildStore, signal: AbortSignal) =>
        store.getRepoEvents('acme/rate-limiter', 0, { signal }),
      getSessionEvents: async (store: RemoteBuildStore, signal: AbortSignal) =>
        store.getSessionEvents('os_1', 0, { signal }),
      readStream: async (store: RemoteBuildStore, signal: AbortSignal) =>
        store.readStream('st_1', { signal }),
    }
    for (const [name, act] of Object.entries(cases)) {
      const store = new RemoteBuildStore({ url: 'http://store.test', fetchFn: abortingFetch() })
      try {
        expect(await act(store, abortedSignal())).toEqual(
          name === 'readStream' ? { chunks: [], status: 'open' } : [],
        )
      } catch (error) {
        throw new Error(`held read "${name}" did not resolve empty: ${(error as Error).message}`)
      }
    }
  })

  test('a failure that is not the caller abort still rejects', async () => {
    const fetchFn = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const store = new RemoteBuildStore({ url: 'http://store.test', fetchFn })
    const signal = new AbortController().signal
    await expect(store.getEvents('build-a', 0, { signal })).rejects.toThrow('ECONNREFUSED')
    await expect(store.readStream('st_1', { signal })).rejects.toThrow('ECONNREFUSED')
  })

  test("the caller's signal is forwarded to fetch and not yet aborted", async () => {
    const { fetchFn, calls } = fakeFetch([{ body: [] }])
    const store = new RemoteBuildStore({ url: 'http://store.test', fetchFn })
    const controller = new AbortController()
    await store.getEvents('build-a', 0, { signal: controller.signal })
    expect(calls[0]?.signal).toBe(controller.signal)
    expect(calls[0]?.signal?.aborted).toBe(false)
  })
})

// ── Subscribe waits (AUT-334) ────────────────────────────────────────────────

describe('subscribe waits (AUT-334)', () => {
  test('a default subscribe long-polls with the bounded-wait window', async () => {
    const { fetchFn, calls } = fakeFetch([{ body: [] }])
    const store = new RemoteBuildStore({ url: 'http://store.test', fetchFn })
    // The first held read is issued synchronously by the poll loop.
    const stop = store.subscribe('build-a', {}, () => {})
    try {
      expect(calls[0]?.url).toBe(
        `http://store.test/builds/build-a/events?since=0&wait=${REMOTE_EVENT_WAIT_SECONDS}`,
      )
      expect(calls).toHaveLength(1)
    } finally {
      stop()
    }
  })

  test('waitSeconds: 0 forces the immediate interval loop without a wait parameter', async () => {
    const { fetchFn, calls } = fakeFetch([{ body: [] }, { body: [] }])
    const store = new RemoteBuildStore({ url: 'http://store.test', fetchFn })
    const stop = store.subscribe('build-a', { waitSeconds: 0 }, () => {})
    try {
      expect(calls[0]?.url).toBe('http://store.test/builds/build-a/events?since=0')
    } finally {
      stop()
    }
  })

  test('since pages forward across reads and delivery stays in order', async () => {
    const first = wireEvent({ seq: 1 })
    const second = wireEvent({ seq: 2 })
    const { fetchFn, calls } = fakeFetch([{ body: [first] }, { body: [second] }, { body: [] }])
    const store = new RemoteBuildStore({ url: 'http://store.test', fetchFn })
    const seen: number[] = []
    const stop = store.subscribe('build-a', { waitSeconds: 0, pollMs: 5 }, (event) =>
      seen.push(event.seq),
    )
    try {
      await waitFor(() => calls.length >= 2 && seen.length === 2, 'two delivered events')
      expect(calls[1]?.url).toBe('http://store.test/builds/build-a/events?since=1')
      expect(seen).toEqual([1, 2])
    } finally {
      stop()
    }
  })
})

// ── Scoped tokens (D8 — core owns minting and verification) ──────────────────

describe('scoped tokens (D8)', () => {
  const now = new Date(T0)
  const later = Date.parse(T0) + 60_000

  test('mint → verify round-trips every scope family', () => {
    const scopes: TokenScope[] = [
      { build: 'build-a', session: 's_9f2', exp: later },
      { resource: { kind: 'build', id: 'build-a' }, session: 's_9f2', exp: later },
      { resource: { kind: 'repo', id: 'acme/rate-limiter' }, session: '*', exp: later },
      {
        resource: { kind: 'session', id: 'os_1' },
        session: 'os_1',
        exp: later,
        via: { kind: 'session', id: 'os_1' },
      },
      { operator: { user: 'op' }, exp: later },
      { operator: { user: 'op' }, exp: later, via: { kind: 'mcp', client: 'ab' } },
      { operator: true, session: '*', exp: later },
    ]
    for (const scope of scopes) {
      expect(verifyToken('secret', mintToken('secret', scope), now)).toEqual(scope)
    }
  })

  test('a token minted with another secret → null', () => {
    const token = mintToken('other-secret', { build: 'build-a', session: 's_9f2', exp: later })
    expect(verifyToken('secret', token, now)).toBeNull()
  })

  test('expired (exp <= now) → null', () => {
    const atNow = mintToken('secret', { build: 'build-a', session: 's_9f2', exp: now.getTime() })
    expect(verifyToken('secret', atNow, now)).toBeNull()
    const past = mintToken('secret', { build: 'build-a', session: 's_9f2', exp: now.getTime() - 1 })
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
