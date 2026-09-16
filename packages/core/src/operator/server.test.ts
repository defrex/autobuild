import { describe, expect, test } from 'bun:test'
import { parseConfig } from '../config/load'
import { agentActor, DISPATCHER, KERNEL } from '../events/envelope'
import { MemoryBuildStore } from '../store/memory'
import { RemoteBuildStore } from '../store/remote/client'
import { createStoreServer } from '../store/remote/server'
import { mintToken, tokenResource, verifyToken } from '../store/remote/token'
import {
  AUTOBUILD_VERSION,
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
} from '../store/remote/version'
import { OperatorApiClient, OperatorApiError } from './client'
import { createOperatorServer, REGISTRY_ERROR_STATUS } from './server'

const now = new Date('2026-09-02T00:00:00.000Z')
const clock = () => now
const secret = 'operator-test-secret'
const repo = 'acme/widgets'

function fetchFor(server: { fetch(req: Request): Promise<Response> }): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    server.fetch(
      input instanceof Request ? new Request(input, init) : new Request(String(input), init),
    )) as typeof fetch
}

const DASHBOARD_CONFIG = parseConfig(`
capacity = 2
[tickets]
source = "file"
readyState = "ready"
[verify]
steps = []
[finalize]
steps = []
`)

async function publishConfig(store: MemoryBuildStore): Promise<void> {
  await store.ensureRepo(repo)
  const { verify, finalize, ...root } = DASHBOARD_CONFIG
  const artifact = await store.putRepoArtifact(repo, {
    kind: 'dispatcher-effective-config',
    content: JSON.stringify({
      ...root,
      verify: { steps: verify.steps, ...verify.stepConfigs },
      finalize: { steps: finalize.steps, ...finalize.stepConfigs },
    }),
  })
  await store.appendRepo(repo, {
    actor: DISPATCHER,
    type: 'dispatcher.run-started',
    payload: {
      run: 'dispatch-1',
      pid: 123,
      effectiveConfig: { kind: artifact.kind, rev: artifact.revision },
      roleWarnings: [],
    },
  })
}

async function runningStore(): Promise<MemoryBuildStore> {
  const store = new MemoryBuildStore({ clock })
  await store.createBuild({ slug: 'demo', repo, ticket: { source: 'linear', id: 'AUT-1' } })
  await store.append('demo', {
    actor: DISPATCHER,
    type: 'build.created',
    payload: {
      ticket: { source: 'linear', id: 'AUT-1' },
      repo,
      baseBranch: 'main',
    },
  })
  await store.append('demo', {
    actor: KERNEL,
    type: 'runner.attached',
    payload: { instance: 'runner-1', host: 'host-1' },
  })
  return store
}

