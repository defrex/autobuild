import { expect, test } from 'bun:test'
import {
  MemoryBuildStore,
  sampleBuildInput,
  buildCreatedWrite,
  FakeTicketSource,
} from '@defrex/autobuild/plugin-sdk'
import {
  newerFact,
  seedNewerMemoryFact,
  readBuildFacts,
  readRepositoryFacts,
  READ_CATALOG_IDENTITY,
} from '@defrex/autobuild/testing'
import {
  RemoteBuildStore,
  mintToken,
  CATALOG_IDENTITY_HEADER,
  AUTOBUILD_VERSION_HEADER,
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION,
  RELEASE_LINE_PROTOCOLS,
} from '@defrex/autobuild/remote-store'
import { createStoreServer } from './remote-store-server'
import { createHostedStoreService } from './service'
import { testProjects } from './testing/projects'
import { MemoryTicketPolicyStore } from '@defrex/autobuild-postgres-store/ticket-policy'
import { reducerValueSchema as releasedParser } from './compatibility-fixtures/reducer-values-v1.0.0-beta.0'

const secret = 'mixed-version-test'
const token = mintToken(secret, {
  version: 1,
  ownerAdmin: { user: 'test' },
  exp: Date.now() + 600_000,
})
const headers = {
  authorization: `Bearer ${token}`,
  [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
  [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
  'content-type': 'application/json',
}
async function fixture() {
  const store = new MemoryBuildStore()
  await store.createBuild(sampleBuildInput('mixed', { repo: 'repo' }))
  const known = buildCreatedWrite()
  seedNewerMemoryFact(store, {
    ...newerFact(1),
    actor: known.actor,
    type: known.type,
    payload: {
      ...known.payload,
      repo: 'repo',
      future: { enabled: true },
      ticket: { ...known.payload.ticket, future: true },
    },
  })
  seedNewerMemoryFact(store, newerFact(2))
  await store.ensureRepo('repo')
  seedNewerMemoryFact(store, { ...newerFact(1), build: undefined, repo: 'repo' })
  return store
}

test('released strict parsers accept three-field build/repository answers through direct and composed services', async () => {
  const store = await fixture()
  const direct = createStoreServer({ store, secret })
  const composed = createHostedStoreService({
    openTicketPolicy: async () => new MemoryTicketPolicyStore(),
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
    openStore: async () => store,
  })
  for (const service of [direct, composed])
    for (const [path, reducer] of [
      ['/builds/mixed', 'buildReadFacts'],
      ['/repos/repo', 'repositoryReadFacts'],
    ]) {
      const response = await service.fetch(
        new Request(`https://test${path}/reducer-values`, {
          method: 'POST',
          headers: {
            ...headers,
            [AUTOBUILD_VERSION_HEADER]: '1.0.0-beta.0',
            [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: RELEASE_LINE_PROTOCOLS['1.0']!,
          },
          body: JSON.stringify({ reducer }),
        }),
      )
      expect(response.status).toBe(200)
      expect(response.headers.get(CATALOG_IDENTITY_HEADER)).toBe(READ_CATALOG_IDENTITY)
      const body = await response.json()
      expect(Object.keys(body).sort()).toEqual(['cursor', 'value', 'version'])
      releasedParser.parse(body)
    }
})

for (const identity of [READ_CATALOG_IDENTITY, null, 'malformed', 'f'.repeat(64)]) {
  test(`hosted client uses its catalog for header ${identity?.slice(0, 10) ?? 'absent'}`, async () => {
    const store = await fixture()
    const server = createStoreServer({ store, secret })
    let rawReads = 0
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const request = new Request(url, init)
      if (new URL(request.url).pathname.endsWith('/events')) rawReads++
      const response = await server.fetch(request)
      if (request.url.endsWith('/reducer-values')) {
        const body = await response.json()
        if (identity === null) response.headers.delete(CATALOG_IDENTITY_HEADER)
        else response.headers.set(CATALOG_IDENTITY_HEADER, identity)
        // Structurally valid values from another catalog cannot be accepted.
        if (identity !== READ_CATALOG_IDENTITY) {
          if (body.value.state) body.value.state.compatibility.decisiveFacts = 0
          if (body.value.compatibility) body.value.compatibility.decisiveFacts = 0
        }
        return new Response(JSON.stringify(body), {
          status: response.status,
          headers: response.headers,
        })
      }
      return response
    }) as typeof fetch
    const client = new RemoteBuildStore({ url: 'https://test', token, fetchFn })
    expect((await readBuildFacts(client, 'mixed')).value.state.compatibility.decisiveFacts).toBe(1)
    expect((await readRepositoryFacts(client, 'repo')).value.compatibility.decisiveFacts).toBe(1)
    expect(rawReads).toBe(identity === READ_CATALOG_IDENTITY ? 0 : 2)
    expect((await client.getEvents('mixed'))[1]!.payload as unknown).toEqual(newerFact(2).payload)
    expect((await client.getEvents('mixed'))[1]!.compatibility).toEqual(newerFact(2).compatibility)
    expect((await client.getEvents('mixed'))[0]!.payload as unknown).toHaveProperty('future', {
      enabled: true,
    })
  })
}

test('a backend without identity is never labelled with the service catalog', async () => {
  const store = await fixture()
  const read = store.getReducerValue.bind(store)
  store.getReducerValue = async (...args) => {
    const { catalogIdentity: _, ...legacy } = await read(...args)
    return legacy
  }
  const server = createStoreServer({ store, secret })
  const response = await server.fetch(
    new Request('https://test/builds/mixed/reducer-values', {
      method: 'POST',
      headers,
      body: JSON.stringify({ reducer: 'buildReadFacts' }),
    }),
  )
  expect(response.status).toBe(200)
  expect(response.headers.get(CATALOG_IDENTITY_HEADER)).toBeNull()
  releasedParser.parse(await response.json())
})

test('a newer reducer version replays only the frozen response cursor, without remote cache writes', async () => {
  const store = await fixture()
  const server = createStoreServer({ store, secret })
  const calls: string[] = []
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const request = new Request(url, init)
    calls.push(`${request.method} ${new URL(request.url).pathname}`)
    if (request.url.includes('/events?')) seedNewerMemoryFact(store, newerFact(3))
    const response = await server.fetch(request)
    if (!request.url.endsWith('/reducer-values')) return response
    const body = await response.json()
    body.version++
    return new Response(JSON.stringify(body), {
      status: response.status,
      headers: response.headers,
    })
  }) as typeof fetch
  const client = new RemoteBuildStore({ url: 'https://test', token, fetchFn })
  const result = await readBuildFacts(client, 'mixed')
  expect(result.cursor).toBe(2)
  expect(result.value.state.compatibility.unknownFacts).toBe(1)
  expect(result.value.state.compatibility.decisiveFacts).toBe(1)
  expect(calls).toEqual(['POST /builds/mixed/reducer-values', 'GET /builds/mixed/events'])
  expect((await store.getEvents('mixed')).at(-1)!.seq).toBe(3)
})

