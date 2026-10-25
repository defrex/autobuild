import { OperatorApiClient } from './operator-api'
import { HostedTicketSource } from '@defrex/autobuild/hosted-tickets'
import { ticketProject } from './testing/ticket-project'
import { MemoryTicketPolicyStore } from '@defrex/autobuild-postgres-store/ticket-policy'
import { testProjects } from './testing/projects'
import { describe, expect, test } from 'bun:test'
import { FakeTicketSource, MemoryBuildStore } from '@defrex/autobuild/plugin-sdk'
import { parseConfig } from '@defrex/autobuild/testing'
import {
  AUTOBUILD_VERSION,
  supportedClientRange,
  AUTOBUILD_VERSION_HEADER,
  RemoteBuildStore,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
  mintToken,
} from '@defrex/autobuild/remote-store'
import { HOSTED_ARTIFACT_MAX_BYTES } from './config'
import { createHostedStoreService, hostedPublicOrigin } from './service'

const env = {
  AB_STORE_SECRET: 'test-signing-secret',
  AB_POSTGRES_URL: 'postgres://unused/test',
  AB_BLOB_BACKEND: 's3',
  AB_S3_BUCKET: 'unused',
  AB_S3_REGION: 'us-east-1',
  AB_S3_ACCESS_KEY_ID: 'unused',
  AB_S3_SECRET_ACCESS_KEY: 'unused',
}
const now = new Date('2026-09-02T00:00:00.000Z')
const clock = () => now
const repo = 'acme/widgets'

const token = mintToken(env.AB_STORE_SECRET, {
  version: 1,
  ownerAdmin: { user: 'owner:fixture' },
  exp: now.getTime() + 60_000,
})
const machineHeaders = {
  authorization: `Bearer ${token}`,
  [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
  [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
}

function clientFor(service: ReturnType<typeof createHostedStoreService>, identity = {}) {
  const token = mintToken(env.AB_STORE_SECRET, {
    version: 1,
    ownerAdmin: { user: 'owner:fixture' },
    exp: now.getTime() + 60_000,
  })
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) =>
    service.fetch(
      input instanceof Request ? new Request(input, init) : new Request(input.toString(), init),
    )) as typeof fetch
  return new RemoteBuildStore({ url: 'http://hosted.test', token, fetchFn, identity })
}

