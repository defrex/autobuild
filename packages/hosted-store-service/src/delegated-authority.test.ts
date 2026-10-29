import { temporaryDirectories as ownTempDirectories } from '@defrex/autobuild/testing'
import { MemoryTicketPolicyStore } from '@defrex/autobuild-postgres-store/ticket-policy'
import { FakeTicketSource } from '@defrex/autobuild/plugin-sdk'
import { createTicketServer } from './ticket-server'
import { afterEach, expect, test } from 'bun:test'
import { MemoryBuildStore, sampleBuildInput, sampleEventWrite } from '@defrex/autobuild/plugin-sdk'
import { mintToken, verifyToken, type DelegatedTokenScope } from '@defrex/autobuild/remote-store'
import { createMachineAuth } from './machine-auth'
import { createDelegationHandler, delegationActive } from './delegated-authority'
import { createStoreServer } from './remote-store-server'
import { testCredentials } from './testing/credentials'
import { testProjects } from './testing/projects'
import {
  AUTOBUILD_VERSION,
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
} from '@defrex/autobuild/remote-store'

const mkdtemp = ownTempDirectories(afterEach)

const A = 'https://github.com/acme/a'
const B = 'https://github.com/acme/b'
const secret = 'delegation-test'
function request(path: string, token: string, body?: unknown, method?: string) {
  return new Request(`http://store${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
      [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
async function fixture(purpose: 'project-owner' | 'dispatcher' = 'project-owner') {
  let time = Date.parse('2026-01-01T00:00:00Z')
  const clock = () => new Date(time)
  const projects = testProjects([A, B])
  const { store: credentials } = testCredentials(projects, secret, clock)
  const project = await credentials.issue(A, 'owner', {
    purpose,
    expiresAt: new Date(time + 7 * 86400000),
  })
  const store = new MemoryBuildStore({ clock })
  for (const [slug, repo] of [
    ['one', A],
    ['two', A],
    ['foreign', B],
  ]) {
    await store.createBuild(sampleBuildInput(slug!, { repo: repo! }))
    await store.append(slug!, sampleEventWrite())
  }
  await store.ensureRepo(A)
  await store.ensureRepo(B)
  const auth = createMachineAuth({ secret, credentials, projects, store, clock })
  const delegate = createDelegationHandler({ store, auth, secret, clock })
  const issue = async (token: string, target: unknown) =>
    delegate(request('/credentials/delegate', token, target))
  const response = await issue(project.token, { kind: 'build-runner', id: 'one' })
  expect(response.status).toBe(200)
  const token = (await response.json()).token as string
  return {
    clock,
    projects,
    credentials,
    project,
    store,
    auth,
    issue,
    token,
    server: createStoreServer({ store, auth, clock }),
    advance: (ms: number) => {
      time += ms
    },
  }
}

test('delegation is strict, signed and has no fixed expiration; retired tokens retain expiration', () => {
  const scope: DelegatedTokenScope = {
    version: 2,
    delegation: { repo: A, kind: 'build-runner', id: 'one', anchor: 1 },
  }
  const token = mintToken(secret, scope)
  expect(verifyToken(secret, token, new Date('2050-01-01'))).toEqual(scope)
  expect(verifyToken('other', token, new Date())).toBeNull()
  for (const delegation of [
    { ...scope.delegation, id: '*' },
    { ...scope.delegation, session: 's' },
    { ...scope.delegation, anchor: 0 },
  ])
    expect(
      verifyToken(secret, mintToken(secret, { version: 2, delegation }), new Date()),
    ).toBeNull()
  expect(
    verifyToken(secret, mintToken(secret, { build: 'one', session: 's', exp: 0 }), new Date()),
  ).toBeNull()
})

test('raw HTTP reads stay project-wide, while every mutation targets the granted build', async () => {
  const f = await fixture()
  const write = sampleEventWrite()
  for (const path of [
    '/builds/two',
    '/builds/two/events',
    `/repos/${encodeURIComponent(A)}/events`,
    '/builds',
  ])
    expect((await f.server.fetch(request(path, f.token))).status).toBe(200)
  for (const [path, body, method] of [
    ['/builds/two/events', write],
    ['/builds/two/events/conditional', { expectedSeq: 1, event: write }],
    ['/builds/two/deposits', { event: write, artifacts: [{ kind: 'x', contentBase64: '' }] }],
    ['/builds/two/artifacts', { kind: 'x', contentBase64: '' }],
    ['/builds/two/lease/claim', { holder: 'h', ttlMs: 60000 }],
    ['/builds/one/node-writer/claim', { holder: 'h', ttlMs: 60000 }],
    ['/builds/one/node-writer/heartbeat', { holder: 'h' }],
    ['/builds/one/node-writer/release', { holder: 'h' }],
    ['/builds/two/snapshots/test', {}, 'PUT'],
    ['/builds', sampleBuildInput('untrusted', { repo: A })],
    [`/repos/${encodeURIComponent(A)}/sessions`, { operator: 'owner' }],
    [`/repos/${encodeURIComponent(A)}/events`, {}],
  ] as const)
    expect((await f.server.fetch(request(path, f.token, body, method))).status).toBe(403)
  expect(await f.store.listArtifacts('two')).toEqual([])
  for (const path of ['/builds/foreign', '/builds/foreign/events'])
    expect((await f.server.fetch(request(path, f.token))).status).toBe(404)
  expect(
    (await f.server.fetch(request(`/repos/${encodeURIComponent(B)}/events`, f.token))).status,
  ).toBe(403)
  expect((await f.server.fetch(request('/builds/one/events', f.token, write))).status).toBe(201)
  const stream = await f.store.createStream({ kind: 'build', build: 'two' }, 'other')
  expect(
    (
      await f.server.fetch(
        request(`/streams/${stream.id}/close`, f.token, { outcome: 'completed' }),
      )
    ).status,
  ).toBe(404)
  expect((await f.issue(f.project.token, { kind: 'build-runner', id: 'foreign' })).status).toBe(403)
  expect((await f.issue(f.token, { kind: 'build-runner', id: 'two' })).status).toBe(403)
})

test('active grants survive dispatcher parent deletion, expiry and service reconstruction, then retire at exactly 60 seconds', async () => {
  const f = await fixture('dispatcher')
  expect(await f.credentials.deleteDispatcherCredential(A, f.project.credential.id)).toBe(1)
  f.advance(10 * 86400000)
  expect((await f.auth.authenticate(request('/builds/one', f.token))).kind).toBe('delegated')
  const reconstructed = createMachineAuth({
    secret,
    credentials: f.credentials,
    projects: f.projects,
    store: f.store,
    clock: f.clock,
  })
  expect((await reconstructed.authenticate(request('/builds/one', f.token))).kind).toBe('delegated')
  await f.store.append('one', {
    actor: { kind: 'kernel' },
    type: 'session.started',
    payload: {
      session: 'surviving-phase',
      role: 'implement',
      runner: 'fake',
      phase: 'implement',
      round: 1,
    },
  })
  const phaseResponse = await f.issue(f.token, {
    kind: 'build-phase',
    id: 'one',
    session: 'surviving-phase',
  })
  expect(phaseResponse.status).toBe(200)
  const phase = (await phaseResponse.json()).token
  expect(
    (
      await f.server.fetch(
        request('/builds/one/events', phase, {
          ...sampleEventWrite(),
          actor: { kind: 'agent', role: 'implement', session: 'surviving-phase' },
        }),
      )
    ).status,
  ).toBe(201)
  await f.store.append('one', { actor: { kind: 'kernel' }, type: 'build.aborted', payload: {} })
  f.advance(59999)
  expect((await f.server.fetch(request('/builds/one', f.token))).status).toBe(200)
  f.advance(1)
  expect((await f.server.fetch(request('/builds/one', f.token))).status).toBe(401)
  expect((await f.server.fetch(request('/builds/one', phase))).status).toBe(401)
})

test('project removal and failed state reads fail closed', async () => {
  const f = await fixture()
  const claims = verifyToken(secret, f.token, f.clock()) as DelegatedTokenScope
  await expect(
    delegationActive(
      {
        ...f.store,
        getBuild: async () => {
          throw new Error('offline')
        },
      } as never,
      claims.delegation,
      f.clock(),
    ),
  ).rejects.toThrow('offline')
  await f.projects.remove(A, 'owner')
  expect((await f.server.fetch(request('/builds/one', f.token))).status).toBe(403)
})

test('runner attenuation survives parent deletion; phase grants cannot delegate or attribute another session', async () => {
  const f = await fixture('dispatcher')
  expect(await f.credentials.deleteDispatcherCredential(A, f.project.credential.id)).toBe(1)
  f.advance(8 * 86400000)
  const target = { kind: 'build-phase', id: 'one', session: 'phase-one' }
  expect((await f.issue(f.token, target)).status).toBe(404)
  await f.store.append('one', {
    actor: { kind: 'kernel' },
    type: 'session.started',
    payload: {
      session: 'phase-one',
      role: 'implement',
      runner: 'fake',
      phase: 'implement',
      round: 1,
    },
  })
  const response = await f.issue(f.token, target)
  expect(response.status).toBe(200)
  const phase = (await response.json()).token
  expect((await f.issue(phase, target)).status).toBe(403)
  expect((await f.issue(f.token, { ...target, id: 'two' })).status).toBe(403)
  const write = sampleEventWrite()
  expect((await f.server.fetch(request('/builds/one/events', phase, write))).status).toBe(403)
  expect(
    (
      await f.server.fetch(
        request('/builds/one/events', phase, {
          ...write,
          actor: { kind: 'agent', role: 'implement', session: 'phase-one' },
        }),
      )
    ).status,
  ).toBe(201)
  expect(
    (
      await f.server.fetch(
        request('/builds/one/events', phase, {
          actor: { kind: 'kernel' },
          type: 'build.paused',
          payload: {},
        }),
      )
    ).status,
  ).toBe(201)
  f.advance(8 * 86400000)
  expect((await f.server.fetch(request('/builds/one', phase))).status).toBe(200)
  await f.store.append('one', {
    actor: { kind: 'kernel' },
    type: 'session.ended',
    payload: {
      session: 'phase-one',
      outcome: 'reclaimed',
      reclaimedBy: { instance: 'replacement', resumedFromSeq: 1 },
    },
  })
  f.advance(60000)
  expect((await f.server.fetch(request('/builds/one', phase))).status).toBe(401)
  expect((await f.server.fetch(request('/builds/one', f.token))).status).toBe(200)
})

test('harvest grant binds run artifacts, atomic deposits, streams and adopted lease holder; recovery cannot resurrect the original grant', async () => {
  const f = await fixture('dispatcher')
  await f.store.claimRepoLease(A, 'dispatcher', 60000)
  await f.store.appendRepo(A, {
    actor: { kind: 'kernel' },
    type: 'harvest.started',
    payload: {
      run: 'run-one',
      observations: [{ build: 'one', seq: 1 }],
      scan: { kind: 'harvest-scan', rev: 0 },
    },
  })
  await f.store.appendRepo(A, {
    actor: { kind: 'dispatcher' },
    type: 'harvest.execution.authorized',
    payload: {
      execution: 'execution-one',
      run: 'run-one',
      launch: 'started',
      leaseHolder: 'dispatcher',
    },
  })
  const target = {
    kind: 'harvest-runner',
    execution: 'execution-one',
    repo: A,
    id: 'run-one',
    leaseHolder: 'dispatcher',
  }
  const issued = await f.issue(f.project.token, target)
  expect(issued.status).toBe(200)
  const token = (await issued.json()).token
  expect(await f.credentials.deleteDispatcherCredential(A, f.project.credential.id)).toBe(1)
  const base = `/repos/${encodeURIComponent(A)}`
  const artifact = { kind: 'harvest-proposals', contentBase64: '', metadata: { run: 'run-one' } }
  expect((await f.server.fetch(request(`${base}/artifacts`, token, artifact))).status).toBe(201)
  expect(
    (
      await f.server.fetch(
        request(`${base}/artifacts`, token, { ...artifact, metadata: { run: 'other' } }),
      )
    ).status,
  ).toBe(403)
  expect(
    (await f.server.fetch(request(`${base}/lease/heartbeat`, token, { holder: 'foreign' }))).status,
  ).toBe(403)
  expect(
    (await f.server.fetch(request(`${base}/lease/heartbeat`, token, { holder: 'dispatcher' })))
      .status,
  ).toBe(200)
  expect(
    (
      await f.server.fetch(
        request(`${base}/lease/claim`, token, { holder: 'foreign', ttlMs: 60000 }),
      )
    ).status,
  ).toBe(403)
  await f.store.releaseRepoLease(A, 'dispatcher')
  const reclaimed = await f.server.fetch(
    request(`${base}/lease/claim`, token, { holder: 'dispatcher', ttlMs: 60000 }),
  )
  expect(reclaimed.status).toBe(200)
  expect(await reclaimed.json()).toEqual({ ok: true })
  expect(
    (
      await f.server.fetch(
        request(`${base}/events`, token, {
          actor: { kind: 'kernel' },
          type: 'harvest.resumed',
          payload: {},
        }),
      )
    ).status,
  ).toBe(403)
  const rejected = await f.server.fetch(
    request(`${base}/deposits`, token, {
      artifacts: [{ ...artifact, metadata: { run: 'other' } }],
      event: {
        actor: { kind: 'kernel' },
        type: 'harvest.proposals.submitted',
        payload: { run: 'run-one', round: 1, artifact: { kind: 'harvest-proposals', rev: -1 } },
      },
    }),
  )
  expect(rejected.status).toBe(403)
  expect(
    (
      await f.server.fetch(
        request(`${base}/deposits`, token, {
          artifacts: [{ ...artifact, metadata: { run: 'other' } }],
          event: {
            actor: { kind: 'dispatcher' },
            type: 'harvest.execution.ended',
            payload: { run: 'run-one', execution: 'execution-one' },
          },
        }),
      )
    ).status,
  ).toBe(403)
  expect(await f.store.listRepoArtifacts(A, 'harvest-proposals')).toHaveLength(1)
  const streamResponse = await f.server.fetch(
    request(`${base}/streams`, token, { label: 'harvest:run-one:execution-one:session:test' }),
  )
  expect(streamResponse.status).toBe(201)
  const stream = await streamResponse.json()
  expect(
    (
      await f.server.fetch(
        request(`/streams/${stream.id}/chunks`, token, { parts: [{ type: 'start' }] }),
      )
    ).status,
  ).toBe(201)
  expect(
    (await f.server.fetch(request(`/streams/${stream.id}/close`, token, { outcome: 'completed' })))
      .status,
  ).toBe(200)
  const other = await f.store.createStream({ kind: 'repo', repo: A }, 'harvest:other:session:test')
  expect(
    (await f.server.fetch(request(`/streams/${other.id}/close`, token, { outcome: 'completed' })))
      .status,
  ).toBe(404)
  await f.store.appendRepo(A, {
    actor: { kind: 'kernel' },
    type: 'harvest.failed',
    payload: {
      run: 'run-one',
      step: 'synthesize',
      round: 1,
      attempt: 1,
      error: 'interrupted',
      willRetry: false,
    },
  })
  await f.store.appendRepo(A, {
    actor: { kind: 'human', user: 'owner' },
    type: 'harvest.resume-requested',
    payload: {},
  })
  await f.store.appendRepo(A, { actor: { kind: 'kernel' }, type: 'harvest.resumed', payload: {} })
  await f.store.appendRepo(A, {
    actor: { kind: 'dispatcher' },
    type: 'harvest.execution.authorized',
    payload: {
      execution: 'execution-two',
      run: 'run-one',
      launch: 'resumed',
      leaseHolder: 'dispatcher',
    },
  })
  const nextTick = await f.credentials.issue(A, 'next cron', { purpose: 'dispatcher' })
  const fresh = await f.issue(nextTick.token, { ...target, execution: 'execution-two' })
  expect(fresh.status).toBe(200)
  const replacement = (await fresh.json()).token
  expect(replacement).not.toBe(token)
  f.advance(60000)
  expect((await f.server.fetch(request(`${base}/events`, token))).status).toBe(401)
  expect((await f.server.fetch(request(`${base}/events`, replacement))).status).toBe(200)
})

test('ticket operation matrix enforces every delegated grant kind before parsing or source construction', async () => {
  const f = await fixture()
  await f.store.append('one', {
    actor: { kind: 'kernel' },
    type: 'session.started',
    payload: { session: 'phase', role: 'implement', runner: 'fake', phase: 'implement', round: 1 },
  })
  await f.store.appendRepo(A, {
    actor: { kind: 'kernel' },
    type: 'harvest.started',
    payload: {
      run: 'run',
      observations: [{ build: 'one', seq: 1 }],
      scan: { kind: 'harvest-scan', rev: 0 },
    },
  })
  await f.store.appendRepo(A, {
    actor: { kind: 'dispatcher' },
    type: 'harvest.execution.authorized',
    payload: { execution: 'execution', run: 'run', launch: 'started', leaseHolder: 'dispatcher' },
  })
  await f.store.appendRepo(A, {
    actor: { kind: 'kernel' },
    type: 'harvest.session.started',
    payload: {
      run: 'run',
      session: 'harvest-phase',
      role: 'harvest',
      runner: 'fake',
      args: [],
      step: 'synthesize',
      round: 1,
    },
  })
  await f.store.claimRepoLease(A, 'dispatcher', 60000)
  const targets = [
    { kind: 'build-runner', id: 'one' },
    { kind: 'build-phase', id: 'one', session: 'phase' },
    {
      kind: 'harvest-runner',
      repo: A,
      id: 'run',
      execution: 'execution',
      leaseHolder: 'dispatcher',
    },
    { kind: 'harvest-phase', repo: A, id: 'run', session: 'harvest-phase' },
  ]
  const inputs = {
    'list-ready': {},
    get: { id: 'unknown' },
    'dependency-states': { ids: ['unknown'] },
    states: {},
    'add-state': { name: 'icebox', about: 'Deferred' },
    create: { draft: { title: 'Proposal', body: 'Spec' } },
    claim: { id: 'unknown' },
    comment: { id: 'unknown', body: 'hello' },
    transition: { id: 'unknown', state: 'Ready' },
    update: { id: 'unknown', patch: { title: 'Updated' } },
    'add-blocker': { id: 'unknown', blockerId: 'other' },
    'remove-blocker': { id: 'unknown', blockerId: 'other' },
  }
  let harvestToken = ''
  for (const target of targets) {
    const issued = await f.issue(
      target.kind === 'harvest-phase' ? harvestToken : f.project.token,
      target,
    )
    expect(issued.status).toBe(200)
    const token = (await issued.json()).token
    if (target.kind === 'harvest-runner') harvestToken = token
    const { createOperatorServer } = await import('./operator-server')
    const operator = createOperatorServer({
      store: f.store,
      projects: f.projects,
      auth: f.auth,
      secret,
      clock: f.clock,
    })
    const beforeRecovery = await f.store.getRepoEvents(A)
    const clear = await operator.fetch(
      request(`/operator/v1/repos/${encodeURIComponent(A)}/tools/repository.forge_clear`, token, {
        repo: A,
        forge: 'github',
        reason: 'spoofed operator',
        actor: { kind: 'human', user: 'owner' },
      }),
    )
    expect(clear.status).toBe(403)
    expect(await f.store.getRepoEvents(A)).toEqual(beforeRecovery)
    for (const [operation, input] of Object.entries(inputs)) {
      let opened = false
      const server = createTicketServer({
        secret,
        auth: f.auth,
        sourceFor: () => {
          opened = true
          return new FakeTicketSource([])
        },
      })
      const allowed =
        target.kind.startsWith('harvest') &&
        (['list-ready', 'get', 'dependency-states', 'states'].includes(operation) ||
          (target.kind === 'harvest-runner' && operation === 'create'))
      const response = await server.fetch(
        request(`/tickets/${operation}`, token, {
          context: { teamKey: 'TEAM' },
          input,
        }),
      )
      expect(response.status).toBe(allowed ? (operation === 'create' ? 201 : 200) : 403)
      expect(opened).toBe(allowed)
      if (allowed && operation === 'create') {
        for (const requestedId of ['TEAM-706', 'TEAM-9223372036854775807', 'foreign']) {
          opened = false
          const denied = await server.fetch(
            request('/tickets/create', token, {
              context: { teamKey: 'TEAM' },
              input: { draft: { title: 'Forbidden import', body: '' }, options: { requestedId } },
            }),
          )
          expect(denied.status).toBe(403)
          expect(await denied.json()).toMatchObject({
            kind: 'auth',
            error: 'only project or owner authority may request a ticket id',
          })
          expect(opened).toBe(false)
        }
      }
      if (!allowed) {
        expect((await response.json()).error).toBe(
          `delegated ${target.kind} credential cannot perform ticket operation ${operation}`,
        )
        const malformed = await server.fetch(request(`/tickets/${operation}`, token, {}))
        expect(malformed.status).toBe(403)
      }
    }
  }
  const backend = new FakeTicketSource([])
  const projectServer = createTicketServer({ secret, auth: f.auth, sourceFor: () => backend })
  const imported = await projectServer.fetch(
    request('/tickets/create', f.project.token, {
      context: { teamKey: 'TEAM' },
      input: {
        draft: { title: 'Operator import', body: '' },
        options: { requestedId: 'TEAM-706' },
      },
    }),
  )
  expect(imported.status).toBe(201)
  expect((await imported.json()).ref.id).toBe('TEAM-706')
  expect((await backend.listReady({})).tickets).toHaveLength(1)
})

test('project and admin credentials retain every hosted ticket operation', async () => {
  const f = await fixture()
  const admin = mintToken(secret, {
    version: 1,
    ownerAdmin: { user: 'owner' },
    exp: f.clock().getTime() + 60000,
  })
  for (const token of [f.project.token, admin]) {
    const backend = new FakeTicketSource([])
    const server = createTicketServer({ secret, auth: f.auth, sourceFor: () => backend })
    const invoke = (operation: string, input: unknown) =>
      server.fetch(request(`/tickets/${operation}`, token, { context: { teamKey: 'TEAM' }, input }))
    const created = await invoke('create', { draft: { title: 'Ticket', body: 'Spec' } })
    expect(created.status).toBe(201)
    const {
      ref: { id },
    } = await created.json()
    const blocker = await backend.create({ title: 'Blocker', body: 'Spec' })
    for (const [operation, input] of [
      ['list-ready', {}],
      ['get', { id }],
      ['dependency-states', { ids: [id] }],
      ['claim', { id }],
      ['comment', { id, body: 'Comment' }],
      ['transition', { id, state: 'Ready' }],
      ['update', { id, patch: { title: 'New' } }],
      ['add-blocker', { id, blockerId: blocker.ref.id }],
      ['remove-blocker', { id, blockerId: blocker.ref.id }],
    ] as const)
      expect((await invoke(operation, input)).status).toBe(200)
  }
})

test('a prepared harvest reads hosted tickets and files proposals using delegated credentials end to end', async () => {
  const { ScriptedAgentRunner, defaultTurnResult } = await import('@defrex/autobuild/plugin-sdk')
  const { HostedTicketSource } = await import('@defrex/autobuild/hosted-tickets')
  const { RemoteBuildStore } = await import('@defrex/autobuild/remote-store')
  const {
    HarvestRunner,
    parseConfig,
    sequentialIds,
    randomUuids,
    buildHarvestContext,
    submitHarvestProposals,
    submitHarvestVerdict,
    resolveHarvestCliEnv,
  } = await import('@defrex/autobuild/testing')
  const { readFile, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const f = await fixture()
  const workspace = await mkdtemp(join(tmpdir(), 'ab-delegated-harvest-'))
  const backend = new FakeTicketSource([])
  const tickets = createTicketServer({ secret, auth: f.auth, sourceFor: () => backend })
  const calls: Array<{ kind: string; operation: string }> = []
  const http = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname
      if (path === '/credentials/delegate') {
        return createDelegationHandler({ store: f.store, auth: f.auth, secret, clock: f.clock })(
          req,
        )
      }
      if (path.startsWith('/tickets/')) {
        const principal = await f.auth.authenticate(req)
        calls.push({
          kind: principal.kind === 'delegated' ? principal.delegation.kind : principal.kind,
          operation: path.slice('/tickets/'.length),
        })
        return tickets.fetch(req)
      }
      return f.server.fetch(req)
    },
  })
  try {
    const url = `http://127.0.0.1:${http.port}`
    await f.store.append('one', {
      actor: { kind: 'agent', role: 'implement', session: 'origin' },
      type: 'observation.recorded',
      payload: { id: 'obs', kind: 'latent-bug', summary: 'A concrete defect' },
    })
    await f.store.claimRepoLease(A, 'dispatcher', 60000)
    const config = parseConfig(
      '[tickets]\nsource = "hosted"\nteamKey = "TEAM"\nreadyState = "Ready"\n[roles.default]\nruntime = "scripted"\n[policy]\nharvestThreshold = 1',
    )
    const ids = sequentialIds()
    const scripted = new ScriptedAgentRunner({
      script: async ({ opts }) => {
        const env = resolveHarvestCliEnv(opts.env)
        const store = new RemoteBuildStore({ url, token: opts.env!.AB_TOKEN! })
        const deps = { store, env, workspacePath: workspace, ids }
        await buildHarvestContext(deps)
        const phaseTickets = new HostedTicketSource({
          url,
          token: opts.env!.AB_TOKEN!,
          teamKey: 'TEAM',
        })
        await phaseTickets.get('unknown')
        if (opts.skill === 'ab-harvest') {
          const observations = JSON.parse(
            await readFile(join(workspace, '.ab/observations.json'), 'utf8'),
          )
          const file = join(workspace, 'proposals.json')
          await writeFile(
            file,
            JSON.stringify({
              proposals: [
                {
                  action: 'create',
                  title: 'Fix the observed defect',
                  whatWhy: 'The recorded defect needs correcting.',
                  acceptanceCriteria: ['The defect no longer occurs.'],
                  outOfScope: ['Unrelated cleanup.'],
                  observations: observations.map(
                    (item: { occurrence: { build: string; seq: number } }) => item.occurrence,
                  ),
                },
              ],
            }),
          )
          await submitHarvestProposals(deps, file)
        } else {
          const notes = join(workspace, 'review.md')
          await writeFile(notes, 'Approved')
          await submitHarvestVerdict(deps, { verdict: 'approve', notes })
        }
        return defaultTurnResult('done')
      },
    })
    const common = {
      config,
      runtimes: { scripted: { runner: scripted, servesModels: [''] } },
      repo: A,
      workspacePath: workspace,
      ids,
      uuids: randomUuids(),
      clock: f.clock,
      instance: 'execution',
      leaseHolder: 'dispatcher',
      opts: { heartbeatMs: 100000 },
    }
    const prepared = await new HarvestRunner({ ...common, store: f.store, tickets: backend }).run(
      true,
    )
    expect(prepared.outcome).toBe('prepared')
    if (prepared.outcome !== 'prepared') throw new Error('harvest not prepared')
    await f.store.appendRepo(A, {
      actor: { kind: 'dispatcher' },
      type: 'harvest.execution.authorized',
      payload: {
        execution: 'execution',
        run: prepared.run,
        launch: prepared.launch,
        leaseHolder: 'dispatcher',
      },
    })
    const issued = await f.issue(f.project.token, {
      kind: 'harvest-runner',
      repo: A,
      id: prepared.run,
      execution: 'execution',
      leaseHolder: 'dispatcher',
    })
    expect(issued.status).toBe(200)
    const token = (await issued.json()).token
    const result = await new HarvestRunner({
      ...common,
      preparedRun: { run: prepared.run },
      store: new RemoteBuildStore({ url, token }),
      tickets: new HostedTicketSource({ url, token, teamKey: 'TEAM' }),
      sessionEnv: { AB_STORE: url, AB_TOKEN: token },
    }).run()
    expect(result.outcome).toBe('completed')
    expect(calls).toContainEqual({ kind: 'harvest-phase', operation: 'get' })
    expect(calls).toContainEqual({ kind: 'harvest-runner', operation: 'create' })
    expect((await backend.listReady({})).tickets).toHaveLength(1)
  } finally {
    http.stop(true)
    await rm(workspace, { recursive: true, force: true })
  }
})