test('the client rejects unsupported writes before a newer service sees them', async () => {
  let requests = 0
  const fetchFn = (async () => {
    requests++
    throw new Error('must not send unsupported writes')
  }) as unknown as typeof fetch
  const client = new RemoteBuildStore({ url: 'https://test', token, fetchFn })
  await expect(client.append('mixed', newerFact(1) as never)).rejects.toThrow('unknown event type')
  const write = buildCreatedWrite()
  await expect(
    client.append('mixed', { ...write, payload: { ...write.payload, future: true } } as never),
  ).rejects.toThrow('Unrecognized key')
  expect(requests).toBe(0)
})

test('seed, digest, parameterized and repository selectors all replay with absent catalog identity', async () => {
  const store = await fixture()
  const server = createStoreServer({ store, secret })
  let rawReads = 0
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const request = new Request(url, init)
    if (request.url.includes('/events?')) rawReads++
    const response = await server.fetch(request)
    response.headers.delete(CATALOG_IDENTITY_HEADER)
    return response
  }) as typeof fetch
  const client = new RemoteBuildStore({ url: 'https://test', token, fetchFn })
  for (const reducer of ['buildStreamSeed', 'buildDigest', 'phaseFailures']) {
    const request = {
      reducer,
      ...(reducer === 'phaseFailures' ? { args: { phase: 'plan', round: 1 } } : {}),
    }
    const scope = { kind: 'build', slug: 'mixed' } as const
    expect(await client.getReducerValue(scope, request)).toEqual(
      await store.getReducerValue(scope, request),
    )
  }
  expect(
    await client.getReducerValue(
      { kind: 'repo', repo: 'repo' },
      { reducer: 'repositoryAttention' },
    ),
  ).toEqual(
    await store.getReducerValue({ kind: 'repo', repo: 'repo' }, { reducer: 'repositoryAttention' }),
  )
  expect(rawReads).toBe(4)
  expect(
    (await client.getRepoBuildDigests('repo')).get('mixed')!.compatibility!.decisiveFacts,
  ).toBe(1)
})

