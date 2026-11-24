import { temporaryDirectories as ownTempDirectories } from '@defrex/autobuild/testing'
import { FakeTicketSource } from '@defrex/autobuild/plugin-sdk'
import { createTicketServer } from './ticket-server'
import { afterEach, expect, test } from 'bun:test'
import { MemoryBuildStore, sampleBuildInput, sampleEventWrite } from '@defrex/autobuild/plugin-sdk'
import { createMachineAuth } from './machine-auth'
import { createDelegationHandler } from './delegated-authority'
import { createStoreServer } from './remote-store-server'
import { testCredentials } from './testing/credentials'
import { testProjects } from './testing/projects'
import {
  AUTOBUILD_VERSION,
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
} from '@defrex/autobuild/remote-store'

// The in-memory delegated-authority matrix lives in delegated-authority.test.ts;
// this file keeps the cases that need a real socket, workspace or poll waits.

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

test.each(['build-runner', 'build-phase'] as const)(
  // Runners pinned to releases before process-scoped guards still record the
  // repository cooldown; the server keeps admitting it.
  'a repository-scoped %s forge guard records cooldown through delegated HTTP authority and waits for dispatcher recovery',
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

test.each(['build-runner', 'build-phase'] as const)(
  '%s guard reports a credential limit through delegated HTTP authority without pausing the repository',
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
          session: 'limit-phase',
          role: 'implement',
          runner: 'fake',
          phase: 'implement',
          round: 1,
        },
      })
      const response = await f.issue(f.token, { kind, id: 'one', session: 'limit-phase' })
      expect(response.status).toBe(200)
      token = (await response.json()).token
    }
    const limited = (resetAt: string) => ({
      actor: { kind: 'kernel' },
      type: 'forge.credential-limited',
      payload: {
        forge: 'github',
        process: 'build-runner one',
        credential: 'unauthenticated',
        missingCredential: 'GITHUB_TOKEN and GH_TOKEN are unset',
        message: 'API rate limit exceeded',
        resetAt,
      },
    })
    const beyond = new Date(+f.clock() + 24 * 60 * 60 * 1000 + 1).toISOString()
    expect(
      (
        await f.server.fetch(
          request(`/repos/${encodeURIComponent(A)}/events`, token, limited(beyond)),
        )
      ).status,
    ).toBe(400)
    expect(
      (
        await f.server.fetch(
          request(`/repos/${encodeURIComponent(A)}/events`, token, {
            ...limited(new Date(+f.clock() + 1000).toISOString()),
            actor: { kind: 'dispatcher' },
          }),
        )
      ).status,
    ).toBe(403)
    const remote = new RemoteBuildStore({
      url: 'http://store',
      token,
      fetchFn: ((input, init) => f.server.fetch(new Request(input, init))) as typeof fetch,
    })
    const raw = new FakeForge()
    raw.getPrState = async () => {
      throw new ForgeFailure('API rate limit exceeded', {
        kind: 'rate-limited',
        resetAt: new Date(f.clock().getTime() + 1000).toISOString(),
        unauthenticated: 'GITHUB_TOKEN and GH_TOKEN are unset',
      })
    }
    const guarded = guardForge(raw, {
      store: remote,
      repo: A,
      name: 'github',
      now: f.clock,
      scope: { process: `${kind} one` },
    })
    await expect(guarded.getPrState(A, 1)).rejects.toThrow('API rate limit exceeded')
    const events = await f.store.getRepoEvents(A)
    expect(events.map((e) => e.type)).toEqual(['forge.credential-limited'])
    expect(events[0]!.payload).toMatchObject({
      process: `${kind} one`,
      credential: 'unauthenticated',
    })
    // Recovery is still the dispatcher's alone.
    expect(
      (
        await f.server.fetch(
          request(`/repos/${encodeURIComponent(A)}/events`, token, {
            actor: { kind: 'kernel' },
            type: 'dispatcher.forge-recovered',
            payload: { forge: 'github' },
          }),
        )
      ).status,
    ).toBe(403)
  },
)