test('composed ticket routing binds delegated harvest access to its authenticated project', async () => {
  const { createHostedStoreService } = await import('./service')
  const { parseConfig } = await import('@defrex/autobuild/testing')
  const f = await fixture()
  const config = parseConfig('[tickets]\nsource = "hosted"\nteamKey = "TEAM"\nreadyState = "Ready"')
  const artifact = await f.store.putRepoArtifact(A, {
    kind: 'dispatcher-effective-config',
    content: JSON.stringify({
      ...config,
      verify: { steps: config.verify.steps },
      finalize: { steps: config.finalize.steps },
    }),
  })
  await f.store.appendRepo(A, {
    actor: { kind: 'dispatcher' },
    type: 'dispatcher.run-started',
    payload: {
      run: 'dispatch',
      pid: 1,
      effectiveConfig: { kind: artifact.kind, rev: artifact.revision },
      roleWarnings: [],
    },
  })
  await f.store.appendRepo(A, {
    actor: { kind: 'kernel' },
    type: 'harvest.started',
    payload: {
      run: 'run',
      observations: [{ build: 'one', seq: 1 }],
      scan: { kind: 'harvest-scan', rev: 0 },
    },
  })
  await f.store.appendRepo(A, {
    actor: { kind: 'dispatcher' },
    type: 'harvest.execution.authorized',
    payload: { execution: 'execution', run: 'run', launch: 'started', leaseHolder: 'dispatcher' },
  })
  await f.store.claimRepoLease(A, 'dispatcher', 60000)
  const opened: string[] = []
  const service = createHostedStoreService({
    openTicketPolicy: async () => new MemoryTicketPolicyStore(),
    env: {
      AB_STORE_SECRET: secret,
      AB_POSTGRES_URL: 'postgres://injected/test',
      AB_BLOB_BACKEND: 's3',
      AB_S3_BUCKET: 'unused',
      AB_S3_REGION: 'unused',
      AB_S3_ACCESS_KEY_ID: 'unused',
      AB_S3_SECRET_ACCESS_KEY: 'unused',
    },
    clock: f.clock,
    openStore: async () => f.store,
    openProjectRegistry: async () => f.projects,
    openCredentials: async () => f.credentials,
    sourceFor: (context) => {
      opened.push(context.repo)
      return new FakeTicketSource([])
    },
  })
  const issued = await service.fetch(
    request('/credentials/delegate', f.project.token, {
      kind: 'harvest-runner',
      repo: A,
      id: 'run',
      execution: 'execution',
      leaseHolder: 'dispatcher',
    }),
  )
  expect(issued.status).toBe(200)
  const token = (await issued.json()).token
  expect(
    (
      await service.fetch(
        request('/tickets/list-ready', token, { context: { teamKey: 'FORGED' }, input: {} }),
      )
    ).status,
  ).toBe(200)
  expect(opened).toEqual([A])
  expect(
    (
      await service.fetch(
        request('/tickets/list-ready', token, {
          context: { repo: B, teamKey: 'FORGED' },
          input: {},
        }),
      )
    ).status,
  ).toBe(403)
  expect((await service.fetch(request('/tickets/claim', token, {}))).status).toBe(403)
  expect((await service.fetch(request('/tickets/list-ready', f.token, {}))).status).toBe(403)
  expect(opened).toEqual([A])
})

