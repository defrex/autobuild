import { RELEASED_CLIENTS } from '@defrex/autobuild/remote-store'
import {
  RELEASED_REDUCER_VALUES,
  REDUCERS,
  REDUCER_REVISIONS,
  deriveReducerVersion,
  projectReducerValue,
} from '@defrex/autobuild/testing'
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
  ReducerValueIncompatibilityError,
  mintToken,
  CATALOG_IDENTITY_HEADER,
  AUTOBUILD_VERSION_HEADER,
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION,
  RELEASE_LINE_PROTOCOLS,
  REDUCER_VALUE_PROJECTION_HEADER,
  classifyClient,
  supportedClientRange,
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
  await store.appendRepo('repo', {
    actor: { kind: 'kernel' },
    type: 'dispatcher.placement-set',
    payload: { hosted: true, origin: 'https://store.test' },
  })
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
  const line = (version: string) => version.split('.').slice(0, 2).join('.')
  // Published releases still inside the installed service's supported client window.
  const released = RELEASED_CLIENTS.map((entry) => entry.version).filter(
    (version) => classifyClient(version, supportedClientRange()) === 'supported',
  )
  expect(released.length).toBeGreaterThan(0)
  for (const client of released)
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
              [AUTOBUILD_VERSION_HEADER]: client,
              [REMOTE_STORE_PROTOCOL_VERSION_HEADER]:
                line(client) === line(AUTOBUILD_VERSION)
                  ? REMOTE_STORE_PROTOCOL_VERSION
                  : RELEASE_LINE_PROTOCOLS[line(client)]!,
            },
            body: JSON.stringify({ reducer }),
          }),
        )
        expect(response.status).toBe(200)
        expect(response.headers.get(CATALOG_IDENTITY_HEADER)).toBe(READ_CATALOG_IDENTITY)
        const body = await response.json()
        expect(Object.keys(body).sort()).toEqual(['cursor', 'value', 'version'])
        releasedParser.parse(body)
        const publication = RELEASED_CLIENTS.find((entry) => entry.version === client)!
        const catalog = RELEASED_REDUCER_VALUES[publication.contract!]!
        expect(projectReducerValue(reducer!, body.value, catalog)).toEqual({ value: body.value })
      }
})

