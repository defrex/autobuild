import { describe, expect, test } from 'bun:test'
import { verifyToken } from 'autobuild/remote-store'
import { TOOLS, type ToolEntry } from 'autobuild/operator-api'
import { z } from 'zod'
import type { WebAuth } from './auth'
import { MCP_MAX_WAIT_SECONDS, createMcpEndpoint } from './mcp'

const env = {
  BETTER_AUTH_SECRET: '0123456789abcdef0123456789abcdef',
  BETTER_AUTH_URL: 'https://operator.example',
  GITHUB_CLIENT_ID: 'client',
  GITHUB_CLIENT_SECRET: 'github-secret-canary',
  AB_WEB_AUTH_PROVIDERS: 'github',
  AB_WEB_ALLOWED_EMAILS: 'ada@example.com',
  AB_WEB_REPOSITORIES: 'https://github.com/owner/repo',
  AB_POSTGRES_URL: 'postgres://database-canary',
  AB_STORE_SECRET: 'store-secret-canary',
}
const config = {
  secret: '0123456789abcdef0123456789abcdef',
  baseURL: 'https://operator.example',
  providers: ['github' as const],
  allowedEmails: new Set(['ada@example.com']),
  repositories: ['https://github.com/owner/repo'],
  github: { clientId: 'client', clientSecret: 'github-secret-canary' },
  postgresURL: 'postgres://database-canary',
  secureCookies: true,
  mcpResource: 'https://operator.example/mcp',
}
const now = new Date('2029-01-01T00:00:00Z')
const clock = () => now

const TOKEN_ROW = {
  id: 't1',
  accessToken: 'mcp-access-token',
  refreshToken: 'mcp-refresh-token',
  accessTokenExpiresAt: new Date('2029-01-01T01:00:00Z'),
  refreshTokenExpiresAt: new Date('2029-01-02T01:00:00Z'),
  clientId: 'registered-client',
  userId: 'u1',
  scopes: 'openid profile email offline_access',
  createdAt: now,
  updatedAt: now,
}
const USER = { id: 'u1', email: 'Ada@Example.com', name: 'Ada', emailVerified: true }

/** A stub of the Better Auth instance: only the two surfaces the endpoint
 * uses are real (the MCP token store and the typed context adapters). */
function fakeAuth(
  overrides: {
    session?: unknown | null
    user?: unknown | null
    application?: { name?: string } | null
  } = {},
): WebAuth {
  return {
    api: {
      getMcpSession: async () => (overrides.session === undefined ? TOKEN_ROW : overrides.session),
    },
    $context: Promise.resolve({
      internalAdapter: {
        findUserById: async () => (overrides.user === undefined ? USER : overrides.user),
      },
      adapter: {
        findOne: async () =>
          overrides.application === undefined
            ? { id: 'a1', name: 'Claude web', clientId: 'registered-client' }
            : overrides.application,
      },
    }),
  } as unknown as WebAuth
}

function endpoint(
  auth: WebAuth,
  overrides: {
    delegate?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
    entries?: readonly ToolEntry[]
    config?: typeof config
  } = {},
) {
  return createMcpEndpoint({
    config: overrides.config ?? config,
    auth,
    storeSecret: env.AB_STORE_SECRET,
    delegate:
      overrides.delegate ??
      (async (_input: string | URL | Request, _init?: RequestInit) => Response.json({ ok: true })),
    now: clock,
    ...(overrides.entries !== undefined ? { entries: overrides.entries } : {}),
  })
}

/** A minimal MCP initialize request over JSON-RPC (the transport answers
 * statelessly, so each POST is independent). */
function initializeRequest(token?: string): Request {
  return new Request('https://operator.example/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'mcp-unit-test', version: '0.0.0' },
      },
    }),
  })
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>
}

