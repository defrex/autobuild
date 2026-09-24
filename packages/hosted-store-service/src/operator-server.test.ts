import { describe, expect, test } from 'bun:test'
import { parseConfig } from '@defrex/autobuild/testing'
import { agentActor, DISPATCHER, KERNEL } from '@defrex/autobuild/testing'
import { MemoryBuildStore } from '@defrex/autobuild/plugin-sdk'
import { createStoreServer } from './remote-store-server'
import {
  mintToken,
  RemoteBuildStore,
  tokenResource,
  verifyToken,
  AUTOBUILD_VERSION,
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
} from '@defrex/autobuild/remote-store'

import { OperatorApiClient, OperatorApiError } from './operator-client'
import { createOperatorServer, REGISTRY_ERROR_STATUS } from './operator-server'
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import { buildRegistry, createOrchestratorTurnRunner, humanActor } from '@defrex/autobuild/operator'
import { sequentialIds } from '@defrex/autobuild/testing'
import { reduceSession } from './session-reducer'

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
    // The answer clears the pending approval; the turn here was never
    // suspended (the runner suspended nothing), so the open turn keeps the
    // session `running` — only `turn.resumed` matters for suspended turns.
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

describe('session-archive sandbox release hook (AUT-340)', () => {
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

  test('archiving an operator’s last open session releases and journals; one of several does not', async () => {
    const store = new MemoryBuildStore({ clock })
    const calls: Array<{ identity: string; repo: string }> = []
    const sandbox = {
      release: async (identity: string, input: { repo: string }) => {
        calls.push({ identity, repo: input.repo })
      },
    }
    const server = createOperatorServer({
      store,
      secret,
      clock,
      sandbox: sandbox as never,
    })
    const ada = operatorClient(server, 'Ada')
    const first = await ada.createSession(repo, { title: 'one' })
    const second = await ada.createSession(repo, { title: 'two' })

    // Archiving one of several open sessions does not release.
    await ada.archiveSession(repo, first.id)
    expect(calls).toEqual([])

    // Archiving the last open session releases the operator's sandbox.
    await ada.archiveSession(repo, second.id)
    expect(calls).toEqual([{ identity: 'Ada', repo }])
  })

  test('no backend → no release; release of a never-provisioned operator is a silent no-op', async () => {
    const store = new MemoryBuildStore({ clock })
    const server = createOperatorServer({ store, secret, clock })
    const ada = operatorClient(server, 'Ada')
    const session = await ada.createSession(repo, { title: 'x' })
    await ada.archiveSession(repo, session.id)
    expect((await store.listSessions(repo)).length).toBe(1)

    // A never-provisioned operator: the service's release is a no-op, so the
    // hook must not error even when it fires.
    const sandbox = {
      release: async () => undefined,
    }
    const secondServer = createOperatorServer({
      store,
      secret,
      clock,
      sandbox: sandbox as never,
    })
    const client = operatorClient(secondServer, 'Solo')
    const solo = await client.createSession(repo, { title: 'y' })
    await client.archiveSession(repo, solo.id)
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

describe('operator session routes — embedded orchestrator (AUT-342)', () => {
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

  /** The message route's raw response — the tests assert its body shape
   * ({ok, turn, stream}), which the typed client collapses. */
  function postMessage(
    server: { fetch(req: Request): Promise<Response> },
    repoArg: string,
    sid: string,
    text: string,
  ): Promise<Response> {
    return server.fetch(
      new Request(
        `http://operator.test/operator/v1/repos/${encodeURIComponent(repoArg)}/sessions/${encodeURIComponent(sid)}/messages`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${mintToken(secret, { operator: { user: 'Ada' }, exp: now.getTime() + 60_000 })}`,
            [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
            [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ text }),
        },
      ),
    )
  }

  const usage = (inputTokens: number, outputTokens: number) => ({
    inputTokens: {
      total: inputTokens,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: outputTokens,
      text: undefined,
      reasoning: undefined,
      toolCall: undefined,
    },
    totalTokens: inputTokens + outputTokens,
  })

  function textModel(): MockLanguageModelV3 {
    let call = 0
    return new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'response-metadata', id: 't', modelId: 'mock', timestamp: new Date(0) },
            { type: 'text-start', id: 't' },
            { type: 'text-delta', id: 't', delta: `turn ${++call}` },
            { type: 'text-end', id: 't' },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: usage(10, 5) },
          ] as never,
          initialDelayInMs: 0,
        }),
      }),
    })
  }

  const ORCHESTRATOR_CONFIG = parseConfig(`
[tickets]
source = "file"
readyState = "ready"
[verify]
steps = []
[finalize]
steps = []
[orchestrator]
enabled = true
model = "test/mock"
`)

  async function publishOrchestratorConfig(
    store: MemoryBuildStore,
    config: ReturnType<typeof parseConfig> = ORCHESTRATOR_CONFIG,
  ): Promise<void> {
    await store.ensureRepo(repo)
    const { verify, finalize, ...root } = config
    await store.putRepoArtifact(repo, {
      kind: 'dispatcher-effective-config',
      content: JSON.stringify({
        ...root,
        verify: { steps: verify.steps, ...verify.stepConfigs },
        finalize: { steps: finalize.steps, ...finalize.stepConfigs },
      }),
    })
  }

  /** A server wired for turns: the runner factory binds the in-process
   * registry over the same store, exactly as the production wiring does. */
  function orchestratorServer(store: MemoryBuildStore, model = textModel()) {
    const backgrounds: Promise<void>[] = []
    const server = createOperatorServer({
      store,
      secret,
      clock,
      orchestrator: {
        createRunner: (config, runnerRepo) =>
          createOrchestratorTurnRunner({
            store,
            registry: buildRegistry({ store, clock, allowedRepo: runnerRepo }),
            repo: runnerRepo,
            config,
            clock,
            ids: sequentialIds(),
            model,
            maxRetries: 0,
          }),
        scheduleBackground: (fn) => {
          backgrounds.push(fn())
        },
      },
    })
    return { server, backgrounds }
  }

  test('a message post to an enabled repository starts a turn in the same invocation', async () => {
    const store = new MemoryBuildStore({ clock })
    await publishOrchestratorConfig(store)
    const { server, backgrounds } = orchestratorServer(store)
    const ada = operatorClient(server, 'Ada')

    // A new session inherits the default wake set (the attention set).
    const created = await ada.createSession(repo, { title: 'orchestrator' })
    const events = await store.getSessionEvents(created.id)
    expect(events.map((event) => event.type)).toEqual(['session.created', 'session.wake-set'])
    const wakeSet = events.find((event) => event.type === 'session.wake-set')
    expect(wakeSet?.payload.globs).toContain('escalation.raised')
    expect(wakeSet?.actor).toEqual({ kind: 'human', user: 'Ada' })

    // The message route awaits only turn.started and returns the turn and
    // stream; the loop continues in the background.
    const posted = await postMessage(server, repo, created.id, 'hello')
    const body = (await posted.json()) as { ok: boolean; turn?: string; stream?: string }
    expect(body.ok).toBe(true)
    expect(body.turn).toMatch(/^ot_/)
    expect(body.stream).toMatch(/^st_/)

    await Promise.all(backgrounds)
    const state = reduceSession(await store.getSessionEvents(created.id))
    expect(state.status).toBe('idle')
    expect(state.turns[0]).toMatchObject({
      turn: body.turn,
      stream: body.stream,
      state: 'completed',
      trigger: { kind: 'message', messageSeq: 3 },
      usage: { inputTokens: 10, outputTokens: 5, steps: 1 },
    })
    // The turn's stream carried the model's output as protocol parts.
    const read = await store.readStream(body.stream!)
    const types = read.chunks.flatMap((chunk) => chunk.parts.map((part) => part.type))
    expect(types).toContain('text-delta')
    expect(read.status).toBe('closed')
  })

  test('a disabled or absent-config repository behaves exactly as before', async () => {
    const store = new MemoryBuildStore({ clock })
    // No artifact at all.
    const { server, backgrounds } = orchestratorServer(store)
    const ada = operatorClient(server, 'Ada')
    const created = await ada.createSession(repo, { title: 'plain' })
    expect((await store.getSessionEvents(created.id)).map((e) => e.type)).toEqual([
      'session.created',
    ])
    const posted = await postMessage(server, repo, created.id, 'hello')
    expect(await posted.json()).toEqual({ ok: true })
    await Promise.all(backgrounds)
    expect(reduceSession(await store.getSessionEvents(created.id)).turns).toHaveLength(0)

    // An artifact whose orchestrator is disabled.
    const store2 = new MemoryBuildStore({ clock })
    await publishOrchestratorConfig(
      store2,
      parseConfig(`
[tickets]
source = "file"
readyState = "ready"
[verify]
steps = []
[finalize]
steps = []
[orchestrator]
enabled = false
`),
    )
    const server2 = orchestratorServer(store2)
    const ada2 = operatorClient(server2.server, 'Ada')
    const created2 = await ada2.createSession(repo, {})
    expect((await store2.getSessionEvents(created2.id)).map((e) => e.type)).toEqual([
      'session.created',
    ])
    const posted2 = await postMessage(server2.server, repo, created2.id, 'hello')
    expect(await posted2.json()).toEqual({ ok: true })
  })

  test('a broken effective-config artifact is a 500, never a silent disable', async () => {
    const store = new MemoryBuildStore({ clock })
    await store.ensureRepo(repo)
    await store.putRepoArtifact(repo, {
      kind: 'dispatcher-effective-config',
      content: 'not json at all',
    })
    const { server } = orchestratorServer(store)
    const ada = operatorClient(server, 'Ada')
    // The create route resolves the config too (wake inheritance), so the
    // broken artifact fails it with a 500 as well — never a silent disable.
    await expect(ada.createSession(repo, {})).rejects.toMatchObject({ status: 500 })
  })

  test('an approval answer resumes the suspended turn in the same invocation', async () => {
    const store = new MemoryBuildStore({ clock })
    await publishOrchestratorConfig(store)
    const { server, backgrounds } = orchestratorServer(store)
    const ada = operatorClient(server, 'Ada')

    // Seed a turn suspended for approval with a persisted request part.
    const created = await ada.createSession(repo, {})
    const stream = await store.createStream({ kind: 'session', session: created.id }, 'turn:ot_1')
    await store.appendStreamParts(stream.id, [
      { type: 'start', messageId: 'm1' },
      { type: 'tool-approval-request', approvalId: 'a1', toolCallId: 'c1' },
    ])
    await store.appendSessionEvent(created.id, {
      actor: humanActor('Ada'),
      type: 'message.posted',
      payload: { text: 'do it' },
    })
    await store.appendSessionEvent(created.id, {
      actor: AGENT,
      type: 'turn.started',
      payload: {
        turn: 'ot_1',
        stream: stream.id,
        trigger: { kind: 'message', messageSeq: 2 },
      },
    })
    await store.appendSessionEvent(created.id, {
      actor: AGENT,
      type: 'approval.requested',
      payload: { turn: 'ot_1', toolCallId: 'c1', toolName: 'notes.write', input: {} },
    })
    await store.appendSessionEvent(created.id, {
      actor: AGENT,
      type: 'turn.suspended',
      payload: { turn: 'ot_1', cause: 'approval' },
    })

    await ada.answerSessionApproval(repo, created.id, {
      turn: 'ot_1',
      toolCallId: 'c1',
      decision: 'approve',
    })
    await Promise.all(backgrounds)

    const state = reduceSession(await store.getSessionEvents(created.id))
    expect(state.status).toBe('idle')
    expect(state.turns[0]).toMatchObject({ state: 'completed' })
    // The resume recovered the wire approvalId and appended the response.
    const parts = (await store.readStream(stream.id)).chunks.flatMap((c) => c.parts)
    expect(parts.some((part) => part.type === 'tool-approval-response')).toBe(true)
  })
})

describe('request credential threading and sandboxFor (AUT-584)', () => {
  const usage = (inputTokens: number, outputTokens: number) => ({
    inputTokens: {
      total: inputTokens,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: outputTokens,
      text: undefined,
      reasoning: undefined,
      toolCall: undefined,
    },
    totalTokens: inputTokens + outputTokens,
  })

  const AGENT = agentActor('orchestrator', 'os_turn')
  const ORCHESTRATOR_CONFIG = parseConfig(`
[tickets]
source = "file"
readyState = "ready"
[verify]
steps = []
[finalize]
steps = []
[orchestrator]
enabled = true
model = "test/mock"
`)

  async function publishOrchestratorConfig(store: MemoryBuildStore): Promise<void> {
    await store.ensureRepo(repo)
    const { verify, finalize, ...root } = ORCHESTRATOR_CONFIG
    await store.putRepoArtifact(repo, {
      kind: 'dispatcher-effective-config',
      content: JSON.stringify({
        ...root,
        verify: { steps: verify.steps, ...verify.stepConfigs },
        finalize: { steps: finalize.steps, ...finalize.stepConfigs },
      }),
    })
  }

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

  /** Raw session POST with caller-supplied extra headers (the OIDC header the
   * routes thread into the runner factory). */
  function sessionPost(
    server: { fetch(req: Request): Promise<Response> },
    repoArg: string,
    sid: string,
    leaf: 'messages' | 'approvals',
    payload: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    return server.fetch(
      new Request(
        `http://operator.test/operator/v1/repos/${encodeURIComponent(repoArg)}/sessions/${encodeURIComponent(sid)}/${leaf}`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${mintToken(secret, { operator: { user: 'Ada' }, exp: now.getTime() + 60_000 })}`,
            [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
            [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
            'content-type': 'application/json',
            ...extraHeaders,
          },
          body: JSON.stringify(payload),
        },
      ),
    )
  }

  function localTextModel(): MockLanguageModelV3 {
    let call = 0
    return new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'response-metadata', id: 't', modelId: 'mock', timestamp: new Date(0) },
            { type: 'text-start', id: 't' },
            { type: 'text-delta', id: 't', delta: `turn ${++call}` },
            { type: 'text-end', id: 't' },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: usage(10, 5) },
          ] as never,
          initialDelayInMs: 0,
        }),
      }),
    })
  }

  /** The production-shaped wiring: a createRunner double that records its
   * arguments and returns a real runner over the in-process registry. */
  function recordingOrchestratorServer(store: MemoryBuildStore, model = localTextModel()) {
    const runnerCalls: Array<{
      repo: string
      credentials: { oidcToken?: string } | undefined
    }> = []
    const backgrounds: Promise<void>[] = []
    const server = createOperatorServer({
      store,
      secret,
      clock,
      orchestrator: {
        createRunner: (config, runnerRepo, credentials) => {
          runnerCalls.push({ repo: runnerRepo, credentials })
          return createOrchestratorTurnRunner({
            store,
            registry: buildRegistry({ store, clock, allowedRepo: runnerRepo }),
            repo: runnerRepo,
            config,
            clock,
            ids: sequentialIds(),
            model,
            maxRetries: 0,
          })
        },
        scheduleBackground: (fn) => {
          backgrounds.push(fn())
        },
      },
    })
    return { server, runnerCalls, backgrounds }
  }

  test('a message post whose request carries the OIDC header threads it into createRunner; no header passes undefined', async () => {
    const store = new MemoryBuildStore({ clock })
    await publishOrchestratorConfig(store)
    const { server, runnerCalls, backgrounds } = recordingOrchestratorServer(store)
    const ada = operatorClient(server, 'Ada')

    const created = await ada.createSession(repo, { title: 'one' })
    await sessionPost(
      server,
      repo,
      created.id,
      'messages',
      { text: 'hello' },
      {
        'x-vercel-oidc-token': '  req-oidc-token  ',
      },
    )
    await Promise.all(backgrounds)
    expect(runnerCalls).toHaveLength(1)
    // The header value is threaded (trimmed — a blank header is absent).
    expect(runnerCalls[0]!.credentials).toEqual({ oidcToken: 'req-oidc-token' })

    const second = await ada.createSession(repo, { title: 'two' })
    await sessionPost(server, repo, second.id, 'messages', { text: 'hello again' })
    await Promise.all(backgrounds)
    expect(runnerCalls).toHaveLength(2)
    expect(runnerCalls[1]!.credentials).toBeUndefined()
  })

  test("an approval answer threads the request's credential into the resuming createRunner", async () => {
    const store = new MemoryBuildStore({ clock })
    await publishOrchestratorConfig(store)
    const { server, runnerCalls, backgrounds } = recordingOrchestratorServer(store)

    // Seed a turn suspended for approval, exactly as the same-invocation
    // resume test does.
    const created = await store.createSession({ repo, operator: 'Ada' })
    const stream = await store.createStream({ kind: 'session', session: created.id }, 'turn:ot_1')
    await store.appendStreamParts(stream.id, [
      { type: 'start', messageId: 'm1' },
      { type: 'tool-approval-request', approvalId: 'a1', toolCallId: 'c1' },
    ])
    await store.appendSessionEvent(created.id, {
      actor: humanActor('Ada'),
      type: 'message.posted',
      payload: { text: 'do it' },
    })
    await store.appendSessionEvent(created.id, {
      actor: AGENT,
      type: 'turn.started',
      payload: { turn: 'ot_1', stream: stream.id, trigger: { kind: 'message', messageSeq: 2 } },
    })
    await store.appendSessionEvent(created.id, {
      actor: agentActor('orchestrator', 'ot_1'),
      type: 'approval.requested',
      payload: { turn: 'ot_1', toolCallId: 'c1', toolName: 'notes.write', input: {} },
    })
    await store.appendSessionEvent(created.id, {
      actor: agentActor('orchestrator', 'ot_1'),
      type: 'turn.suspended',
      payload: { turn: 'ot_1', cause: 'approval' },
    })

    await sessionPost(
      server,
      repo,
      created.id,
      'approvals',
      { turn: 'ot_1', toolCallId: 'c1', decision: 'approve' },
      { 'x-vercel-oidc-token': 'resume-token' },
    )
    await Promise.all(backgrounds)
    expect(runnerCalls).toHaveLength(1)
    expect(runnerCalls[0]!.credentials).toEqual({ oidcToken: 'resume-token' })
  })

  test('sandboxFor wins over the static option and a disabled/unresolvable resolution releases nothing', async () => {
    const store = new MemoryBuildStore({ clock })
    const staticReleases: string[] = []
    const dynamicReleases: string[] = []
    const staticBackend = {
      release: async (identity: string) => {
        staticReleases.push(identity)
      },
    }
    const dynamicBackend = {
      release: async (identity: string) => {
        dynamicReleases.push(identity)
      },
    }
    const server = createOperatorServer({
      store,
      secret,
      clock,
      sandbox: staticBackend as never,
      sandboxFor: async (repoArg) => {
        // Service-shaped wiring: disabled config → undefined (contained).
        if (repoArg === 'https://github.com/acme/disabled') return undefined
        return dynamicBackend as never
      },
    })

    // The last open session's archive releases through sandboxFor's backend.
    const ada = operatorClient(server, 'Ada')
    const first = await ada.createSession(repo, { title: 'one' })
    const second = await ada.createSession(repo, { title: 'two' })
    await ada.archiveSession(repo, first.id)
    expect(dynamicReleases).toEqual([])
    expect(staticReleases).toEqual([])
    await ada.archiveSession(repo, second.id)
    expect(dynamicReleases).toEqual(['Ada'])
    expect(staticReleases).toEqual([]) // sandboxFor wins

    // A disabled repository resolves to undefined: the archive still
    // succeeds and releases nothing (the dispatcher's idle settlement stops
    // the environment later).
    const disabledRepo = 'https://github.com/acme/disabled'
    const solo = await ada.createSession(disabledRepo, { title: 'x' })
    await ada.archiveSession(disabledRepo, solo.id)
    expect(dynamicReleases).toEqual(['Ada'])
    expect(staticReleases).toEqual([])
  })
})