test('released 1.2.0 clients keep their frozen contract even when advertising projection', async () => {
  const store = await fixture()
  const server = createStoreServer({ store, secret })
  for (const [path, reducer, released] of [
    ['/builds/mixed', 'buildReadFacts', 69],
    ['/repos/repo', 'repositoryReadFacts', 31],
  ] as const) {
    const read = async (projects: boolean) => {
      const response = await server.fetch(
        new Request(`https://test${path}/reducer-values`, {
          method: 'POST',
          headers: {
            ...headers,
            [AUTOBUILD_VERSION_HEADER]: '1.2.0',
            [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: '6',
            ...(projects ? { [REDUCER_VALUE_PROJECTION_HEADER]: '1' } : {}),
          },
          body: JSON.stringify({ reducer }),
        }),
      )
      expect(response.status).toBe(200)
      return (await response.json()) as { version: number; value: Record<string, unknown> }
    }
    expect((await read(true)).version).toBe(released)
    const frozen = await read(false)
    expect(frozen.version).toBe(released)
    if (reducer === 'repositoryReadFacts') expect(frozen.value).not.toHaveProperty('preparation')
  }
})

for (const identity of [READ_CATALOG_IDENTITY, null, 'malformed', 'f'.repeat(64)]) {
  test(`hosted client uses the server answer for header ${identity?.slice(0, 10) ?? 'absent'}`, async () => {
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
        // A distinctive server answer must survive catalog skew.
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
    expect((await readBuildFacts(client, 'mixed')).value.state.compatibility.decisiveFacts).toBe(
      identity === READ_CATALOG_IDENTITY ? 1 : 0,
    )
    expect((await readRepositoryFacts(client, 'repo')).value.compatibility.decisiveFacts).toBe(
      identity === READ_CATALOG_IDENTITY ? 1 : 0,
    )
    expect(rawReads).toBe(0)
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

for (const skew of ['newer', 'older'] as const) {
  test(`a ${skew} reducer version with a representable value is used without raw reads`, async () => {
    const store = await fixture()
    const server = createStoreServer({ store, secret })
    const calls: string[] = []
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const request = new Request(url, init)
      calls.push(`${request.method} ${new URL(request.url).pathname}`)
      const response = await server.fetch(request)
      if (!request.url.endsWith('/reducer-values')) return response
      const body = await response.json()
      body.version += skew === 'newer' ? 1 : -1
      // A newer server's additive field reaches this client as the value it knows.
      body.value.futureField = { added: true }
      return new Response(JSON.stringify(body), {
        status: response.status,
        headers: response.headers,
      })
    }) as typeof fetch
    const client = new RemoteBuildStore({ url: 'https://test', token, fetchFn })
    await readBuildFacts(client, 'mixed')
    expect(calls).toEqual(['POST /builds/mixed/reducer-values'])
    const direct = new RemoteBuildStore({
      url: 'https://test',
      token,
      fetchFn: ((url: string | URL | Request, init?: RequestInit) =>
        server.fetch(new Request(url, init))) as typeof fetch,
    })
    const scope = { kind: 'build', slug: 'mixed' } as const
    const answer = await client.getReducerValue(scope, { reducer: 'buildReadFacts' })
    expect(answer.value).toEqual(
      (await direct.getReducerValue(scope, { reducer: 'buildReadFacts' })).value,
    )
    expect(answer.value).not.toHaveProperty('futureField')
  })
}

test('a value missing a field this client requires fails without raw reads', async () => {
  const store = await fixture()
  const server = createStoreServer({ store, secret })
  const calls: string[] = []
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const request = new Request(url, init)
    calls.push(`${request.method} ${new URL(request.url).pathname}`)
    const response = await server.fetch(request)
    if (!request.url.endsWith('/reducer-values')) return response
    const body = await response.json()
    delete body.value.state
    return new Response(JSON.stringify(body), {
      status: response.status,
      headers: response.headers,
    })
  }) as typeof fetch
  const client = new RemoteBuildStore({ url: 'https://test', token, fetchFn })
  await expect(readBuildFacts(client, 'mixed')).rejects.toBeInstanceOf(
    ReducerValueIncompatibilityError,
  )
  expect(calls).toEqual(['POST /builds/mixed/reducer-values'])
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

test('seed, digest, parameterized and repository selectors accept server values with absent catalog identity', async () => {
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
    expect(await client.getReducerValue(scope, request)).toEqual({
      ...(await store.getReducerValue(scope, request)),
      catalogIdentity: undefined,
    })
  }
  expect(
    await client.getReducerValue(
      { kind: 'repo', repo: 'repo' },
      { reducer: 'repositoryAttention' },
    ),
  ).toEqual({
    ...(await store.getReducerValue(
      { kind: 'repo', repo: 'repo' },
      { reducer: 'repositoryAttention' },
    )),
    catalogIdentity: undefined,
  })
  expect(rawReads).toBe(0)
  expect(
    (await client.getRepoBuildDigests('repo')).get('mixed')!.compatibility!.decisiveFacts,
  ).toBe(1)
})

for (const corruption of ['known-field', 'missing-sequence']) {
  test(`invalid server answer diagnoses ${corruption} corruption`, async () => {
    const store = await fixture()
    const server = createStoreServer({ store, secret })
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const request = new Request(url, init)
      const response = await server.fetch(request)
      response.headers.delete(CATALOG_IDENTITY_HEADER)
      if (!request.url.endsWith('/reducer-values')) return response
      const body = await response.json()
      if (corruption === 'known-field') body.value.state.compatibility = 123
      else delete body.cursor
      return new Response(JSON.stringify(body), { status: 200, headers: response.headers })
    }) as typeof fetch
    const client = new RemoteBuildStore({ url: 'https://test', token, fetchFn })
    await expect(readBuildFacts(client, 'mixed')).rejects.toThrow(
      'incompatible reducer buildReadFacts',
    )
  })
}

