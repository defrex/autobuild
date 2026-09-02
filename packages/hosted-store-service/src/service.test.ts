import { describe, expect, test } from 'bun:test'
import { MemoryBuildStore } from '../../core/src/store/memory'
import {
  AUTOBUILD_VERSION,
  AUTOBUILD_VERSION_HEADER,
  RemoteBuildStore,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
  mintToken,
} from 'autobuild/remote-store'
import { HOSTED_ARTIFACT_MAX_BYTES } from './config'
import { createHostedStoreService } from './service'

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

const token = mintToken(env.AB_STORE_SECRET, {
  build: '*',
  session: '*',
  exp: now.getTime() + 60_000,
})
const machineHeaders = {
  authorization: `Bearer ${token}`,
  [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
  [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
}

function clientFor(service: ReturnType<typeof createHostedStoreService>, identity = {}) {
  const token = mintToken(env.AB_STORE_SECRET, {
    build: '*',
    session: '*',
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
    })
    expect(opens).toBe(0)

    const client = clientFor(service)
    await client.createBuild({ slug: 'demo', repo: 'acme/repo' })
    await client.listBuilds()
    expect(opens).toBe(1)
  })

  test('unknown and unsupported routes return 404 without opening persistence', async () => {
    let opens = 0
    const service = createHostedStoreService({
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

  test('retries lazy store initialization after a rejected attempt', async () => {
    let opens = 0
    const backing = new MemoryBuildStore({ clock })
    const service = createHostedStoreService({
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
    const service = createHostedStoreService({ env, clock, openStore: async () => backing })
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
