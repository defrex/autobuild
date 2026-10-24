import { testAccess } from '../testing/access'
import { describe, expect, test } from 'bun:test'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { createWebAuth, admittedUser } from './auth'
import { CLIENT_NAME_MAX_LENGTH } from './client-name-policy'

describe('GitHub identity admission', () => {
  test('accepts and normalizes an admitted current provider email', async () => {
    expect(
      await admittedUser(testAccess(testEnv), { email: ' Ada@Example.COM ', name: 'Ada' }),
    ).toEqual({
      data: { email: 'ada@example.com', name: 'Ada' },
    })
  })

  test('refuses an identity before user or session creation', async () => {
    expect(await admittedUser(testAccess(testEnv), { email: 'mallory@example.com' })).toBe(false)
  })
})

// The env shape createWebAuth's parser requires (mirrors mcp.test.ts's
// baseEnv, including the blob-backend dummies the hosted service's parser
// insists on even when the opener is injected).
const ORIGIN = 'https://operator.example'
const testEnv: Record<string, string> = {
  BETTER_AUTH_SECRET: '0123456789abcdef0123456789abcdef0123456789',
  BETTER_AUTH_URL: ORIGIN,
  GITHUB_CLIENT_ID: 'github-client-canary',
  GITHUB_CLIENT_SECRET: 'github-secret-canary',
  AB_WEB_AUTH_PROVIDERS: 'github',
  AB_WEB_SUPER_USER_EMAILS: 'ada@example.com',
  AB_WEB_REPOSITORIES: 'https://github.com/owner/repo',
  AB_POSTGRES_URL: 'postgres://database-canary',
  AB_STORE_SECRET: 'store-secret-canary',
  AB_BLOB_BACKEND: 's3',
  AB_S3_BUCKET: 'unused',
  AB_S3_REGION: 'us-east-1',
  AB_S3_ACCESS_KEY_ID: 'unused',
  AB_S3_SECRET_ACCESS_KEY: 'unused',
}

describe('advertised jwks_uri resolves (AUT-369)', () => {
  // The real instance on the memory adapter — the plugin configuration under
  // test is createWebAuth's, not a mock.
  const auth = createWebAuth(testEnv, {
    access: testAccess(testEnv),
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
      jwks: [],
      oauthApplication: [],
      oauthAccessToken: [],
      oauthConsent: [],
    }),
  })

  test('the authorization-server metadata advertises the JWKS endpoint that exists', async () => {
    // This runs against the unpatched published dependency through our HTTP adapter.
    const response = await auth.handler(
      new Request(`${ORIGIN}/.well-known/oauth-authorization-server`),
    )
    expect(response.status).toBe(200)
    const metadata = (await response.json()) as { jwks_uri: string }
    expect(metadata.jwks_uri).toBe(`${ORIGIN}/api/auth/jwks`)
  })

  test('the protected-resource metadata advertises the same jwks_uri', async () => {
    const response = await auth.handler(
      new Request(`${ORIGIN}/.well-known/oauth-protected-resource`),
    )
    expect(response.status).toBe(200)
    const metadata = (await response.json()) as { jwks_uri: string }
    expect(metadata.jwks_uri).toBe(`${ORIGIN}/api/auth/jwks`)
  })

  test('the advertised jwks_uri serves the server JWKS', async () => {
    const response = await auth.handler(new Request(`${ORIGIN}/api/auth/jwks`))
    expect(response.status).toBe(200)
    const jwks = (await response.json()) as { keys: unknown[] }
    expect(Array.isArray(jwks.keys)).toBe(true)
    expect(jwks.keys.length).toBeGreaterThan(0)
  })
})