test('a supported hosted reader preserves the server catalog deferral at an identical reducer version', async () => {
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
      ...body.value.state.compatibility,
      unknownFacts: 1,
      decisiveFacts: 1,
      lastSeq: 2,
      decisiveBoundary: 2,
      decisiveTypes: ['build.pause-requested'],
      writerVersions: [AUTOBUILD_VERSION],
      legacyVersionUnavailable: false,
    }
    response.headers.set(CATALOG_IDENTITY_HEADER, 'e'.repeat(64))
    return new Response(JSON.stringify(body), { status: 200, headers: response.headers })
  }) as typeof fetch
  const client = new RemoteBuildStore({ url: 'https://test', token, fetchFn })
  const facts = (await readBuildFacts(client, 'mixed')).value
  expect(facts.state.compatibility.unknownFacts).toBe(1)
  expect(facts.state.compatibility.decisiveFacts).toBe(1)
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
  test(`mismatched ${scope.kind} reads accept server answers and isolate returned values`, async () => {
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
    expect(next).toEqual({
      ...(await store.getReducerValue(scope, request)),
      catalogIdentity: 'f'.repeat(64),
    })
    expect(transfers).toEqual([])
    expect(await client.getReducerValue(scope, request)).toEqual(next)
    // A caller's alias cannot poison the retained incremental accumulator.
    expect(next.cursor).toBe(nextSeq)
  })
}

test('mismatched parameterized reads accept independent argument answers', async () => {
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
    expect(await client.getReducerValue(scope, request)).toEqual({
      ...(await store.getReducerValue(scope, request)),
      catalogIdentity: undefined,
    })
  }
  expect(cursors).toEqual([])
})

test('concurrent mismatched reads keep their response cursors without cursor substitution', async () => {
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
  expect(cursors).toEqual([])
})

for (const length of [100, 10_000]) {
  test(`fresh catalog-skew clients read zero history rows at ${length} events`, async () => {
    const { catalogSkewReadBudget } = await import('@defrex/autobuild/testing')
    const store = new MemoryBuildStore()
    await store.ensureRepo('repo')
    await store.createBuild({ slug: 'mixed', repo: 'repo' })
    for (let i = 0; i < length; i++) {
      await store.append('mixed', { actor: { kind: 'kernel' }, type: 'build.paused', payload: {} })
      await store.appendRepo('repo', {
        actor: { kind: 'human', user: 'test' },
        type: 'dispatcher.intake-set',
        payload: { enabled: false },
      })
    }
    for (let i = 0; i < (length === 100 ? 1 : 20); i++)
      await store.createBuild({ slug: `extra-${i}`, repo: 'repo' })
    // Instrument both public history filtering and private reducer slice reads.
    let rows = 0
    for (const key of ['builds', 'repos']) {
      const states = Reflect.get(store, key) as Map<string, { events: unknown[] }>
      for (const state of states.values()) {
        for (const method of ['slice', 'filter'] as const) {
          const original = state.events[method].bind(state.events)
          Object.defineProperty(state.events, method, {
            value: (...args: unknown[]) => {
              const result = Reflect.apply(original, state.events, args) as unknown[]
              rows += result.length
              return result
            },
          })
        }
      }
    }
    const server = createStoreServer({ store, secret })
    let raw = 0,
      batches = 0,
      named = 0,
      discovery = 0
    const fetchFn = (async (url, init) => {
      const request = new Request(url, init)
      const path = new URL(request.url).pathname
      if (path.endsWith('/events')) raw++
      if (path.endsWith('/build-digests')) batches++
      if (path.endsWith('/reducer-values')) named++
      if (path === '/builds') discovery++
      const response = await server.fetch(request)
      response.headers.set(CATALOG_IDENTITY_HEADER, 'foreign')
      return response
    }) as typeof fetch
    await catalogSkewReadBudget({
      backing: store,
      fresh: () => new RemoteBuildStore({ url: 'https://test', token, fetchFn }),
      repo: 'repo',
      slug: 'mixed',
      reset: () => {
        rows = 0
      },
      eventRows: () => rows,
    })
    expect({ raw, batches, named, discovery }).toEqual({
      raw: 0,
      batches: 3,
      named: 12,
      discovery: 0,
    })
    for (const skew of ['version', 'value']) {
      const skewedFetch = (async (url, init) => {
        const response = await fetchFn(url, init)
        const body = await response.json()
        if (skew === 'version') body.version++
        else body.value = null
        return Response.json(body, { headers: response.headers })
      }) as typeof fetch
      const client = new RemoteBuildStore({ url: 'https://test', token, fetchFn: skewedFetch })
      const read = client.getReducerValue(
        { kind: 'repo', repo: 'repo' },
        { reducer: 'dispatchUpgrade' },
      )
      // Version skew alone is cache identity; only an unrepresentable value fails.
      if (skew === 'version') await expect(read).resolves.toHaveProperty('value')
      else await expect(read).rejects.toBeInstanceOf(ReducerValueIncompatibilityError)
      expect(rows).toBe(0)
      expect(raw).toBe(0)
    }
    await store.getEvents('mixed')
    expect(rows).toBe(length)
  })
}

