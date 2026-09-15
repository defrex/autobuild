/**
 * The seam test the remote store exists for (SPEC §7.2 adapter 2): the full
 * BuildStore contract runs against RemoteBuildStore → in-process HTTP →
 * MemoryBuildStore, plus the properties that only exist over the wire —
 * D8 scoped tokens, D6 validation-as-feedback surviving serialization, and
 * atomic deposits via the placeholder-ref convention.
 */
import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { EventValidationError, type EventWrite } from '../../events/catalog'
import { agentActor, DISPATCHER, KERNEL, humanActor, type Via } from '../../events/envelope'
import { manualClock } from '../../testing/fixed'
import {
  buildCreatedWrite,
  CONTRACT_T0,
  describeBuildStoreContract,
  sampleBuildInput,
  sampleEventWrite,
} from '../contract'
import { BuildScopeError } from '../build-scope'
import { MemoryBuildStore } from '../memory'
import { StreamBatchTooLargeError, StreamClosedError } from '../streams/types'
import { textContent } from '../types'
import { AuthError, RemoteBuildStore } from './client'
import { createStoreServer, startStoreServer } from './server'
import { mintToken, verifyToken } from './token'
import {
  AUTOBUILD_VERSION,
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
} from './version'

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

describe('D8 scope enforcement over the wire', () => {
  const SECRET = 'store-secret'
  const EXP = Date.parse(CONTRACT_T0) + 3_600_000

  interface SecureCtx {
    url: string
    clock: ReturnType<typeof manualClock>
    backing: MemoryBuildStore
    admin: RemoteBuildStore
  }

  async function withSecureStore(run: (ctx: SecureCtx) => Promise<void>): Promise<void> {
    const clock = manualClock(CONTRACT_T0)
    const backing = new MemoryBuildStore({ clock })
    const server = startStoreServer({ store: backing, secret: SECRET, clock })
    const admin = new RemoteBuildStore({
      url: server.url,
      token: mintToken(SECRET, { build: '*', session: '*', exp: EXP }),
    })
    try {
      await run({ url: server.url, clock, backing, admin })
    } finally {
      await server.stop()
    }
  }

  // Session defaults to sampleEventWrite's actor session, so build-scope
  // tests exercise the build dimension in isolation.
  function scopedClient(url: string, build: string, session = 's_test'): RemoteBuildStore {
    return new RemoteBuildStore({
      url,
      token: mintToken(SECRET, { build, session, exp: EXP }),
    })
  }

  test('a build-scoped token can append to and read its own build', async () => {
    await withSecureStore(async ({ url, admin }) => {
      await admin.createBuild(sampleBuildInput('build-a'))
      const clientA = scopedClient(url, 'build-a')
      const envelope = await clientA.append('build-a', sampleEventWrite('mine'))
      expect(envelope.seq).toBe(1)
      expect((await clientA.getEvents('build-a')).length).toBe(1)
      const meta = await clientA.putArtifact('build-a', { kind: 'plan', content: 'p' })
      expect(meta.revision).toBe(0)
      expect(textContent((await clientA.getArtifact('build-a', 'plan'))!)).toBe('p')
    })
  })

  test('the same token against another build → 403 AuthError, log unchanged', async () => {
    await withSecureStore(async ({ url, admin, backing }) => {
      await admin.createBuild(sampleBuildInput('build-a'))
      await admin.createBuild(sampleBuildInput('build-b'))
      const clientA = scopedClient(url, 'build-a')

      const writeErr = await clientA
        .append('build-b', sampleEventWrite('sneaky'))
        .catch((e: unknown) => e)
      expect(writeErr).toBeInstanceOf(AuthError)
      expect((writeErr as Error).message).toContain('scoped to build "build-a"')

      const readErr = await clientA.getEvents('build-b').catch((e: unknown) => e)
      expect(readErr).toBeInstanceOf(AuthError)

      // B's log is physically untouched (checked on the backing store).
      expect(await backing.getEvents('build-b')).toEqual([])
    })
  })

  test('a session-scoped token only writes events attributed to its session (D8, §8.1)', async () => {
    await withSecureStore(async ({ url, admin, backing }) => {
      await admin.createBuild(sampleBuildInput('build-a'))
      const client = scopedClient(url, 'build-a', 's_one')

      // Its own session: allowed.
      const mine = await client.append('build-a', {
        ...sampleEventWrite('mine'),
        actor: agentActor('implement', 's_one'),
      })
      expect(mine.seq).toBe(1)

      const conditional = await client.appendIfCurrent('build-a', 1, {
        ...sampleEventWrite('conditional mine'),
        actor: agentActor('implement', 's_one'),
      })
      expect(conditional?.seq).toBe(2)

      const conditionalForged = await client
        .appendIfCurrent('build-a', 2, {
          ...sampleEventWrite('conditional forged'),
          actor: agentActor('implement', 's_two'),
        })
        .catch((error: unknown) => error)
      expect(conditionalForged).toBeInstanceOf(AuthError)

      // Another agent session → 403 AuthError, log unchanged.
      const forged = await client
        .append('build-a', {
          ...sampleEventWrite('forged'),
          actor: agentActor('implement', 's_two'),
        })
        .catch((e: unknown) => e)
      expect(forged).toBeInstanceOf(AuthError)
      expect((forged as Error).message).toContain('scoped to session "s_one"')

      // A non-agent actor is not attributable to the session → 403 too.
      const asDispatcher = await client
        .append('build-a', buildCreatedWrite())
        .catch((e: unknown) => e)
      expect(asDispatcher).toBeInstanceOf(AuthError)

      // Deposits carry an event → the same gate; nothing persists.
      const deposit = await client
        .appendWithArtifacts('build-a', [{ kind: 'plan', content: 'p' }], (deposited) => ({
          actor: agentActor('plan', 's_two'),
          type: 'plan.completed',
          payload: {
            round: 1,
            artifact: { kind: 'plan', rev: deposited[0]!.revision },
            verifySteps: ['types', 'unit'],
          },
        }))
        .catch((e: unknown) => e)
      expect(deposit).toBeInstanceOf(AuthError)
      expect(await backing.getEvents('build-a')).toHaveLength(2)
      expect(await backing.listArtifacts('build-a')).toEqual([])

      // Reads stay gated by build scope alone.
      expect((await client.getEvents('build-a')).length).toBe(2)

      // The '*'-session admin token writes on behalf of any session.
      const anySession = await admin.append('build-a', {
        ...sampleEventWrite('admin write'),
        actor: agentActor('implement', 's_two'),
      })
      expect(anySession.seq).toBe(3)
    })
  })

  test('a repo/session token can use only its harvest journal and cannot read builds', async () => {
    await withSecureStore(async ({ url, admin, backing }) => {
      await admin.createBuild(sampleBuildInput('build-a'))
      await admin.ensureRepo('acme/repo')
      await admin.appendRepoWithArtifacts(
        'acme/repo',
        [{ kind: 'harvest-scan', content: '{}' }],
        (deposited) => ({
          actor: KERNEL,
          type: 'harvest.started',
          payload: {
            run: 'h_1',
            observations: [{ build: 'build-a', seq: 1 }],
            scan: { kind: deposited[0]!.kind, rev: deposited[0]!.revision },
          },
        }),
      )
      const client = new RemoteBuildStore({
        url,
        token: mintToken(SECRET, {
          resource: { kind: 'repo', id: 'acme/repo' },
          session: 'hs_one',
          exp: EXP,
        }),
      })
      await client.appendRepoWithArtifacts(
        'acme/repo',
        [{ kind: 'harvest-proposals', content: '{}' }],
        (deposited) => ({
          actor: agentActor('harvest', 'hs_one'),
          type: 'harvest.proposals.submitted',
          payload: {
            run: 'h_1',
            round: 1,
            artifact: { kind: deposited[0]!.kind, rev: deposited[0]!.revision },
          },
        }),
      )
      expect(await client.getRepoEvents('acme/repo')).toHaveLength(2)
      const wrongSession = await client
        .appendRepo('acme/repo', {
          actor: agentActor('harvest', 'hs_two'),
          type: 'harvest.proposals.submitted',
          payload: {
            run: 'h_1',
            round: 2,
            artifact: { kind: 'harvest-proposals', rev: 0 },
          },
        })
        .catch((error: unknown) => error)
      expect(wrongSession).toBeInstanceOf(AuthError)
      const spoofedHumanSetting = await client
        .appendRepo('acme/repo', {
          actor: humanActor('operator'),
          type: 'dispatcher.intake-set',
          payload: { enabled: false },
        })
        .catch((error: unknown) => error)
      expect(spoofedHumanSetting).toBeInstanceOf(AuthError)
      expect((spoofedHumanSetting as Error).message).toContain(
        'may not write events attributed to a non-agent actor',
      )
      expect(await backing.getRepoEvents('acme/repo')).toHaveLength(2)
      expect(await client.getEvents('build-a').catch((error: unknown) => error)).toBeInstanceOf(
        AuthError,
      )
    })
  })

  test('an expired token → 401 AuthError', async () => {
    await withSecureStore(async ({ url, admin, clock }) => {
      await admin.createBuild(sampleBuildInput('build-a'))
      const clientA = scopedClient(url, 'build-a')
      expect((await clientA.getEvents('build-a')).length).toBe(0)
      clock.advance(3_600_001) // server-side clock passes EXP
      const err = await clientA.getEvents('build-a').catch((e: unknown) => e)
      expect(err).toBeInstanceOf(AuthError)
      expect((err as Error).message).toContain('invalid or expired')
    })
  })

  test('the admin "*" token lists and creates builds; a build token may not', async () => {
    await withSecureStore(async ({ url, admin }) => {
      await admin.createBuild(sampleBuildInput('build-a'))
      expect((await admin.listBuilds()).map((b) => b.slug)).toEqual(['build-a'])

      const clientA = scopedClient(url, 'build-a')
      const listErr = await clientA.listBuilds().catch((e: unknown) => e)
      expect(listErr).toBeInstanceOf(AuthError)
      const createErr = await clientA
        .createBuild(sampleBuildInput('build-c'))
        .catch((e: unknown) => e)
      expect(createErr).toBeInstanceOf(AuthError)
    })
  })

  test('interface scope constrains even an admin-token remote client before transport', async () => {
    await withSecureStore(async ({ admin }) => {
      await admin.createBuild(sampleBuildInput('build-a'))
      await admin.createBuild(sampleBuildInput('build-b'))
      await admin.ensureRepo('acme/repo')
      const scoped = admin.scopeBuild('build-a')
      expect(await scoped.getEvents('build-a')).toEqual([])
      expect(await scoped.getEvents('build-b').catch((error: unknown) => error)).toBeInstanceOf(
        BuildScopeError,
      )
      expect(await scoped.listBuilds().catch((error: unknown) => error)).toBeInstanceOf(
        BuildScopeError,
      )
      expect(
        await scoped.getRepoEvents('acme/repo').catch((error: unknown) => error),
      ).toBeInstanceOf(BuildScopeError)
    })
  })

  test('no token → 401; /health stays open', async () => {
    await withSecureStore(async ({ url, admin }) => {
      await admin.createBuild(sampleBuildInput('build-a'))
      const anon = new RemoteBuildStore({ url })
      const err = await anon.getEvents('build-a').catch((e: unknown) => e)
      expect(err).toBeInstanceOf(AuthError)
      expect((err as Error).message).toContain('missing bearer token')

      const health = await fetch(`${url}/health`)
      expect(health.status).toBe(200)
      expect(await health.json()).toEqual({
        ok: true,
        autobuildVersion: AUTOBUILD_VERSION,
        protocolVersion: REMOTE_STORE_PROTOCOL_VERSION,
      })
    })
  })
})

