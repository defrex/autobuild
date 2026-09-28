import { describe, expect, test } from 'bun:test'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { verifyToken } from '@defrex/autobuild/remote-store'
import { TOOLS, type ToolEntry } from '@defrex/autobuild/operator'
import { z } from 'zod'
import { createWebAuth, type WebAuth } from './auth'
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

/** The token clientId the capturing variant's session carries — distinct
 * from `fakeAuth`'s 'registered-client' so no assertion can pass by copying a
 * constant from the happy path of another test. */
const CANARY_CLIENT_ID = 'contract-canary-client'

/** The exact query shape operator() is contract-bound to issue against
 * better-auth's adapter: resolving the MCP client name looks the token's
 * registration up with
 * `findOne({ model: 'oauthApplication', where: [{ field: 'clientId', value }] })`
 * and reads `name` off the row (AUT-398 pinned the identical shape for the
 * consent-page helper). Asserting this shape exactly means a model rename, a
 * field rename, or a where-shape drift in operator() fails the suite instead
 * of silently degrading every client to its raw client_id. */
const expectedLookup = (clientId: string) => ({
  model: 'oauthApplication',
  where: [{ field: 'clientId', value: clientId }],
})

type CapturedLookup = ReturnType<typeof expectedLookup>

/** The contract-pinning counterpart of fakeAuth: its adapter.findOne records
 * each query argument it is called with into `lookups` and answers with the
 * programmed response, so tests assert the lookup itself rather than only the
 * mapped-out name (fakeAuth's findOne ignores its argument and returns a
 * canned row — exactly the unasserted pattern AUT-549 implicates). */
function capturingAuth(
  respond: (lookup: CapturedLookup) => Promise<{ name?: unknown } | null>,
  overrides: { session?: unknown; user?: unknown } = {},
): { auth: WebAuth; lookups: CapturedLookup[] } {
  const lookups: CapturedLookup[] = []
  const auth = {
    api: {
      getMcpSession: async () =>
        overrides.session === undefined
          ? { ...TOKEN_ROW, clientId: CANARY_CLIENT_ID }
          : overrides.session,
    },
    $context: Promise.resolve({
      internalAdapter: {
        findUserById: async () => (overrides.user === undefined ? USER : overrides.user),
      },
      adapter: {
        findOne: async (query: CapturedLookup) => {
          lookups.push(query)
          return respond(query)
        },
      },
    }),
  } as unknown as WebAuth
  return { auth, lookups }
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

  test('an allowlisted operator initializes; stateless GET serves SSE 200 and OPTIONS preflights', async () => {
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

/** A POST tools/call whose Authorization header the endpoint resolves (the
 * transport is stateless — each POST is independent, so no initialize is
 * needed to make operator() run and issue exactly one adapter lookup). */
function toolsCallRequest(token: string): Request {
  return new Request('https://operator.example/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: {
        name: 'builds.list',
        arguments: { repo: 'https://github.com/owner/repo', scope: 'all' },
      },
    }),
  })
}

/** A delegate that captures the request the operator API client handed it,
 * so the minted operator token (where via.client durably lands) can be
 * verified. */
function capturingDelegate(): {
  delegate: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  delegated: () => Request
} {
  let captured: Request | undefined
  return {
    delegate: async (input, init) => {
      captured = new Request(input, init)
      return Response.json({})
    },
    delegated: () => captured!,
  }
}

/** Drive one tools/call through the endpoint and return the delegated
 * request carrying the minted operator token. */
async function throughEndpoint(auth: WebAuth, token = 'any'): Promise<Request> {
  const cap = capturingDelegate()
  const endpoint_ = endpoint(auth, { delegate: cap.delegate })
  const response = await endpoint_.fetch(toolsCallRequest(token))
  // A non-200 means operator() refused before minting — fail loudly here so
  // the via assertions below report the real problem (e.g. a 401 from a
  // mangled real-adapter seed row) instead of an undefined delegated request.
  expect(response.status).toBe(200)
  return cap.delegated()
}

const mintedBearer = (delegated: Request) =>
  delegated.headers.get('authorization')!.replace(/^Bearer /, '')

const VERIFIED_AT = new Date('2029-01-01T00:00:01Z')