test('persisted lifecycle facts match full replay for historical anchors, duplicates, retries and invalid endings', async () => {
  const { resolveReducerValue } = await import('@defrex/autobuild/remote-store')
  const { evaluateDelegationLifecycle, evaluateDelegationFacts } = await import(
    './delegated-authority'
  )
  const { MemoryBuildStore, sampleBuildInput } = await import('@defrex/autobuild/plugin-sdk')
  const store = new MemoryBuildStore()
  const build = await store.createBuild(sampleBuildInput('oracle', { repo: A }))
  const at = '2026-01-01T00:00:00.000Z'
  const buildSpecs = [
    ['observation.recorded', { id: 'o', kind: 'followup', summary: 'test' }],
    [
      'session.started',
      { session: 'phase', phase: 'implement', round: 1, role: 'implement', runner: 'test' },
    ],
    [
      'session.started',
      { session: 'phase', phase: 'implement', round: 1, role: 'implement', runner: 'test' },
    ],
    [
      'session.ended',
      {
        session: 'wrong',
        transcript: { kind: 'transcript', rev: 0 },
        usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
      },
    ],
    [
      'session.ended',
      {
        session: 'phase',
        transcript: { kind: 'transcript', rev: 0 },
        usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
      },
    ],
    ['build.aborted', {}],
  ] as const
  const repoSpecs = [
    [
      'harvest.started',
      { run: 'run', observations: [{ build: 'oracle', seq: 1 }], scan: { kind: 'scan', rev: 0 } },
    ],
    [
      'harvest.execution.authorized',
      { run: 'run', execution: 'exec', leaseHolder: 'holder', launch: 'started' },
    ],
    [
      'harvest.session.started',
      {
        run: 'run',
        session: 'phase',
        step: 'synthesize',
        round: 1,
        role: 'harvest',
        runner: 'test',
        args: [],
      },
    ],
    [
      'harvest.session.started',
      {
        run: 'run',
        session: 'phase',
        step: 'synthesize',
        round: 1,
        role: 'harvest',
        runner: 'test',
        args: [],
      },
    ],
    [
      'harvest.failed',
      { run: 'run', step: 'synthesize', round: 1, attempt: 1, error: 'test', willRetry: true },
    ],
    [
      'harvest.session.ended',
      {
        run: 'run',
        session: 'wrong',
        transcript: { kind: 'transcript', rev: 0 },
        usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
      },
    ],
    [
      'harvest.session.ended',
      {
        run: 'run',
        session: 'phase',
        transcript: { kind: 'transcript', rev: 0 },
        usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
      },
    ],
    [
      'harvest.session.suspended',
      {
        run: 'run',
        session: 'phase',
        cause: 'shutdown',
        transcript: { kind: 'transcript', rev: 0 },
      },
    ],
    [
      'harvest.execution.released',
      { execution: 'exec', environmentId: 'env', snapshots: { outcome: 'confirmed' } },
    ],
    [
      'harvest.failed',
      { run: 'run', step: 'synthesize', round: 1, attempt: 2, error: 'test', willRetry: false },
    ],
  ] as const
  for (const domain of ['build', 'repo'] as const) {
    const specs = domain === 'build' ? buildSpecs : repoSpecs
    for (const invalid of [false, true]) {
      const events = specs.map(([type, payload], index) => ({
        [domain === 'build' ? 'build' : 'repo']: domain === 'build' ? 'oracle' : A,
        seq: index + 1,
        ts: invalid && index === specs.length - 1 ? 'invalid timestamp' : at,
        type,
        payload,
        actor: { kind: 'kernel' },
      }))
      for (let length = 0; length <= events.length; length++) {
        const prefix = events.slice(0, length)
        const { reducer } = resolveReducerValue(
          domain === 'build' ? { kind: 'build', slug: 'oracle' } : { kind: 'repo', repo: A },
          { reducer: domain === 'build' ? 'buildDelegation' : 'harvestDelegation' },
        )
        const facts = reducer.finish(
          reducer.advance(reducer.advance(reducer.initial(), prefix.slice(0, 2)), prefix.slice(2)),
        )
        for (const anchor of [1, 2, 3, 4, 5, 99])
          for (const session of [undefined, 'phase', 'wrong'])
            for (const offset of [-1, 59999, 60000, 60001]) {
              const claims = {
                repo: A,
                id: domain === 'build' ? 'oracle' : 'run',
                anchor,
                kind:
                  domain === 'build'
                    ? session
                      ? 'build-phase'
                      : 'build-runner'
                    : session
                      ? 'harvest-phase'
                      : 'harvest-runner',
                ...(domain === 'repo' ? { execution: 'exec', leaseHolder: 'holder' } : {}),
                ...(session ? { session } : {}),
              } as DelegatedTokenScope['delegation']
              const lifecycle =
                domain === 'build'
                  ? {
                      build,
                      buildEvents:
                        prefix as unknown as import('@defrex/autobuild/plugin-sdk').AbEvent[],
                    }
                  : {
                      repositoryEvents:
                        prefix as unknown as import('@defrex/autobuild/remote-store').RepositoryEvent[],
                    }
              const now = new Date(Date.parse(at) + offset)
              expect(evaluateDelegationFacts(claims, facts, now)).toBe(
                evaluateDelegationLifecycle(claims, lifecycle, now),
              )
            }
      }
    }
  }
  await store.close()
})