// ── Open-server harness for the D6 wire tests ────────────────────────────────

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

// ── Stream wire specifics (SPEC §7.6) ────────────────────────────────────
// Beyond the shared contract: token scope on the stream routes, cross-scope
// addressing, and the typed error mappings (413 ceiling, 409 closed append).

describe('stream wire specifics', () => {
  const SECRET = 'stream-secret'
  const EXP = Date.parse(CONTRACT_T0) + 3_600_000

  test('token scope gates the stream routes like the events routes; cross-scope addressing is 404', async () => {
    const clock = manualClock(CONTRACT_T0)
    const backing = new MemoryBuildStore({ clock })
    const server = startStoreServer({ store: backing, secret: SECRET, clock })
    const admin = new RemoteBuildStore({
      url: server.url,
      token: mintToken(SECRET, { build: '*', session: '*', exp: EXP }),
    })
    try {
      await admin.createBuild(sampleBuildInput('wire-a'))
      await admin.createBuild(sampleBuildInput('wire-b'))
      await admin.ensureRepo('acme/wire')
      const streamA = await admin.createStream({ kind: 'build', build: 'wire-a' }, 'a')
      const repoStream = await admin.createStream({ kind: 'repo', repo: 'acme/wire' }, 'r')

      // A build-scoped token uses its own streams end to end.
      const clientA = new RemoteBuildStore({
        url: server.url,
        token: mintToken(SECRET, { build: 'wire-a', session: '*', exp: EXP }),
      })
      const chunk = await clientA.appendStreamParts(streamA.id, [
        { type: 'text-delta', id: 't', delta: 'x' },
      ])
      expect(chunk.seq).toBe(1)
      expect((await clientA.readStream(streamA.id)).chunks).toHaveLength(1)
      expect(
        (await clientA.listStreams({ kind: 'build', build: 'wire-a' })).map((r) => r.id),
      ).toEqual([streamA.id])

      // Another build's token: 403 AuthError on every shape.
      const clientB = new RemoteBuildStore({
        url: server.url,
        token: mintToken(SECRET, { build: 'wire-b', session: '*', exp: EXP }),
      })
      for (const attempt of [
        () => clientB.appendStreamParts(streamA.id, [{ type: 'text-delta', id: 't', delta: 'y' }]),
        () => clientB.readStream(streamA.id),
        () => clientB.closeStream(streamA.id, 'completed'),
        () => clientB.getStream(streamA.id),
        () => clientB.listStreams({ kind: 'build', build: 'wire-a' }),
      ]) {
        const err = await attempt().catch((e: unknown) => e)
        expect(err).toBeInstanceOf(AuthError)
      }

      // A repo token cannot touch build streams and vice versa.
      const repoClient = new RemoteBuildStore({
        url: server.url,
        token: mintToken(SECRET, {
          resource: { kind: 'repo', id: 'acme/wire' },
          session: '*',
          exp: EXP,
        }),
      })
      const repoErr = await repoClient
        .appendStreamParts(streamA.id, [{ type: 'text-delta', id: 't', delta: 'z' }])
        .catch((e: unknown) => e)
      expect(repoErr).toBeInstanceOf(AuthError)
      const buildErr = await clientA
        .appendStreamParts(repoStream.id, [{ type: 'text-delta', id: 't', delta: 'z' }])
        .catch((e: unknown) => e)
      expect(buildErr).toBeInstanceOf(AuthError)

      // Unknown stream id → 404 → null (getStream), Error elsewhere.
      expect(await clientA.getStream('st_nope')).toBeNull()
      const unknownErr = await clientA.readStream('st_nope').catch((e: unknown) => e)
      expect((unknownErr as Error).message).toContain('unknown stream')
    } finally {
      await admin.close()
      await server.stop()
    }
  })

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

describe('session token scope and via attribution over the wire', () => {
  const SECRET = 'session-secret'
  const EXP = Date.parse(CONTRACT_T0) + 3_600_000

  interface Ctx {
    url: string
    admin: RemoteBuildStore
    backing: MemoryBuildStore
  }

  async function withServer(run: (ctx: Ctx) => Promise<void>): Promise<void> {
    const backing = new MemoryBuildStore({ clock: manualClock(CONTRACT_T0) })
    const server = startStoreServer({
      store: backing,
      secret: SECRET,
      clock: manualClock(CONTRACT_T0),
    })
    const admin = new RemoteBuildStore({
      url: server.url,
      token: mintToken(SECRET, { build: '*', session: '*', exp: EXP }),
    })
    try {
      await run({ url: server.url, admin, backing })
    } finally {
      await admin.close()
      await server.stop()
    }
  }

  function token(
    scope:
      | { resource: { kind: 'session' | 'repo'; id: string }; session: string; via?: unknown }
      | { operator: { user: string }; via?: unknown },
  ): string {
    return 'via' in scope && scope.via !== undefined
      ? mintToken(SECRET, {
          ...(scope as { resource: { kind: 'session' | 'repo'; id: string }; session: string }),
          exp: EXP,
          via: scope.via as never,
        })
      : 'operator' in scope
        ? mintToken(SECRET, {
            operator: { user: (scope as { operator: { user: string } }).operator.user },
            exp: EXP,
          })
        : mintToken(SECRET, {
            ...(scope as { resource: { kind: 'session' | 'repo'; id: string }; session: string }),
            exp: EXP,
          })
  }

  test('a session resource token gates exactly its own session and cannot create or list', async () => {
    await withServer(async ({ url, admin }) => {
      await admin.ensureRepo('acme/sessions')
      const mine = await admin.createSession({ repo: 'acme/sessions', operator: 'op' })
      const other = await admin.createSession({ repo: 'acme/sessions', operator: 'op' })
      const client = new RemoteBuildStore({
        url,
        token: token({ resource: { kind: 'session', id: mine.id }, session: '*' }),
      })

      // Own session: full family works.
      expect(await client.getSession(mine.id)).not.toBeNull()
      await client.appendSessionEvent(mine.id, {
        actor: humanActor('op'),
        type: 'message.posted',
        payload: { text: 'mine' },
      })
      expect((await client.getSessionEvents(mine.id)).map((e) => e.seq)).toEqual([1, 2])
      const stream = await client.createStream({ kind: 'session', session: mine.id }, 'turn')
      await client.appendStreamParts(stream.id, [{ type: 'text-delta', id: 't', delta: 'x' }])
      expect(
        (await client.listStreams({ kind: 'session', session: mine.id })).map((r) => r.id),
      ).toEqual([stream.id])

      // Foreign session, create, and list: 403 AuthError.
      for (const attempt of [
        () => client.getSession(other.id),
        () =>
          client.appendSessionEvent(other.id, {
            actor: humanActor('op'),
            type: 'message.posted',
            payload: { text: 'no' },
          }),
        () => client.listSessions('acme/sessions'),
        () => client.createSession({ repo: 'acme/sessions', operator: 'op' }),
      ]) {
        const err = await attempt().catch((e: unknown) => e)
        expect(err).toBeInstanceOf(AuthError)
      }

      // A repo token owns the collection routes but not a foreign session.
      const repoClient = new RemoteBuildStore({
        url,
        token: token({ resource: { kind: 'repo', id: 'acme/sessions' }, session: '*' }),
      })
      expect((await repoClient.listSessions('acme/sessions')).map((s) => s.id)).toEqual([
        mine.id,
        other.id,
      ])
      const created = await repoClient.createSession({
        repo: 'acme/sessions',
        operator: 'op',
        title: 'from repo token',
      })
      expect(created.id).toMatch(/^os_/)
      const foreignErr = await repoClient.getSession(mine.id).catch((e: unknown) => e)
      expect(foreignErr).toBeInstanceOf(AuthError)
    })
  })

  test('via stamping and rejection follow the token, not the write', async () => {
    await withServer(async ({ url, admin, backing }) => {
      await admin.createBuild(sampleBuildInput('via-wire'))
      const via: Via = { kind: 'session', id: 'os_delegate' }
      const otherVia: Via = { kind: 'mcp', client: 'claude-code' }

      // A via-carrying resource token stamps its via onto human writes.
      const stamped = new RemoteBuildStore({
        url,
        token: mintToken(SECRET, {
          resource: { kind: 'build', id: 'via-wire' },
          session: '*',
          exp: EXP,
          via: via as never,
        }),
      })
      const envelope = await stamped.append('via-wire', {
        actor: humanActor('operator'),
        type: 'build.pause-requested',
        payload: {},
      })
      expect(envelope.actor).toEqual({ kind: 'human', user: 'operator', via })

      // A human write claiming a via the token carries is accepted unchanged.
      const claimed = await stamped.append('via-wire', {
        actor: humanActor('operator', via as never),
        type: 'build.resume-requested',
        payload: {},
      })
      expect(claimed.actor).toEqual({ kind: 'human', user: 'operator', via })

      // A human write claiming a different via → 403 AuthError.
      const mismatch = await stamped
        .append('via-wire', {
          actor: humanActor('operator', otherVia as never),
          type: 'build.pause-requested',
          payload: {},
        })
        .catch((e: unknown) => e)
      expect(mismatch).toBeInstanceOf(AuthError)

      // A token without via rejects any write claiming one.
      const unscoped = new RemoteBuildStore({
        url,
        token: token({ operator: { user: 'op' } }),
      })
      // Operator tokens never authorize raw store routes at all.
      const operatorErr = await unscoped
        .append('via-wire', {
          actor: humanActor('operator'),
          type: 'build.pause-requested',
          payload: {},
        })
        .catch((e: unknown) => e)
      expect(operatorErr).toBeInstanceOf(AuthError)

      // A via-carrying resource token rejects a claim when the write carries
      // one and the token does not.
      const plainResource = new RemoteBuildStore({
        url,
        token: mintToken(SECRET, {
          resource: { kind: 'build', id: 'via-wire' },
          session: '*',
          exp: EXP,
        }),
      })
      const claimedErr = await plainResource
        .append('via-wire', {
          actor: humanActor('operator', via as never),
          type: 'build.pause-requested',
          payload: {},
        })
        .catch((e: unknown) => e)
      expect(claimedErr).toBeInstanceOf(AuthError)

      // The backing log holds exactly the stamped writes, in order.
      const events = await backing.getEvents('via-wire')
      expect(events.map((e) => (e.actor as { via?: unknown }).via ?? null)).toEqual([via, via])
    })
  })
})
