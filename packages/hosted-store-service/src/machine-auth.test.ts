import { temporaryDirectories as ownTempDirectories } from '@defrex/autobuild/testing'
import { MemoryTicketPolicyStore } from '@defrex/autobuild-postgres-store/ticket-policy'
import { afterEach, expect, test } from 'bun:test'
import {
  AUTOBUILD_VERSION,
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
  mintToken,
} from '@defrex/autobuild/remote-store'
import { testCredentials } from './testing/credentials'
import { testProjects } from './testing/projects'
import { createStoreServer } from './remote-store-server'
import { MemoryBuildStore, sampleEventWrite } from '@defrex/autobuild/plugin-sdk'
import { createTicketServer } from './ticket-server'
import { createMachineAuth } from './machine-auth'
import { createDelegationHandler } from './delegated-authority'

const mkdtemp = ownTempDirectories(afterEach)

const A = 'https://github.com/acme/a'
const B = 'https://github.com/acme/b'
const request = (path: string, token: string, body?: unknown) =>
  new Request(`http://store${path}`, {
    headers: {
      [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
      [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
      authorization: `Bearer ${token}`,
    },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  })
test('two project store boundary, opaque identities, collections, revocation and registration', async () => {
  const projects = testProjects([A, B])
  const { store: credentials, auth } = testCredentials(projects)
  const a = await credentials.issue(A, 'owner')
  const a2 = await credentials.issue(A, 'owner')
  const b = await credentials.issue(B, 'owner')
  const backing = new MemoryBuildStore()
  const server = createStoreServer({ store: backing, auth })
  const create = async (repo: string, token: string) => {
    const response = await server.fetch(
      request('/builds', token, { slug: 'fix-login', repo, branch: 'ab/fix-login' }),
    )
    expect(response.status).toBe(201)
    return response.json()
  }
  const first = await create(A, a.token)
  const second = await create(B, b.token)
  expect(first.slug).not.toBe(second.slug)
  expect(first.branch).toBe(`ab/${first.slug}`)
  expect((await server.fetch(request('/builds', a.token))).status).toBe(200)
  expect(await (await server.fetch(request('/builds', a.token))).json()).toEqual([first])
  const foreign = await server.fetch(request(`/builds/${second.slug}`, a.token))
  const absent = await server.fetch(request('/builds/absent', a.token))
  expect(foreign.status).toBe(404)
  expect(await foreign.json()).toEqual(await absent.json())
  expect(
    (await server.fetch(request(`/repos/${encodeURIComponent(B)}/events`, a.token))).status,
  ).toBe(403)
  expect((await server.fetch(request('/builds', a.token, { slug: 'bad', repo: B }))).status).toBe(
    403,
  )
  expect((await server.fetch(request('/repos', a.token, { repo: B }))).status).toBe(403)
  await backing.ensureRepo(A)
  await backing.ensureRepo(B)
  const session = await backing.createSession({ repo: B, operator: 'owner' })
  const stream = await backing.createStream({ kind: 'session', session: session.id }, 'output')
  for (const path of [
    `/sessions/${session.id}`,
    `/streams/${stream.id}`,
    `/builds/${second.slug}/events`,
    `/builds/${second.slug}/artifacts?kind=x`,
    `/builds/${second.slug}/snapshots/test?version=1`,
  ])
    expect((await server.fetch(request(path, a.token))).status).toBe(404)
  const repeatedRequest = request('/builds', a.token)
  expect((await server.fetch(repeatedRequest)).status).toBe(200)
  const ownerAdmin = mintToken('secret', {
    version: 1,
    ownerAdmin: { user: 'owner' },
    exp: Date.now() + 60000,
  })
  expect(await (await server.fetch(request('/builds', ownerAdmin))).json()).toHaveLength(2)
  await credentials.revoke(A, a.credential.id, 'owner')
  expect((await server.fetch(request('/builds', a.token))).status).toBe(401)
  expect((await server.fetch(repeatedRequest)).status).toBe(401)
  expect((await server.fetch(request('/builds', a2.token))).status).toBe(200)
  expect((await server.fetch(request('/builds', b.token))).status).toBe(200)
  await projects.remove(A, 'owner')
  expect((await server.fetch(request('/builds', a2.token))).status).toBe(403)
})
test('retired formats fail; internal delegation is registered, project bound and operator only; admin is explicit', async () => {
  const projects = testProjects([A])
  const { auth } = testCredentials(projects)
  const server = createStoreServer({ store: new MemoryBuildStore(), auth })
  for (const scope of [
    { operator: true as const, session: '*', exp: Date.now() + 60000 },
    { build: '*', session: '*', exp: Date.now() + 60000 },
    { operator: { user: 'owner' }, exp: Date.now() + 60000 },
  ]) {
    const response = await server.fetch(request('/builds', mintToken('secret', scope)))
    expect(response.status).toBe(401)
    expect((await response.json()).error).toContain('credential format changed')
  }
  const internal = mintToken('secret', {
    version: 1,
    internalOperator: { repo: A, user: 'owner' },
    exp: Date.now() + 60000,
  })
  expect((await server.fetch(request('/builds', internal))).status).toBe(403)
  const admin = mintToken('secret', {
    version: 1,
    ownerAdmin: { user: 'owner' },
    exp: Date.now() + 60000,
  })
  expect((await server.fetch(request('/builds', admin))).status).toBe(200)
})
test('ticket admission precedes parsing/source construction and revocation is immediate', async () => {
  const projects = testProjects([A])
  const { store: credentials, auth } = testCredentials(projects)
  const a = await credentials.issue(A, 'owner')
  let calls = 0
  const server = createTicketServer({
    secret: 'secret',
    auth,
    sourceFor: () => {
      calls++
      throw new Error('must not open')
    },
  })
  await credentials.revoke(A, a.credential.id, 'owner')
  expect((await server.fetch(request('/tickets/get', a.token, {}))).status).toBe(401)
  expect(calls).toBe(0)
})
test('unknown opaque secrets cannot disclose metadata', async () => {
  const projects = testProjects([A])
  const { store } = testCredentials(projects)
  const auth = createMachineAuth({ secret: 'secret', projects, credentials: store })
  const issued = await store.issue(A, 'private-owner')
  await expect(
    auth.authenticate(request('/builds', `${issued.token.slice(0, -1)}z`)),
  ).rejects.toThrow('unknown or revoked credential')
})

test('every raw route family denies foreign project before parsing or mutation', async () => {
  const projects = testProjects([A, B])
  const { store: credentials, auth } = testCredentials(projects)
  const { token } = await credentials.issue(A, 'owner')
  const backing = new MemoryBuildStore()
  await backing.createBuild({ slug: 'foreign', repo: B })
  await backing.ensureRepo(B)
  const session = await backing.createSession({ repo: B, operator: 'owner' })
  const streams = await Promise.all([
    backing.createStream({ kind: 'build', build: 'foreign' }, 'build'),
    backing.createStream({ kind: 'session', session: session.id }, 'session'),
    backing.createStream({ kind: 'repo', repo: B }, 'repo'),
  ])
  const server = createStoreServer({ store: backing, auth })
  const denied = async (path: string, status: number, method = 'GET') => {
    const req = request(path, token)
    const response = await server.fetch(
      new Request(req, { method, ...(method === 'GET' ? {} : { body: '{invalid' }) }),
    )
    expect(response.status).toBe(status)
    expect(JSON.stringify(await response.json())).not.toContain(B)
  }
  for (const root of ['/builds/foreign', `/sessions/${session.id}`]) {
    for (const [method, leaf] of [
      ['GET', ''],
      ['GET', '/events'],
      ['POST', '/events'],
      ['POST', '/events/conditional'],
      ['POST', '/deposits'],
      ['GET', '/artifacts?kind=x'],
      ['POST', '/artifacts'],
      ['GET', '/artifact-list'],
      ...(root.startsWith('/builds/')
        ? [
            ['GET', '/artifact-meta?kind=x'],
            ['GET', `/node-rewrite?previous=${'a'.repeat(40)}`],
          ]
        : []),
      ['GET', '/streams'],
      ['POST', '/streams'],
    ])
      await denied(`${root}${leaf}`, 404, method)
  }
  for (const leaf of ['lease/claim', 'lease/heartbeat', 'lease/release'])
    await denied(`/builds/foreign/${leaf}`, 404, 'POST')
  for (const [method, leaf] of [
    ['GET', 'events'],
    ['POST', 'events'],
    ['POST', 'deposits'],
    ['GET', 'high-water'],
    ['GET', 'state-events'],
    ['GET', 'build-digests'],
    ['GET', 'change-position'],
    ['GET', 'builds'],
    ['GET', 'artifacts?kind=x'],
    ['POST', 'artifacts'],
    ['GET', 'artifact-list'],
    ['GET', 'sessions'],
    ['POST', 'sessions'],
    ['GET', 'streams'],
    ['POST', 'streams'],
    ['GET', 'ticket-asset-limits'],
    ['GET', 'tickets/T-1/assets/list'],
    ['POST', 'tickets/T-1/assets'],
    ['POST', 'tickets/T-1/assets/remove'],
    ['GET', 'snapshots/test?version=1'],
    ['PUT', 'snapshots/test'],
  ])
    await denied(`/repos/${encodeURIComponent(B)}/${leaf}`, 403, method)
  for (const stream of streams)
    for (const [method, leaf] of [
      ['GET', ''],
      ['GET', '/chunks'],
      ['POST', '/chunks'],
      ['POST', '/close'],
    ])
      await denied(`/streams/${stream.id}${leaf}`, 404, method)
  expect(await backing.getEvents('foreign')).toEqual([])
})

test('allocation retries only uniqueness errors; project writes reject forged via', async () => {
  const projects = testProjects([A])
  const { store: credentials, auth } = testCredentials(projects)
  const { token } = await credentials.issue(A, 'owner')
  const backing = new MemoryBuildStore()
  const create = backing.createBuild.bind(backing)
  let calls = 0
  backing.createBuild = async (input) => {
    if (++calls === 1) throw Object.assign(new Error('unique constraint'), { code: '23505' })
    return create(input)
  }
  const server = createStoreServer({ store: backing, auth })
  const response = await server.fetch(request('/builds', token, { slug: 'base', repo: A }))
  expect(response.status).toBe(201)
  expect(calls).toBe(2)
  const record = await response.json()
  const via = await server.fetch(
    request(`/builds/${record.slug}/events`, token, {
      type: 'build.paused',
      actor: { kind: 'human', user: 'owner', via: { kind: 'mcp', client: 'forged' } },
      payload: {},
    }),
  )
  expect(via.status).toBe(403)
  backing.createBuild = async () => {
    calls++
    throw new Error('database unavailable')
  }
  expect((await server.fetch(request('/builds', token, { slug: 'base', repo: A }))).status).toBe(
    500,
  )
  expect(calls).toBe(3)
})

test('composed service retries credential-store opening, checks warm revocation, and separates operator purpose', async () => {
  const { createHostedStoreService } = await import('./service')
  const { RemoteBuildStore } = await import('@defrex/autobuild/remote-store')
  const { OperatorApiClient } = await import('./operator-client')
  const projects = testProjects([A, B])
  const { store: credentials } = testCredentials(projects)
  const owner = await credentials.issue(A, 'owner')
  const dispatcher = await credentials.issue(A, 'system:dispatcher', { purpose: 'dispatcher' })
  const other = await credentials.issue(B, 'owner')
  let opens = 0
  const backing = new MemoryBuildStore()
  const service = createHostedStoreService({
    openTicketPolicy: async () => new MemoryTicketPolicyStore(),
    env: {
      AB_STORE_SECRET: 'secret',
      AB_POSTGRES_URL: 'postgres://unused/db',
      AB_BLOB_BACKEND: 's3',
      AB_S3_BUCKET: 'unused',
      AB_S3_REGION: 'unused',
      AB_S3_ACCESS_KEY_ID: 'unused',
      AB_S3_SECRET_ACCESS_KEY: 'unused',
    },
    openStore: async () => backing,
    openProjectRegistry: async () => projects,
    openCredentials: async () => {
      if (++opens === 1) throw new Error('temporary database failure')
      return credentials
    },
    reportInternalError: () => {},
  })
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) =>
    service.fetch(
      input instanceof Request ? new Request(input, init) : new Request(String(input), init),
    )) as typeof fetch
  const raw = new RemoteBuildStore({ url: 'http://store', token: owner.token, fetchFn })
  await expect(raw.listBuilds()).rejects.toThrow('hosted store is unavailable')
  expect(await raw.listBuilds()).toEqual([])
  expect(opens).toBe(2)
  const operator = new OperatorApiClient({ url: 'http://store', token: owner.token, fetchFn })
  await operator.callTool(A, 'repository.settings', { repo: A, setting: 'intake', enabled: false })
  expect((await backing.getRepoEvents(A)).at(-1)?.actor).toEqual({ kind: 'human', user: 'owner' })
  const runner = new OperatorApiClient({ url: 'http://store', token: dispatcher.token, fetchFn })
  await expect(runner.listBuilds(A)).rejects.toThrow('dispatcher credential')
  await expect(operator.listBuilds(B)).rejects.toThrow('wrong project')
  const internal = new OperatorApiClient({
    url: 'http://store',
    token: mintToken('secret', {
      version: 1,
      internalOperator: { repo: A, user: 'owner' },
      exp: Date.now() + 60000,
    }),
    fetchFn,
  })
  expect(await internal.listBuilds(A)).toEqual([])
  await expect(internal.listBuilds(B)).rejects.toThrow('wrong project')
  await credentials.revoke(A, owner.credential.id, 'owner')
  await expect(raw.listBuilds()).rejects.toThrow('unknown or revoked credential')
  expect(
    await new RemoteBuildStore({
      url: 'http://store',
      token: dispatcher.token,
      fetchFn,
    }).listBuilds(),
  ).toEqual([])
  expect(
    await new RemoteBuildStore({ url: 'http://store', token: other.token, fetchFn }).listBuilds(),
  ).toEqual([])
})