test('delegated credentials cannot forge value checkpoints or extend an ended lifecycle', async () => {
  const { resolveReducerValue } = await import('@defrex/autobuild/remote-store')
  const f = await fixture()
  const started = await f.store.append('one', {
    actor: { kind: 'kernel' },
    type: 'session.started',
    payload: {
      session: 'ended-phase',
      role: 'implement',
      phase: 'implement',
      round: 1,
      runner: 'test',
    },
  })
  const issued = await f.issue(f.token, { kind: 'build-phase', id: 'one', session: 'ended-phase' })
  expect(issued.status).toBe(200)
  const phaseToken = (await issued.json()).token as string
  const ended = await f.store.append('one', {
    actor: { kind: 'kernel' },
    type: 'session.ended',
    payload: {
      session: 'ended-phase',
      outcome: 'reclaimed',
      reclaimedBy: { instance: 'replacement', resumedFromSeq: started.seq },
    },
  })
  const scope = { kind: 'build' as const, slug: 'one' }
  const resolved = resolveReducerValue(scope, { reducer: 'buildDelegation' })
  const legacyKey = `value.${new Bun.CryptoHasher('sha256').update(resolved.identity).digest('hex').slice(0, 56)}`
  const forged = {
    version: resolved.reducer.version,
    cursor: ended.seq,
    state: {
      identity: resolved.identity,
      acc: {
        lastSeq: ended.seq,
        sessions: {
          'id:ended-phase': { starts: [started.seq], endings: [] },
          'id:never-started': { starts: [started.seq], endings: [] },
        },
        terminals: [],
      },
    },
  }
  for (const token of [phaseToken, f.token, f.project.token])
    for (const key of [resolved.key, legacyKey, 'value.arbitrary']) {
      const path = `/builds/one/snapshots/${key}`
      expect((await f.server.fetch(request(path, token, forged, 'PUT'))).status).toBe(400)
      expect((await f.server.fetch(request(`${path}?version=1`, token))).status).toBe(400)
    }
  // Generic snapshots retain their historical API outside the reserved prefix.
  expect(
    (
      await f.server.fetch(
        request(
          '/builds/one/snapshots/legacy-client',
          phaseToken,
          { version: 1, cursor: ended.seq, state: { ok: true } },
          'PUT',
        ),
      )
    ).status,
  ).toBe(200)
  expect(
    (await f.server.fetch(request('/builds/one/snapshots/legacy-client?version=1', phaseToken)))
      .status,
  ).toBe(200)
  expect(
    (await f.issue(f.token, { kind: 'build-phase', id: 'one', session: 'never-started' })).status,
  ).toBe(404)
  // A checkpoint forged through the prior release must not survive an upgrade.
  const snapshots = Reflect.get(f.store, 'snapshots') as Map<string, typeof forged>
  snapshots.set(`build:one\u0000${legacyKey}`, forged)
  snapshots.delete(`build:one\u0000${resolved.key}`)
  f.advance(59999)
  expect((await f.server.fetch(request('/builds/one', phaseToken))).status).toBe(200)
  f.advance(1)
  expect((await f.server.fetch(request('/builds/one', phaseToken))).status).toBe(401)
  expect(
    (await f.issue(f.token, { kind: 'build-phase', id: 'one', session: 'never-started' })).status,
  ).toBe(404)
  const terminal = await f.store.append('one', {
    actor: { kind: 'kernel' },
    type: 'build.aborted',
    payload: {},
  })
  expect(
    (
      await f.server.fetch(
        request(
          `/builds/one/snapshots/${resolved.key}`,
          f.token,
          { ...forged, cursor: terminal.seq },
          'PUT',
        ),
      )
    ).status,
  ).toBe(400)
  f.advance(60000)
  expect((await f.server.fetch(request('/builds/one', f.token))).status).toBe(401)
})

