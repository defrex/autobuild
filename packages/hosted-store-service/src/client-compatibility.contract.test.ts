import { testProjects } from './testing/projects'
import { expect, test } from 'bun:test'
import { MemoryBuildStore, FakeTicketSource } from '@defrex/autobuild/plugin-sdk'
import {
  mintToken,
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
} from '@defrex/autobuild/remote-store'
import { createStoreServer } from './remote-store-server'
import { createTicketServer } from './ticket-server'
import { createOperatorServer } from './operator-server'
import { createHostedStoreService } from './service'
import * as storeWire from './compatibility-fixtures/store-v0.9'
import * as ticketWire from './compatibility-fixtures/tickets-v0.9'
import * as operatorWire from './compatibility-fixtures/operator-v0.9'

const secret = 'historical-contract'
const token = mintToken(secret, { operator: true, session: '*', exp: Date.now() + 600_000 })
const admin = mintToken(secret, { build: '*', session: '*', exp: Date.now() + 600_000 })
const operator = mintToken(secret, { operator: { user: 'historical' }, exp: Date.now() + 600_000 })
function request(path: string, version: string, body?: unknown, bearer = admin, protocol = '3') {
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

for (const version of ['0.9.0', '0.10.0', '0.11.0', '0.11.999', '0.8.99', '0.12.0', 'invalid']) {
  test(`all gates negotiate ${version} before backend effects`, async () => {
    const supported = ['0.9.0', '0.10.0', '0.11.0', '0.11.999'].includes(version)
    const store = new MemoryBuildStore()
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
      openProjectRegistry: async () => testProjects(['repo']),
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
            { context: { teamKey: 'ENG' }, input: {} },
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
        (await standalone.fetch(request('/builds', version, undefined, admin, '4'))).status,
      ).toBe(409)
    }
  })
}

for (const version of ['0.9.0', '0.10.0']) {
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
    ticketWire.ticketWireSchema.parse(await call('get', { id }))
    ticketWire.ticketListingWireSchema.parse(await call('list-ready', {}))
    ticketWire.successWireSchema.parse(await call('update', { id, patch: { title: 'Updated' } }))
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
    storeWire.buildDigestListSchema.parse(await call('/repos/repo/build-digests'))
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
      request('/operator/v1/repos/repo/builds', version, undefined, admin),
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
