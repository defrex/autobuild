import { MemoryTicketPolicyStore } from '@defrex/autobuild-postgres-store/ticket-policy'
import { FakeTicketSource } from '@defrex/autobuild/plugin-sdk'
import { withPaging } from './testing/paged-fake'
import { createTicketServer } from './ticket-server'
import { expect, test } from 'bun:test'
import { MemoryBuildStore, sampleBuildInput, sampleEventWrite } from '@defrex/autobuild/plugin-sdk'
import {
  mintToken,
  RemoteBuildStore,
  verifyToken,
  type DelegatedTokenScope,
} from '@defrex/autobuild/remote-store'
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
    'list-targeting': { nodeId: 'unknown' },
    // An operator listing: no grant or delegation may page.
    'list-page': { criteria: {}, page: { limit: 1 } },
    // Search is operator authority too.
    search: { text: 'x', limit: 1 },
    get: { id: 'unknown' },
    'dependency-states': { ids: ['unknown'] },
    states: {},
    'state-counts': { names: ['Triage'] },
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
          const backend = new FakeTicketSource([])
          return Object.assign(backend, {
            listTargeting: async (nodeId: string) => {
              const all = await backend.listAll()
              return { ...all, tickets: all.tickets.filter((t) => t.target === nodeId) }
            },
          })
        },
      })
      const allowed =
        target.kind.startsWith('harvest') &&
        (['list-ready', 'list-targeting', 'get', 'dependency-states', 'states'].includes(
          operation,
        ) ||
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
    const backend = withPaging(new FakeTicketSource([]))
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
      ['list-page', { criteria: {}, page: { limit: 1 } }],
      ['search', { text: 'Ticket', limit: 1 }],
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
      expect(
        (
          await f.server.fetch(
            request(`/repos/${encodeURIComponent(A)}/events/conditional`, token, {
              expectedSeq: before.length,
              event,
            }),
          )
        ).status,
      ).toBe(token === f.token ? 403 : 400)
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
  const conditional = (expectedSeq: number) =>
    f.server.fetch(
      request(`/repos/${encodeURIComponent(A)}/events/conditional`, f.project.token, {
        expectedSeq,
        event: {
          actor: { kind: 'kernel' },
          type: 'dispatcher.forge-degraded',
          payload: {
            forge: 'github',
            message: 'limit',
            firstFailureAt: f.clock().toISOString(),
            resetAt: new Date(+f.clock() + 1000).toISOString(),
          },
        },
      }),
    )
  const seq = (await f.store.getRepoEvents(A)).length
  expect((await conditional(seq)).status).toBe(201)
  const stale = await conditional(seq)
  expect([stale.status, await stale.json()]).toEqual([200, null])
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

test('a build-phase grant declares a ticket wait with no ticket credential', async () => {
  const f = await fixture('dispatcher')
  await f.store.append('one', {
    actor: { kind: 'kernel' },
    type: 'session.started',
    payload: {
      session: 'waiting-phase',
      role: 'implement',
      runner: 'fake',
      phase: 'implement',
      round: 1,
    },
  })
  const issued = await f.issue(f.token, {
    kind: 'build-phase',
    id: 'one',
    session: 'waiting-phase',
  })
  expect(issued.status).toBe(200)
  const phase = (await issued.json()).token as string
  const client = new RemoteBuildStore({
    url: 'http://store',
    token: phase,
    fetchFn: (async (url: string | URL | Request, init?: RequestInit) =>
      f.server.fetch(new Request(url, init))) as typeof fetch,
  })
  // `ab wait-on` deposits its terminal through this compare-and-append; the
  // session needs only its build-phase grant, and the dispatcher validates.
  const cursor = (await f.store.getEvents('one')).at(-1)!.seq
  const deposited = await client.appendWithArtifactsIfCurrent('one', cursor, [], () => ({
    actor: { kind: 'agent', role: 'implement', session: 'waiting-phase' },
    type: 'wait.requested',
    payload: { id: 'wait_1', phase: 'implement', round: 1, tickets: ['B'], reason: 'needs B' },
  }))
  expect(deposited?.event.type).toBe('wait.requested')
  expect((await f.store.getEvents('one')).at(-1)).toMatchObject({
    type: 'wait.requested',
    actor: { kind: 'agent', session: 'waiting-phase' },
  })
  // The grant cannot attribute the declaration to another session.
  const other = await client
    .appendWithArtifactsIfCurrent('one', cursor + 1, [], () => ({
      actor: { kind: 'agent', role: 'implement', session: 'another-phase' },
      type: 'wait.requested',
      payload: { id: 'wait_2', phase: 'implement', round: 1, tickets: ['B'], reason: 'needs B' },
    }))
    .catch((error: Error) => error)
  expect(other).toBeInstanceOf(Error)
})

test('a build runner issues a write-only judge grant bound to one judge session', async () => {
  const f = await fixture()
  const kernel = { kind: 'kernel' } as const
  await f.store.append('one', {
    actor: kernel,
    type: 'panel.started',
    payload: {
      panel: 'panel-1',
      candidate: 'c'.repeat(40),
      baseline: 'b'.repeat(40),
      harnessPin: 'a'.repeat(40),
      purpose: 'clearer prose',
      rubric: 'evals/rubric.md',
      harness: ['evals/**'],
      judges: 2,
    },
  })
  const target = { kind: 'build-judge', id: 'one', session: 's_j1', panel: 'panel-1', judge: 1 }
  // An unstarted judge has no lifecycle binding.
  expect((await f.issue(f.token, target)).status).toBe(404)
  await f.store.append('one', {
    actor: kernel,
    type: 'panel.judge-started',
    payload: {
      panel: 'panel-1',
      judge: 1,
      session: 's_j1',
      order: 'baseline-first',
      runner: 'fake',
    },
  })
  const issued = await f.issue(f.token, target)
  expect(issued.status).toBe(200)
  const judge = (await issued.json()).token as string
  expect(verifyToken(secret, judge, f.clock())).toMatchObject({
    delegation: { kind: 'build-judge', id: 'one', session: 's_j1', panel: 'panel-1', judge: 1 },
  })

  // A phase grant, a judge grant and another build cannot issue it.
  await f.store.append('one', {
    actor: kernel,
    type: 'session.started',
    payload: {
      session: 's_phase',
      role: 'implement',
      runner: 'fake',
      phase: 'implement',
      round: 1,
    },
  })
  const phase = (
    await (await f.issue(f.token, { kind: 'build-phase', id: 'one', session: 's_phase' })).json()
  ).token as string
  expect((await f.issue(phase, target)).status).toBe(403)
  expect((await f.issue(judge, target)).status).toBe(403)
  expect((await f.issue(f.token, { ...target, id: 'two' })).status).toBe(403)

  // Every read is refused.
  for (const path of [
    '/builds/one',
    '/builds/one/events',
    '/builds/one/artifacts?kind=transcript',
    '/builds/two',
    '/builds',
    `/repos/${encodeURIComponent(A)}/events`,
    `/repos/${encodeURIComponent(A)}`,
  ]) {
    const response = await f.server.fetch(request(path, judge))
    expect(response.status).toBe(403)
  }
  expect(
    (
      await f.server.fetch(
        request('/builds/one/reducer-values', judge, { reducer: 'buildDelegation' }),
      )
    ).status,
  ).toBe(403)
  expect(
    (
      await f.server.fetch(
        request(`/repos/${encodeURIComponent(A)}/reducer-values`, judge, { reducer: 'x' }),
      )
    ).status,
  ).toBe(403)

  expect(
    (
      await f.server.fetch(
        request(`/repos/${encodeURIComponent(A)}/rollup-values`, judge, {
          reducer: 'stepDurations',
        }),
      )
    ).status,
  ).toBe(403)

  // Every other route family is refused too, read or write: snapshots, session
  // and stream routes, and further credential issuance for any target.
  for (const [path, body, method] of [
    ['/builds/one/snapshots/buildReadFacts'],
    [`/repos/${encodeURIComponent(A)}/snapshots/repositoryFacts`],
    ['/builds/one/snapshots/buildReadFacts', { cursor: 1, value: {} }, 'PUT'],
    ['/sessions/s_j1'],
    ['/sessions/s_j1/events'],
    ['/sessions/s_j1/events', sampleEventWrite()],
    ['/streams/builds'],
    ['/builds/one/streams/events'],
    ['/builds/one/stream-seed?cursor=1'],
    ['/builds/one/ticket-assets?kind=design&name=x'],
    [`/repos/${encodeURIComponent(A)}/events`, sampleEventWrite()],
  ] as const) {
    const response = await f.server.fetch(request(path, judge, body, method))
    expect(response.status).toBe(403)
  }
  for (const other of [
    { kind: 'build-phase', id: 'one', session: 's_j1' },
    { kind: 'build-runner', id: 'one' },
    { ...target, judge: 2, session: 's_j2' },
  ])
    expect((await f.issue(judge, other)).status).toBe(403)
  // Ticket and operator surfaces refuse the judge grant before any backend.
  const { createOperatorServer } = await import('./operator-server')
  const operator = createOperatorServer({
    store: f.store,
    projects: f.projects,
    auth: f.auth,
    secret,
    clock: f.clock,
  })
  const beforeOperator = await f.store.getRepoEvents(A)
  expect(
    (
      await operator.fetch(
        request(`/operator/v1/repos/${encodeURIComponent(A)}/tools/repository.forge_clear`, judge, {
          repo: A,
          forge: 'github',
          reason: 'judge',
          actor: { kind: 'human', user: 'owner' },
        }),
      )
    ).status,
  ).toBe(403)
  expect(await f.store.getRepoEvents(A)).toEqual(beforeOperator)
  let ticketsOpened = false
  const tickets = createTicketServer({
    secret,
    auth: f.auth,
    sourceFor: () => {
      ticketsOpened = true
      return new FakeTicketSource([])
    },
  })
  for (const operation of ['list-ready', 'get', 'create'])
    expect(
      (
        await tickets.fetch(
          request(`/tickets/${operation}`, judge, { context: { teamKey: 'TEAM' }, input: {} }),
        )
      ).status,
    ).toBe(403)
  expect(ticketsOpened).toBe(false)

  const preferred = (payload: Record<string, unknown> = {}, session = 's_j1') => ({
    actor: { kind: 'agent', role: 'judge', session },
    type: 'panel.preferred',
    payload: {
      panel: 'panel-1',
      judge: 1,
      session: 's_j1',
      preference: 'A',
      reason: 'A reads better',
      ...payload,
    },
  })
  // A wrong panel, judge or session, another type, or another route is refused.
  for (const body of [
    preferred({ panel: 'panel-0' }),
    preferred({ judge: 2 }),
    preferred({ session: 's_other' }),
    preferred({}, 's_other'),
    { ...preferred(), type: 'panel.judged' },
    sampleEventWrite(),
  ])
    expect((await f.server.fetch(request('/builds/one/events', judge, body))).status).toBe(403)
  for (const [path, body] of [
    ['/builds/one/events/conditional', { expectedSeq: 1, event: preferred() }],
    ['/builds/one/deposits', { event: preferred(), artifacts: [] }],
    ['/builds/one/artifacts', { kind: 'x', contentBase64: '' }],
    ['/builds/two/events', preferred()],
  ] as const)
    expect((await f.server.fetch(request(path, judge, body))).status).toBe(403)

  // Its one preference is accepted; a duplicate is refused.
  expect((await f.server.fetch(request('/builds/one/events', judge, preferred()))).status).toBe(201)
  const duplicate = await f.server.fetch(
    request('/builds/one/events', judge, preferred({ preference: 'B' })),
  )
  expect(duplicate.status).toBe(403)
  expect(JSON.stringify(await duplicate.json())).toContain('already recorded')

  // The grant retires 60 seconds after its judge session ends.
  await f.store.append('one', {
    actor: kernel,
    type: 'panel.judge-ended',
    payload: { panel: 'panel-1', judge: 1, session: 's_j1', outcome: 'completed' },
  })
  f.advance(59_999)
  expect((await f.server.fetch(request('/builds/one/events', judge, preferred()))).status).toBe(403)
  f.advance(1)
  expect((await f.server.fetch(request('/builds/one/events', judge, preferred()))).status).toBe(401)
})

test('a judge grant retires once its build terminates', async () => {
  const f = await fixture()
  const kernel = { kind: 'kernel' } as const
  await f.store.append('one', {
    actor: kernel,
    type: 'panel.judge-started',
    payload: { panel: 'p', judge: 1, session: 's_j9', order: 'candidate-first', runner: 'fake' },
  })
  const judge = (
    await (
      await f.issue(f.token, {
        kind: 'build-judge',
        id: 'one',
        session: 's_j9',
        panel: 'p',
        judge: 1,
      })
    ).json()
  ).token as string
  await f.store.append('one', { actor: kernel, type: 'build.aborted', payload: {} })
  f.advance(60_000)
  expect((await f.server.fetch(request('/builds/one', judge))).status).toBe(401)
})

test('racing judge preferences record one durable event; distinct sessions each record', async () => {
  const f = await fixture()
  const kernel = { kind: 'kernel' } as const
  await f.store.append('one', {
    actor: kernel,
    type: 'panel.started',
    payload: {
      panel: 'panel-1',
      candidate: 'c'.repeat(40),
      baseline: 'b'.repeat(40),
      harnessPin: 'a'.repeat(40),
      purpose: 'clearer prose',
      rubric: 'evals/rubric.md',
      harness: ['evals/**'],
      judges: 3,
    },
  })
  const tokens: Record<number, string> = {}
  for (const judge of [1, 2, 3]) {
    const session = `s_j${judge}`
    await f.store.append('one', {
      actor: kernel,
      type: 'panel.judge-started',
      payload: { panel: 'panel-1', judge, session, order: 'candidate-first', runner: 'fake' },
    })
    const issued = await f.issue(f.token, {
      kind: 'build-judge',
      id: 'one',
      session,
      panel: 'panel-1',
      judge,
    })
    tokens[judge] = (await issued.json()).token as string
  }
  const preferred = (judge: number, preference: string) => ({
    actor: { kind: 'agent', role: 'judge', session: `s_j${judge}` },
    type: 'panel.preferred',
    payload: { panel: 'panel-1', judge, session: `s_j${judge}`, preference, reason: 'reasons' },
  })
  /** Hold the delegation reads made for the judges' conditional appends until
   * both racers have read, so each decides on the same facts. */
  const barrier = () => {
    const read = f.store.getReducerValue.bind(f.store)
    let waiting = 0
    let release!: () => void
    const both = new Promise<void>((resolve) => {
      release = resolve
    })
    f.store.getReducerValue = async (scope, request) => {
      const judging = new Error().stack?.includes('appendJudgePreference') ?? false
      const value = await read(scope, request)
      if (judging && waiting < 2) {
        waiting += 1
        if (waiting === 2) release()
        await both
      }
      return value
    }
    return () => {
      f.store.getReducerValue = read
      // Both racers read before either appended.
      expect(waiting).toBe(2)
    }
  }
  const post = (judge: number, preference: string) =>
    f.server.fetch(request('/builds/one/events', tokens[judge]!, preferred(judge, preference)))
  const durable = async () =>
    (await f.store.getEvents('one')).filter((event) => event.type === 'panel.preferred')

  // Distinct authorized sessions racing are each recorded.
  let restore = barrier()
  const distinct = await Promise.all([post(1, 'A'), post(2, 'tie')])
  restore()
  expect(distinct.map((response) => response.status)).toEqual([201, 201])

  // One session racing two different preferences records exactly one.
  restore = barrier()
  const same = await Promise.all([post(3, 'A'), post(3, 'B')])
  restore()
  expect(same.map((response) => response.status).sort()).toEqual([201, 403])
  const lost = same.find((response) => response.status === 403)!
  expect(JSON.stringify(await lost.json())).toContain('already recorded')
  expect((await durable()).map((event) => event.payload.session).sort()).toEqual([
    's_j1',
    's_j2',
    's_j3',
  ])
})