const STREAM_SEEDS = [
  ['/builds/mixed', 'buildStreamSeed'],
  ['/repos/repo', 'repositoryAttention'],
] as const

/** A store whose build and repository logs are long enough to resume inside. */
async function seedFixture() {
  const store = new MemoryBuildStore()
  await store.ensureRepo('repo')
  await store.createBuild({ slug: 'mixed', repo: 'repo' })
  for (let i = 0; i < 4; i++) {
    await store.append('mixed', { actor: { kind: 'kernel' }, type: 'build.paused', payload: {} })
    await store.appendRepo('repo', {
      actor: { kind: 'human', user: 'test' },
      type: 'dispatcher.intake-set',
      payload: { enabled: false },
    })
  }
  const cursors = {
    '/builds/mixed': (await store.getEvents('mixed')).length - 2,
    '/repos/repo': (await store.getRepositoryTail('repo', 0)).length - 2,
  }
  return { store, cursors }
}

const line = (version: string) => version.split('.').slice(0, 2).join('.')
/** The headers a released client sends to `stream-seed`: version and protocol only. */
const releasedHeaders = (client: string) => ({
  authorization: `Bearer ${token}`,
  [AUTOBUILD_VERSION_HEADER]: client,
  [REMOTE_STORE_PROTOCOL_VERSION_HEADER]:
    line(client) === line(AUTOBUILD_VERSION)
      ? REMOTE_STORE_PROTOCOL_VERSION
      : RELEASE_LINE_PROTOCOLS[line(client)]!,
})
const supportedReleases = () =>
  RELEASED_CLIENTS.map((entry) => entry.version).filter(
    (version) => classifyClient(version, supportedClientRange()) === 'supported',
  )
const frozenCatalog = (client: string) =>
  RELEASED_REDUCER_VALUES[RELEASED_CLIENTS.find((entry) => entry.version === client)!.contract!]!

/** Make the store answer seeds as a newer server would: a bumped version and an
 * additive field no released contract knows. */
function newerSeeds(store: MemoryBuildStore, edit?: (value: Record<string, unknown>) => void) {
  const read = store.getStreamSeed.bind(store)
  store.getStreamSeed = async (...args) => {
    const seed = await read(...args)
    const value = { ...(seed.value as Record<string, unknown>), addedByNewerServer: 1 }
    edit?.(value)
    return { ...seed, version: seed.version + 1, value: value as never }
  }
}

