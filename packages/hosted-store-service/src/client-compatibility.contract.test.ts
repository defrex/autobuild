import * as store10 from './compatibility-fixtures/store-v1.0'
import { MemoryTicketPolicyStore } from '@defrex/autobuild-postgres-store/ticket-policy'
import { DISPATCHER, parseConfig } from '@defrex/autobuild/testing'
import { testCredentials } from './testing/credentials'
import { testProjects } from './testing/projects'
import { expect, test } from 'bun:test'
import { MemoryBuildStore, FakeTicketSource } from '@defrex/autobuild/plugin-sdk'
import {
  mintToken,
  AUTOBUILD_VERSION,
  RELEASE_LINE_PROTOCOLS,
  REMOTE_STORE_PROTOCOL_VERSION,
  classifyClient,
  supportedClientRange,
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
} from '@defrex/autobuild/remote-store'
import { createStoreServer } from './remote-store-server'
import { createTicketServer } from './ticket-server'
import { createOperatorServer } from './operator-server'
import { createHostedStoreService } from './service'
import * as storeWire from './compatibility-fixtures/store-v0.9'
import * as ticketWire from './compatibility-fixtures/tickets-v0.9'
import * as ticket12 from './compatibility-fixtures/tickets-v0.12'
import * as ticket13 from './compatibility-fixtures/tickets-v0.13'
import * as operatorWire from './compatibility-fixtures/operator-v0.9'