describe('hosted MCP endpoint guard', () => {
  test('a missing, unknown, or expired token receives the RFC 9728 challenge', async () => {
    const endpoint_ = endpoint(fakeAuth({ session: null }))
    for (const request of [
      new Request('https://operator.example/mcp', { method: 'POST', body: '{}' }),
      initializeRequest('unknown-token'),
    ]) {
      const response = await endpoint_.fetch(request)
      expect(response.status).toBe(401)
      expect(response.headers.get('www-authenticate')).toBe(
        'Bearer resource_metadata="https://operator.example/.well-known/oauth-protected-resource"',
      )
      const body = await jsonOf(response)
      expect(body).toMatchObject({ jsonrpc: '2.0', id: null })
    }

    const expired = endpoint(
      fakeAuth({ session: { ...TOKEN_ROW, accessTokenExpiresAt: new Date('2028-12-31') } }),
    )
    const response = await expired.fetch(initializeRequest())
    expect(response.status).toBe(401)
  })

  test('a dropped or unresolvable operator is refused 403', async () => {
    const dropped = endpoint(fakeAuth({ user: { ...USER, email: 'mallory@example.com' } }))
    expect((await dropped.fetch(initializeRequest())).status).toBe(403)
    const missing = endpoint(fakeAuth({ user: null }))
    expect((await missing.fetch(initializeRequest())).status).toBe(403)
  })

  test('an allowlisted operator initializes; GET answers 405 and OPTIONS preflights', async () => {
    const endpoint_ = endpoint(fakeAuth())
    const initialized = await endpoint_.fetch(initializeRequest('any'))
    expect(initialized.status).toBe(200)
    const body = await jsonOf(initialized)
    const result = body.result as { serverInfo?: { name?: string }; instructions?: string }
    expect(result.serverInfo?.name).toBe('autobuild')
    expect(result.instructions).toContain('repositories.list')

    // The transport contract: GET answers an SSE stream (the SDK's standalone
    // stream, not a 405 — stateless mode disables session validation, not
    // server-to-client streams).
    expect(
      (
        await endpoint_.fetch(
          new Request('https://operator.example/mcp', {
            method: 'GET',
            headers: { accept: 'text/event-stream' },
          }),
        )
      ).status,
    ).toBe(200)
    const preflight = await endpoint_.fetch(
      new Request('https://operator.example/mcp', { method: 'OPTIONS' }),
    )
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
  })
})

