import { describe, expect, test } from 'bun:test'
import { DISPATCHER, KERNEL } from '../events/envelope'
import { MemoryBuildStore } from '../store/memory'
import { RemoteBuildStore } from '../store/remote/client'
import { createStoreServer } from '../store/remote/server'
import { mintToken, tokenResource, verifyToken } from '../store/remote/token'
import { OperatorApiClient, OperatorApiError } from './client'
import { createOperatorServer } from './server'

const now = new Date('2026-09-02T00:00:00.000Z')
const clock = () => now
const secret = 'operator-test-secret'
const repo = 'acme/widgets'

function fetchFor(server: { fetch(req: Request): Promise<Response> }): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    server.fetch(
      input instanceof Request ? new Request(input, init) : new Request(String(input), init),
    )) as typeof fetch
}

async function runningStore(): Promise<MemoryBuildStore> {
  const store = new MemoryBuildStore({ clock })
  await store.createBuild({ slug: 'demo', repo, ticket: { source: 'linear', id: 'AUT-1' } })
  await store.append('demo', {
    actor: DISPATCHER,
    type: 'build.created',
    payload: {
      ticket: { source: 'linear', id: 'AUT-1' },
      repo,
      baseBranch: 'main',
    },
  })
  await store.append('demo', {
    actor: KERNEL,
    type: 'runner.attached',
    payload: { instance: 'runner-1', host: 'host-1' },
  })
  return store
}

describe('operator HTTP API', () => {
  test('operator token claims are strict and identify a distinct resource', () => {
    const valid = mintToken(secret, {
      operator: { user: 'Ada' },
      exp: now.getTime() + 60_000,
    })
    const scope = verifyToken(secret, valid, now)
    expect(scope).not.toBeNull()
    expect(tokenResource(scope!)).toEqual({ kind: 'operator', id: 'Ada' })
    const blank = mintToken(secret, {
      operator: { user: '   ' },
      exp: now.getTime() + 60_000,
    })
    expect(verifyToken(secret, blank, now)).toBeNull()
  })

  test('requires operator scope and attributes controls to its signed user', async () => {
    const store = await runningStore()
    const server = createOperatorServer({ store, secret, clock })
    const operatorToken = mintToken(secret, {
      operator: { user: 'Ada Lovelace' },
      exp: now.getTime() + 60_000,
    })
    const client = new OperatorApiClient({
      url: 'http://operator.test',
      token: operatorToken,
      fetchFn: fetchFor(server),
    })

    expect((await client.listBuilds(repo, 'all')).map((build) => build.slug)).toEqual(['demo'])
    await client.controlBuild(repo, 'demo', { action: 'pause' })
    expect((await store.getEvents('demo')).at(-1)).toMatchObject({
      actor: { kind: 'human', user: 'Ada Lovelace' },
      type: 'build.pause-requested',
      payload: {},
    })

    const admin = new OperatorApiClient({
      url: 'http://operator.test',
      token: mintToken(secret, { build: '*', session: '*', exp: now.getTime() + 60_000 }),
      fetchFn: fetchFor(server),
    })
    const error = await admin.listBuilds(repo).catch((caught) => caught)
    expect(error).toBeInstanceOf(OperatorApiError)
    expect(error).toMatchObject({ status: 403, kind: 'auth' })
  })

  test('operator scope cannot use raw store authority and downloads binary artifacts', async () => {
    const store = await runningStore()
    const token = mintToken(secret, {
      operator: { user: 'Grace' },
      exp: now.getTime() + 60_000,
    })
    const storeServer = createStoreServer({ store, secret, clock })
    const raw = new RemoteBuildStore({
      url: 'http://store.test',
      token,
      fetchFn: fetchFor(storeServer),
    })
    await expect(raw.getBuild('demo')).rejects.toThrow('may not access build "demo"')

    await store.putArtifact('demo', { kind: 'notes/report', content: new Uint8Array([0, 1, 255]) })
    const operatorServer = createOperatorServer({ store, secret, clock })
    const client = new OperatorApiClient({
      url: 'http://operator.test',
      token,
      fetchFn: fetchFor(operatorServer),
    })
    const artifact = await client.downloadArtifact(repo, 'demo', 'notes/report', 0)
    expect([...artifact.content]).toEqual([0, 1, 255])
    expect(artifact).toMatchObject({ kind: 'notes/report', revision: 0 })
  })

  test('version validation precedes authentication and terminal refusal text survives', async () => {
    const store = await runningStore()
    await store.append('demo', {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: 'merged' },
    })
    const server = createOperatorServer({ store, secret, clock })
    const skew = await server.fetch(
      new Request(`http://operator.test/operator/v1/repos/${encodeURIComponent(repo)}/builds`),
    )
    expect(skew.status).toBe(409)
    expect(await skew.json()).toMatchObject({ kind: 'conflict' })

    const client = new OperatorApiClient({
      url: 'http://operator.test',
      token: mintToken(secret, { operator: { user: 'Ada' }, exp: now.getTime() + 60_000 }),
      fetchFn: fetchFor(server),
    })
    const error = await client
      .controlBuild(repo, 'demo', { action: 'pause' })
      .catch((caught) => caught)
    expect(error).toMatchObject({ status: 409, kind: 'refusal', code: 'inactive' })
    expect((error as Error).message).toBe(
      'build "demo" is not active (status: done); build controls require running, paused, or blocked',
    )
  })
})
