import { describe, expect, test } from 'bun:test'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { registeredClientName, type AuthContextLike } from './client-name'
import { createWebAuth } from '@defrex/autobuild-hosted-store-service/web/auth'

/** The exact query shape the helper is contract-bound to issue against
 * better-auth's adapter: `getClient` in the pinned oidc-provider plugin
 * (better-auth 1.4.18) looks a client up with
 * `findOne({ model: 'oauthApplication', where: [{ field: 'clientId', value }] })`
 * and reads `name` off the row. Asserting this shape exactly means a model
 * rename or a field rename in the helper fails the suite instead of silently
 * degrading the consent page to the raw client_id. */
const expectedLookup = (clientId: string) => ({
  model: 'oauthApplication',
  where: [{ field: 'clientId', value: clientId }],
})

type CapturedLookup = ReturnType<typeof expectedLookup>

/** A stub whose findOne records the argument it was called with, so tests can
 * assert the lookup contract rather than only the mapped-out return value. */
function capturingAuth(
  respond: (lookup: CapturedLookup) => Promise<{ name?: string | null } | null>,
): { auth: { $context: Promise<AuthContextLike> }; lookups: CapturedLookup[] } {
  const lookups: CapturedLookup[] = []
  const findOne: AuthContextLike['adapter']['findOne'] = (query) => {
    lookups.push(query)
    return respond(query)
  }
  return { auth: { $context: Promise.resolve({ adapter: { findOne } }) }, lookups }
}

describe('registeredClientName — lookup contract', () => {
  // Two distinct client ids across the assertions so a hardcoded where value
  // cannot pass by copying the happy path's constant.
  test('issues the better-auth client lookup for the requested client id', async () => {
    const { auth, lookups } = capturingAuth(() => Promise.resolve({ name: 'Acme MCP Console' }))
    expect(await registeredClientName('client-123', auth)).toBe('Acme MCP Console')
    expect(lookups.length).toBe(1)
    expect(lookups[0]).toEqual(expectedLookup('client-123'))
  })

  test('looks up the id it was actually handed, not a constant', async () => {
    const { auth, lookups } = capturingAuth(() => Promise.resolve(null))
    expect(await registeredClientName('client-other-456', auth)).toBeNull()
    expect(lookups[0]).toEqual(expectedLookup('client-other-456'))
  })

  test('maps a missing client record to null', async () => {
    const { auth, lookups } = capturingAuth(() => Promise.resolve(null))
    expect(await registeredClientName('client-123', auth)).toBeNull()
    expect(lookups[0]).toEqual(expectedLookup('client-123'))
  })

  test('maps a blank registered name to null', async () => {
    for (const name of ['', '   ']) {
      const { auth, lookups } = capturingAuth(() => Promise.resolve({ name }))
      expect(await registeredClientName('client-123', auth)).toBeNull()
      expect(lookups[0]).toEqual(expectedLookup('client-123'))
    }
  })

  test('maps an adapter rejection to null, without throwing', async () => {
    const { auth } = capturingAuth(() => Promise.reject(new Error('database down')))
    expect(await registeredClientName('client-123', auth)).toBeNull()
  })

  test('maps a context-resolution rejection to null, without throwing', async () => {
    const auth = { $context: Promise.reject(new Error('context unavailable')) }
    expect(await registeredClientName('client-123', auth)).toBeNull()
  })
})

// Drives the helper through a real better-auth instance — the actual adapter
// factory and the memory adapter's findOne query path (field resolution
// included) — rather than a hand-written fake. Same pattern as
// src/web/auth.test.ts; the instance is passed via the `auth` parameter the
// helper already exposes, so the module-level webAuth() singleton is untouched.
const ORIGIN = 'https://operator.example'
const realAuthEnv: Record<string, string> = {
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

describe('registeredClientName — through a real better-auth adapter', () => {
  const seededClient = {
    id: 'app-1',
    clientId: 'client-123',
    name: 'Acme MCP Console',
    redirectUrls: 'https://app.example/callback',
    type: 'web',
    disabled: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }

  const auth = createWebAuth(realAuthEnv, {
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
      jwks: [],
      oauthApplication: [seededClient],
      oauthAccessToken: [],
      oauthConsent: [],
    }),
  })

  test('resolves the seeded client through the real adapter query path', async () => {
    expect(await registeredClientName('client-123', auth)).toBe('Acme MCP Console')
  })

  test('resolves an unknown client id to null through the same instance', async () => {
    expect(await registeredClientName('client-unregistered', auth)).toBeNull()
  })
})
