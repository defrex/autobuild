import { testAccess } from '../testing/access'
import { testProjects } from '../testing/projects'
import { describe, expect, test } from 'bun:test'
import { verifyToken } from '@defrex/autobuild/remote-store'
import { createWebGateway } from './gateway'

const storeSecret = 'store-secret-canary'
const env = {
  BETTER_AUTH_SECRET: '0123456789abcdef0123456789abcdef',
  BETTER_AUTH_URL: 'https://operator.example',
  GITHUB_CLIENT_ID: 'client',
  GITHUB_CLIENT_SECRET: 'github-secret-canary',
  AB_WEB_AUTH_PROVIDERS: 'github',
  AB_WEB_SUPER_USER_EMAILS: 'ada@example.com',
  AB_WEB_REPOSITORIES: 'git@github.com:owner/repo.git',
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
      access: testAccess(env, testProjects(['https://github.com/owner/repo'])),
      projects: testProjects(['https://github.com/owner/repo']),
      env,
      now: () => new Date('2029-01-01T00:00:00Z'),
      getSession: session,
      delegate: async (request) => {
        delegated = request
        return Response.json({ ok: true })
      },
    })
    const response = await gateway.fetch(
      new Request(
        'https://operator.example/api/web/repos/https%3A%2F%2Fgithub.com%2Fowner%2Frepo/builds/demo/control',
        {
          method: 'POST',
          headers: {
            origin: 'https://operator.example',
            'content-type': 'application/json',
            authorization: 'Bearer attacker',
            'x-autobuild-version': 'attacker',
          },
          body: JSON.stringify({ action: 'pause' }),
        },
      ),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(new URL(delegated!.url).pathname).toBe(
      '/operator/v1/repos/https%3A%2F%2Fgithub.com%2Fowner%2Frepo/builds/demo/control',
    )
    const raw = delegated!.headers.get('authorization')!.replace(/^Bearer /, '')
    expect(raw).not.toBe('attacker')
    expect(verifyToken(storeSecret, raw, new Date('2029-01-01T00:00:01Z'))).toEqual({
      version: 1,
      internalOperator: { user: 'ada@example.com', repo: 'https://github.com/owner/repo' },
      exp: Date.parse('2029-01-01T00:00:30Z'),
    })
  })

  test('refuses missing sessions, removed identities, cross-origin writes and unconfigured repos', async () => {
    const delegate = async () => {
      throw new Error('must not delegate')
    }
    const request = (url: string, init?: RequestInit) => new Request(url, init)
    const signedOut = createWebGateway({
      access: testAccess(env, testProjects(['https://github.com/owner/repo'])),
      projects: testProjects(['https://github.com/owner/repo']),
      env,
      getSession: async () => null,
      delegate,
    })
    expect(
      (
        await signedOut.fetch(
          request(
            'https://operator.example/api/web/repos/https%3A%2F%2Fgithub.com%2Fowner%2Frepo/dashboard',
          ),
        )
      ).status,
    ).toBe(401)
    const removed = createWebGateway({
      access: testAccess(env, testProjects(['https://github.com/owner/repo'])),
      projects: testProjects(['https://github.com/owner/repo']),
      env,
      getSession: async () => ({
        user: { email: 'other@example.com' },
        session: { expiresAt: '2030-01-01' },
      }),
      delegate,
    })
    expect(
      (
        await removed.fetch(
          request(
            'https://operator.example/api/web/repos/https%3A%2F%2Fgithub.com%2Fowner%2Frepo/dashboard',
          ),
        )
      ).status,
    ).toBe(403)
    const gateway = createWebGateway({
      access: testAccess(env, testProjects(['https://github.com/owner/repo'])),
      projects: testProjects(['https://github.com/owner/repo']),
      env,
      getSession: session,
      delegate,
    })
    expect(
      (
        await gateway.fetch(
          request(
            'https://operator.example/api/web/repos/https%3A%2F%2Fgithub.com%2Fowner%2Frepo/bulk-control',
            {
              method: 'POST',
              headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
              body: '{}',
            },
          ),
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await gateway.fetch(
          request(
            'https://operator.example/api/web/repos/https%3A%2F%2Fgithub.com%2Fother%2Frepo/dashboard',
          ),
        )
      ).status,
    ).toBe(404)
  })

  test('delegates ticket reads and moves and refuses every other ticket write', async () => {
    const delegated: string[] = []
    const gateway = createWebGateway({
      access: testAccess(env, testProjects(['https://github.com/owner/repo'])),
      projects: testProjects(['https://github.com/owner/repo']),
      env,
      getSession: session,
      delegate: async (request) => {
        const url = new URL(request.url)
        delegated.push(`${request.method} ${url.pathname}${url.search}`)
        return Response.json({})
      },
    })
    const base = 'https://operator.example/api/web/repos/https%3A%2F%2Fgithub.com%2Fowner%2Frepo'
    const writes = {
      headers: { origin: 'https://operator.example', 'content-type': 'application/json' },
      body: '{}',
    }
    for (const path of ['tickets?state=ready&limit=25', 'tickets/AUT-1', 'tickets/states']) {
      expect((await gateway.fetch(new Request(`${base}/${path}`))).status, path).toBe(200)
    }
    expect(
      (
        await gateway.fetch(
          new Request(`${base}/tickets/AUT-1/move`, { method: 'POST', ...writes }),
        )
      ).status,
    ).toBe(200)
    const operator = '/operator/v1/repos/https%3A%2F%2Fgithub.com%2Fowner%2Frepo'
    expect(delegated).toEqual([
      `GET ${operator}/tickets?state=ready&limit=25`,
      `GET ${operator}/tickets/AUT-1`,
      `GET ${operator}/tickets/states`,
      `POST ${operator}/tickets/AUT-1/move`,
    ])
    delegated.length = 0

    const requests = [
      new Request(`${base}/tickets`, { method: 'POST', ...writes }),
      new Request(`${base}/tickets/states`, { method: 'POST', ...writes }),
      new Request(`${base}/tickets/AUT-1`, { method: 'PATCH', ...writes }),
      ...['block', 'unblock'].map(
        (action) => new Request(`${base}/tickets/AUT-1/${action}`, { method: 'POST', ...writes }),
      ),
    ]

    for (const request of requests) {
      const response = await gateway.fetch(request)
      expect(response.status, `${request.method} ${request.url}`).toBe(404)
      expect(await response.json()).toEqual({ kind: 'not-found', error: 'unknown web route' })
    }
    expect(delegated).toEqual([])
  })

  test('valid write routes still require application/json', async () => {
    const gateway = createWebGateway({
      access: testAccess(env, testProjects(['https://github.com/owner/repo'])),
      projects: testProjects(['https://github.com/owner/repo']),
      env,
      getSession: session,
      delegate: async () => {
        throw new Error('must not delegate')
      },
    })
    const response = await gateway.fetch(
      new Request(
        'https://operator.example/api/web/repos/https%3A%2F%2Fgithub.com%2Fowner%2Frepo/bulk-control',
        {
          method: 'POST',
          headers: { origin: 'https://operator.example', 'content-type': 'text/plain' },
          body: '{}',
        },
      ),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      kind: 'validation',
      error: 'controls require application/json',
    })
  })

  test('preserves artifact bytes without exposing configured canaries', async () => {
    const bytes = Uint8Array.from([0, 255, 17])
    const gateway = createWebGateway({
      access: testAccess(env, testProjects(['https://github.com/owner/repo'])),
      projects: testProjects(['https://github.com/owner/repo']),
      env,
      getSession: session,
      delegate: async () =>
        new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }),
    })
    const response = await gateway.fetch(
      new Request(
        'https://operator.example/api/web/repos/https%3A%2F%2Fgithub.com%2Fowner%2Frepo/builds/demo/artifacts/transcript?rev=1',
      ),
    )
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
    expect(JSON.stringify([...response.headers])).not.toContain('canary')
  })
})