test('ticket project admission preserves shared backend and rejects repo injection before source construction', async () => {
  const { FakeTicketSource } = await import('@defrex/autobuild/plugin-sdk')
  const projects = testProjects([A, B])
  const { auth, store: credentials } = testCredentials(projects)
  const a = await credentials.issue(A, 'owner')
  const b = await credentials.issue(B, 'owner')
  const backend = new FakeTicketSource()
  let calls = 0
  const server = createTicketServer({
    secret: 'secret',
    auth,
    sourceFor: () => {
      calls++
      return backend
    },
  })
  const body = { context: { teamKey: 'ENG' }, input: {} }
  expect((await server.fetch(request('/tickets/list-ready', a.token, body))).status).toBe(200)
  expect((await server.fetch(request('/tickets/list-ready', b.token, body))).status).toBe(200)
  expect(calls).toBe(2)
  expect(
    (
      await server.fetch(
        request('/tickets/list-ready', a.token, { ...body, context: { ...body.context, repo: B } }),
      )
    ).status,
  ).toBe(403)
  expect(calls).toBe(2)
  await projects.remove(A, 'owner')
  expect((await server.fetch(request('/tickets/list-ready', a.token, {}))).status).toBe(403)
  expect(calls).toBe(2)
})

test('each route authenticates once per invocation, including reused requests and refusals', async () => {
  const projects = testProjects([A])
  const { store: credentials, auth } = testCredentials(projects)
  const issued = await credentials.issue(A, 'owner')
  const backing = new MemoryBuildStore()
  await backing.ensureRepo(A)
  const session = await backing.createSession({ repo: A, operator: 'owner' })
  const stream = await backing.createStream({ kind: 'repo', repo: A }, 'output')
  let calls = 0
  const server = createStoreServer({
    store: backing,
    secret: 'secret',
    auth: {
      authenticate: (req) => {
        calls++
        return auth.authenticate(req)
      },
    },
  })
  const checks: Array<[string, unknown?]> = [
    ['/repos', { repo: A }],
    [`/repos/${encodeURIComponent(A)}`],
    [`/sessions/${session.id}`],
    ['/builds'],
    ['/builds/missing'],
    [`/streams/${stream.id}`],
    [`/streams/${stream.id}/chunks`],
    [`/streams/${stream.id}/chunks`, { parts: [] }],
    [`/streams/${stream.id}/close`, { outcome: 'completed' }],
    ['/streams/missing'],
    ['/credentials/delegate', {}],
    [`/repos/${encodeURIComponent(B)}/events`],
  ]
  for (const [path, body] of checks) {
    calls = 0
    await server.fetch(request(path, issued.token, body))
    expect(calls).toBe(1)
  }
  const repeated = request('/builds', issued.token)
  await server.fetch(repeated)
  calls = 0
  await server.fetch(repeated)
  expect(calls).toBe(1)
  await credentials.revoke(A, issued.credential.id, 'owner')
  calls = 0
  expect((await server.fetch(repeated)).status).toBe(401)
  expect(calls).toBe(1)
})