for (const corruption of ['known-field', 'missing-sequence']) {
  test(`local replay surfaces genuine ${corruption} corruption`, async () => {
    const store = await fixture()
    const server = createStoreServer({ store, secret })
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const request = new Request(url, init)
      const response = await server.fetch(request)
      response.headers.delete(CATALOG_IDENTITY_HEADER)
      if (!request.url.includes('/events?')) return response
      const events = await response.json()
      if (corruption === 'known-field') events[0].payload.ticket.id = 123
      else events.shift()
      return new Response(JSON.stringify(events), { status: 200, headers: response.headers })
    }) as typeof fetch
    const client = new RemoteBuildStore({ url: 'https://test', token, fetchFn })
    await expect(readBuildFacts(client, 'mixed')).rejects.toThrow(
      corruption === 'missing-sequence' ? 'noncontiguous reducer log' : 'Invalid input',
    )
  })
}

test('a supported hosted reader clears a prior catalog deferral at an identical reducer version', async () => {
  const store = new MemoryBuildStore()
  await store.createBuild(sampleBuildInput('mixed', { repo: 'repo' }))
  await store.append('mixed', buildCreatedWrite())
  await store.append('mixed', {
    actor: { kind: 'human', user: 'fixture' },
    type: 'build.pause-requested',
    payload: {},
  })
  const server = createStoreServer({ store, secret })
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const request = new Request(url, init)
    const response = await server.fetch(request)
    if (!request.url.endsWith('/reducer-values')) return response
    const body = await response.json()
    // A frozen older catalog could not interpret pause-requested. Its cached
    // reduction has a valid local shape and the same reducer integer.
    body.value.state.compatibility = {
      unknownFacts: 1,
      decisiveFacts: 1,
      lastSeq: 2,
      decisiveBoundary: 2,
      types: ['build.pause-requested'],
      writerVersions: [AUTOBUILD_VERSION],
      legacyVersionUnavailable: false,
    }
    response.headers.set(CATALOG_IDENTITY_HEADER, 'e'.repeat(64))
    return new Response(JSON.stringify(body), { status: 200, headers: response.headers })
  }) as typeof fetch
  const client = new RemoteBuildStore({ url: 'https://test', token, fetchFn })
  const facts = (await readBuildFacts(client, 'mixed')).value
  expect(facts.state.compatibility.unknownFacts).toBe(0)
  expect(facts.state.compatibility.decisiveFacts).toBe(0)
  expect(facts.state.pendingCommands).toHaveLength(1)
})

test('producer release metadata survives direct, conditional and atomic hosted writes', async () => {
  const store = new MemoryBuildStore()
  await store.createBuild(sampleBuildInput('mixed', { repo: 'repo' }))
  await store.ensureRepo('repo')
  const server = createStoreServer({ store, secret })
  const fetchFn = ((url: string | URL | Request, init?: RequestInit) =>
    server.fetch(new Request(url, init))) as typeof fetch
  const client = new RemoteBuildStore({ url: 'https://test', token, fetchFn })
  const compatibility = { writerVersion: '1.0.0-beta.0', classification: 'decisive' } as const
  expect(
    (
      await client.append('mixed', {
        actor: { kind: 'kernel' },
        type: 'plan.started',
        payload: { round: 1 },
        compatibility,
      })
    ).compatibility,
  ).toEqual(compatibility)
  expect(
    (await client.appendIfCurrent('mixed', 1, {
      actor: { kind: 'kernel' },
      type: 'plan-review.started',
      payload: { round: 1 },
      compatibility,
    }))!.compatibility,
  ).toEqual(compatibility)
  const build = await client.appendWithArtifacts(
    'mixed',
    [{ kind: 'plan', content: '# Plan' }],
    (metas) => ({
      actor: { kind: 'agent', role: 'plan', session: 'fixture' },
      type: 'plan.completed',
      payload: { round: 1, artifact: { kind: 'plan', rev: metas[0]!.revision } },
      compatibility,
    }),
  )
  expect(build.event.compatibility).toEqual(compatibility)
  const repo = await client.appendRepoWithArtifacts(
    'repo',
    [{ kind: 'scan', content: '{}' }],
    (metas) => ({
      actor: { kind: 'kernel' },
      type: 'harvest.step.completed',
      payload: {
        run: 'fixture',
        step: 'scan',
        outcome: 'completed',
        artifact: { kind: 'scan', rev: metas[0]!.revision },
      },
      compatibility,
    }),
  )
  expect(repo.event.compatibility).toEqual(compatibility)
  expect((await client.getEvents('mixed')).map((e) => e.compatibility)).toEqual([
    compatibility,
    compatibility,
    compatibility,
  ])
  expect((await client.getRepoEvents('repo'))[0]!.compatibility).toEqual(compatibility)
  await expect(
    store.append('mixed', {
      actor: { kind: 'kernel' },
      type: 'plan.started',
      payload: { round: 2 },
      compatibility: { ...compatibility, classification: 'advisory' },
    }),
  ).rejects.toThrow('classification disagrees')
  expect(await client.getEvents('mixed')).toHaveLength(3)
})

