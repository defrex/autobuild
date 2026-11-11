import { expect, test } from 'bun:test'
import {
  AUTOBUILD_VERSION,
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
  creationBuildSlug,
  mintToken,
} from '@defrex/autobuild/remote-store'
import { MemoryBuildStore, type NewBuildInput } from '@defrex/autobuild/plugin-sdk'
import { testCredentials } from './testing/credentials'
import { testProjects } from './testing/projects'
import { createStoreServer } from './remote-store-server'

const A = 'https://github.com/acme/a'
const DISPATCHER = { kind: 'dispatcher' }
const request = (path: string, token: string, body?: unknown) =>
  new Request(`http://store${path}`, {
    headers: {
      [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
      [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
      authorization: `Bearer ${token}`,
    },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  })
const created = (kind?: 'node') => ({
  actor: DISPATCHER,
  type: 'build.created',
  payload: {
    repo: A,
    ticket: { source: 'file', id: 'T-1' },
    baseBranch: 'main',
    ...(kind === undefined ? {} : { kind }),
  },
})

async function harness(backing = new MemoryBuildStore()) {
  const { store: credentials, auth } = testCredentials(testProjects([A]))
  const { token } = await credentials.issue(A, 'owner')
  const server = createStoreServer({ store: backing, auth })
  const post = (body: Record<string, unknown>) =>
    server.fetch(request('/builds', token, { repo: A, ...body }))
  const create = async (body: Record<string, unknown>) => {
    const response = await post(body)
    expect(response.status).toBe(201)
    return (await response.json()) as { slug: string; branch: string }
  }
  const rejected = async (body: Record<string, unknown>) => {
    const response = await post(body)
    expect(response.status).toBe(400)
    expect(((await response.json()) as { kind: string }).kind).toBe('validation')
    expect(await backing.listBuilds()).toEqual([])
  }
  return { backing, server, token, create, rejected }
}

const SERVER_SLUG = (base: string) => new RegExp(`^${base}-[a-f0-9]{24}$`)

test('project leaf creation allocates a server slug on ab/', async () => {
  const { create } = await harness()
  const withClaims = await create({ slug: 'fix-login', branch: 'ab/fix-login', created: created() })
  expect(withClaims.slug).toMatch(SERVER_SLUG('fix-login'))
  expect(withClaims.branch).toBe(`ab/${withClaims.slug}`)
  const bare = await create({ slug: 'fix-login' })
  expect(bare.slug).toMatch(SERVER_SLUG('fix-login'))
  expect(bare.branch).toBe(`ab/${bare.slug}`)
})

test('project node creation keeps the ab-node/ namespace after slug rewriting', async () => {
  const { backing, server, token, create } = await harness()
  const node = await create({
    slug: 'integration',
    branch: 'ab-node/integration',
    created: created('node'),
  })
  expect(node.slug).toMatch(SERVER_SLUG('integration'))
  expect(node.branch).toBe(`ab-node/${node.slug}`)
  const read = await server.fetch(request(`/builds/${node.slug}`, token))
  expect(((await read.json()) as { branch: string }).branch).toBe(node.branch)
  const [first] = await backing.getEvents(node.slug)
  expect(first).toMatchObject({ seq: 1, type: 'build.created', payload: { kind: 'node' } })

  const byKind = await create({ slug: 'by-kind', created: created('node') })
  expect(byKind.branch).toBe(`ab-node/${byKind.slug}`)
  const byBranch = await create({ slug: 'by-branch', branch: 'ab-node/by-branch' })
  expect(byBranch.branch).toBe(`ab-node/${byBranch.slug}`)
})

test('a branch that conflicts with the build.created kind is refused before any write', async () => {
  const { rejected } = await harness()
  await rejected({ slug: 'x', branch: 'ab/x', created: created('node') })
  await rejected({ slug: 'x', branch: 'ab-node/x', created: created() })
})

test('client branches outside the two server namespaces for the requested slug are refused', async () => {
  const { rejected } = await harness()
  for (const branch of ['refs/heads/main', 'main', 'ab/other', 'ab-node/x/../y', 'feature/x'])
    await rejected({ slug: 'x', branch })
})

test('the slug base must be a kebab build slug after normalization', async () => {
  const { create, rejected } = await harness()
  for (const slug of ['Fix_Login', 'a/b', '-x']) await rejected({ slug })
  const long = `${'a'.repeat(59)}-${'b'.repeat(10)}`
  const record = await create({ slug: long, created: created('node') })
  expect(record.slug).toMatch(SERVER_SLUG('a'.repeat(59)))
  expect(record.branch).toBe(`ab-node/${record.slug}`)
})

test('retries keep the requested namespace on every allocation', async () => {
  class CollidingOnce extends MemoryBuildStore {
    calls = 0
    override async createBuild(input: NewBuildInput) {
      this.calls += 1
      if (this.calls === 1) throw new Error(`build "${input.slug}" already exists`)
      return super.createBuild(input)
    }
  }
  const backing = new CollidingOnce()
  const { create } = await harness(backing)
  const body = { slug: 'integration', branch: 'ab-node/integration', created: created('node') }
  const first = await create(body)
  expect(backing.calls).toBe(2)
  expect(first.branch).toBe(`ab-node/${first.slug}`)
  const second = await create(body)
  expect(second.slug).not.toBe(first.slug)
  expect(second.branch).toBe(`ab-node/${second.slug}`)
})

test('owner-admin exact-slug creation stores the client branch verbatim', async () => {
  const { server } = await harness()
  const ownerAdmin = mintToken('secret', {
    version: 1,
    ownerAdmin: { user: 'owner' },
    exp: Date.now() + 60000,
  })
  const response = await server.fetch(
    request('/builds', ownerAdmin, { slug: 'n', repo: A, branch: 'ab-node/n' }),
  )
  expect(response.status).toBe(201)
  expect(await response.json()).toMatchObject({ slug: 'n', branch: 'ab-node/n' })
})

test('keyed project creation lands once at the derived slug in the requested namespace', async () => {
  const { backing, server, token, create } = await harness()
  const leaf = await create({ slug: 'fix-login', created: created(), creationKey: 'prep_1' })
  expect(leaf).toMatchObject({
    slug: creationBuildSlug(A, 'fix-login', 'prep_1'),
    branch: `ab/${creationBuildSlug(A, 'fix-login', 'prep_1')}`,
  })
  expect(leaf).not.toHaveProperty('creationKey')
  const node = await create({
    slug: 'integration',
    branch: 'ab-node/integration',
    created: created('node'),
    creationKey: 'prep_2',
  })
  expect(node.branch).toBe(`ab-node/${creationBuildSlug(A, 'integration', 'prep_2')}`)

  const repeat = await server.fetch(
    request('/builds', token, {
      repo: A,
      slug: 'fix-login',
      created: created(),
      creationKey: 'prep_1',
    }),
  )
  expect(repeat.status).toBe(409)
  expect(((await repeat.json()) as { kind: string }).kind).toBe('conflict')
  expect(await backing.listBuilds()).toHaveLength(2)

  const other = await create({ slug: 'fix-login', created: created(), creationKey: 'prep_3' })
  expect(other.slug).toBe(creationBuildSlug(A, 'fix-login', 'prep_3'))
  expect(await backing.listBuilds()).toHaveLength(3)
})

test('an invalid creation key is refused before any write', async () => {
  const { rejected } = await harness()
  for (const creationKey of ['', 'has space', 'a'.repeat(129)])
    await rejected({ slug: 'x', creationKey })
})

test('owner-admin exact-slug creation ignores a creation key', async () => {
  const { server, backing } = await harness()
  const ownerAdmin = mintToken('secret', {
    version: 1,
    ownerAdmin: { user: 'owner' },
    exp: Date.now() + 60000,
  })
  const response = await server.fetch(
    request('/builds', ownerAdmin, { slug: 'n', repo: A, creationKey: 'prep_1' }),
  )
  expect(response.status).toBe(201)
  expect(await response.json()).toMatchObject({ slug: 'n' })
  expect((await backing.listBuilds()).map((record) => record.slug)).toEqual(['n'])
})

test('health advertises keyed build creation', async () => {
  const { server, token } = await harness()
  const response = await server.fetch(request('/health', token))
  expect(((await response.json()) as { capabilities?: string[] }).capabilities).toContain(
    'build-creation-key-v1',
  )
})