test('released clients resume both stream kinds with a seed projected onto their frozen contract', async () => {
  const { store, cursors } = await seedFixture()
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
  const released = supportedReleases()
  // The regression this pins: 1.8.1 knows buildStreamSeed 55 and the server is newer.
  expect(released).toContain('1.8.1')
  expect(frozenCatalog('1.8.1').versions.buildStreamSeed).toBe(55)
  const current = await store.getStreamSeed(
    { kind: 'build', slug: 'mixed' },
    cursors['/builds/mixed'],
  )
  expect(current.version).toBeGreaterThan(55)
  for (const client of released)
    for (const service of [direct, composed])
      for (const [path, reducer] of STREAM_SEEDS) {
        const response = await service.fetch(
          new Request(`https://test${path}/stream-seed?cursor=${cursors[path]}`, {
            headers: releasedHeaders(client),
          }),
        )
        expect(response.status).toBe(200)
        const body = await response.json()
        expect(Object.keys(body).sort()).toEqual(['cursor', 'value', 'version'])
        expect(body.cursor).toBe(cursors[path])
        const catalog = frozenCatalog(client)
        expect(body.version).toBe(catalog.versions[reducer]!)
        expect(projectReducerValue(reducer, body.value, catalog)).toEqual({ value: body.value })
      }
})

test('a newer server seed is projected for both stream kinds', async () => {
  const { store, cursors } = await seedFixture()
  newerSeeds(store)
  const server = createStoreServer({ store, secret })
  for (const client of supportedReleases())
    for (const [path, reducer] of STREAM_SEEDS) {
      const response = await server.fetch(
        new Request(`https://test${path}/stream-seed?cursor=${cursors[path]}`, {
          headers: releasedHeaders(client),
        }),
      )
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.version).toBe(frozenCatalog(client).versions[reducer]!)
      expect(body.value).not.toHaveProperty('addedByNewerServer')
    }
})

test('stream seeds keep the typed incompatibility failures', async () => {
  const { store, cursors } = await seedFixture()
  const server = createStoreServer({ store, secret })
  for (const [path] of STREAM_SEEDS) {
    for (const outside of [
      { ...releasedHeaders('1.8.1'), [AUTOBUILD_VERSION_HEADER]: '1.1.0' },
      { ...releasedHeaders('1.8.1'), [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: '0' },
    ]) {
      const response = await server.fetch(
        new Request(`https://test${path}/stream-seed?cursor=${cursors[path]}`, {
          headers: outside,
        }),
      )
      expect(response.status).toBe(409)
    }
  }
  // A seed the frozen release cannot represent stays canonical, so the client refuses it.
  newerSeeds(store, (value) => {
    for (const key of Object.keys(value)) delete value[key]
  })
  const calls: string[] = []
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const request = new Request(url, init)
    calls.push(new URL(request.url).pathname)
    return server.fetch(request)
  }) as typeof fetch
  const client = new RemoteBuildStore({ url: 'https://test', token, fetchFn })
  for (const [path, reducer] of STREAM_SEEDS) {
    const response = await server.fetch(
      new Request(`https://test${path}/stream-seed?cursor=${cursors[path]}`, {
        headers: releasedHeaders('1.8.1'),
      }),
    )
    expect(response.status).toBe(200)
    expect((await response.json()).version).not.toBe(frozenCatalog('1.8.1').versions[reducer])
  }
  await expect(
    client.getStreamSeed({ kind: 'build', slug: 'mixed' }, cursors['/builds/mixed']),
  ).rejects.toBeInstanceOf(ReducerValueIncompatibilityError)
  await expect(
    client.getStreamSeed({ kind: 'repo', repo: 'repo' }, cursors['/repos/repo']),
  ).rejects.toBeInstanceOf(ReducerValueIncompatibilityError)
  expect(calls.filter((path) => !path.endsWith('/stream-seed'))).toEqual([])
})