async function artifactRequest(store: MemoryBuildStore, rev?: string): Promise<Response> {
  const query = rev === undefined ? '' : `?rev=${encodeURIComponent(rev)}`
  return createOperatorServer({ store, secret, clock }).fetch(
    new Request(
      `http://operator.test/operator/v1/repos/${encodeURIComponent(repo)}/builds/demo/artifacts/notes${query}`,
      {
        headers: {
          authorization: `Bearer ${mintToken(secret, { operator: { user: 'Ada' }, exp: now.getTime() + 60_000 })}`,
          [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
          [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
        },
      },
    ),
  )
}

async function storeWithArtifactRevisions(): Promise<MemoryBuildStore> {
  const store = await runningStore()
  await store.putArtifact('demo', { kind: 'notes', content: 'revision zero' })
  await store.putArtifact('demo', { kind: 'notes', content: 'revision one' })
  return store
}

describe('operator HTTP API', () => {
  test('operator token claims are strict and identify a distinct resource', () => {
    const valid = mintToken(secret, {
      operator: { user: 'Ada' },
      exp: now.getTime() + 60_000,
    })
    const scope = verifyToken(secret, valid, now)
    expect(scope).not.toBeNull()
    expect(tokenResource(scope!)).toEqual({ kind: 'operator', id: 'Ada' })
    const blank = mintToken(secret, {
      operator: { user: '   ' },
      exp: now.getTime() + 60_000,
    })
    expect(verifyToken(secret, blank, now)).toBeNull()
  })

  test('requires operator scope and attributes controls to its signed user', async () => {
    const store = await runningStore()
    const server = createOperatorServer({ store, secret, clock })
    const operatorToken = mintToken(secret, {
      operator: { user: 'Ada Lovelace' },
      exp: now.getTime() + 60_000,
    })
    const client = new OperatorApiClient({
      url: 'http://operator.test',
      token: operatorToken,
      fetchFn: fetchFor(server),
    })

    expect((await client.listBuilds(repo, 'all')).map((build) => build.slug)).toEqual(['demo'])
    await client.controlBuild(repo, 'demo', { action: 'pause' })
    expect((await store.getEvents('demo')).at(-1)).toMatchObject({
      actor: { kind: 'human', user: 'Ada Lovelace' },
      type: 'build.pause-requested',
      payload: {},
    })

    const admin = new OperatorApiClient({
      url: 'http://operator.test',
      token: mintToken(secret, { build: '*', session: '*', exp: now.getTime() + 60_000 }),
      fetchFn: fetchFor(server),
    })
    const error = await admin.listBuilds(repo).catch((caught) => caught)
    expect(error).toBeInstanceOf(OperatorApiError)
    expect(error).toMatchObject({ status: 403, kind: 'auth' })
  })

  test('operator scope cannot use raw store authority and downloads binary artifacts', async () => {
    const store = await runningStore()
    const token = mintToken(secret, {
      operator: { user: 'Grace' },
      exp: now.getTime() + 60_000,
    })
    const storeServer = createStoreServer({ store, secret, clock })
    const raw = new RemoteBuildStore({
      url: 'http://store.test',
      token,
      fetchFn: fetchFor(storeServer),
    })
    await expect(raw.getBuild('demo')).rejects.toThrow('may not access build "demo"')

    await store.putArtifact('demo', { kind: 'notes/report', content: new Uint8Array([0, 1, 255]) })
    const operatorServer = createOperatorServer({ store, secret, clock })
    const client = new OperatorApiClient({
      url: 'http://operator.test',
      token,
      fetchFn: fetchFor(operatorServer),
    })
    const artifact = await client.downloadArtifact(repo, 'demo', 'notes/report', 0)
    expect([...artifact.content]).toEqual([0, 1, 255])
    expect(artifact).toMatchObject({ kind: 'notes/report', revision: 0 })
  })

  describe('artifact revision query validation', () => {
    test('an omitted revision selects the latest artifact', async () => {
      const response = await artifactRequest(await storeWithArtifactRevisions())

      expect(response.status).toBe(200)
      expect(response.headers.get('x-autobuild-artifact-revision')).toBe('1')
      expect(await response.text()).toBe('revision one')
    })

    test('a valid decimal revision retrieves the requested artifact', async () => {
      const response = await artifactRequest(await storeWithArtifactRevisions(), '1')

      expect(response.status).toBe(200)
      expect(response.headers.get('x-autobuild-artifact-revision')).toBe('1')
      expect(await response.text()).toBe('revision one')
    })

    test('the lower boundary revision zero is accepted', async () => {
      const response = await artifactRequest(await storeWithArtifactRevisions(), '0')

      expect(response.status).toBe(200)
      expect(response.headers.get('x-autobuild-artifact-revision')).toBe('0')
      expect(await response.text()).toBe('revision zero')
    })

    test('the upper safe-integer boundary passes validation', async () => {
      const response = await artifactRequest(
        await storeWithArtifactRevisions(),
        String(Number.MAX_SAFE_INTEGER),
      )

      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({ kind: 'not-found' })
    })

    test.each([
      ['empty', ''],
      ['whitespace', ' '],
      ['hexadecimal', '0x1'],
      ['exponent', '1e0'],
      ['fractional', '1.0'],
      ['infinite', 'Infinity'],
      ['NaN', 'NaN'],
      ['signed', '+1'],
      ['negative', '-1'],
      ['trailing characters', '1junk'],
      ['above the safe-integer range', '9007199254740992'],
    ] as const)('rejects a supplied %s revision', async (_label, rev) => {
      const response = await artifactRequest(await storeWithArtifactRevisions(), rev)

      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ kind: 'validation' })
    })
  })

  test('per-build projection retains aborted cleanup rows until completion', async () => {
    const store = await runningStore()
    await publishConfig(store)
    await store.append('demo', { actor: KERNEL, type: 'build.aborted', payload: {} })
    const server = createOperatorServer({ store, secret, clock })
    const client = new OperatorApiClient({
      url: 'http://operator.test',
      token: mintToken(secret, { operator: { user: 'Ada' }, exp: now.getTime() + 60_000 }),
      fetchFn: fetchFor(server),
    })
    const build = await client.getBuild(repo, 'demo')
    expect(build.dashboardRow).toMatchObject({ slug: 'demo', status: 'cleaning' })
    expect(build.dashboardRow).not.toBeNull()
    expect((await client.dashboard(repo)).model.builds).toContainEqual(build.dashboardRow!)
  })

  test('cross-repository builds are consistently hidden and retry rejects text', async () => {
    const store = await runningStore()
    const client = new OperatorApiClient({
      url: 'http://operator.test',
      token: mintToken(secret, { operator: { user: 'Ada' }, exp: now.getTime() + 60_000 }),
      fetchFn: fetchFor(createOperatorServer({ store, secret, clock })),
    })
    for (const call of [
      () => client.getBuild('/another-repo', 'demo'),
      () => client.controlBuild('/another-repo', 'demo', { action: 'pause' }),
      () => client.answer('/another-repo', 'demo', { resolution: 'retry' }),
      () => client.downloadArtifact('/another-repo', 'demo', 'notes'),
    ]) {
      const error = await call().catch((caught) => caught)
      expect(error).toMatchObject({ status: 404, kind: 'not-found' })
      expect((error as Error).message).toBe('unknown build "demo"')
    }

    const response = await fetchFor(createOperatorServer({ store, secret, clock }))(
      `http://operator.test/operator/v1/repos/${encodeURIComponent(repo)}/builds/demo/answer`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${mintToken(secret, { operator: { user: 'Ada' }, exp: now.getTime() + 60_000 })}`,
          [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
          [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ resolution: 'retry', text: 'stray guidance' }),
      },
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ kind: 'validation' })
  })

  test('version validation precedes authentication and terminal refusal text survives', async () => {
    const store = await runningStore()
    await store.append('demo', {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: 'merged' },
    })
    const server = createOperatorServer({ store, secret, clock })
    const skew = await server.fetch(
      new Request(`http://operator.test/operator/v1/repos/${encodeURIComponent(repo)}/builds`),
    )
    expect(skew.status).toBe(409)
    expect(await skew.json()).toMatchObject({ kind: 'conflict' })

    const client = new OperatorApiClient({
      url: 'http://operator.test',
      token: mintToken(secret, { operator: { user: 'Ada' }, exp: now.getTime() + 60_000 }),
      fetchFn: fetchFor(server),
    })
    const error = await client
      .controlBuild(repo, 'demo', { action: 'pause' })
      .catch((caught) => caught)
    expect(error).toMatchObject({ status: 409, kind: 'refusal', code: 'inactive' })
    expect((error as Error).message).toBe(
      'build "demo" is not active (status: done); build controls require running, paused, or blocked',
    )
  })
})

