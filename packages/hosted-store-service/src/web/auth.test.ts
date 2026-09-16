import { describe, expect, test } from 'bun:test'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { createWebAuth, admittedUser } from './auth'

describe('GitHub identity admission', () => {
  test('accepts and normalizes an allowed current provider email', () => {
    expect(
      admittedUser(new Set(['ada@example.com']), { email: ' Ada@Example.COM ', name: 'Ada' }),
    ).toEqual({
      data: { email: 'ada@example.com', name: 'Ada' },
    })
  })

  test('refuses an identity before user or session creation', () => {
    expect(admittedUser(new Set(['ada@example.com']), { email: 'mallory@example.com' })).toBe(false)
  })
})

// The env shape createWebAuth's parser requires (mirrors mcp.live.test.ts's
// baseEnv, including the blob-backend dummies the hosted service's parser
// insists on even when the opener is injected).
const ORIGIN = 'https://operator.example'
const testEnv: Record<string, string> = {
  BETTER_AUTH_SECRET: '0123456789abcdef0123456789abcdef0123456789',
  BETTER_AUTH_URL: ORIGIN,
  GITHUB_CLIENT_ID: 'github-client-canary',
  GITHUB_CLIENT_SECRET: 'github-secret-canary',
  AB_WEB_AUTH_PROVIDERS: 'github',
  AB_WEB_ALLOWED_EMAILS: 'ada@example.com',
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
    // Regression canary: the pinned 1.4.18 MCP plugin hardcodes
    // `<baseURL>/mcp/jwks` (an endpoint that 404s) in
    // getMCPProviderMetadata and only spreads the TOP-LEVEL `metadata` of
    // the mcp() options — a field MCPOptions omits. If a plugin upgrade
    // drops that spread, this fails loudly instead of re-advertising a
    // dead jwks_uri.
    const response = await auth.handler(
      new Request(`${ORIGIN}/api/auth/.well-known/oauth-authorization-server`),
    )
    expect(response.status).toBe(200)
    const metadata = (await response.json()) as { jwks_uri: string }
    expect(metadata.jwks_uri).toBe(`${ORIGIN}/api/auth/jwks`)
  })

  test('the protected-resource metadata advertises the same jwks_uri', async () => {
    const response = await auth.handler(
      new Request(`${ORIGIN}/api/auth/.well-known/oauth-protected-resource`),
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