describe('DCR client-name policy (AUT-399)', () => {
  // The real instance on the memory adapter: the hook under test is the
  // file-local plugin in createWebAuth, not a mock, and the endpoint is the
  // pinned 1.4.18 MCP plugin's own registerMcpClient at /mcp/register —
  // mounted under the app's /api/auth prefix.
  const db: Record<string, Record<string, unknown>[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
    jwks: [],
    oauthApplication: [],
    oauthAccessToken: [],
    oauthConsent: [],
  }
  const auth = createWebAuth(testEnv, { access: testAccess(testEnv), database: memoryAdapter(db) })

  async function registerClient(body: Record<string, unknown>): Promise<Response> {
    return await auth.handler(
      new Request(`${ORIGIN}/api/auth/mcp/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          ...body,
        }),
      }),
    )
  }

  test('a conforming client_name registers and is persisted', async () => {
    const response = await registerClient({ client_name: 'Acme MCP Console' })
    expect(response.status).toBe(201)
    // RFC 7591 registration response echoes the metadata fields.
    const registered = (await response.json()) as { client_name?: string }
    expect(registered.client_name).toBe('Acme MCP Console')
    expect(db.oauthApplication?.at(-1)?.name).toBe('Acme MCP Console')
  })

  test('a control character in client_name is rejected with the RFC 7591 error shape', async () => {
    const response = await registerClient({ client_name: 'acme\u0000console' })
    expect(response.status).toBe(400)
    const body = (await response.json()) as {
      error?: string
      error_description?: string
    }
    expect(body.error).toBe('invalid_client_metadata')
    expect(body.error_description).toContain('control or invisible formatting')
  })

  test('an oversized client_name is rejected', async () => {
    const response = await registerClient({ client_name: 'a'.repeat(CLIENT_NAME_MAX_LENGTH + 1) })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error?: string }
    expect(body.error).toBe('invalid_client_metadata')
  })

  test('a whitespace-only client_name is rejected', async () => {
    const response = await registerClient({ client_name: '   ' })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error?: string }
    expect(body.error).toBe('invalid_client_metadata')
  })

  test('registration without client_name stays legal (the unnamed-client path)', async () => {
    const response = await registerClient({})
    expect(response.status).toBe(201)
    const registered = (await response.json()) as { client_name?: string }
    expect(registered.client_name).toBeUndefined()
  })
})

describe('discovery HTTP adapter', () => {
  test('preserves request body, query, headers and ordinary request identity', async () => {
    const { authHTTPHandler } = await import('./auth')
    const ordinary = new Request(`${ORIGIN}/api/auth/mcp/register`, {
      method: 'POST',
      body: 'body',
    })
    let received: Request | undefined
    const handler = authHTTPHandler(async (request) => {
      received = request
      return new Response('unchanged', { status: 400 })
    }, `${ORIGIN}/api/auth/jwks`)
    await handler(ordinary)
    expect(received).toBe(ordinary)
    const request = new Request(`${ORIGIN}/.well-known/oauth-protected-resource?q=1`, {
      method: 'POST',
      headers: { 'x-canary': 'yes' },
      body: 'payload',
    })
    await handler(request)
    expect(received?.url).toBe(`${ORIGIN}/api/auth/.well-known/oauth-protected-resource?q=1`)
    expect(received?.method).toBe('POST')
    expect(received?.headers.get('x-canary')).toBe('yes')
    expect(await received?.text()).toBe('payload')
    expect(await request.text()).toBe('payload')
    const near = new Request(`${ORIGIN}/.well-known/oauth-protected-resource/extra`)
    await handler(near)
    expect(received).toBe(near)
  })

  test('corrects only successful provider metadata, preserves headers and propagates failures', async () => {
    const { authHTTPHandler } = await import('./auth')
    const request = new Request(`${ORIGIN}/.well-known/oauth-authorization-server`)
    const handler = authHTTPHandler(
      async () =>
        new Response('{"issuer":"issuer","jwks_uri":"bad"}', {
          status: 200,
          headers: { 'content-type': 'application/json', 'content-length': '1', 'x-canary': 'yes' },
        }),
      'good',
    )
    const response = await handler(request)
    expect(response.headers.get('content-length')).toBeNull()
    expect(response.headers.get('x-canary')).toBe('yes')
    expect(await response.json()).toEqual({ issuer: 'issuer', jwks_uri: 'good' })
    const failed = new Response('failure', { status: 500 })
    expect(await authHTTPHandler(async () => failed, 'good')(request)).toBe(failed)
    await expect(
      authHTTPHandler(async () => {
        throw new Error('upstream')
      }, 'good')(request),
    ).rejects.toThrow('upstream')
  })
})

describe('organization admission and raw provider boundary', () => {
  test('raw organization APIs never reach the provider router', async () => {
    const { authHTTPHandler } = await import('./auth')
    let called = 0
    const handler = authHTTPHandler(async () => {
      called++
      return Response.json({})
    }, `${ORIGIN}/api/auth/jwks`)
    for (const path of [
      'organization/create',
      'organization/add-member',
      'organization/invite-member',
      '%6frganization/create',
      'organization%2fcreate',
      '%256frganization/create',
      'x/../organization/create',
    ]) {
      expect(
        (await handler(new Request(`${ORIGIN}/api/auth/${path}`, { method: 'POST' }))).status,
      ).toBe(403)
    }
    expect(called).toBe(0)
  })
  test('email grants admit before sign-in and session creation rechecks removal', async () => {
    const { HumanAccess } = await import('./access')
    const fixture = testAccess(testEnv)
    const store = await fixture.store()
    const grants = new Set(['member@example.com'])
    const synchronized: string[] = []
    store.admitted = async (email) => grants.has(email)
    store.materialize = async (_id, email) => {
      synchronized.push(email)
    }
    const access = new HumanAccess(async () => store, testEnv)
    const db = {
      user: [],
      session: [],
      account: [],
      verification: [],
      jwks: [],
      oauthApplication: [],
      oauthAccessToken: [],
      oauthConsent: [],
      organization: [],
      member: [],
      invitation: [],
    }
    const auth = createWebAuth(testEnv, { database: memoryAdapter(db), access })
    const ctx = await auth.$context
    const user = await ctx.internalAdapter.createUser({
      email: ' MEMBER@Example.com ',
      name: 'Member',
      emailVerified: true,
    })
    expect(user.email).toBe('member@example.com')
    expect(synchronized).toEqual(['member@example.com'])
    expect(await ctx.internalAdapter.createSession(user.id)).toBeTruthy()
    grants.clear()
    expect(await ctx.internalAdapter.createSession(user.id)).toBeNull()
    expect(await access.principal(user.email)).toBeNull()
    expect(
      await ctx.internalAdapter.createUser({
        email: 'outsider@example.com',
        name: 'No',
        emailVerified: true,
      }),
    ).toBeNull()
  })
})