const secret = 'historical-contract'
const token = mintToken(secret, {
  version: 1,
  ownerAdmin: { user: 'owner:fixture' },
  exp: Date.now() + 600_000,
})
const admin = mintToken(secret, {
  version: 1,
  ownerAdmin: { user: 'owner:fixture' },
  exp: Date.now() + 600_000,
})
const operator = mintToken(secret, {
  version: 1,
  internalOperator: { user: 'historical', repo: 'repo' },
  exp: Date.now() + 600_000,
})
function request(
  path: string,
  version: string,
  body?: unknown,
  bearer = admin,
  protocol = version.split('.').slice(0, 2).join('.') ===
  AUTOBUILD_VERSION.split('.').slice(0, 2).join('.')
    ? REMOTE_STORE_PROTOCOL_VERSION
    : (RELEASE_LINE_PROTOCOLS[version.split('.').slice(0, 2).join('.')] ??
      REMOTE_STORE_PROTOCOL_VERSION),
) {
  return new Request(`https://test${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      [AUTOBUILD_VERSION_HEADER]: version,
      [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: protocol,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

// Negotiate against the installed release's window so these contracts hold on
// both sides of a minor bump.
const clientWindow = supportedClientRange()
const isSupported = (version: string) => classifyClient(version, clientWindow) === 'supported'
const minLine = Number(clientWindow.minVersion.split('.')[1])
const endLine = Number(clientWindow.maxVersionExclusive.split('.')[1])
const advertised = Array.from({ length: endLine - minLine }, (_, i) => minLine + i).flatMap(
  (minor) => [`0.${minor}.0`, `0.${minor}.999`],
)
// Lines whose clients decode with the frozen v0.9 baseline (see the fixtures README).
const frozenBaseline = ['0.9.0', '0.10.0'].filter(isSupported)

for (const version of [
  ...advertised,
  `0.${minLine - 1}.99`,
  clientWindow.maxVersionExclusive,
  'invalid',
]) {
  test(`all gates negotiate ${version} before backend effects`, async () => {
    const supported = isSupported(version)
    const store = new MemoryBuildStore()
    await store.ensureRepo('https://github.com/acme/compat')
    const config = parseConfig(
      '[tickets]\nsource = "hosted"\nteamKey = "ENG"\nreadyState = "Ready"\n[verify]\nsteps = []\n[finalize]\nsteps = []',
    )
    const { verify, finalize, ...root } = config
    const artifact = await store.putRepoArtifact('https://github.com/acme/compat', {
      kind: 'dispatcher-effective-config',
      content: JSON.stringify({
        ...root,
        verify: { steps: verify.steps },
        finalize: { steps: finalize.steps },
      }),
    })
    await store.appendRepo('https://github.com/acme/compat', {
      actor: DISPATCHER,
      type: 'dispatcher.run-started',
      payload: {
        run: 'compat',
        pid: 1,
        effectiveConfig: { kind: artifact.kind, rev: artifact.revision },
        roleWarnings: [],
      },
    })
    const standalone = createStoreServer({ store, secret })
    let ticketCalls = 0
    const tickets = createTicketServer({
      secret,
      sourceFor: () => {
        ticketCalls++
        return new FakeTicketSource()
      },
    })
    const operators = createOperatorServer({ store, secret, projects: testProjects(['repo']) })
    let opens = 0
    const composed = createHostedStoreService({
      openTicketPolicy: async () => new MemoryTicketPolicyStore(),
      openProjectRegistry: async () => testProjects(['repo', 'https://github.com/acme/compat']),
      env: {
        AB_STORE_SECRET: secret,
        AB_POSTGRES_URL: 'postgres://unused/test',
        AB_BLOB_BACKEND: 's3',
        AB_S3_BUCKET: 'unused',
        AB_S3_REGION: 'us-east-1',
        AB_S3_ACCESS_KEY_ID: 'unused',
        AB_S3_SECRET_ACCESS_KEY: 'unused',
      },
      sourceFor: () => new FakeTicketSource(),
      openStore: async () => {
        opens++
        return store
      },
    })
    let createdCount = 0
    for (const server of [standalone, composed]) {
      expect(
        (
          await server.fetch(
            request('/builds', version, { slug: `demo-${createdCount++}`, repo: 'repo' }),
          )
        ).status,
      ).toBe(supported ? 201 : 409)
    }
    expect(opens).toBe(supported ? 1 : 0)
    expect(
      (
        await tickets.fetch(
          request(
            '/tickets/list-ready',
            version,
            { context: { teamKey: 'ENG' }, input: {} },
            token,
          ),
        )
      ).status,
    ).toBe(supported ? 200 : 409)
    expect(ticketCalls).toBe(supported ? 1 : 0)
    expect(
      (
        await composed.fetch(
          request(
            '/tickets/list-ready',
            version,
            { context: { teamKey: 'ENG', repo: 'https://github.com/acme/compat' }, input: {} },
            token,
          ),
        )
      ).status,
    ).toBe(supported ? 200 : 409)
    expect(
      (
        await composed.fetch(
          request('/operator/v1/repos/repo/builds', version, undefined, operator),
        )
      ).status,
    ).toBe(supported ? 200 : 409)

    expect(
      (
        await operators.fetch(
          request('/operator/v1/repos/repo/builds', version, undefined, operator),
        )
      ).status,
    ).toBe(supported ? 200 : 409)
    expect((await standalone.fetch(request('/sessions/missing', version))).status).toBe(
      supported ? 200 : 409,
    )
    if (supported) {
      expect(
        (
          await tickets.fetch(
            request('/tickets/list-ready', version, { context: { teamKey: 'ENG' }, input: {} }, ''),
          )
        ).status,
      ).toBe(401)
      expect(
        (await operators.fetch(request('/operator/v1/repos/repo/builds', version, undefined, '')))
          .status,
      ).toBe(401)
      expect((await standalone.fetch(request('/builds', version, undefined, ''))).status).toBe(401)
      expect(
        (await standalone.fetch(request('/builds', version, undefined, admin, '99'))).status,
      ).toBe(409)
    }
  })
}

for (const version of frozenBaseline) {
  test(`frozen ${version} ticket requests and strict decoders survive current fields`, async () => {
    const source = new FakeTicketSource()
    const server = createTicketServer({ secret, sourceFor: () => source })
    const call = async (
      operation: keyof typeof ticketWire.hostedTicketRequestSchemas,
      input: unknown,
    ) => {
      const body = ticketWire.hostedTicketRequestSchemas[operation].parse({
        context: { teamKey: 'ENG' },
        input,
      })
      const response = await server.fetch(request(`/tickets/${operation}`, version, body, token))
      expect(response.ok).toBe(true)
      return response.json()
    }
    const created = ticketWire.ticketWireSchema.parse(
      await call('create', { draft: { title: 'Old client', body: '# Spec' } }),
    )
    const id = created.ref.id
    const parent = await source.create({ title: 'Parent', body: 'Body', kind: 'node' })
    await source.update(id, { kind: 'node', target: parent.ref.id })
    ticketWire.ticketWireSchema.parse(await call('get', { id }))
    ticketWire.ticketListingWireSchema.parse(await call('list-ready', {}))
    ticketWire.successWireSchema.parse(await call('update', { id, patch: { title: 'Updated' } }))
    expect(await source.get(id)).toMatchObject({ kind: 'node', target: parent.ref.id })
    ticketWire.successWireSchema.parse(await call('comment', { id, body: 'hello' }))
    ticketWire.claimWireSchema.parse(await call('claim', { id }))
    const blocker = ticketWire.ticketWireSchema.parse(
      await call('create', { draft: { title: 'Blocker', body: '' } }),
    )
    ticketWire.successWireSchema.parse(await call('add-blocker', { id, blockerId: blocker.ref.id }))
    ticketWire.dependencyStatesWireSchema.parse(
      await call('dependency-states', { ids: [id, blocker.ref.id] }),
    )
    ticketWire.successWireSchema.parse(
      await call('remove-blocker', { id, blockerId: blocker.ref.id }),
    )
    ticketWire.successWireSchema.parse(await call('transition', { id, state: 'Done' }))
    const current = await server.fetch(
      request('/tickets/get', '0.11.0', { context: { teamKey: 'ENG' }, input: { id } }, token),
    )
    expect(await current.json()).toHaveProperty('resolved', true)
    // Prove that projection, rather than permissive fixture decoding, enables compatibility.
    expect(ticketWire.ticketWireSchema.safeParse({ ...created, resolved: true }).success).toBe(
      false,
    )
  })

  test(`frozen ${version} store envelopes, artifacts, events, leases and digests`, async () => {
    const store = new MemoryBuildStore()
    const server = createStoreServer({ store, secret })
    const call = async (path: string, body?: unknown) => {
      const response = await server.fetch(request(path, version, body))
      if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`)
      expect(response.ok).toBe(true)
      return response.json()
    }
    storeWire.buildRecordWireSchema.parse(
      await call('/builds', storeWire.newBuildBodySchema.parse({ slug: 'demo', repo: 'repo' })),
    )
    storeWire.eventEnvelopeWireSchema.parse(
      await call('/builds/demo/events', {
        actor: { kind: 'dispatcher' },
        type: 'build.created',
        payload: { ticket: { source: 'file', id: 'T-1' }, repo: 'repo', baseBranch: 'main' },
      }),
    )
    expect(storeWire.eventListSchema.parse(await call('/builds/demo/events?since=0'))).toHaveLength(
      1,
    )
    const meta = storeWire.artifactMetaWireSchema.parse(
      await call('/builds/demo/artifacts', { kind: 'spec', contentBase64: 'aGVsbG8=' }),
    )
    expect(
      storeWire.artifactGetResponseSchema.parse(
        await call(`/builds/demo/artifacts?kind=spec&rev=${meta.revision}`),
      ),
    ).toHaveProperty('contentBase64', 'aGVsbG8=')
    expect(
      storeWire.okResponseSchema.parse(
        await call('/builds/demo/lease/claim', { holder: 'old', ttlMs: 10000 }),
      ).ok,
    ).toBe(true)
    expect(
      storeWire.okResponseSchema.parse(
        await call('/builds/demo/lease/heartbeat', { holder: 'old' }),
      ).ok,
    ).toBe(true)
    storeWire.okResponseSchema.parse(await call('/builds/demo/lease/release', { holder: 'old' }))
    storeWire.repositoryRecordWireSchema.parse(await call('/repos', { repo: 'repo' }))
    storeWire.repositoryEventEnvelopeWireSchema.parse(
      await call('/repos/repo/events', {
        actor: { kind: 'human', user: 'old' },
        type: 'dispatcher.intake-set',
        payload: { enabled: true },
      }),
    )
    storeWire.repositoryEventListSchema.parse(await call('/repos/repo/events?since=0'))
    await store.append('demo', {
      actor: { kind: 'dispatcher' },
      type: 'integration.landed',
      payload: {
        operation: 'audit-op',
        head: 'head',
        landed: 'landed',
        provenance: 'kernel',
        verified: true,
        fenced: false,
      },
    })
    const digests = await call('/repos/repo/build-digests')
    expect(digests[0]).not.toHaveProperty('integrationAuditPending')
    storeWire.buildDigestListSchema.parse(digests)
    const session = storeWire.sessionRecordWireSchema.parse(
      await call('/repos/repo/sessions', { repo: 'repo', operator: 'old' }),
    )
    storeWire.sessionRecordWireSchema.parse(await call(`/sessions/${session.id}`))
    storeWire.sessionEventEnvelopeWireSchema.parse(
      await call(`/sessions/${session.id}/events`, {
        actor: { kind: 'human', user: 'old' },
        type: 'message.posted',
        payload: { text: 'Historical session' },
      }),
    )
    expect(
      storeWire.sessionEventListSchema.parse(await call(`/sessions/${session.id}/events?since=0`)),
    ).toHaveLength(2)
    storeWire.repositoryArtifactMetaWireSchema.parse(
      await call('/repos/repo/artifacts', { kind: 'legacy', contentBase64: 'aGVsbG8=' }),
    )
    storeWire.repositoryArtifactGetResponseSchema.parse(
      await call('/repos/repo/artifacts?kind=legacy'),
    )
    storeWire.sessionArtifactMetaWireSchema.parse(
      await call(`/sessions/${session.id}/artifacts`, {
        kind: 'legacy',
        contentBase64: 'aGVsbG8=',
      }),
    )
    storeWire.sessionArtifactGetResponseSchema.parse(
      await call(`/sessions/${session.id}/artifacts?kind=legacy`),
    )
  })

  test(`historical ${version} operator read/control/error and generic tool contract`, async () => {
    const store = new MemoryBuildStore()
    const server = createOperatorServer({ store, secret, projects: testProjects(['repo']) })
    const read = await server.fetch(
      request('/operator/v1/repos/repo/builds', version, undefined, operator),
    )
    expect(read.status).toBe(200)
    expect(Array.isArray(await read.json())).toBe(true) // historical operator client casts successful JSON without a decoder
    const control = operatorWire.settingRequestSchema.parse({ enabled: false })
    const controlRequest = request(
      '/operator/v1/repos/repo/settings/intake',
      version,
      control,
      operator,
    )
    const response = await server.fetch(new Request(controlRequest, { method: 'PUT' }))
    expect(response.status).toBe(200)
    const denied = await server.fetch(
      request('/operator/v1/repos/repo/builds', version, undefined, ''),
    )
    operatorWire.operatorErrorSchema.parse(await denied.json())
    const tools = await server.fetch(
      request(
        '/operator/v1/repos/repo/tools/repository.status',
        version,
        { repo: 'repo' },
        operator,
      ),
    )
    expect(tools.status).toBe(200)
  })
}