test.each(['build-runner', 'build-phase'] as const)(
  '%s forge guard records cooldown through delegated HTTP authority and waits for dispatcher recovery',
  async (kind) => {
    const { RemoteBuildStore } = await import('@defrex/autobuild/remote-store')
    const { FakeForge, ForgeFailure } = await import('@defrex/autobuild/plugin-sdk')
    const { guardForge } = await import('@defrex/autobuild/testing')
    const f = await fixture()
    let token = f.token
    if (kind === 'build-phase') {
      await f.store.append('one', {
        actor: { kind: 'kernel' },
        type: 'session.started',
        payload: {
          session: 'guard-phase',
          role: 'implement',
          runner: 'fake',
          phase: 'implement',
          round: 1,
        },
      })
      const response = await f.issue(f.token, { kind, id: 'one', session: 'guard-phase' })
      expect(response.status).toBe(200)
      token = (await response.json()).token
    }
    // B is independently registered and accessible with its own authority.
    const other = await f.credentials.issue(B, 'other-owner', {
      purpose: 'project-owner',
      expiresAt: new Date(+f.clock() + 86400000),
    })
    expect(
      (await f.server.fetch(request(`/repos/${encodeURIComponent(B)}/events`, other.token))).status,
    ).toBe(200)
    const cooldown = {
      actor: { kind: 'kernel' },
      type: 'dispatcher.forge-degraded',
      payload: {
        forge: 'github',
        message: 'limit',
        firstFailureAt: f.clock().toISOString(),
        resetAt: new Date(+f.clock() + 1000).toISOString(),
      },
    }
    expect(await f.projects.has(A)).toBe(true)
    expect(await f.projects.has(B)).toBe(true)
    const artifactsA = await f.store.listRepoArtifacts(A)
    const artifactsB = await f.store.listRepoArtifacts(B)
    const beforeA = await f.store.getRepoEvents(A)
    const beforeB = await f.store.getRepoEvents(B)
    const denied = await f.server.fetch(
      request(`/repos/${encodeURIComponent(B)}/events`, token, cooldown),
    )
    expect(denied.status).toBe(403)
    expect(await denied.text()).toContain('wrong project')
    expect(await f.store.getRepoEvents(A)).toEqual(beforeA)
    expect(await f.store.getRepoEvents(B)).toEqual(beforeB)
    expect(await f.store.listRepoArtifacts(A)).toEqual(artifactsA)
    expect(await f.store.listRepoArtifacts(B)).toEqual(artifactsB)
    for (const actor of [
      { kind: 'human', user: 'owner' },
      { kind: 'dispatcher' },
      { kind: 'agent', session: 'guard-phase', role: 'implement' },
    ]) {
      const before = await f.store.getRepoEvents(A)
      const artifacts = await f.store.listRepoArtifacts(A)
      expect(
        (
          await f.server.fetch(
            request(`/repos/${encodeURIComponent(A)}/events`, token, { ...cooldown, actor }),
          )
        ).status,
      ).toBe(403)
      expect(await f.store.getRepoEvents(A)).toEqual(before)
      expect(await f.store.listRepoArtifacts(A)).toEqual(artifacts)
    }
    const remote = new RemoteBuildStore({
      url: 'http://store',
      token,
      fetchFn: ((input, init) => f.server.fetch(new Request(input, init))) as typeof fetch,
    })
    const raw = new FakeForge()
    let calls = 0
    raw.getPrState = async () => {
      if (++calls === 1)
        throw new ForgeFailure('primary limit', {
          kind: 'rate-limited',
          resetAt: new Date(f.clock().getTime() + 1000).toISOString(),
        })
      return { state: 'open', mergeable: true }
    }
    const guarded = guardForge(raw, {
      store: remote,
      repo: A,
      name: 'github',
      now: f.clock,
      wait: true,
    })
    const result = guarded.getPrState(A, 1)
    // Wait for the actual HTTP append before checking that retry is parked.
    for (let n = 0; n < 100 && (await f.store.getRepoEvents(A)).length === 0; n++)
      await Bun.sleep(10)
    expect((await f.store.getRepoEvents(A)).map((e) => e.type)).toEqual([
      'dispatcher.forge-degraded',
    ])
    expect(calls).toBe(1)
    f.advance(60_000)
    // Only the dispatcher can record recovery; delegates get no general repo write grant.
    for (const body of [
      {
        actor: { kind: 'kernel' },
        type: 'dispatcher.forge-recovered',
        payload: { forge: 'github' },
      },
      {
        actor: { kind: 'dispatcher' },
        type: 'dispatcher.forge-degraded',
        payload: {
          forge: 'github',
          message: 'x',
          resetAt: f.clock().toISOString(),
          firstFailureAt: f.clock().toISOString(),
        },
      },
    ])
      expect(
        (await f.server.fetch(request(`/repos/${encodeURIComponent(A)}/events`, token, body)))
          .status,
      ).toBe(403)
    expect((await f.server.fetch(request('/repos', token, { repo: A }))).status).toBe(403)
    await f.store.appendRepo(A, {
      actor: { kind: 'dispatcher' },
      type: 'dispatcher.forge-recovered',
      payload: { forge: 'github' },
    })
    expect(await result).toEqual({ state: 'open', mergeable: true })
    expect(calls).toBe(2)
  },
  35_000,
)

