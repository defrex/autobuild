import { expect, test } from 'bun:test'
import { AccessError, type OrganizationStore } from '@defrex/autobuild-postgres-store/organizations'
import { HumanAccess } from './access'
import { createOrganizationHandler } from './organizations'

const repo = 'https://github.com/acme/project'
const env = {
  BETTER_AUTH_URL: 'https://app.example.com',
  BETTER_AUTH_SECRET: '0123456789abcdef0123456789abcdef',
  AB_POSTGRES_URL: 'postgres://test@localhost/db',
  AB_WEB_AUTH_PROVIDERS: 'github',
  AB_WEB_SUPER_USER_EMAILS: 'root@example.com',
  GITHUB_CLIENT_ID: 'client',
  GITHUB_CLIENT_SECRET: 'secret',
}
function fixture() {
  let email = 'owner@example.com',
    expired = false,
    failure = false
  const calls: unknown[] = []
  const access = new HumanAccess(
    async () => ({ admitted: async () => true }) as unknown as OrganizationStore,
    env,
  )
  const handler = createOrganizationHandler({
    access,
    getSession: async () => ({
      user: { email },
      session: { expiresAt: expired ? new Date(0) : new Date(Date.now() + 60000) },
    }),
    deletion: async () => ({
      preview: async (actor, repository) => {
        if (actor.email !== 'owner@example.com' && !actor.isSuperUser())
          throw new AccessError(403, 'organization owner required')
        calls.push(['preview', repository])
        return {
          repo: repository,
          token: '"generation"',
          builds: 3,
          tickets: 4,
          secrets: 2,
          subscriptionAccounts: 1,
        }
      },
      delete: async (actor, repository, token) => {
        if (actor.email !== 'owner@example.com' && !actor.isSuperUser())
          throw new AccessError(403, 'organization owner required')
        if (!token) throw new AccessError(428, 'deletion preview required')
        if (token !== '"generation"') throw new AccessError(412, 'project changed')
        if (failure) throw new Error('sensitive provider details')
        calls.push(['delete', repository, token])
      },
    }),
  })
  const request = (method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
    handler(
      new Request(
        `https://app.example.com/api/web/projects/deletion${method === 'GET' ? `?repo=${encodeURIComponent(repo)}` : ''}`,
        {
          method,
          headers: { origin: env.BETTER_AUTH_URL, 'content-type': 'application/json', ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      ),
    )
  return {
    request,
    calls,
    identity: (value: string) => {
      email = value
    },
    expire: () => {
      expired = true
    },
    fail: () => {
      failure = true
    },
  }
}
test('project deletion preview and exact generation-bound write contract', async () => {
  const f = fixture()
  const preview = await f.request()
  expect(preview.headers.get('cache-control')).toContain('no-store')
  expect(await preview.json()).toMatchObject({
    repo,
    builds: 3,
    tickets: 4,
    secrets: 2,
    subscriptionAccounts: 1,
  })
  expect((await f.request('DELETE', { repo })).status).toBe(428)
  expect((await f.request('DELETE', { repo }, { 'if-match': '"old"' })).status).toBe(412)
  expect(
    (await f.request('DELETE', { repo, token: 'generation' }, { 'if-match': '"generation"' }))
      .status,
  ).toBe(400)
  expect(
    (
      await f.request(
        'DELETE',
        { repo },
        { origin: 'https://evil.example', 'if-match': '"generation"' },
      )
    ).status,
  ).toBe(403)
  expect(f.calls).toHaveLength(1)
  expect(
    await (await f.request('DELETE', { repo }, { 'if-match': '"generation"' })).json(),
  ).toEqual({ deleted: true })
  expect(f.calls).toHaveLength(2)
})
test('members and outsiders receive no counts and expired sessions are refused', async () => {
  const f = fixture()
  for (const email of ['member@example.com', 'outsider@example.com']) {
    f.identity(email)
    expect((await f.request()).status).toBe(403)
    expect((await f.request('DELETE', { repo }, { 'if-match': '"generation"' })).status).toBe(403)
  }
  expect(f.calls).toEqual([])
  f.expire()
  expect((await f.request()).status).toBe(401)
})
test('provider failures are safe and retryable', async () => {
  const f = fixture()
  f.fail()
  const response = await f.request('DELETE', { repo }, { 'if-match': '"generation"' })
  expect(response.status).toBe(503)
  expect(await response.text()).not.toContain('sensitive')
  expect(f.calls).toEqual([])
})