for (const version of frozenBaseline) {
  test(`historical ${version} wire shapes accept opaque project credentials`, async () => {
    const repo = 'https://github.com/acme/compatibility'
    const projects = testProjects([repo])
    const { store: credentials, auth } = testCredentials(projects, secret)
    const { token } = await credentials.issue(repo, 'historical-owner')
    const store = new MemoryBuildStore()
    const server = createStoreServer({ store, secret, auth })
    const created = await server.fetch(
      request('/builds', version, { slug: 'fix-login', repo }, token),
    )
    expect(created.status).toBe(201)
    const record = storeWire.buildRecordWireSchema.parse(await created.json())
    expect(record.slug).toMatch(/^fix-login-/)
    expect(record.branch).toBe(`ab/${record.slug}`)
    const operators = createOperatorServer({ store, secret, projects, auth })
    expect(
      (
        await operators.fetch(
          request(
            `/operator/v1/repos/${encodeURIComponent(repo)}/builds`,
            version,
            undefined,
            token,
          ),
        )
      ).status,
    ).toBe(200)
    const tickets = createTicketServer({ secret, auth, sourceFor: () => new FakeTicketSource() })
    expect(
      (
        await tickets.fetch(
          request(
            '/tickets/list-ready',
            version,
            { context: { teamKey: 'ENG' }, input: {} },
            token,
          ),
        )
      ).status,
    ).toBe(200)
  })
}