describe('hosted store service', () => {
  test('health is public and does not open persistence; machine routes open it once', async () => {
    let opens = 0
    const backing = new MemoryBuildStore({ clock })
    const service = createHostedStoreService({
      openTicketPolicy: async () => new MemoryTicketPolicyStore(),
      issueDispatcherCredential: async () => 'abp_1_fixture',
      openProjectRegistry: async () => testProjects([repo, 'acme/repo']),
      env,
      clock,
      openStore: async () => {
        opens++
        return backing
      },
    })
    const health = await service.fetch(new Request('http://hosted.test/health'))
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({
      ok: true,
      autobuildVersion: AUTOBUILD_VERSION,
      protocolVersion: REMOTE_STORE_PROTOCOL_VERSION,
      supportedClientRange: supportedClientRange(),
    })
    expect(opens).toBe(0)

    const client = clientFor(service)
    await client.createBuild({ slug: 'demo', repo: 'acme/repo' })
    await client.listBuilds()
    expect(opens).toBe(1)
  })

  test('composes the operator API through the same lazy store', async () => {
    let opens = 0
    const backing = new MemoryBuildStore({ clock })
    const service = createHostedStoreService({
      openTicketPolicy: async () => new MemoryTicketPolicyStore(),
      issueDispatcherCredential: async () => 'abp_1_fixture',
      openProjectRegistry: async () => testProjects([repo, 'acme/repo']),
      env,
      clock,
      openStore: async () => {
        opens += 1
        return backing
      },
    })
    const token = mintToken(env.AB_STORE_SECRET, {
      version: 1,
      internalOperator: { user: 'Hosted Operator', repo: 'acme/repo' },
      exp: now.getTime() + 60_000,
    })
    const client = new OperatorApiClient({
      url: 'http://hosted.test',
      token,
      fetchFn: ((input: string | URL | Request, init?: RequestInit) =>
        service.fetch(
          input instanceof Request ? new Request(input, init) : new Request(String(input), init),
        )) as typeof fetch,
    })
    expect(await client.repositoryStatus('acme/repo')).toEqual({
      repo: 'acme/repo',
      dispatcher: {
        state: 'absent',
        holder: null,
        expiredHolder: null,
        latestRun: null,
        latestStoppedRun: null,
      },
      intake: true,
      paused: false,
      defaultAutoMerge: false,
      operator: { registrations: [] },
      sandboxes: [],
      upgrades: { runs: {}, holds: {}, lineages: {}, rollbackIds: [] },
      publications: [],
    })
    expect(opens).toBe(1)
    await client.setIntake('acme/repo', false)
    expect((await backing.getRepoEvents('acme/repo')).at(-1)).toMatchObject({
      actor: { kind: 'human', user: 'Hosted Operator' },
      type: 'dispatcher.intake-set',
      payload: { enabled: false },
    })
  })

  test('routes the generic tools POST to the operator server', async () => {
    const backing = new MemoryBuildStore({ clock })
    const service = createHostedStoreService({
      openTicketPolicy: async () => new MemoryTicketPolicyStore(),
      issueDispatcherCredential: async () => 'abp_1_fixture',
      openProjectRegistry: async () => testProjects([repo, 'acme/repo']),
      env,
      clock,
      openStore: async () => backing,
    })
    const token = mintToken(env.AB_STORE_SECRET, {
      version: 1,
      internalOperator: { user: 'Hosted Operator', repo: 'acme/repo' },
      via: { kind: 'mcp', client: 'claude' },
      exp: now.getTime() + 60_000,
    })
    const client = new OperatorApiClient({
      url: 'http://hosted.test',
      token,
      fetchFn: ((input: string | URL | Request, init?: RequestInit) =>
        service.fetch(
          input instanceof Request ? new Request(input, init) : new Request(String(input), init),
        )) as typeof fetch,
    })
    // An unclassified route would 404 here — the branch is load-bearing.
    expect(
      await client.callTool('acme/repo', 'repository.status', { repo: 'acme/repo' }),
    ).toMatchObject({ repo: 'acme/repo', intake: true })
    await client.callTool('acme/repo', 'repository.settings', {
      repo: 'acme/repo',
      setting: 'intake',
      enabled: false,
    })
    expect((await backing.getRepoEvents('acme/repo')).at(-1)?.actor).toEqual({
      kind: 'human',
      user: 'Hosted Operator',
      via: { kind: 'mcp', client: 'claude' },
    })
  })

  test('redacts operator backing failures and reports them with operator context', async () => {
    const failure = new Error('postgres://operator:secret@db.internal/control')
    const backing = new MemoryBuildStore({ clock })
    backing.getRepo = async () => {
      throw failure
    }
    const reports: unknown[][] = []
    const service = createHostedStoreService({
      openTicketPolicy: async () => new MemoryTicketPolicyStore(),
      issueDispatcherCredential: async () => 'abp_1_fixture',
      openProjectRegistry: async () => testProjects([repo, 'acme/repo']),
      env,
      clock,
      openStore: async () => backing,
      reportInternalError: (reported, context) => reports.push([reported, context]),
    })
    const operator = new OperatorApiClient({
      url: 'http://hosted.test',
      token: mintToken(env.AB_STORE_SECRET, {
        version: 1,
        internalOperator: { user: 'Hosted Operator', repo: 'acme/repo' },
        exp: now.getTime() + 60_000,
      }),
      fetchFn: ((input: string | URL | Request, init?: RequestInit) =>
        service.fetch(
          input instanceof Request ? new Request(input, init) : new Request(String(input), init),
        )) as typeof fetch,
    })

    const error = await operator.repositoryStatus('acme/repo').catch((caught) => caught)
    expect(error).toMatchObject({
      status: 500,
      kind: 'internal',
      message: 'hosted store is unavailable',
    })
    expect(reports).toEqual([
      [
        failure,
        {
          backend: 'operator',
          method: 'GET',
          pathname: '/operator/v1/repos/acme%2Frepo/status',
        },
      ],
    ])
  })

  test('unknown and unsupported routes return 404 without opening persistence', async () => {
    let opens = 0
    const service = createHostedStoreService({
      openTicketPolicy: async () => new MemoryTicketPolicyStore(),
      issueDispatcherCredential: async () => 'abp_1_fixture',
      openProjectRegistry: async () => testProjects([repo, 'acme/repo']),
      env,
      openStore: async () => {
        opens++
        throw new Error('must not open')
      },
      openTicketDatabase: async () => {
        opens++
        throw new Error('must not open')
      },
    })

    for (const request of [
      new Request('http://hosted.test/favicon.ico'),
      new Request('http://hosted.test/builds-extra'),
      new Request('http://hosted.test/builds', { method: 'DELETE' }),
      new Request('http://hosted.test/builds/demo/events/extra', { method: 'GET' }),
      new Request('http://hosted.test/tickets/not-an-operation', { method: 'POST' }),
      new Request('http://hosted.test/operator/v1/repos/acme%2Frepo/not-an-operation'),
    ]) {
      const response = await service.fetch(request)
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({
        error: `no route: ${request.method} ${new URL(request.url).pathname}`,
        kind: 'not-found',
      })
    }
    expect(opens).toBe(0)
  })

  test('operator presence collection is classified without requiring a journal', async () => {
    const backing = new MemoryBuildStore({ clock })
    const service = createHostedStoreService({
      openTicketPolicy: async () => new MemoryTicketPolicyStore(),
      issueDispatcherCredential: async () => 'abp_1_fixture',
      openProjectRegistry: async () => testProjects([repo]),
      env,
      clock,
      openStore: async () => backing,
    })
    const path = `http://hosted.test/repos/${encodeURIComponent(repo)}/operator-presence`
    const read = await service.fetch(new Request(path, { headers: machineHeaders }))
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual([])
    const response = await service.fetch(
      new Request(path, {
        method: 'POST',
        headers: machineHeaders,
        body: JSON.stringify({ id: 'one', host: 'host', pid: 1, startedAt: clock().toISOString() }),
      }),
    )
    expect(response.status).toBe(200)
    expect(await backing.listOperatorPresence(repo)).toHaveLength(1)
    expect(await backing.getRepo(repo)).toBeNull()
  })

  test('GET /repos/{repo}/state-events classifies as a store route and reaches the repo gate', async () => {
    const backing = new MemoryBuildStore({ clock })
    let opens = 0
    const service = createHostedStoreService({
      openTicketPolicy: async () => new MemoryTicketPolicyStore(),
      issueDispatcherCredential: async () => 'abp_1_fixture',
      openProjectRegistry: async () => testProjects([repo, 'acme/repo']),
      env,
      clock,
      openStore: async () => {
        opens++
        return backing
      },
    })
    // The bounded repository-journal read (AUT-489) is classified in
    // `storeResourceRoutes`, so it reaches the store server's repository
    // gate — an unknown repo answers the store server's own 404 (which
    // opened persistence), never the generic unclassified 404.
    const response = await service.fetch(
      new Request('http://hosted.test/repos/acme%2Fnever-seen/state-events', {
        headers: machineHeaders,
      }),
    )
    expect(opens).toBe(1)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: 'unknown repo "acme/never-seen"',
      kind: 'not-found',
    })
  })

  test('snapshot routes classify as store routes for GET and PUT only', async () => {
    const backing = new MemoryBuildStore({ clock })
    let opens = 0
    const service = createHostedStoreService({
      openTicketPolicy: async () => new MemoryTicketPolicyStore(),
      issueDispatcherCredential: async () => 'abp_1_fixture',
      openProjectRegistry: async () => testProjects([repo, 'acme/repo']),
      env,
      clock,
      openStore: async () => {
        opens++
        return backing
      },
    })
    // Reducer snapshots: served inside the existence gates, so an unknown
    // build or repository answers the store server's own 404 (persistence
    // opened); any other method is the generic unclassified 404.
    for (const path of [
      '/builds/never/snapshots/build?version=1',
      '/repos/acme%2Fnever/snapshots/journalView?version=1',
    ]) {
      const response = await service.fetch(
        new Request(`http://hosted.test${path}`, { headers: machineHeaders }),
      )
      expect(opens).toBe(1)
      expect(response.status).toBe(404)
      expect(((await response.json()) as { error: string }).error).toContain('unknown')
    }
    const deleted = await service.fetch(
      new Request('http://hosted.test/builds/never/snapshots/build', {
        method: 'DELETE',
        headers: machineHeaders,
      }),
    )
    expect(deleted.status).toBe(404)
    expect(((await deleted.json()) as { error: string }).error).toContain('no route')
  })

  test('retries lazy store initialization after a rejected attempt', async () => {
    let opens = 0
    const backing = new MemoryBuildStore({ clock })
    const service = createHostedStoreService({
      openTicketPolicy: async () => new MemoryTicketPolicyStore(),
      issueDispatcherCredential: async () => 'abp_1_fixture',
      openProjectRegistry: async () => testProjects([repo, 'acme/repo']),
      env,
      clock,
      openStore: async () => {
        opens++
        if (opens === 1) throw new Error('temporary provider outage')
        return backing
      },
    })
    const client = clientFor(service)

    const firstError = await client
      .createBuild({ slug: 'demo', repo: 'acme/repo' })
      .catch((value: unknown) => value)
    expect((firstError as Error).message).toBe('hosted store is unavailable')
    expect(opens).toBe(1)

    await client.createBuild({ slug: 'demo', repo: 'acme/repo' })
    expect(await client.listBuilds()).toHaveLength(1)
    expect(opens).toBe(2)
  })

  test('shares an in-flight store initialization and reuses it after success', async () => {
    let opens = 0
    const backing = new MemoryBuildStore({ clock })
    const deferred = Promise.withResolvers<MemoryBuildStore>()
    const service = createHostedStoreService({
      openTicketPolicy: async () => new MemoryTicketPolicyStore(),
      issueDispatcherCredential: async () => 'abp_1_fixture',
      openProjectRegistry: async () => testProjects([repo, 'acme/repo']),
      env,
      clock,
      openStore: async () => {
        opens++
        return deferred.promise
      },
    })
    const client = clientFor(service)

    const first = client.listBuilds()
    const second = client.listBuilds()
    expect(opens).toBe(1)

    deferred.resolve(backing)
    expect(await Promise.all([first, second])).toEqual([[], []])
    expect(await client.listBuilds()).toEqual([])
    expect(opens).toBe(1)
  })

  test('round-trips 1 MiB and rejects ceiling-plus-one without mutation', async () => {
    const backing = new MemoryBuildStore({ clock })
    const service = createHostedStoreService({
      openTicketPolicy: async () => new MemoryTicketPolicyStore(),
      issueDispatcherCredential: async () => 'abp_1_fixture',
      openProjectRegistry: async () => testProjects([repo, 'acme/repo']),
      env,
      clock,
      openStore: async () => backing,
    })
    const client = clientFor(service)
    await client.createBuild({ slug: 'demo', repo: 'acme/repo' })

    const content = new Uint8Array(HOSTED_ARTIFACT_MAX_BYTES).fill(0xa5)
    const meta = await client.putArtifact('demo', { kind: 'boundary', content })
    expect((await client.getArtifact('demo', 'boundary', meta.revision))?.content).toEqual(content)

    const error = await client
      .putArtifact('demo', {
        kind: 'too-large',
        content: new Uint8Array(HOSTED_ARTIFACT_MAX_BYTES + 1),
      })
      .catch((value: unknown) => value)
    expect((error as Error).message).toContain(`${HOSTED_ARTIFACT_MAX_BYTES} bytes`)
    expect(await client.listArtifacts('demo', 'too-large')).toEqual([])
  })

  test('reports package skew before authentication and redacts opener failures', async () => {
    const service = createHostedStoreService({
      openTicketPolicy: async () => new MemoryTicketPolicyStore(),
      issueDispatcherCredential: async () => 'abp_1_fixture',
      openProjectRegistry: async () => testProjects([repo, 'acme/repo']),
      env,
      clock,
      openStore: async () => new MemoryBuildStore({ clock }),
    })
    const error = await clientFor(service, { autobuildVersion: '99.0.0' })
      .listBuilds()
      .catch((value: unknown) => value)
    expect((error as Error).message).toContain('client Autobuild 99.0.0')
    expect((error as Error).message).toContain(`server Autobuild ${AUTOBUILD_VERSION}`)

    const failure = new Error('postgres://user:password@secret-host/db')
    const reports: unknown[][] = []
    const failed = createHostedStoreService({
      openTicketPolicy: async () => new MemoryTicketPolicyStore(),
      issueDispatcherCredential: async () => 'abp_1_fixture',
      openProjectRegistry: async () => testProjects([repo, 'acme/repo']),
      env,
      openStore: async () => {
        throw failure
      },
      reportInternalError: (reported, context) => reports.push([reported, context]),
    })
    const response = await failed.fetch(
      new Request('http://hosted.test/builds', { headers: machineHeaders }),
    )
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: 'hosted store is unavailable',
      kind: 'internal',
    })
    expect(reports).toEqual([[failure, { backend: 'store', method: 'GET', pathname: '/builds' }]])
  })

  test('redacts backing-provider failures while retaining original diagnostics', async () => {
    const failure = new Error(
      'query SELECT secret FROM builds failed at postgres://admin:credential@db.internal/prod',
      { cause: new Error('S3 bucket infrastructure timeout') },
    )
    const backing = new MemoryBuildStore({ clock })
    backing.listBuilds = async () => {
      throw failure
    }
    const reports: unknown[][] = []
    const service = createHostedStoreService({
      openTicketPolicy: async () => new MemoryTicketPolicyStore(),
      issueDispatcherCredential: async () => 'abp_1_fixture',
      openProjectRegistry: async () => testProjects([repo, 'acme/repo']),
      env,
      clock,
      openStore: async () => backing,
      reportInternalError: (reported, context) => reports.push([reported, context]),
    })

    const response = await service.fetch(
      new Request('http://hosted.test/builds', { headers: machineHeaders }),
    )
    const text = await response.text()

    expect(response.status).toBe(500)
    expect(JSON.parse(text)).toEqual({
      error: 'hosted store is unavailable',
      kind: 'internal',
    })
    for (const sensitive of ['SELECT', 'credential', 'db.internal', 'S3 bucket']) {
      expect(text).not.toContain(sensitive)
    }
    expect(reports).toEqual([[failure, { backend: 'store', method: 'GET', pathname: '/builds' }]])
    expect((reports[0]![0] as Error).cause).toBe(failure.cause)
  })

  test('passes expected protocol errors through unchanged', async () => {
    const service = createHostedStoreService({
      openTicketPolicy: async () => new MemoryTicketPolicyStore(),
      issueDispatcherCredential: async () => 'abp_1_fixture',
      openProjectRegistry: async () => testProjects([repo, 'acme/repo']),
      env,
      clock,
      openStore: async () => new MemoryBuildStore({ clock }),
    })
    const response = await service.fetch(
      new Request('http://hosted.test/builds', {
        method: 'POST',
        headers: { ...machineHeaders, 'content-type': 'application/json' },
        body: '{}',
      }),
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ kind: 'validation' })
  })
})

