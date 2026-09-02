import { describe, expect, test } from 'bun:test'
import { verifyToken } from 'autobuild/remote-store'
import { createWebGateway } from './gateway'

const storeSecret = 'store-secret-canary'
const env = {
  BETTER_AUTH_SECRET: '0123456789abcdef0123456789abcdef',
  BETTER_AUTH_URL: 'https://operator.example',
  GITHUB_CLIENT_ID: 'client',
  GITHUB_CLIENT_SECRET: 'github-secret-canary',
  AB_WEB_AUTH_PROVIDERS: 'github',
  AB_WEB_ALLOWED_EMAILS: 'ada@example.com',
  AB_WEB_REPOSITORIES: 'owner/repo',
  AB_POSTGRES_URL: 'postgres://database-canary',
  AB_STORE_SECRET: storeSecret,
}
const session = async () => ({
  user: { email: 'Ada@Example.com' },
  session: { expiresAt: '2030-01-01' },
})

describe('web operator gateway', () => {
  test('scopes routes and replaces caller credentials with attributed short-lived authority', async () => {
    let delegated: Request | undefined
    const gateway = createWebGateway({
      env,
      now: () => new Date('2029-01-01T00:00:00Z'),
      getSession: session,
      delegate: async (request) => {
        delegated = request
        return Response.json({ ok: true })
      },
    })
    const response = await gateway.fetch(
      new Request('https://operator.example/api/web/repos/owner%2Frepo/builds/demo/control', {
        method: 'POST',
        headers: {
          origin: 'https://operator.example',
          'content-type': 'application/json',
          authorization: 'Bearer attacker',
          'x-autobuild-version': 'attacker',
        },
        body: JSON.stringify({ action: 'pause' }),
      }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(new URL(delegated!.url).pathname).toBe(
      '/operator/v1/repos/owner%2Frepo/builds/demo/control',
    )
    const raw = delegated!.headers.get('authorization')!.replace(/^Bearer /, '')
    expect(raw).not.toBe('attacker')
    expect(verifyToken(storeSecret, raw, new Date('2029-01-01T00:00:01Z'))).toEqual({
      operator: { user: 'ada@example.com' },
      exp: Date.parse('2029-01-01T00:00:30Z'),
    })
  })

  test('refuses missing sessions, removed identities, cross-origin writes and unconfigured repos', async () => {
    const delegate = async () => {
      throw new Error('must not delegate')
    }
    const request = (url: string, init?: RequestInit) => new Request(url, init)
    const signedOut = createWebGateway({ env, getSession: async () => null, delegate })
    expect(
      (
        await signedOut.fetch(
          request('https://operator.example/api/web/repos/owner%2Frepo/dashboard'),
        )
      ).status,
    ).toBe(401)
    const removed = createWebGateway({
      env,
      getSession: async () => ({ user: { email: 'other@example.com' } }),
      delegate,
    })
    expect(
      (
        await removed.fetch(
          request('https://operator.example/api/web/repos/owner%2Frepo/dashboard'),
        )
      ).status,
    ).toBe(403)
    const gateway = createWebGateway({ env, getSession: session, delegate })
    expect(
      (
        await gateway.fetch(
          request('https://operator.example/api/web/repos/owner%2Frepo/bulk-control', {
            method: 'POST',
            headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
            body: '{}',
          }),
        )
      ).status,
    ).toBe(403)
    expect(
      (await gateway.fetch(request('https://operator.example/api/web/repos/other/dashboard')))
        .status,
    ).toBe(404)
  })

  test('allows only exact ticket shapes and applies write origin/content-type checks', async () => {
    const delegated: string[] = []
    const gateway = createWebGateway({
      env,
      getSession: session,
      delegate: async (request) => {
        delegated.push(`${request.method} ${new URL(request.url).pathname}`)
        return Response.json({ ok: true })
      },
    })
    expect(
      (
        await gateway.fetch(
          new Request('https://operator.example/api/web/repos/owner%2Frepo/tickets?state=Ready'),
        )
      ).status,
    ).toBe(200)
    expect(
      (
        await gateway.fetch(
          new Request('https://operator.example/api/web/repos/owner%2Frepo/tickets/AUT-1'),
        )
      ).status,
    ).toBe(200)
    expect(
      (
        await gateway.fetch(
          new Request('https://operator.example/api/web/repos/owner%2Frepo/tickets/AUT-1/move', {
            method: 'POST',
            headers: { origin: 'https://operator.example', 'content-type': 'application/json' },
            body: '{"state":"Done"}',
          }),
        )
      ).status,
    ).toBe(200)
    expect(
      (
        await gateway.fetch(
          new Request('https://operator.example/api/web/repos/owner%2Frepo/tickets/AUT-1/comments'),
        )
      ).status,
    ).toBe(404)
    expect(
      (
        await gateway.fetch(
          new Request('https://operator.example/api/web/repos/owner%2Frepo/tickets', {
            method: 'POST',
            headers: { origin: 'https://operator.example', 'content-type': 'text/plain' },
            body: '{}',
          }),
        )
      ).status,
    ).toBe(400)
    expect(delegated).toEqual([
      'GET /operator/v1/repos/owner%2Frepo/tickets',
      'GET /operator/v1/repos/owner%2Frepo/tickets/AUT-1',
      'POST /operator/v1/repos/owner%2Frepo/tickets/AUT-1/move',
    ])
  })

  test('preserves artifact bytes without exposing configured canaries', async () => {
    const bytes = Uint8Array.from([0, 255, 17])
    const gateway = createWebGateway({
      env,
      getSession: session,
      delegate: async () =>
        new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }),
    })
    const response = await gateway.fetch(
      new Request(
        'https://operator.example/api/web/repos/owner%2Frepo/builds/demo/artifacts/transcript?rev=1',
      ),
    )
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
    expect(JSON.stringify([...response.headers])).not.toContain('canary')
  })
})