test('a source catalog receives the canonical seed and the client sends its catalog headers', async () => {
  const { store, cursors } = await seedFixture()
  newerSeeds(store)
  const server = createStoreServer({ store, secret })
  const canonical = await store.getStreamSeed(
    { kind: 'build', slug: 'mixed' },
    cursors['/builds/mixed'],
  )
  const response = await server.fetch(
    new Request(`https://test/builds/mixed/stream-seed?cursor=${cursors['/builds/mixed']}`, {
      headers: {
        ...releasedHeaders('1.8.1'),
        [REDUCER_VALUE_PROJECTION_HEADER]: '1',
        [CATALOG_IDENTITY_HEADER]: 'f'.repeat(64),
      },
    }),
  )
  const body = await response.json()
  expect(body.version).toBe(canonical.version)
  expect(body.value).toHaveProperty('addedByNewerServer', 1)

  const sent: Headers[] = []
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const request = new Request(url, init)
    sent.push(request.headers)
    return new Response(JSON.stringify({ error: 'stop' }), { status: 500 })
  }) as typeof fetch
  const client = new RemoteBuildStore({ url: 'https://test', token, fetchFn })
  await expect(client.getStreamSeed({ kind: 'build', slug: 'mixed' }, 1)).rejects.toThrow()
  await expect(
    client.getReducerValue({ kind: 'build', slug: 'mixed' }, { reducer: 'buildStreamSeed' }),
  ).rejects.toThrow()
  // The seed request identifies its catalog exactly as a named value request does.
  expect(sent[0]!.get(REDUCER_VALUE_PROJECTION_HEADER)).toBe('1')
  expect(sent[0]!.get(CATALOG_IDENTITY_HEADER)).toMatch(/^[0-9a-f]{64}$/)
  expect(sent[0]!.get(CATALOG_IDENTITY_HEADER)).toBe(sent[1]!.get(CATALOG_IDENTITY_HEADER))
})

test('projecting a stream seed reads no more rows than serving it unprojected', async () => {
  const { store, cursors } = await seedFixture()
  let rows = 0
  for (const key of ['builds', 'repos']) {
    const states = Reflect.get(store, key) as Map<string, { events: unknown[] }>
    for (const state of states.values())
      for (const method of ['slice', 'filter'] as const) {
        const original = state.events[method].bind(state.events)
        Object.defineProperty(state.events, method, {
          value: (...args: unknown[]) => {
            const result = Reflect.apply(original, state.events, args) as unknown[]
            rows += result.length
            return result
          },
        })
      }
  }
  const server = createStoreServer({ store, secret })
  const read = async (path: string, client: Record<string, string>) => {
    rows = 0
    const response = await server.fetch(
      new Request(
        `https://test${path}/stream-seed?cursor=${cursors[path as keyof typeof cursors]}`,
        {
          headers: client,
        },
      ),
    )
    expect(response.status).toBe(200)
    return rows
  }
  for (const [path] of STREAM_SEEDS) {
    await read(path, headers)
    expect(await read(path, releasedHeaders('1.8.1'))).toBe(0)
    expect(await read(path, headers)).toBe(0)
  }
})

/** Answer as a server whose reducer identities carry one more ledger revision
 * than this client's: only server-side reads see the revised identity. */
function revisedServer(server: { fetch(request: Request): Promise<Response> }) {
  return async (request: Request) => {
    const restore: (() => void)[] = []
    for (const [, name] of STREAM_SEEDS) {
      const entry = REDUCERS[name]!.valueRead
      if ('excluded' in entry) throw new Error(`${name} is not a value reducer`)
      const create = entry.create
      entry.create = (args) => {
        const reducer = create(args)
        const ledger = { ...REDUCER_REVISIONS, [`${reducer.identity}/fold/serverskew`]: 'skew' }
        return {
          ...reducer,
          version: deriveReducerVersion({ identity: reducer.identity!, ledger }),
        }
      }
      restore.push(() => {
        entry.create = create
      })
    }
    try {
      return await server.fetch(request)
    } finally {
      for (const undo of restore) undo()
    }
  }
}