describe('hostedPublicOrigin (AUT-584)', () => {
  test('derives the deployment origin from BETTER_AUTH_URL; absence or invalidity is unavailable', () => {
    expect(hostedPublicOrigin({ BETTER_AUTH_URL: 'https://hosted.example.com' })).toBe(
      'https://hosted.example.com',
    )
    expect(hostedPublicOrigin({ BETTER_AUTH_URL: 'http://localhost:3000/app' })).toBe(
      'http://localhost:3000',
    )
    expect(hostedPublicOrigin({})).toBeUndefined()
    expect(hostedPublicOrigin({ BETTER_AUTH_URL: '   ' })).toBeUndefined()
    expect(hostedPublicOrigin({ BETTER_AUTH_URL: 'not a url' })).toBeUndefined()
    expect(hostedPublicOrigin({ BETTER_AUTH_URL: 'ftp://hosted.example.com' })).toBeUndefined()
  })
})

describe('hosted operator-sandbox backend (AUT-584)', () => {
  const SANDBOX_CONFIG = parseConfig(`
[workspace]
provider = "vercel-sandbox"
[workspace.config]
timeoutSeconds = 3600
[tickets]
source = "file"
readyState = "ready"
[verify]
steps = []
[finalize]
steps = []
[orchestrator]
enabled = true
`)

  async function publishSandboxConfig(store: MemoryBuildStore): Promise<void> {
    await store.ensureRepo('acme/repo')
    const { verify, finalize, ...root } = SANDBOX_CONFIG
    await store.putRepoArtifact('acme/repo', {
      kind: 'dispatcher-effective-config',
      content: JSON.stringify({
        ...root,
        orchestrator: {
          ...root.orchestrator,
          model: 'test/historical',
          invocationBudgetSeconds: 240,
          approvals: [],
          wake: ['*'],
        },
        verify: { steps: verify.steps, ...verify.stepConfigs },
        finalize: { steps: finalize.steps, ...finalize.stepConfigs },
      }),
    })
  }

  function sandboxService(
    backing: MemoryBuildStore,
    extraEnv: Record<string, string | undefined> = {},
  ) {
    const reports: unknown[][] = []
    const service = createHostedStoreService({
      openTicketPolicy: async () => new MemoryTicketPolicyStore(),
      issueDispatcherCredential: async () => 'abp_1_fixture',
      openProjectRegistry: async () => testProjects([repo, 'acme/repo']),
      env: { ...env, ...extraEnv },
      clock,
      openStore: async () => backing,
      reportInternalError: (reported, context) => reports.push([reported, context]),
    })
    return { service, reports }
  }

  async function postMessage(
    service: ReturnType<typeof createHostedStoreService>,
    sid: string,
    extraHeaders: Record<string, string> = {},
    action = 'messages',
  ): Promise<Response> {
    const token = mintToken(env.AB_STORE_SECRET, {
      version: 1,
      internalOperator: { user: 'Hosted Operator', repo: 'acme/repo' },
      exp: now.getTime() + 60_000,
    })
    return service.fetch(
      new Request(`http://hosted.test/operator/v1/repos/acme%2Frepo/sessions/${sid}/${action}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
          [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
          'content-type': 'application/json',
          ...extraHeaders,
        },
        body: JSON.stringify({ text: 'hello' }),
      }),
    )
  }

  test('a message on an enabled sandbox repository remains inert with request credentials', async () => {
    const backing = new MemoryBuildStore({ clock })
    await publishSandboxConfig(backing)
    const { service, reports } = sandboxService(backing, {
      BETTER_AUTH_URL: 'https://hosted.example.com',
    })
    const created = (await (
      await service.fetch(
        new Request('http://hosted.test/operator/v1/repos/acme%2Frepo/sessions', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${mintToken(env.AB_STORE_SECRET, {
              version: 1,
              internalOperator: { user: 'Hosted Operator', repo: 'acme/repo' },
              exp: now.getTime() + 60_000,
            })}`,
            [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
            [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ title: 'sandboxed' }),
        }),
      )
    ).json()) as { id: string }

    const posted = await postMessage(service, created.id, {
      'x-vercel-oidc-token': 'request-oidc-token',
    })
    expect(posted.status).toBe(200)
    const events = await backing.getSessionEvents(created.id)
    expect(events.some((event) => event.type === 'turn.started')).toBe(false)
    expect(reports).toEqual([])
    const archived = await postMessage(
      service,
      created.id,
      { 'x-vercel-oidc-token': 'request-oidc-token' },
      'archive',
    )
    expect(archived.status).toBe(200)
    expect(await archived.json()).toEqual({ ok: true })
    expect(reports).toEqual([])
    expect((await backing.getSessionEvents(created.id)).at(-1)?.type).toBe('session.archived')
  })

  test('a message without Vercel credentials records only durable facts', async () => {
    const backing = new MemoryBuildStore({ clock })
    await publishSandboxConfig(backing)
    const { service, reports } = sandboxService(backing, {
      BETTER_AUTH_URL: 'https://hosted.example.com',
    })
    const created = (await (
      await service.fetch(
        new Request('http://hosted.test/operator/v1/repos/acme%2Frepo/sessions', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${mintToken(env.AB_STORE_SECRET, {
              version: 1,
              internalOperator: { user: 'Hosted Operator', repo: 'acme/repo' },
              exp: now.getTime() + 60_000,
            })}`,
            [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
            [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ title: 'uncredentialed' }),
        }),
      )
    ).json()) as { id: string }

    const posted = await postMessage(service, created.id)
    expect(posted.status).toBe(200)
    expect(await posted.json()).toEqual({ ok: true })
    expect((await backing.getSessionEvents(created.id)).map((event) => event.type)).toEqual([
      'session.created',
      'message.posted',
    ])
    expect(reports).toEqual([])
  })

  test('an absent BETTER_AUTH_URL leaves the deployment sandbox-free without degrading anything else', async () => {
    const backing = new MemoryBuildStore({ clock })
    await publishSandboxConfig(backing)
    const { service, reports } = sandboxService(backing)
    const created = (await (
      await service.fetch(
        new Request('http://hosted.test/operator/v1/repos/acme%2Frepo/sessions', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${mintToken(env.AB_STORE_SECRET, {
              version: 1,
              internalOperator: { user: 'Hosted Operator', repo: 'acme/repo' },
              exp: now.getTime() + 60_000,
            })}`,
            [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
            [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ title: 'no-origin' }),
        }),
      )
    ).json()) as { id: string }
    const posted = await postMessage(service, created.id, {
      'x-vercel-oidc-token': 'request-oidc-token',
    })
    expect(posted.status).toBe(200)
    const events = await backing.getSessionEvents(created.id)
    expect(events.some((event) => event.type === 'turn.started')).toBe(false)
    // No origin → no composition attempt → no diagnostic.
    expect(reports).toEqual([])
  })
})