describe('operator() — oauthApplication lookup contract (AUT-549)', () => {
  test('issues the exact oauthApplication/clientId lookup for the token row', async () => {
    const { auth, lookups } = capturingAuth(() =>
      Promise.resolve({ name: 'Contract Canary Console' }),
    )
    await throughEndpoint(auth)
    expect(lookups.length).toBe(1)
    expect(lookups[0]).toEqual(expectedLookup(CANARY_CLIENT_ID))
  })

  test('a registered name flows through to the minted token’s via marker', async () => {
    const { auth } = capturingAuth(() => Promise.resolve({ name: 'Contract Canary Console' }))
    const delegated = await throughEndpoint(auth)
    expect(verifyToken(env.AB_STORE_SECRET, mintedBearer(delegated), VERIFIED_AT)).toMatchObject({
      via: { kind: 'mcp', client: 'Contract Canary Console' },
    })
  })

  test('looks up the clientId it was actually handed, not a constant', async () => {
    const otherSession = {
      ...TOKEN_ROW,
      id: 't2',
      accessToken: 'other-mcp-access-token',
      clientId: 'another-canary-client',
    }
    const { auth, lookups } = capturingAuth(() => Promise.resolve(null), { session: otherSession })
    await throughEndpoint(auth)
    expect(lookups.length).toBe(1)
    expect(lookups[0]).toEqual(expectedLookup('another-canary-client'))
  })

  test('an empty-string registered name falls back to the raw clientId, with the lookup still issued', async () => {
    const { auth, lookups } = capturingAuth(() => Promise.resolve({ name: '' }))
    const delegated = await throughEndpoint(auth)
    expect(lookups[0]).toEqual(expectedLookup(CANARY_CLIENT_ID))
    expect(verifyToken(env.AB_STORE_SECRET, mintedBearer(delegated), VERIFIED_AT)).toMatchObject({
      via: { kind: 'mcp', client: CANARY_CLIENT_ID },
    })
  })

  test('a missing oauthApplication row falls back to the raw clientId', async () => {
    const { auth, lookups } = capturingAuth(() => Promise.resolve(null))
    const delegated = await throughEndpoint(auth)
    expect(lookups[0]).toEqual(expectedLookup(CANARY_CLIENT_ID))
    expect(verifyToken(env.AB_STORE_SECRET, mintedBearer(delegated), VERIFIED_AT)).toMatchObject({
      via: { kind: 'mcp', client: CANARY_CLIENT_ID },
    })
  })

  test('a non-string name is not rendered and falls back to the raw clientId', async () => {
    const { auth, lookups } = capturingAuth(() => Promise.resolve({ name: 42 }))
    const delegated = await throughEndpoint(auth)
    expect(lookups[0]).toEqual(expectedLookup(CANARY_CLIENT_ID))
    expect(verifyToken(env.AB_STORE_SECRET, mintedBearer(delegated), VERIFIED_AT)).toMatchObject({
      via: { kind: 'mcp', client: CANARY_CLIENT_ID },
    })
  })

  test('a whitespace-only name renders verbatim — operator() does not trim', async () => {
    // Pins the actual behavior: operator()’s guard is
    // `typeof name === 'string' && name !== ''` with no .trim(), a deliberate
    // divergence from the AUT-398 consent-page helper (which reads
    // `client?.name?.trim()`). If a future ticket adds trimming here, this
    // assertion changes with it, consciously.
    const { auth, lookups } = capturingAuth(() => Promise.resolve({ name: '   ' }))
    const delegated = await throughEndpoint(auth)
    expect(lookups[0]).toEqual(expectedLookup(CANARY_CLIENT_ID))
    expect(verifyToken(env.AB_STORE_SECRET, mintedBearer(delegated), VERIFIED_AT)).toMatchObject({
      via: { kind: 'mcp', client: '   ' },
    })
  })
})

// Drives operator() through a real better-auth instance — the actual adapter
// factory and the memory adapter's findOne query path (field resolution
// included) — rather than a hand-written fake. Same pattern as
// app/oauth/consent/client-name.test.ts; the instance goes through the
// `auth` option createMcpEndpoint already injects, so no production seam is
// refactored in.
describe('operator() — through a real better-auth adapter', () => {
  const REAL_ACCESS_TOKEN = 'real-adapter-access-token'
  const REAL_CLIENT_ID = 'real-adapter-client-id'
  // A second registration/token pair under the same instance: the
  // empty-string-name fallback case, without mutating the first case's rows.
  const BLANK_ACCESS_TOKEN = 'real-adapter-blank-access-token'
  const BLANK_CLIENT_ID = 'real-adapter-blank-client-id'

  const db: Record<string, Record<string, unknown>[]> = {
    user: [
      {
        id: 'u1',
        email: 'ada@example.com',
        name: 'Ada',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    ],
    session: [],
    account: [],
    verification: [],
    jwks: [],
    oauthApplication: [
      {
        id: 'app-1',
        clientId: REAL_CLIENT_ID,
        name: 'Real Adapter Console',
        redirectUrls: 'https://app.example/callback',
        type: 'web',
        disabled: false,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
      {
        id: 'app-2',
        clientId: BLANK_CLIENT_ID,
        name: '',
        redirectUrls: 'https://app.example/callback',
        type: 'web',
        disabled: false,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ],
    oauthAccessToken: [
      { ...TOKEN_ROW, accessToken: REAL_ACCESS_TOKEN, clientId: REAL_CLIENT_ID },
      {
        ...TOKEN_ROW,
        id: 't2',
        accessToken: BLANK_ACCESS_TOKEN,
        clientId: BLANK_CLIENT_ID,
      },
    ],
    oauthConsent: [],
  }

  const realAuth = createWebAuth(env, { database: memoryAdapter(db) })

  test('resolves the registered name through the real adapter query path', async () => {
    const delegated = await throughEndpoint(realAuth, REAL_ACCESS_TOKEN)
    expect(verifyToken(env.AB_STORE_SECRET, mintedBearer(delegated), VERIFIED_AT)).toMatchObject({
      via: { kind: 'mcp', client: 'Real Adapter Console' },
    })
  })

  test('an empty-string registered name falls back to the raw clientId through the same instance', async () => {
    const delegated = await throughEndpoint(realAuth, BLANK_ACCESS_TOKEN)
    expect(verifyToken(env.AB_STORE_SECRET, mintedBearer(delegated), VERIFIED_AT)).toMatchObject({
      via: { kind: 'mcp', client: BLANK_CLIENT_ID },
    })
  })
})