test('all allowed owners see live additions and removals; registry failures fail closed', async () => {
  const repo = 'https://github.com/owner/repo'
  const projects = testProjects([])
  let calls = 0
  let email = 'ada@example.com'
  const gateway = createWebGateway({
    access: testAccess(
      { ...env, AB_WEB_SUPER_USER_EMAILS: 'ada@example.com,grace@example.com' },
      projects,
    ),
    env: { ...env, AB_WEB_SUPER_USER_EMAILS: 'ada@example.com,grace@example.com' },
    projects,
    getSession: async () => ({ user: { email }, session: { expiresAt: '2030-01-01' } }),
    delegate: async () => {
      calls++
      return Response.json({ ok: true })
    },
  })
  const request = () =>
    new Request(`https://operator.example/api/web/repos/${encodeURIComponent(repo)}/dashboard`)
  expect((await gateway.fetch(request())).status).toBe(404)
  await projects.add(repo, 'Ada')
  for (const owner of ['ada@example.com', 'grace@example.com']) {
    email = owner
    expect((await gateway.fetch(request())).status).toBe(200)
  }
  email = 'outsider@example.com'
  expect((await gateway.fetch(request())).status).toBe(403)
  email = 'ada@example.com'
  await projects.remove(repo, 'Ada')
  expect((await gateway.fetch(request())).status).toBe(404)
  projects.has = async () => {
    throw new Error('unavailable')
  }
  expect((await gateway.fetch(request())).status).toBe(500)
  expect(calls).toBe(2)
})