test('project discovery opens independently of blobs and retries failed initialization', async () => {
  let attempts = 0
  const projects = testProjects(['https://github.com/acme/one'])
  const service = createHostedStoreService({
    openTicketPolicy: async () => new MemoryTicketPolicyStore(),
    issueDispatcherCredential: async () => 'abp_1_fixture',
    env: {},
    openStore: async () => {
      throw new Error('project discovery opened blobs')
    },
    openProjectRegistry: async () => {
      attempts++
      if (attempts === 1) throw new Error('temporary registry outage')
      return projects
    },
  })
  await expect(service.projects.list()).rejects.toThrow('temporary registry outage')
  expect(await service.projects.has('https://github.com/acme/one')).toBe(true)
  await projects.remove('https://github.com/acme/one', 'Ada')
  expect(await service.projects.list()).toEqual([])
  expect(attempts).toBe(2)
})

test('hosted HTTP preserves tree validation refusals without reporting internal failures', async () => {
  const project = await ticketProject(repo, env.AB_STORE_SECRET, clock)
  const backend = new FakeTicketSource()
  const reports: unknown[] = []
  const responses: { status: number; body: unknown }[] = []
  const service = createHostedStoreService({
    ...project,
    env,
    clock,
    sourceFor: () => backend,
    reportInternalError: (error) => {
      reports.push(error)
    },
  })
  const source = new HostedTicketSource({
    url: 'https://hosted.test',
    token: project.token,
    teamKey: 'ENG',
    fetchFn: async (input, init) => {
      const response = await service.fetch(new Request(input, init))
      responses.push({ status: response.status, body: await response.clone().json() })
      return response
    },
  })
  const work = await source.create({ title: 'Work', body: 'Body' })
  const node = await source.create({ title: 'Node', body: 'Body', kind: 'node' })
  const child = await source.create({ title: 'Child', body: 'Body', target: node.ref.id })
  for (const [operation, message] of [
    [
      () => source.create({ title: 'Invalid', body: 'Body', target: work.ref.id }),
      `target ${work.ref.id} is not a node`,
    ],
    [
      () => source.update(child.ref.id, { title: 'Lost', target: work.ref.id }),
      `target ${work.ref.id} is not a node`,
    ],
    [
      () => source.update(node.ref.id, { target: node.ref.id }),
      `target ${node.ref.id} would create a cycle (or has a cyclic ancestor chain)`,
    ],
    [
      () => source.update(node.ref.id, { kind: 'work' }),
      `cannot change node ${node.ref.id} to work: ticket ${child.ref.id} targets it`,
    ],
  ] as const) {
    await expect(operation()).rejects.toThrow(message)
    expect(responses.at(-1)).toEqual({ status: 400, body: { kind: 'validation', error: message } })
  }
  expect((await source.get(child.ref.id))?.title).toBe('Child')
  // The database uses its own transaction-local validation wording.
  for (const message of [
    'target ENG-1 would create a cycle',
    'cannot demote node: ticket ENG-3 targets it',
    'target ENG-1 does not exist in the configured file source',
    'target ENG-1 is in a different source',
  ]) {
    backend.update = async () => {
      throw new Error(message)
    }
    await expect(source.update(child.ref.id, { target: node.ref.id })).rejects.toThrow(message)
    expect(responses.at(-1)).toEqual({ status: 400, body: { kind: 'validation', error: message } })
  }
  expect(reports).toEqual([])
  const failure = new Error('postgres://private:secret@database/internal')
  backend.update = async () => {
    throw failure
  }
  await expect(source.update(child.ref.id, { title: 'Unavailable' })).rejects.toThrow(
    'hosted store is unavailable',
  )
  expect(responses.at(-1)?.status).toBe(500)
  expect(reports).toEqual([failure])
})