for (const scope of [
  { kind: 'build', slug: 'mixed' },
  { kind: 'repo', repo: 'repo' },
] as const) {
  test(`mismatched ${scope.kind} reads transfer only the delta and isolate returned values`, async () => {
    const store = await fixture()
    const server = createStoreServer({ store, secret })
    const transfers: { since: number; count: number }[] = []
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const request = new Request(url, init)
      const response = await server.fetch(request)
      response.headers.set(CATALOG_IDENTITY_HEADER, 'f'.repeat(64))
      if (request.url.includes('/events?')) {
        transfers.push({
          since: Number(new URL(request.url).searchParams.get('since')),
          count: (await response.clone().json()).length,
        })
      }
      return response
    }) as typeof fetch
    const client = new RemoteBuildStore({ url: 'https://test', token, fetchFn })
    const request = { reducer: scope.kind === 'build' ? 'buildReadFacts' : 'repositoryReadFacts' }
    const first = await client.getReducerValue(scope, request)
    const pristine = structuredClone(first)
    const exposed = first.value as unknown as {
      state?: { compatibility: { unknownFacts: number } }
      compatibility?: { unknownFacts: number }
    }
    ;(exposed.state?.compatibility ?? exposed.compatibility!).unknownFacts = 999
    for (let i = 0; i < 5; i++)
      expect(await client.getReducerValue(scope, request)).toEqual(pristine)
    const nextSeq = first.cursor + 1
    seedNewerMemoryFact(
      store,
      scope.kind === 'build'
        ? newerFact(nextSeq)
        : { ...newerFact(nextSeq), build: undefined, repo: 'repo' },
    )
    const next = await client.getReducerValue(scope, request)
    expect(next).toEqual(await store.getReducerValue(scope, request))
    expect(transfers).toEqual([
      { since: 0, count: first.cursor },
      { since: first.cursor, count: 1 },
    ])
    expect(await client.getReducerValue(scope, request)).toEqual(next)
    expect(transfers).toHaveLength(2)
    // A caller's alias cannot poison the retained incremental accumulator.
    expect(next.cursor).toBe(nextSeq)
  })
}

test('mismatched parameterized reads retain independent argument accumulators', async () => {
  const store = await fixture()
  const server = createStoreServer({ store, secret })
  const cursors: number[] = []
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const request = new Request(url, init)
    if (request.url.includes('/events?'))
      cursors.push(Number(new URL(request.url).searchParams.get('since')))
    const response = await server.fetch(request)
    response.headers.delete(CATALOG_IDENTITY_HEADER)
    return response
  }) as typeof fetch
  const client = new RemoteBuildStore({ url: 'https://test', token, fetchFn })
  const scope = { kind: 'build', slug: 'mixed' } as const
  for (const round of [1, 2, 1, 2]) {
    const request = { reducer: 'phaseFailures', args: { phase: 'plan', round } }
    expect(await client.getReducerValue(scope, request)).toEqual(
      await store.getReducerValue(scope, request),
    )
  }
  expect(cursors).toEqual([0, 0])
})

test('concurrent mismatched reads keep their response cursors without regressing the accumulator', async () => {
  const store = await fixture()
  const server = createStoreServer({ store, secret })
  let release!: () => void
  let captured!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const ready = new Promise<void>((resolve) => {
    captured = resolve
  })
  let hold = false
  const cursors: number[] = []
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const request = new Request(url, init)
    const response = await server.fetch(request)
    response.headers.delete(CATALOG_IDENTITY_HEADER)
    if (request.url.includes('/events?'))
      cursors.push(Number(new URL(request.url).searchParams.get('since')))
    if (hold && request.url.endsWith('/reducer-values')) {
      hold = false
      captured()
      await held
    }
    return response
  }) as typeof fetch
  const client = new RemoteBuildStore({ url: 'https://test', token, fetchFn })
  const scope = { kind: 'build', slug: 'mixed' } as const
  const request = { reducer: 'buildReadFacts' }
  await client.getReducerValue(scope, request)
  seedNewerMemoryFact(store, newerFact(3))
  hold = true
  const older = client.getReducerValue(scope, request)
  await ready
  seedNewerMemoryFact(store, newerFact(4))
  const newer = await client.getReducerValue(scope, request)
  expect(newer.cursor).toBe(4)
  release()
  const late = await older
  expect(late.cursor).toBe(3)
  expect(
    (late.value as unknown as { state: { compatibility: { unknownFacts: number } } }).state
      .compatibility.unknownFacts,
  ).toBe(2)
  expect(await client.getReducerValue(scope, request)).toEqual(newer)
  expect(cursors).toEqual([0, 2, 0])
})