test('project listing uses the bound optional capability and retains ownership filtering', async () => {
  const projects = testProjects([A, B])
  const { store: credentials, auth } = testCredentials(projects)
  const owner = await credentials.issue(A, 'owner')
  const other = await credentials.issue(B, 'owner')
  const dispatcher = await credentials.issue(A, 'owner', { purpose: 'dispatcher' })
  const backing = new MemoryBuildStore()
  const foreign = await backing.createBuild({ slug: 'foreign', repo: B })
  const global = backing.listBuilds.bind(backing)
  let globalCalls = 0
  const scopedCalls: string[] = []
  const store = Object.assign(backing, {
    async listBuildsForRepo(this: MemoryBuildStore, repo: string) {
      expect(this).toBe(backing)
      scopedCalls.push(repo)
      return (await global()).filter((r) => r.repo === repo)
    },
  })
  backing.listBuilds = async () => {
    globalCalls++
    return global()
  }
  const server = createStoreServer({ store, auth })
  for (const token of [owner.token, dispatcher.token]) {
    expect(await (await server.fetch(request('/builds', token))).json()).toEqual([])
  }
  const own = await backing.createBuild({ slug: 'own', repo: A })
  expect(await (await server.fetch(request('/builds', owner.token))).json()).toEqual([own])
  expect(await (await server.fetch(request('/builds', other.token))).json()).toEqual([foreign])
  expect(scopedCalls).toEqual([A, A, A, B])
  expect(globalCalls).toBe(0)
  store.listBuildsForRepo = async () => [foreign, own]
  expect(await (await server.fetch(request('/builds', owner.token))).json()).toEqual([own])
  const admin = mintToken('secret', {
    version: 1,
    ownerAdmin: { user: 'owner' },
    exp: Date.now() + 60000,
  })
  expect(await (await server.fetch(request('/builds', admin))).json()).toEqual(await global())
  expect(globalCalls).toBe(1)
  const local = createStoreServer({ store })
  expect(
    await (
      await local.fetch(
        new Request('http://store/builds', {
          headers: {
            [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
            [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
          },
        }),
      )
    ).json(),
  ).toEqual(await global())
  expect(globalCalls).toBe(2)
})

test('project listing fallback filters global records and scoped failures retain server errors', async () => {
  const projects = testProjects([A, B])
  const { store: credentials, auth } = testCredentials(projects)
  const owner = await credentials.issue(A, 'owner')
  const backing = new MemoryBuildStore()
  await backing.createBuild({ slug: 'fallback-foreign', repo: B })
  const own = await backing.createBuild({ slug: 'fallback-own', repo: A })
  const server = createStoreServer({ store: backing, auth, onInternalError: () => {} })
  expect(await (await server.fetch(request('/builds', owner.token))).json()).toEqual([own])
  const failing = Object.assign(backing, {
    async listBuildsForRepo() {
      throw new Error('database unavailable')
    },
  })
  const failedServer = createStoreServer({ store: failing, auth, onInternalError: () => {} })
  expect((await failedServer.fetch(request('/builds', owner.token))).status).toBe(500)
})

test('delegated listing retains project scope while internal operator grants remain denied', async () => {
  const projects = testProjects([A, B])
  const { store: credentials } = testCredentials(projects)
  const owner = await credentials.issue(A, 'owner')
  const backing = new MemoryBuildStore()
  const own = await backing.createBuild({ slug: 'delegation-own', repo: A })
  await backing.append(own.slug, sampleEventWrite())
  await backing.createBuild({ slug: 'delegation-foreign', repo: B })
  const calls: string[] = []
  const global = backing.listBuilds.bind(backing)
  const store = Object.assign(backing, {
    async listBuildsForRepo(repo: string) {
      calls.push(repo)
      return (await global()).filter((record) => record.repo === repo)
    },
  })
  const auth = createMachineAuth({ secret: 'secret', projects, credentials, store })
  const delegate = createDelegationHandler({ secret: 'secret', auth, store })
  const response = await delegate(
    request('/credentials/delegate', owner.token, {
      kind: 'build-runner',
      id: own.slug,
    }),
  )
  expect(response.status).toBe(200)
  const token = (await response.json()).token
  const server = createStoreServer({ store, auth })
  expect(await (await server.fetch(request('/builds', token))).json()).toEqual([
    await backing.getBuild(own.slug),
  ])
  expect(calls).toEqual([A])
  const internal = mintToken('secret', {
    version: 1,
    internalOperator: { repo: A, user: 'owner' },
    exp: Date.now() + 60000,
  })
  expect((await server.fetch(request('/builds', internal))).status).toBe(403)
  expect(calls).toEqual([A])
})

test('operator presence requires repository operator authority before reads or writes', async () => {
  const projects = testProjects([A, B])
  const { store: credentials, auth } = testCredentials(projects)
  const owner = await credentials.issue(A, 'owner')
  const foreign = await credentials.issue(B, 'owner')
  const store = new MemoryBuildStore()
  const server = createStoreServer({ store, auth })
  const path = `/repos/${encodeURIComponent(A)}/operator-presence`
  const identity = { id: 'one', host: 'host', pid: 1, startedAt: '2026-10-24T12:00:00.000Z' }
  expect(await (await server.fetch(request(path, owner.token))).json()).toEqual([])
  expect(await store.getRepo(A)).toBeNull()
  expect((await server.fetch(request(path, foreign.token, identity))).status).toBe(403)
  for (const bad of [
    { ...identity, pid: 0 },
    { ...identity, extra: true },
  ]) {
    expect((await server.fetch(request(path, owner.token, bad))).status).toBe(400)
  }
  expect((await server.fetch(request(path, owner.token, identity))).status).toBe(200)
  expect((await server.fetch(request(path, owner.token, { ...identity, id: 'two' }))).status).toBe(
    200,
  )
  expect((await (await server.fetch(request(path, owner.token))).json()).length).toBe(2)
  expect(await store.getRepo(A)).toBeNull()
  const internal = mintToken('secret', {
    version: 1,
    internalOperator: { repo: A, user: 'owner' },
    exp: Date.now() + 60_000,
  })
  expect((await server.fetch(request(path, internal))).status).toBe(403)

  const deletion = (bearer: string) =>
    new Request(`https://test${path}/one`, {
      method: 'DELETE',
      headers: request(path, bearer).headers,
    })
  expect((await server.fetch(deletion(foreign.token))).status).toBe(403)
  expect((await server.fetch(deletion(owner.token))).status).toBe(200)
  expect((await server.fetch(deletion(owner.token))).status).toBe(200)
  expect((await store.listOperatorPresence(A)).map((row) => row.id)).toEqual(['two'])
  let reads = 0
  let writes = 0
  store.listOperatorPresence = async () => {
    reads++
    return []
  }
  store.upsertOperatorPresence = async () => {
    writes++
    throw new Error('unexpected')
  }
  store.removeOperatorPresence = async () => {
    writes++
    throw new Error('unexpected')
  }
  for (const kind of ['build-runner', 'harvest-runner', 'conversation'] as const) {
    const delegated = createStoreServer({
      store,
      auth: {
        async authenticate() {
          return {
            kind: 'delegated',
            repo: A,
            user: 'owner',
            delegation: { kind, id: 'scope' },
          } as never
        },
      },
    })
    expect((await delegated.fetch(deletion('unused'))).status).toBe(403)
    for (const body of [undefined, identity]) {
      const response = await delegated.fetch(request(path, 'unused', body))
      expect(response.status).toBe(403)
    }
  }
  expect([reads, writes]).toEqual([0, 0])
})

test('node verifier hydrates prepared inputs with a server-issued build token', async () => {
  const { RemoteBuildStore } = await import('@defrex/autobuild/remote-store')
  const { buildContext } = await import('@defrex/autobuild/testing')
  const { scopeLocalStoreToPhaseSession } = await import('@defrex/autobuild/testing')
  const { prepareNodeVerificationContext, NODE_VERIFICATION_CONTEXT } = await import(
    '@defrex/autobuild/testing'
  )
  const { spawnExec } = await import('@defrex/autobuild/testing')
  const { DISPATCHER, KERNEL } = await import('@defrex/autobuild/testing')
  const { rm, readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const workspace = await mkdtemp(join(tmpdir(), 'node-remote-context-'))
  const git = async (...args: string[]) => {
    const result = await spawnExec(['git', ...args], { cwd: workspace })
    if (result.exitCode) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  const projects = testProjects([A])
  const { store: credentials } = testCredentials(projects)
  const owner = await credentials.issue(A, 'owner')
  const backing = new MemoryBuildStore()
  const auth = createMachineAuth({ secret: 'secret', projects, credentials, store: backing })
  const server = createStoreServer({ store: backing, auth })
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) =>
    server.fetch(new Request(input, init))) as typeof fetch
  const project = new RemoteBuildStore({ url: 'http://store', token: owner.token, fetchFn })
  try {
    await Bun.write(
      join(workspace, 'autobuild.toml'),
      '[tickets]\nsource = "file"\nreadyState = "ready"\n[verify]\nsteps = ["visual"]\n[verify.visual]\nkind = "agent"\nskill = "visual"\n',
    )
    await git('init')
    await git('config', 'user.email', 'test@example.com')
    await git('config', 'user.name', 'Test')
    await git('commit', '--allow-empty', '-m', 'base')
    const base = await git('rev-parse', 'HEAD')
    const records = []
    for (const kind of ['node', 'work'] as const) {
      const record = await project.createBuild({
        slug: kind,
        repo: A,
        ticket: { source: 'file', id: kind },
      })
      records.push(record)
      await project.append(record.slug, {
        actor: DISPATCHER,
        type: 'build.created',
        payload: { repo: A, kind, ticket: { source: 'file', id: kind }, baseBranch: 'main' },
      })
      await project.appendWithArtifacts(
        record.slug,
        [{ kind: 'spec', content: `spec for ${kind}` }],
        ([artifact]) => ({
          actor: DISPATCHER,
          type: 'spec.imported',
          payload: {
            ticket: { source: 'file', id: kind },
            artifact: { kind: 'spec', rev: artifact!.revision },
          },
        }),
      )
    }
    const node = records[0]!,
      child = records[1]!
    await git('commit', '--allow-empty', '-m', `child\n\nAutobuild-Build: ${child.slug}`)
    const head = await git('rev-parse', 'HEAD')
    await project.append(node.slug, {
      actor: DISPATCHER,
      type: 'node.opened',
      payload: { sha: base },
    })
    const cycle = { id: 'cycle', parent: base, head }
    const content = await prepareNodeVerificationContext(
      project,
      A,
      cycle,
      { nodeOpened: { sha: base } },
      { exec: spawnExec, workspacePath: workspace },
    )
    await project.appendWithArtifacts(
      node.slug,
      [{ kind: NODE_VERIFICATION_CONTEXT, content }],
      ([artifact]) => ({
        actor: KERNEL,
        type: 'integration.prepared',
        payload: {
          ...cycle,
          config: 'config',
          context: { kind: NODE_VERIFICATION_CONTEXT, rev: artifact!.revision },
        },
      }),
    )
    const delegate = createDelegationHandler({ secret: 'secret', auth, store: backing })
    const response = await delegate(
      request('/credentials/delegate', owner.token, { kind: 'build-runner', id: node.slug }),
    )
    expect(response.status).toBe(200)
    const token = (await response.json()).token
    const guest = new RemoteBuildStore({ url: 'http://store', token, fetchFn })
    const scoped = scopeLocalStoreToPhaseSession(guest.scopeBuild(node.slug), {
      kind: 'build',
      id: node.slug,
      session: 's_test',
    })
    const manifest = await buildContext({
      store: scoped,
      env: {
        store: 'http://store',
        build: node.slug,
        phase: 'verify:visual',
        round: 1,
        session: 's_test',
      },
      workspacePath: workspace,
      exec: spawnExec,
    })
    expect(
      await readFile(
        join(workspace, manifest.nodeVerification!.contributions[0]!.specPath),
        'utf8',
      ),
    ).toBe('spec for work')
    await expect(scoped.getBuild(child.slug)).rejects.toThrow()
    await expect(scoped.getArtifact(child.slug, 'spec', 0)).rejects.toThrow()
    await expect(scoped.getEvents(child.slug)).rejects.toThrow()
    await expect(
      guest.putArtifact(child.slug, { kind: 'spec', content: 'forbidden' }),
    ).rejects.toThrow()
    await expect(guest.append(child.slug, sampleEventWrite())).rejects.toThrow()
    expect(await backing.listArtifacts(child.slug, 'spec')).toHaveLength(1)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