test('harvest suspension closes the old phase immediately while runner authority opens a fresh continuation', async () => {
  const f = await fixture()
  await f.store.appendRepo(A, {
    actor: { kind: 'kernel' },
    type: 'harvest.started',
    payload: {
      run: 'resume-run',
      observations: [{ build: 'one', seq: 1 }],
      scan: { kind: 'scan', rev: 0 },
    },
  })
  await f.store.appendRepo(A, {
    actor: { kind: 'dispatcher' },
    type: 'harvest.execution.authorized',
    payload: { execution: 'exec', run: 'resume-run', launch: 'started', leaseHolder: 'holder' },
  })
  await f.store.claimRepoLease(A, 'holder', 60000)
  const issued = await f.issue(f.project.token, {
    kind: 'harvest-runner',
    execution: 'exec',
    repo: A,
    id: 'resume-run',
    leaseHolder: 'holder',
  })
  expect(issued.status).toBe(200)
  const token = (await issued.json()).token
  const base = `/repos/${encodeURIComponent(A)}`
  const start = (session: string, continuation?: unknown) => ({
    actor: { kind: 'kernel' },
    type: 'harvest.session.started',
    payload: {
      run: 'resume-run',
      session,
      role: 'harvest',
      runner: 'scripted',
      step: 'synthesize',
      round: 1,
      ...(continuation ? { continuation } : {}),
    },
  })
  expect((await f.server.fetch(request(`${base}/events`, token, start('old')))).status).toBe(201)
  const oldResponse = await f.issue(token, {
    kind: 'harvest-phase',
    repo: A,
    id: 'resume-run',
    session: 'old',
  })
  expect(oldResponse.status).toBe(200)
  const old = (await oldResponse.json()).token
  expect(
    (
      await f.server.fetch(
        request(`${base}/events`, token, {
          actor: { kind: 'kernel' },
          type: 'harvest.session.suspended',
          payload: {
            run: 'resume-run',
            session: 'old',
            cause: 'cutover',
            transcript: { kind: 'harvest-transcript', rev: 0 },
          },
        }),
      )
    ).status,
  ).toBe(201)
  expect((await f.server.fetch(request(`${base}/events`, old))).status).toBe(401)
  expect(
    (
      await f.server.fetch(
        request(
          `${base}/events`,
          token,
          start('new', { predecessor: 'old', root: 'old', cause: 'cutover' }),
        ),
      )
    ).status,
  ).toBe(201)
  const fresh = await f.issue(token, {
    kind: 'harvest-phase',
    repo: A,
    id: 'resume-run',
    session: 'new',
  })
  expect(fresh.status).toBe(200)
  expect((await f.server.fetch(request(`${base}/events`, (await fresh.json()).token))).status).toBe(
    200,
  )
  expect((await f.server.fetch(request(`${base}/events`, old))).status).toBe(401)
})