for (const version of ['0.12.0', '0.13.0', '0.14.0'].filter(isSupported)) {
  test(`frozen ${version} strict ticket decoder preserves tree metadata behind projection`, async () => {
    const wire = version === '0.12.0' ? ticket12 : ticket13
    const source = new FakeTicketSource()
    const parent = await source.create({ title: 'Parent', body: 'Body', kind: 'node' })
    const node = await source.create(
      { title: 'Node', body: 'Body', kind: 'node', target: parent.ref.id },
      { idempotencyKey: 'adopt-node' },
    )
    const server = createTicketServer({ secret, sourceFor: () => source })
    const call = async (operation: 'create' | 'get' | 'update' | 'list-ready', input: unknown) => {
      const body = wire.hostedTicketRequestSchemas[operation].parse({
        context: { teamKey: 'ENG' },
        input,
      })
      const req = request(`/tickets/${operation}`, version, body, token)
      if (version !== '0.12.0') {
        req.headers.set('x-autobuild-ticket-revisions', '1')
        req.headers.set('x-autobuild-ticket-comments', '1')
      }
      const response = await server.fetch(req)
      expect(response.ok).toBe(true)
      return response.json()
    }
    wire.ticketWireSchema.parse(await call('get', { id: node.ref.id }))
    wire.ticketWireSchema.parse(
      await call('create', {
        draft: { title: 'Adopt', body: 'Body' },
        options: { idempotencyKey: 'adopt-node' },
      }),
    )
    wire.ticketListingWireSchema.parse(await call('list-ready', {}))
    wire.successWireSchema.parse(
      await call('update', { id: node.ref.id, patch: { title: 'Updated' } }),
    )
    expect(await source.get(node.ref.id)).toMatchObject({
      title: 'Updated',
      kind: 'node',
      target: parent.ref.id,
    })
  })
}