describe('hosted MCP endpoint tool binding', () => {
  test('every registry entry is listed with its schema, annotations, and repositories.list', async () => {
    const endpoint_ = endpoint(fakeAuth())
    const list = await endpoint_.fetch(
      new Request('https://operator.example/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer any',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      }),
    )
    expect(list.status).toBe(200)
    const { result } = (await jsonOf(list)) as { result: { tools: { name: string }[] } }
    const names = result.tools.map((tool) => tool.name).sort()
    expect(names).toContain('builds.list')
    expect(names).toContain('notes.write')
    expect(names).toContain('repositories.list')
    expect(result.tools).toHaveLength(TOOLS.length + 1)
  })

  test('a tool call mints an attributed operator token and delegates to the tools route', async () => {
    let delegated: Request | undefined
    const endpoint_ = endpoint(fakeAuth(), {
      delegate: async (input, init) => {
        delegated = new Request(input, init)
        return Response.json({ ok: true, via: 'operator' })
      },
    })
    const response = await endpoint_.fetch(
      new Request('https://operator.example/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer any',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'repository.settings',
            arguments: { repo: 'https://github.com/owner/repo', setting: 'intake', enabled: false },
          },
        }),
      }),
    )
    expect(response.status).toBe(200)
    expect(new URL(delegated!.url).pathname).toBe(
      '/operator/v1/repos/https%3A%2F%2Fgithub.com%2Fowner%2Frepo/tools/repository.settings',
    )
    const raw = delegated!.headers.get('authorization')!.replace(/^Bearer /, '')
    expect(verifyToken(env.AB_STORE_SECRET, raw, new Date('2029-01-01T00:00:01Z'))).toEqual({
      operator: { user: 'ada@example.com' },
      via: { kind: 'mcp', client: 'Claude web' },
      exp: Date.parse('2029-01-01T00:00:30Z'),
    })
    expect(await delegated!.json()).toEqual({
      repo: 'https://github.com/owner/repo',
      setting: 'intake',
      enabled: false,
    })
  })

  test('an unserved repository is refused before delegation', async () => {
    let delegated = 0
    const endpoint_ = endpoint(fakeAuth(), {
      delegate: async () => {
        delegated += 1
        return Response.json({})
      },
    })
    const response = await endpoint_.fetch(
      new Request('https://operator.example/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer any',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: { name: 'builds.list', arguments: { repo: 'https://github.com/owner/other' } },
        }),
      }),
    )
    expect(response.status).toBe(200)
    const { result } = (await jsonOf(response)) as {
      result: { isError?: boolean; content: { text: string }[] }
    }
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ kind: 'validation' })
    expect(delegated).toBe(0)
  })

  test('an operator failure body round-trips onto the tool result with isError', async () => {
    const endpoint_ = endpoint(fakeAuth(), {
      delegate: async () =>
        Response.json(
          { kind: 'conflict', error: 'remote store version mismatch', code: 'version' },
          { status: 409 },
        ),
    })
    const response = await endpoint_.fetch(
      new Request('https://operator.example/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer any',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: {
            name: 'builds.list',
            arguments: { repo: 'https://github.com/owner/repo', scope: 'all' },
          },
        }),
      }),
    )
    const { result } = (await jsonOf(response)) as {
      result: { isError?: boolean; content: { text: string }[] }
    }
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      kind: 'conflict',
      error: 'remote store version mismatch',
      code: 'version',
    })
  })

  test('the wait clamp bounds builds.events before delegation', async () => {
    // The registry's own schema caps waitSeconds at 30 today, so the SDK's
    // schema validation refuses anything larger before this handler runs.
    // Simulate the future schema raise the clamp exists for: a synthetic
    // builds.events entry whose cap exceeds the clamp.
    const raised = TOOLS.find((entry) => entry.name === 'builds.events')!
    const synthetic: ToolEntry = {
      ...raised,
      inputSchema: z.strictObject({
        repo: z.string().min(1),
        slug: z.string().min(1),
        cursor: z.number().int().min(0),
        waitSeconds: z.number().int().min(0).max(100_000).default(0),
      }),
    }
    let delegated: Request | undefined
    const endpoint_ = endpoint(fakeAuth(), {
      entries: [synthetic],
      delegate: async (input, init) => {
        delegated = new Request(input, init)
        return Response.json({ events: [] })
      },
    })
    await endpoint_.fetch(
      new Request('https://operator.example/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer any',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/call',
          params: {
            name: 'builds.events',
            arguments: {
              repo: 'https://github.com/owner/repo',
              slug: 'demo',
              cursor: 0,
              waitSeconds: 10_000,
            },
          },
        }),
      }),
    )
    expect((await delegated!.json()).waitSeconds).toBe(MCP_MAX_WAIT_SECONDS)
    expect(MCP_MAX_WAIT_SECONDS).toBe(240)
  })

  test('an injected extra registry entry appears in tools/list and delegates through the same closure', async () => {
    // The no-code-change criterion: a future sandbox ticket adds entries to
    // the registry table, and they appear here with no edit to this module.
    const synthetic: ToolEntry = {
      name: 'sandbox.probe' as ToolEntry['name'],
      description: 'A hypothetical future sandbox tool.',
      inputSchema: z.strictObject({ repo: z.string().min(1) }),
      outputDescription: 'A probe result.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      approval: 'never',
      handler: async () => ({ probed: true }),
    }
    let delegated: Request | undefined
    const endpoint_ = endpoint(fakeAuth(), {
      entries: [...TOOLS, synthetic],
      delegate: async (input, init) => {
        delegated = new Request(input, init)
        return Response.json({ probed: true })
      },
    })
    const list = await endpoint_.fetch(
      new Request('https://operator.example/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer any',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} }),
      }),
    )
    const { result } = (await jsonOf(list)) as { result: { tools: { name: string }[] } }
    expect(result.tools.map((tool) => tool.name)).toContain('sandbox.probe')

    const call = await endpoint_.fetch(
      new Request('https://operator.example/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer any',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 8,
          method: 'tools/call',
          params: {
            name: 'sandbox.probe',
            arguments: { repo: 'https://github.com/owner/repo' },
          },
        }),
      }),
    )
    expect(call.status).toBe(200)
    expect(new URL(delegated!.url).pathname.endsWith('/tools/sandbox.probe')).toBe(true)
  })

  test('the client name falls back to the raw clientId when the registration omits it', async () => {
    let delegated: Request | undefined
    const endpoint_ = endpoint(fakeAuth({ application: { name: '' } }), {
      delegate: async (input, init) => {
        delegated = new Request(input, init)
        return Response.json({})
      },
    })
    await endpoint_.fetch(initializeRequest())
    await endpoint_.fetch(
      new Request('https://operator.example/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer any',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 9,
          method: 'tools/call',
          params: {
            name: 'builds.list',
            arguments: { repo: 'https://github.com/owner/repo', scope: 'all' },
          },
        }),
      }),
    )
    expect(
      verifyToken(
        env.AB_STORE_SECRET,
        delegated!.headers.get('authorization')!.replace(/^Bearer /, ''),
        new Date('2029-01-01T00:00:01Z'),
      ),
    ).toMatchObject({ via: { kind: 'mcp', client: 'registered-client' } })
  })
})