test('hosted admission validates cooldowns before append, deposit or tick finish for every authority', async () => {
  const f = await fixture()
  const admin = mintToken(secret, {
    version: 1,
    ownerAdmin: { user: 'admin' },
    exp: +f.clock() + 86400000,
  })
  for (const token of [f.project.token, f.token, admin]) {
    for (const resetAt of [
      undefined,
      'invalid',
      '9999-01-01T00:00:00Z',
      new Date(+f.clock() + 86400001).toISOString(),
    ]) {
      const event = {
        actor: { kind: 'kernel' },
        type: 'dispatcher.forge-degraded',
        payload: {
          forge: 'github',
          message: 'limit',
          firstFailureAt: f.clock().toISOString(),
          resetAt,
        },
      }
      const before = await f.store.getRepoEvents(A)
      const artifacts = await f.store.listRepoArtifacts(A)
      expect(
        (await f.server.fetch(request(`/repos/${encodeURIComponent(A)}/events`, token, event)))
          .status,
      ).toBe(400)
      expect(await f.store.getRepoEvents(A)).toEqual(before)
      const response = await f.server.fetch(
        request(`/repos/${encodeURIComponent(A)}/deposits`, token, {
          event,
          artifacts: [{ kind: 'evidence', contentBase64: 'eA==' }],
        }),
      )
      expect(response.status).toBe(token === f.token ? 403 : 400)
      expect(await f.store.listRepoArtifacts(A)).toEqual(artifacts)
      expect(await f.store.getRepoEvents(A)).toEqual(before)
      if (token !== f.token) {
        const holder = 'admission-test'
        expect(await f.store.claimRepoLease(A, holder, 60_000)).toBe(true)
        const startedAt = await f.store.beginRepoTick(A, holder)
        const tick = (await f.store.getRepo(A))?.tick
        const response = await f.server.fetch(
          request(`/repos/${encodeURIComponent(A)}/tick/finish`, token, {
            holder,
            completion: { outcome: 'failed', error: 'test failure' },
            events: [
              {
                actor: { kind: 'dispatcher' },
                type: 'dispatcher.tick-started',
                payload: { run: holder, startedAt },
              },
              { ...event, actor: { kind: 'dispatcher' } },
            ],
          }),
        )
        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({
          kind: 'validation',
          error: expect.stringContaining('resetAt'),
        })
        expect(await f.store.getRepoEvents(A)).toEqual(before)
        expect(await f.store.listRepoArtifacts(A)).toEqual(artifacts)
        expect((await f.store.getRepo(A))?.tick).toEqual(tick)
      }
    }
  }
  for (const offset of [-1000, 86400000]) {
    expect(
      (
        await f.server.fetch(
          request(`/repos/${encodeURIComponent(A)}/events`, f.token, {
            actor: { kind: 'kernel' },
            type: 'dispatcher.forge-degraded',
            payload: {
              forge: 'github',
              message: 'limit',
              firstFailureAt: f.clock().toISOString(),
              resetAt: new Date(+f.clock() + offset).toISOString(),
            },
          }),
        )
      ).status,
    ).toBe(201)
  }
})

test('a provider deadline beyond admission fails recording explicitly without retrying the provider', async () => {
  const { RemoteBuildStore } = await import('@defrex/autobuild/remote-store')
  const { FakeForge, ForgeFailure } = await import('@defrex/autobuild/plugin-sdk')
  const { guardForge } = await import('@defrex/autobuild/testing')
  const f = await fixture()
  const remote = new RemoteBuildStore({
    url: 'http://store',
    token: f.token,
    fetchFn: ((input, init) => f.server.fetch(new Request(input, init))) as typeof fetch,
  })
  const raw = new FakeForge()
  let calls = 0
  raw.getPrState = async () => {
    calls++
    throw new ForgeFailure('observed distant deadline', {
      kind: 'rate-limited',
      resetAt: new Date(+f.clock() + 86400001).toISOString(),
    })
  }
  const forge = guardForge(raw, {
    store: remote,
    repo: A,
    name: 'github',
    now: f.clock,
    wait: true,
  })
  await expect(forge.getPrState(A, 1)).rejects.toMatchObject({
    name: 'EventValidationError',
    message: expect.stringContaining('24 hours'),
  })
  expect(calls).toBe(1)
  expect(await f.store.getRepoEvents(A)).toEqual([])
})
