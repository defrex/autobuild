import { testAccess } from '../testing/access'
import type { HumanAccess } from './access'
import { MemoryBuildStore, parseConfig, DISPATCHER } from '@defrex/autobuild/testing'
import type { BuildStore } from '@defrex/autobuild/store-adapter'
import type { ProjectSecretMetadata } from '@defrex/autobuild/project-secrets'
import { expect, test } from 'bun:test'
import { createWebProjectSecretsHandler } from './project-secrets'
import { testProjects } from '../testing/projects'
import { StaticSecretConflictError } from '@defrex/autobuild-postgres-store/project-secrets'
import { ProjectSecretError } from '@defrex/autobuild/project-secrets'
const repo = 'https://github.com/example/project'
const baseURL = 'https://operator.example'
const sentinel = 'never-return-this-secret'
function fixture(
  buildStore?: BuildStore,
  metadata: ProjectSecretMetadata[] = [],
  accessOverride?: HumanAccess,
) {
  let allowed = true,
    expired = false,
    reads = 0
  const writes: unknown[][] = []
  let failure: Error | undefined
  const access = {
    principal: async (email: string) => ({ email, isSuperUser: () => false }),
    canAccess: async () => allowed,
  }
  const handler = createWebProjectSecretsHandler({
    baseURL,
    access: accessOverride ?? access,
    projects: testProjects([repo]),
    getSession: async () => ({
      user: { email: ' Member@Example.com ' },
      session: { expiresAt: expired ? '2000-01-01' : '2099-01-01' },
    }),
    secrets: async () => {
      reads++
      return {
        list: async () => metadata,
        set: async () => {
          throw Error('unsafe fallback')
        },
        setStaticOnly: async (...args) => {
          if (failure) throw failure
          writes.push(args)
        },
        remove: async (...args) => {
          writes.push(args)
        },
      }
    },
    store: async () => {
      if (buildStore) return buildStore
      throw Error('broken config')
    },
  })
  function request(operation = '', body?: unknown, headers: Record<string, string> = {}) {
    return handler(
      new Request(
        `${baseURL}/api/web/repos/${encodeURIComponent(repo)}/secrets${operation && `/${operation}`}`,
        {
          method: body === undefined ? 'GET' : 'POST',
          headers: { origin: baseURL, 'content-type': 'application/json', ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      ),
    )
  }
  return {
    request,
    writes,
    get reads() {
      return reads
    },
    deny() {
      allowed = false
    },
    expire() {
      expired = true
    },
    fail(error: Error) {
      failure = error
    },
  }
}
test('member writes use normalized session actor; metadata survives unavailable configuration', async () => {
  const f = fixture()
  const response = await f.request('set', { name: 'TOKEN', value: sentinel })
  expect(response.status).toBe(200)
  expect(await response.text()).not.toContain(sentinel)
  expect(f.writes).toEqual([[repo, 'TOKEN', sentinel, 'member@example.com']])
  const read = await f.request()
  expect(await read.json()).toEqual({ secrets: [], configuration: 'unavailable', accounts: [] })
  expect(read.headers.get('cache-control')).toBe('private, no-store')
})
test('denies expired and revoked sessions before opening secrets storage', async () => {
  for (const deny of ['expire', 'deny'] as const) {
    const f = fixture()
    f[deny]()
    expect((await f.request('set', { name: 'TOKEN', value: sentinel })).status).toBe(
      deny === 'expire' ? 401 : 404,
    )
    expect(f.reads).toBe(0)
    expect(f.writes).toEqual([])
  }
})
test('strict bounded browser bodies, origin, names and values', async () => {
  for (const body of [
    { name: 'AB_TOKEN', value: sentinel },
    { name: 'TOKEN', value: '' },
    { name: 'TOKEN', value: '\0' },
    { name: 'TOKEN', value: 'a'.repeat(65537) },
    { name: 'TOKEN', value: sentinel, actor: 'attacker' },
    null,
  ]) {
    const f = fixture()
    const r = await f.request('set', body)
    expect(r.status).toBe(400)
    expect(f.writes).toEqual([])
    expect(await r.text()).not.toContain(sentinel)
  }
  for (const headers of [
    { origin: 'https://evil.example' },
    { 'content-type': 'text/plain' },
  ] as Record<string, string>[]) {
    const f = fixture()
    expect(
      (await f.request('set', { name: 'TOKEN', value: sentinel }, headers)).status,
    ).toBeGreaterThanOrEqual(400)
    expect(f.reads).toBe(0)
  }
  expect(
    (await fixture().request('set', { name: 'TOKEN', value: 'x'.repeat(400001) })).status,
  ).toBe(413)
})
test('safe conflicts, encryption refusal, and arbitrary exceptions never echo submitted value', async () => {
  for (const error of [
    new StaticSecretConflictError(),
    new ProjectSecretError('key-unavailable'),
    new Error(sentinel),
  ]) {
    const f = fixture()
    f.fail(error)
    const r = await f.request('set', { name: 'TOKEN', value: sentinel })
    expect(r.status).toBe(error instanceof StaticSecretConflictError ? 409 : 503)
    const text = await r.text()
    expect(text).not.toContain(sentinel)
    if (error instanceof ProjectSecretError) expect(text).toContain('administrator')
  }
})

test('durable configuration projects only account slots and readiness; no dispatcher is distinct', async () => {
  const store = new MemoryBuildStore()
  await store.ensureRepo(repo)
  expect((await (await fixture(store).request()).json()).configuration).toBe('no-dispatcher')
  const config = parseConfig(`[tickets]
source = "file"
readyState = "ready"
[accounts.claude]
kind = "claude-subscription"
credentialEnv = "TOKEN"
[accounts.missing]
kind = "chatgpt-subscription"
credentialEnv = "OTHER_TOKEN"`)
  const { verify, finalize, ...root } = config
  const artifact = await store.putRepoArtifact(repo, {
    kind: 'dispatcher-effective-config',
    content: JSON.stringify({
      ...root,
      verify: { steps: verify.steps, ...verify.stepConfigs },
      finalize: { steps: finalize.steps, ...finalize.stepConfigs },
    }),
  })
  await store.appendRepo(repo, {
    actor: DISPATCHER,
    type: 'dispatcher.run-started',
    payload: {
      run: 'run',
      pid: 42,
      effectiveConfig: { kind: artifact.kind, rev: artifact.revision },
      roleWarnings: [],
    },
  })
  for (const status of ['ready', 'refreshing', 'failed'] as const) {
    const secret = {
      name: 'TOKEN',
      kind: 'static',
      owner: 'member@example.com',
      setAt: '2026-10-27T00:00:00Z',
      fingerprint: '0123456789abcdef',
      lastSuppliedAt: null,
      failureCode: null,
      status,
    }
    const data = await (await fixture(store, [secret]).request()).json()
    expect(data.configuration).toBe('available')
    expect(data.accounts).toEqual([
      {
        name: 'claude',
        kind: 'claude-subscription',
        credentialEnv: 'TOKEN',
        ready: status === 'ready',
      },
      { name: 'missing', kind: 'chatgpt-subscription', credentialEnv: 'OTHER_TOKEN', ready: false },
    ])
    expect(Object.keys(data).sort()).toEqual(['accounts', 'configuration', 'secrets'])
    expect(JSON.stringify(data)).not.toContain('roles')
  }
  const poison = {
    name: 'TOKEN',
    kind: 'static',
    owner: 'member',
    setAt: '2026-10-27T00:00:00Z',
    fingerprint: '0123456789abcdef',
    lastSuppliedAt: null,
    failureCode: null,
    status: 'ready',
    value: sentinel,
  } as ProjectSecretMetadata
  const response = await fixture(store, [poison]).request()
  expect(response.status).toBe(503)
  expect(await response.text()).not.toContain(sentinel)
})

test('a real HumanAccess super-user principal can write without organization admission', async () => {
  const access = testAccess(
    {
      BETTER_AUTH_SECRET: '0123456789abcdef0123456789abcdef',
      BETTER_AUTH_URL: baseURL,
      GITHUB_CLIENT_ID: 'client',
      GITHUB_CLIENT_SECRET: 'secret',
      AB_WEB_AUTH_PROVIDERS: 'github',
      AB_WEB_SUPER_USER_EMAILS: 'member@example.com',
      AB_POSTGRES_URL: 'postgres://database-canary',
    },
    testProjects([repo]),
  )
  const f = fixture(undefined, [], access)
  expect((await f.request('set', { name: 'TOKEN', value: sentinel })).status).toBe(200)
  expect(f.writes[0]?.[3]).toBe('member@example.com')
})