for (const version of ['1.0.0', '1.0.1']) {
  test(`published ${version}/protocol-4 wire operations work against next-minor withdrawal service`, async () => {
    const store = new MemoryBuildStore()
    const server = createStoreServer({
      store,
      identity: { autobuildVersion: '1.1.0', protocolVersion: '6' },
    })
    const send = (path: string, body?: unknown) =>
      server.fetch(request(path, version, body, admin, '4'))
    const position = await send('/repos/repo/change-position')
    expect(position.status).toBe(200)
    expect(store10.repoChangePositionSchema.parse(await position.json())).toEqual({ position: '0' })
    await store.ensureRepo('repo')
    const claim = await send(
      '/repos/repo/lease/claim',
      store10.leaseClaimBodySchema.parse({ holder: 'published', ttlMs: 60_000 }),
    )
    expect(claim.status).toBe(200)
    expect(store10.okResponseSchema.parse(await claim.json()).ok).toBe(true)
    const heartbeat = await send(
      '/repos/repo/lease/heartbeat',
      store10.leaseHolderBodySchema.parse({ holder: 'published' }),
    )
    expect(store10.okResponseSchema.parse(await heartbeat.json()).ok).toBe(true)
    const tick = await send('/repos/repo/tick/begin', { holder: 'published' })
    expect(tick.status).toBe(200)
    expect(store10.beginRepoTickResponseSchema.parse(await tick.json())).toBeString()
    const highWater = await send('/repos/repo/high-water')
    expect(store10.repoHighWaterSchema.parse(await highWater.json())).toEqual({ seq: 0 })
    const release = await send('/repos/repo/lease/release', { holder: 'published' })
    expect(store10.okResponseSchema.parse(await release.json()).ok).toBe(true)
    for (const protocol of ['5', '6']) {
      const rejected = await server.fetch(
        request('/repos/repo/change-position', version, undefined, admin, protocol),
      )
      expect(rejected.status).toBe(409)
      expect(store10.errorBodySchema.parse(await rejected.json()).kind).toBe('conflict')
    }
  })
}
