import { describe, expect, test } from 'bun:test'
import { MemoryBuildStore } from '../../core/src/store/memory'
import { OperatorApiClient } from 'autobuild/operator-api'
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

  test('composes the operator API through the same lazy store', async () => {
    let opens = 0
    const backing = new MemoryBuildStore({ clock })
    const service = createHostedStoreService({
      env,
      clock,
      openStore: async () => {
        opens += 1
        return backing
      },
    })
    const token = mintToken(env.AB_STORE_SECRET, {
      operator: { user: 'Hosted Operator' },
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
      intake: true,
      paused: false,
      defaultAutoMerge: false,
    })
    expect(opens).toBe(1)
    await client.setIntake('acme/repo', false)
    expect((await backing.getRepoEvents('acme/repo')).at(-1)).toMatchObject({
      actor: { kind: 'human', user: 'Hosted Operator' },
      type: 'dispatcher.intake-set',
      payload: { enabled: false },
    })
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

  test('reports package skew before authentication and hides opener failures', async () => {
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

    const failed = createHostedStoreService({
      env,
      openStore: async () => {
        throw new Error('postgres://user:password@secret-host/db')
      },
    })
    const response = await failed.fetch(
      new Request('http://hosted.test/builds', {
        headers: {
          [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
          [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
        },
      }),
    )
    expect(await response.text()).not.toContain('password')
  })
})
