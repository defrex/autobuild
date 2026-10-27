import { testAccess } from './testing/access'
import { expect, test } from 'bun:test'
import { memoryAdapter } from 'better-auth/adapters/memory'
import type {
  ConnectionStore,
  ConnectionRecord,
} from '@defrex/autobuild-postgres-store/connections'
import { createConnectionHandler } from './connections'
import { createWebAuth } from './web/auth'

const origin = 'https://operator.example',
  email = 'owner@example.com'
const env = {
  BETTER_AUTH_SECRET: '0123456789abcdef0123456789abcdef0123456789',
  BETTER_AUTH_URL: origin,
  GITHUB_CLIENT_ID: 'client',
  GITHUB_CLIENT_SECRET: 'secret',
  AB_WEB_AUTH_PROVIDERS: 'github',
  AB_WEB_SUPER_USER_EMAILS: email,
  AB_POSTGRES_URL: 'postgres://unused',
}
const connection: ConnectionRecord = {
  id: 'a'.repeat(32),
  repo: 'https://github.com/example/project',
  credentialId: 'b'.repeat(32),
  code: '123456789A',
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  status: 'pending',
}
function fixture() {
  let decisions = 0,
    revoked = ''
  const store: ConnectionStore = {
    start: async () => ({ ...connection, capability: 'c'.repeat(64) }),
    lookup: async () => connection,
    approvalContext: async () => ({
      connection,
      assignment: 'fixed',
      organizations: [],
      assignedOrganization: null,
    }),
    poll: async () => connection,
    decide: async (_code, _actor, approve) => {
      decisions++
      return { ...connection, status: approve ? 'approved' : 'denied' }
    },
  }
  return {
    store,
    decisions: () => decisions,
    revoked: () => revoked,
    credentials: async () => ({
      revoke: async (repo: string, id: string) => {
        revoked = `${repo}:${id}`
      },
    }),
  }
}
function req(path: string, body: unknown = {}, headers: Record<string, string> = {}) {
  return new Request(`${origin}/connect/v1/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, ...headers },
    body: JSON.stringify(body),
  })
}
test('real Better Auth session gates approval; cookie, allowlist and CSRF are required', async () => {
  const db = {
    user: [],
    session: [],
    account: [],
    verification: [],
    jwks: [],
    oauthApplication: [],
    oauthAccessToken: [],
    oauthConsent: [],
  }
  const auth = createWebAuth(env, { access: testAccess(env), database: memoryAdapter(db) })
  const context = await auth.$context
  const user = await context.internalAdapter.createUser({
    email,
    name: 'Owner',
    emailVerified: true,
  })
  const session = await context.internalAdapter.createSession(user.id)
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.BETTER_AUTH_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = Buffer.from(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(session.token)),
  ).toString('base64')
  const cookie = `__Secure-better-auth.session_token=${encodeURIComponent(`${session.token}.${signature}`)}`
  const f = fixture()
  const handle = createConnectionHandler({
    store: async () => f.store,
    credentials: f.credentials,
    machineAuth: () => ({ authenticate: async () => ({ kind: 'admin', user: email }) }),
    baseURL: origin,
    browser: {
      access: testAccess(env),
      getSession: (headers) => auth.api.getSession({ headers }),
    },
  })
  expect(
    (await handle(req('browser/decide', { code: connection.code, approve: true }))).status,
  ).toBe(401)
  expect(
    (
      await handle(
        req(
          'browser/decide',
          { code: connection.code, approve: true },
          { cookie, origin: 'https://evil.example' },
        ),
      )
    ).status,
  ).toBe(403)
  expect(
    (
      await handle(
        req(
          'browser/decide',
          { code: connection.code, approve: true },
          { cookie, 'content-type': 'text/plain' },
        ),
      )
    ).status,
  ).toBe(400)
  const lookup = await handle(req('browser/lookup', { code: connection.code }, { cookie }))
  expect(lookup.status).toBe(200)
  expect(await lookup.json()).toEqual({
    connection,
    assignment: 'fixed',
    organizations: [],
    assignedOrganization: null,
  })
  const response = await handle(
    req(
      'browser/decide',
      { code: connection.code, approve: true, repo: 'other', digest: 'evil' },
      { cookie },
    ),
  )
  expect(response.status).toBe(200)
  const body = await response.text()
  expect(body).toContain(connection.repo)
  for (const secret of ['digest', 'capability', 'abp_1_']) expect(body).not.toContain(secret)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(f.decisions()).toBe(1)
})
test('machine self-service refuses admin/internal principals and revokes only the authenticated id', async () => {
  const f = fixture()
  const options = { store: async () => f.store, credentials: f.credentials, baseURL: origin }
  for (const kind of ['admin', 'internal'] as const) {
    const handle = createConnectionHandler({
      ...options,
      machineAuth: () => ({
        authenticate: async () => ({ kind, repo: connection.repo, user: email }),
      }),
    })
    expect((await handle(req('revoke'))).status).toBe(403)
  }
  const handle = createConnectionHandler({
    ...options,
    machineAuth: () => ({
      authenticate: async () => ({
        kind: 'project',
        repo: connection.repo,
        user: email,
        credential: {
          id: connection.credentialId,
          repo: connection.repo,
          createdAt: new Date().toISOString(),
          createdBy: email,
          lastUsedAt: null,
          revokedAt: null,
          expiresAt: null,
          purpose: 'project-owner',
        },
      }),
    }),
  })
  expect((await handle(req('revoke', { repo: 'other', credentialId: 'other' }))).status).toBe(200)
  expect(f.revoked()).toBe(`${connection.repo}:${connection.credentialId}`)
  expect((await handle(new Request(`${origin}/connect/v1/browser/decide`))).status).toBe(405)
})
