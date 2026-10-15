import { FakeTicketSource } from '@defrex/autobuild/plugin-sdk'
import { createTicketServer } from './ticket-server'
import { expect, test } from 'bun:test'
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
async function fixture() {
  let time = Date.parse('2026-01-01T00:00:00Z')
  const clock = () => new Date(time)
  const projects = testProjects([A, B])
  const { store: credentials } = testCredentials(projects, secret, clock)
  const project = await credentials.issue(A, 'owner', { expiresAt: new Date(time + 7 * 86400000) })
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

test('active grants survive parent expiry and service reconstruction, then retire at exactly 60 seconds', async () => {
  const f = await fixture()
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
  await f.store.append('one', { actor: { kind: 'kernel' }, type: 'build.aborted', payload: {} })
  f.advance(59999)
  expect((await f.server.fetch(request('/builds/one', f.token))).status).toBe(200)
  f.advance(1)
  expect((await f.server.fetch(request('/builds/one', f.token))).status).toBe(401)
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

test('runner attenuation requires its own recorded session; phase grants cannot delegate or attribute another session', async () => {
  const f = await fixture()
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
  const f = await fixture()
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
  const fresh = await f.issue(f.project.token, { ...target, execution: 'execution-two' })
  expect(fresh.status).toBe(200)
  const replacement = (await fresh.json()).token
  expect(replacement).not.toBe(token)
  f.advance(60000)
  expect((await f.server.fetch(request(`${base}/events`, token))).status).toBe(401)
  expect((await f.server.fetch(request(`${base}/events`, replacement))).status).toBe(200)
})

test('delegated hosted ticket admission equals the parent project credential until project-owned tickets land', async () => {
  const f = await fixture()
  const source = new FakeTicketSource([])
  const server = createTicketServer({ secret, auth: f.auth, sourceFor: () => source })
  const body = { context: { teamKey: 'TEAM' }, input: { id: 'unknown' } }
  const parent = await server.fetch(request('/tickets/get', f.project.token, body))
  const delegated = await server.fetch(request('/tickets/get', f.token, body))
  expect(parent.status).toBe(200)
  expect(delegated.status).toBe(parent.status)
  expect(await delegated.json()).toEqual(await parent.json())
})