describe('operator session routes', () => {
  const AGENT = agentActor('orchestrator', 'os_turn')

  function operatorClient(
    server: { fetch(req: Request): Promise<Response> },
    user: string,
  ): OperatorApiClient {
    return new OperatorApiClient({
      url: 'http://operator.test',
      token: mintToken(secret, { operator: { user }, exp: now.getTime() + 60_000 }),
      fetchFn: fetchFor(server),
    })
  }

  async function startTurn(store: MemoryBuildStore, sessionId: string): Promise<string> {
    const stream = await store.createStream({ kind: 'session', session: sessionId }, 'turn t1')
    await store.appendSessionEvent(sessionId, {
      actor: AGENT,
      type: 'turn.started',
      payload: { turn: 't1', stream: stream.id, trigger: { kind: 'message', messageSeq: 2 } },
    })
    await store.appendStreamParts(stream.id, [{ type: 'text-delta', id: 't', delta: 'working' }])
    return stream.id
  }

  test('requires an operator token; raw store and deployment tokens are 403', async () => {
    const store = await runningStore()
    const server = createOperatorServer({ store, secret, clock })
    for (const token of [
      mintToken(secret, { build: '*', session: '*', exp: now.getTime() + 60_000 }),
      mintToken(secret, { operator: true, session: '*', exp: now.getTime() + 60_000 }),
    ]) {
      const response = await server.fetch(
        new Request(`http://operator.test/operator/v1/repos/${encodeURIComponent(repo)}/sessions`, {
          headers: {
            authorization: `Bearer ${token}`,
            [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
            [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
          },
        }),
      )
      expect(response.status).toBe(403)
    }
  })

  test('session lifecycle: ownership, attribution, approval matching, archive, turn stream', async () => {
    const store = new MemoryBuildStore({ clock })
    const server = createOperatorServer({ store, secret, clock })
    const ada = operatorClient(server, 'Ada')
    const bob = operatorClient(server, 'Bob')

    // Create: attributed to the signed-in operator.
    const created = await ada.createSession(repo, { title: 'orchestrator' })
    expect(created.id).toMatch(/^os_/)
    expect(created.operator).toBe('Ada')
    const foreign = await bob.createSession(repo, { title: 'bob' })

    // List: both sessions of the repo, newest update first (with a frozen
    // clock the insertion order stands in for the tie-break).
    expect((await bob.listSessions(repo)).map((s) => s.id).sort()).toEqual(
      [foreign.id, created.id].sort(),
    )

    // A turn on Ada's session so views have content.
    await startTurn(store, created.id)
    const view = await bob.getSession(repo, created.id)
    expect(view.session.operator).toBe('Ada')
    expect(view.state.status).toBe('running')
    expect(view.turns).toEqual([
      {
        turn: 't1',
        stream: expect.any(String),
        startedSeq: 2,
        trigger: { kind: 'message', messageSeq: 2 },
        state: 'open',
      },
    ])

    // Same-repo operators read but cannot write to someone else's session.
    await expect(bob.postSessionMessage(repo, created.id, { text: 'hi' })).rejects.toMatchObject({
      status: 403,
    })
    await expect(bob.archiveSession(repo, created.id)).rejects.toMatchObject({ status: 403 })
    await expect(
      bob.answerSessionApproval(repo, created.id, {
        turn: 't1',
        toolCallId: 'c1',
        decision: 'approve',
      }),
    ).rejects.toMatchObject({ status: 403 })
    await expect(bob.getSession(repo, created.id)).resolves.toBeDefined()

    // Owner writes are attributed to the signed-in operator, never a
    // client-supplied identity, and never carry a via marker.
    await ada.postSessionMessage(repo, created.id, { text: 'fix the login flow' })
    await ada.setSessionWake(repo, created.id, { globs: ['escalation.raised'] })
    const events = await store.getSessionEvents(created.id)
    for (const event of events) {
      expect((event.actor as { via?: unknown }).via).toBeUndefined()
      if (event.type !== 'turn.started') {
        expect(event.actor).toEqual({ kind: 'human', user: 'Ada' })
      }
    }

    // Approvals: no matching pending approval, a mismatched tool call id, or
    // an unknown turn is a 409 refusal.
    await expect(
      ada.answerSessionApproval(repo, created.id, {
        turn: 't1',
        toolCallId: 'c1',
        decision: 'approve',
      }),
    ).rejects.toMatchObject({ status: 409 })
    await store.appendSessionEvent(created.id, {
      actor: AGENT,
      type: 'approval.requested',
      payload: { turn: 't1', toolCallId: 'c1', toolName: 'bash', input: { command: 'ls' } },
    })
    expect((await ada.getSession(repo, created.id)).state.status).toBe('awaiting-approval')
    await expect(
      ada.answerSessionApproval(repo, created.id, {
        turn: 't1',
        toolCallId: 'c9',
        decision: 'deny',
      }),
    ).rejects.toMatchObject({ status: 409 })
    await ada.answerSessionApproval(repo, created.id, {
      turn: 't1',
      toolCallId: 'c1',
      decision: 'deny',
    })
    const answered = await ada.getSession(repo, created.id)
    expect(answered.state.status).toBe('running')
    expect(answered.state.pendingApproval).toBeUndefined()

    // Turn stream read; readable by any operator of the repo; unknown turn 404s.
    await expect(
      operatorClient(server, 'Bob').readSessionTurnStream(repo, created.id, 't1', {}),
    ).resolves.toMatchObject({ status: 'open' })
    await expect(
      ada.readSessionTurnStream(repo, created.id, 't-missing', {}),
    ).rejects.toMatchObject({ status: 404 })

    // Archive: owner only; archived sessions are read-only for everyone.
    await ada.archiveSession(repo, created.id)
    await expect(ada.getSession(repo, created.id)).resolves.toMatchObject({
      state: { status: 'archived' },
    })
    for (const attempt of [
      () => ada.postSessionMessage(repo, created.id, { text: 'hello?' }),
      () => ada.setSessionWake(repo, created.id, { globs: [] }),
      () => ada.archiveSession(repo, created.id),
      () =>
        ada.answerSessionApproval(repo, created.id, {
          turn: 't1',
          toolCallId: 'c1',
          decision: 'deny',
        }),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ status: 409 })
    }

    // Bob's own session is untouched by all of this.
    expect((await bob.getSession(repo, foreign.id)).session.operator).toBe('Bob')
    await bob.archiveSession(repo, foreign.id)
  })

  test('unknown sessions are 404 wherever they are addressed', async () => {
    const store = await runningStore()
    const server = createOperatorServer({ store, secret, clock })
    const ada = operatorClient(server, 'Ada')
    await expect(ada.getSession(repo, 'os_nope')).rejects.toMatchObject({ status: 404 })
    await expect(ada.postSessionMessage(repo, 'os_nope', { text: 'hi' })).rejects.toMatchObject({
      status: 404,
    })
    await expect(ada.listSessions(repo)).resolves.toEqual([])
  })
})

describe('the generic tools route', () => {
  const via = { kind: 'mcp', client: 'claude' } as const

  function toolsFetch(server: { fetch(req: Request): Promise<Response> }, token: string) {
    return async (repoPath: string, tool: string, input?: unknown): Promise<Response> =>
      server.fetch(
        new Request(
          `http://operator.test/operator/v1/repos/${encodeURIComponent(repoPath)}/tools/${tool}`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
              [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
              ...(input !== undefined ? { 'content-type': 'application/json' } : {}),
            },
            ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
          },
        ),
      )
  }

  test('a token carrying via stamps it onto the executed registry writes', async () => {
    const store = await runningStore()
    const server = createOperatorServer({ store, secret, clock })
    const token = mintToken(secret, {
      operator: { user: 'Ada' },
      via,
      exp: now.getTime() + 60_000,
    })
    const call = toolsFetch(server, token)
    const response = await call(repo, 'repository.settings', {
      repo,
      setting: 'intake',
      enabled: false,
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ enabled: false })
    const event = (await store.getRepoEvents(repo)).at(-1)
    expect(event?.actor).toEqual({ kind: 'human', user: 'Ada', via })

    // The same route executes any tool from the closed table.
    const read = await call(repo, 'builds.list', { repo, scope: 'all' })
    expect(read.status).toBe(200)
    expect(((await read.json()) as { slug: string }[]).map((build) => build.slug)).toEqual(['demo'])
  })

  test('a via-less token leaves actors unmarked', async () => {
    const store = await runningStore()
    const server = createOperatorServer({ store, secret, clock })
    const token = mintToken(secret, {
      operator: { user: 'Ada' },
      exp: now.getTime() + 60_000,
    })
    const call = toolsFetch(server, token)
    const response = await call(repo, 'notes.write', { repo, document: 'hello' })
    expect(response.status).toBe(200)
    const artifact = await store.getRepoArtifact(repo, 'operator-notes')
    expect(artifact?.meta.metadata).toEqual({ user: 'Ada' })
  })

  test('unknown tools, mismatched bodies, and refusals keep their failure shapes', async () => {
    const store = await runningStore()
    const server = createOperatorServer({ store, secret, clock })
    const token = mintToken(secret, {
      operator: { user: 'Ada' },
      exp: now.getTime() + 60_000,
    })
    const call = toolsFetch(server, token)

    // Unknown tool: registry.call refuses not-found → 404.
    const unknown = await call(repo, 'nope.tool', { repo })
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({ kind: 'not-found' })

    // A body repo that disagrees with the path repository → 400.
    const mismatch = await call(repo, 'builds.list', { repo: 'acme/other', scope: 'all' })
    expect(mismatch.status).toBe(400)
    expect(await mismatch.json()).toMatchObject({ kind: 'validation' })

    // A non-object body → 400.
    const nonObject = await toolsFetch(server, token)(repo, 'builds.list', ['nope'])
    expect(nonObject.status).toBe(400)

    // A registry validation refusal → 400 with the registry's message.
    const invalid = await call(repo, 'builds.list', { repo, scope: 'nope' })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ kind: 'validation' })

    // A domain refusal (unknown build) → 404 via the deterministic mapping.
    const refused = await call(repo, 'builds.get', { repo, slug: 'os_nope' })
    expect(refused.status).toBe(404)
    expect(await refused.json()).toMatchObject({ kind: 'not-found' })
  })

  test('every registry failure kind maps to its documented status', () => {
    expect(REGISTRY_ERROR_STATUS).toEqual({
      validation: 400,
      auth: 403,
      'not-found': 404,
      conflict: 409,
      refusal: 409,
      internal: 500,
    })
  })
})