test('a server one ledger revision ahead keeps seeds typed, values canonical and releases frozen', async () => {
  const { store, cursors } = await seedFixture()
  const answer = revisedServer(createStoreServer({ store, secret }))
  const calls: string[] = []
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const request = new Request(url, init)
    calls.push(`${request.method} ${new URL(request.url).pathname}`)
    // A source checkout between releases: its catalog matches no published
    // contract. The release gate freezes this checkout's catalog before
    // publishing, so without this the client would be answered as a release.
    const unreleased = new Headers(request.headers)
    unreleased.set(CATALOG_IDENTITY_HEADER, `${unreleased.get(CATALOG_IDENTITY_HEADER)}+source`)
    return answer(new Request(request, { headers: unreleased }))
  }) as typeof fetch
  const client = new RemoteBuildStore({ url: 'https://test', token, fetchFn })
  const scopes = {
    '/builds/mixed': { kind: 'build', slug: 'mixed' },
    '/repos/repo': { kind: 'repo', repo: 'repo' },
  } as const
  for (const [path, reducer] of STREAM_SEEDS) {
    const scope = scopes[path]
    const local = REDUCERS[reducer]!.reducer.version
    // The older client's seed identity disagrees: a typed failure, never a replay.
    await expect(client.getStreamSeed(scope, cursors[path])).rejects.toBeInstanceOf(
      ReducerValueIncompatibilityError,
    )
    // A named value is the server's canonical answer at its own identity.
    const value = await client.getReducerValue(scope, { reducer })
    expect(value.version).toBe(local + 1)
    // Released clients still receive their frozen catalog version.
    for (const released of supportedReleases()) {
      const response = await answer(
        new Request(`https://test${path}/stream-seed?cursor=${cursors[path]}`, {
          headers: releasedHeaders(released),
        }),
      )
      expect(response.status).toBe(200)
      expect((await response.json()).version).toBe(frozenCatalog(released).versions[reducer]!)
    }
  }
  expect(calls.filter((call) => call.startsWith('GET') && call.endsWith('/events'))).toEqual([])
  expect(calls.every((call) => !call.includes('/events'))).toBe(true)
})

test('fresh clients read the canonical rollup in one request with zero backing event rows', async () => {
  const { rollupRemoteReadBudget } = await import('@defrex/autobuild/testing')
  const store = new MemoryBuildStore()
  for (const slug of ['rollup-a', 'rollup-b', 'rollup-c']) {
    await store.createBuild({ slug, repo: 'repo' })
    await store.append(slug, { actor: { kind: 'kernel' }, type: 'build.paused', payload: {} })
    await store.append(slug, { actor: { kind: 'kernel' }, type: 'build.resumed', payload: {} })
  }
  let rows = 0
  const states = Reflect.get(store, 'builds') as Map<string, { events: unknown[] }>
  for (const state of states.values())
    for (const method of ['slice', 'filter'] as const) {
      const original = state.events[method].bind(state.events)
      Object.defineProperty(state.events, method, {
        value: (...args: unknown[]) => {
          const result = Reflect.apply(original, state.events, args) as unknown[]
          rows += result.length
          return result
        },
      })
    }
  const server = createStoreServer({ store, secret })
  const requests: string[] = []
  const fetchFn = (async (url, init) => {
    const request = new Request(url, init)
    requests.push(new URL(request.url).pathname)
    return server.fetch(request)
  }) as typeof fetch
  await rollupRemoteReadBudget({
    backing: store,
    fresh: () => new RemoteBuildStore({ url: 'https://test', token, fetchFn }),
    repo: 'repo',
    reset: () => {
      rows = 0
    },
    eventRows: () => rows,
    requests: () => requests,
  })
})
