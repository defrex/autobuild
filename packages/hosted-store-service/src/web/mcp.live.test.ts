/**
 * End-to-end OAuth 2.1 + MCP over the hosted service (AUT-341): a single
 * Fetch router composes Better Auth's handler at /api/auth/* and the /mcp
 * endpoint delegating in-process to the real hosted service (store +
 * operator + ticket backends). Better Auth runs on the memory adapter by
 * default — a real test database that runs everywhere the unit step runs —
 * and, when AB_POSTGRES_TEST_URL is set, the same flow runs against a
 * migrated isolated Postgres schema (production adapter parity, exercising
 * the auth schema v3 DDL end to end).
 *
 * The client side is the MCP SDK's own OAuth client (client/auth.js) and
 * StreamableHTTPClientTransport, exactly the machinery Claude web, Claude
 * Code, and Codex bring, so contract drift on either side fails loudly.
 */
import { describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { AUTH_SCHEMA_VERSION, migratePostgres } from '@defrex/autobuild-postgres-store'
import { TOOLS } from '@defrex/autobuild/operator'
import { MemoryBuildStore } from '@defrex/autobuild/plugin-sdk'
import { createHostedStoreService } from '../service'
import { createWebAuth, type WebAuth } from './auth'
import { parseWebAuthEnv } from './config'
import { createMcpEndpoint, MCP_SERVER_INSTRUCTIONS } from './mcp'

const ORIGIN = 'https://operator.example'
const REPO = 'https://github.com/owner/repo'
const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback'
const SCOPE = 'openid profile email offline_access'

const baseEnv: Record<string, string> = {
  BETTER_AUTH_SECRET: '0123456789abcdef0123456789abcdef0123456789',
  BETTER_AUTH_URL: ORIGIN,
  GITHUB_CLIENT_ID: 'github-client-canary',
  GITHUB_CLIENT_SECRET: 'github-secret-canary',
  AB_WEB_AUTH_PROVIDERS: 'github',
  AB_WEB_ALLOWED_EMAILS: 'ada@example.com',
  AB_WEB_REPOSITORIES: REPO,
  AB_POSTGRES_URL: 'postgres://database-canary',
  AB_STORE_SECRET: 'store-secret-canary',
  // The hosted service's env parser requires a blob backend even when the
  // opener is injected; dummies satisfy it (service.test.ts precedent).
  AB_BLOB_BACKEND: 's3',
  AB_S3_BUCKET: 'unused',
  AB_S3_REGION: 'us-east-1',
  AB_S3_ACCESS_KEY_ID: 'unused',
  AB_S3_SECRET_ACCESS_KEY: 'unused',
}

const emptyDB = (): Record<string, Record<string, unknown>[]> => ({
  user: [],
  session: [],
  account: [],
  verification: [],
  jwks: [],
  oauthApplication: [],
  oauthAccessToken: [],
  oauthConsent: [],
})

type App = (request: Request) => Promise<Response>

/** Better Auth on the memory adapter with the plugin configuration
 * createWebAuth uses. */
function buildAuth(env: Record<string, string>, accessTokenExpiresIn?: number): WebAuth {
  return createWebAuth(env, {
    database: memoryAdapter(emptyDB()),
    ...(accessTokenExpiresIn === undefined ? {} : { accessTokenExpiresIn }),
  })
}

/** The hosted service with a real (memory) store behind the authenticated
 * protocol; the MCP endpoint delegates to it in-process. */
function buildApp(
  env: Record<string, string>,
  auth: WebAuth,
): {
  app: App
  backing: MemoryBuildStore
} {
  const backing = new MemoryBuildStore()
  const config = parseWebAuthEnv(env)
  const service = createHostedStoreService({ env, openStore: async () => backing })
  const endpoint = createMcpEndpoint({
    config,
    auth,
    storeSecret: env.AB_STORE_SECRET!,
    delegate: (request) => service.fetch(request),
  })
  const app: App = async (request) => {
    const url = new URL(request.url)
    // The next.config.ts beforeFiles rewrites, replayed for the test router.
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return auth.handler(rewrite(request, '/api/auth/.well-known/oauth-authorization-server'))
    }
    if (url.pathname === '/.well-known/oauth-protected-resource') {
      return auth.handler(rewrite(request, '/api/auth/.well-known/oauth-protected-resource'))
    }
    if (url.pathname.startsWith('/api/auth/')) return auth.handler(request)
    if (url.pathname === '/mcp') return endpoint.fetch(request)
    return Response.json({ error: `no route: ${request.method} ${url.pathname}` }, { status: 404 })
  }
  return { app, backing }
}

function rewrite(request: Request, pathname: string): Request {
  const url = new URL(request.url)
  return new Request(`${url.origin}${pathname}`, {
    method: request.method,
    headers: request.headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
  })
}

/** Sign the session cookie exactly as better-call's setSignedCookie does, so
 * a session created through the auth context authenticates a browser request. */
async function sessionCookie(token: string, secret: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(token))
  const base64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
  return `__Secure-better-auth.session_token=${encodeURIComponent(`${token}.${base64}`)}`
}

async function seedUser(
  auth: WebAuth,
  email: string,
  db?: ReturnType<typeof emptyDB>,
): Promise<{ cookie: string; userId: string }> {
  const context = await auth.$context
  let userId: string
  if (db !== undefined) {
    // The admission hook refuses any user outside the allowlist at creation
    // time — the resource-side 403 test needs a row seeded beneath it.
    userId = 'mallory-user-id'
    db.user!.push({
      id: userId,
      email,
      name: email.split('@')[0] ?? email,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  } else {
    const user = await context.internalAdapter.createUser({
      email,
      name: email.split('@')[0] ?? email,
      emailVerified: true,
    })
    userId = user.id
  }
  const session = await context.internalAdapter.createSession(userId)
  return {
    cookie: await sessionCookie(session.token, parseWebAuthEnv(baseEnv).secret),
    userId,
  }
}

/** The MCP SDK's OAuth client provider, in-memory (Claude-web-shaped). */
function provider(): OAuthClientProvider & {
  saveClientInformation: (info: OAuthClientInformationMixed) => void
} {
  const state: {
    clientInformation?: OAuthClientInformationMixed
    tokens?: OAuthTokens
    codeVerifier?: string
  } = {}
  return {
    get redirectUrl() {
      return REDIRECT_URI
    },
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: 'e2e-mcp-client',
        redirect_uris: [REDIRECT_URI],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }
    },
    clientInformation() {
      return state.clientInformation
    },
    saveClientInformation(info) {
      state.clientInformation = info
    },
    tokens() {
      return state.tokens
    },
    saveTokens(tokens) {
      state.tokens = tokens
    },
    redirectToAuthorization() {},
    saveCodeVerifier(verifier) {
      state.codeVerifier = verifier
    },
    codeVerifier() {
      if (state.codeVerifier === undefined) throw new Error('no code verifier saved')
      return state.codeVerifier
    },
  }
}

const CLIENT_METADATA: OAuthClientMetadata = {
  client_name: 'e2e-mcp-client',
  redirect_uris: [REDIRECT_URI],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
}

async function discoverMetadata(
  app: App,
): Promise<Parameters<typeof registerClient>[1]['metadata']> {
  const response = await app(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`))
  expect(response.status).toBe(200)
  const metadata = (await response.json()) as Parameters<typeof registerClient>[1]['metadata']
  expect(metadata).toMatchObject({ authorization_endpoint: `${ORIGIN}/api/auth/mcp/authorize` })
  return metadata
}

async function discoverProtectedResource(app: App): Promise<void> {
  const response = await app(new Request(`${ORIGIN}/.well-known/oauth-protected-resource`))
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    resource: `${ORIGIN}/mcp`,
    authorization_servers: [ORIGIN],
  })
}

async function dynamicRegister(
  app: App,
  metadata: Parameters<typeof registerClient>[1]['metadata'],
): Promise<OAuthClientInformationMixed> {
  const fetchFn = routerFetch(app)
  return await registerClient(ORIGIN, {
    metadata,
    clientMetadata: CLIENT_METADATA,
    fetchFn,
  })
}

function routerFetch(app: App): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) =>
    app(new Request(input, init))) as unknown as typeof fetch
}

/** Drive the full authorization-code + PKCE + consent flow for one session
 * cookie, returning the tokens the client would hold. */
async function authorizeFlow(
  app: App,
  cookie: string,
  client?: OAuthClientInformationMixed,
): Promise<OAuthTokens> {
  const metadata = await discoverMetadata(app)
  await discoverProtectedResource(app)
  const registered = client ?? (await dynamicRegister(app, metadata))
  expect(registered?.client_id).toBeTruthy()

  const { authorizationUrl, codeVerifier } = await startAuthorization(ORIGIN, {
    metadata,
    clientInformation: registered!,
    redirectUrl: REDIRECT_URI,
    scope: SCOPE,
    state: 'e2e-state',
  })
  authorizationUrl.searchParams.set('prompt', 'consent')

  // The signed-in allowlisted operator visits the authorize URL.
  const authorizeResponse = await app(
    new Request(authorizationUrl, { headers: { cookie }, redirect: 'manual' }),
  )
  expect(authorizeResponse.status).toBe(302)
  const consentLocation = new URL(authorizeResponse.headers.get('location')!, ORIGIN)
  expect(consentLocation.pathname).toBe('/oauth/consent')
  const consentCode = consentLocation.searchParams.get('consent_code')
  expect(consentCode).toBeTruthy()

  // The consent POST: the request the /oauth/consent page's form drives.
  const consentResponse = await app(
    new Request(`${ORIGIN}/api/auth/oauth2/consent`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ accept: true, consent_code: consentCode }),
    }),
  )
  expect(consentResponse.status).toBe(200)
  const { redirectURI } = (await consentResponse.json()) as { redirectURI: string }
  expect(redirectURI.startsWith(REDIRECT_URI)).toBe(true)
  const code = new URL(redirectURI).searchParams.get('code')
  expect(code).toBeTruthy()

  const tokens = await exchangeAuthorization(ORIGIN, {
    metadata,
    clientInformation: registered!,
    authorizationCode: code!,
    codeVerifier,
    redirectUri: REDIRECT_URI,
    fetchFn: routerFetch(app),
  })
  expect(tokens.access_token).toBeTruthy()
  expect(tokens.refresh_token).toBeTruthy()
  return tokens
}

/** An MCP SDK client connected over Streamable HTTP with pre-loaded tokens. */
async function connectClient(
  app: App,
  tokens: OAuthTokens,
  clientInformation: OAuthClientInformationMixed,
): Promise<Client> {
  const authProvider = provider()
  authProvider.saveTokens(tokens)
  if (clientInformation !== undefined) authProvider.saveClientInformation(clientInformation)
  const mcpClient = new Client({ name: 'e2e-mcp-client', version: '1.0.0' })
  await mcpClient.connect(
    new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
      authProvider,
      fetch: routerFetch(app),
    }),
  )
  return mcpClient
}

function toolsListRequest(token: string, id: number): Request {
  return new Request(`${ORIGIN}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params: {} }),
  })
}

describe('hosted MCP over OAuth (memory adapter)', () => {
  const env = { ...baseEnv }
  const db = emptyDB()
  const auth = createWebAuth(env, { database: memoryAdapter(db) })
  const { app, backing } = buildApp(env, auth)
  let adaCookie = ''
  let adaTokens: OAuthTokens | undefined
  let registered: OAuthClientInformationMixed | undefined

  test('an unauthenticated tools/list POST receives the RFC 9728 challenge', async () => {
    const response = await app(
      new Request(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
    )
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`,
    )
  })

  test('the full OAuth flow authorizes a dynamically registered client', async () => {
    const seeded = await seedUser(auth, 'ada@example.com')
    adaCookie = seeded.cookie
    const metadata = await discoverMetadata(app)
    await discoverProtectedResource(app)
    registered = await dynamicRegister(app, metadata)
    adaTokens = await authorizeFlow(app, adaCookie, registered)
    expect(adaTokens.access_token).toBeTruthy()
  })

  test('the MCP client connects, lists the live registry table, and reads a tool', async () => {
    const mcpClient = await connectClient(app, adaTokens!, registered!)
    try {
      const { tools } = await mcpClient.listTools()
      // Equality with the live registry table, plus repositories.list.
      expect(tools).toHaveLength(TOOLS.length + 1)
      expect(tools.map((tool) => tool.name).sort()).toEqual(
        [...TOOLS.map((entry) => entry.name as string), 'repositories.list'].sort(),
      )
      const repositories = tools.find((tool) => tool.name === 'repositories.list')!
      expect(repositories.annotations).toMatchObject({ readOnlyHint: true })
      const buildsList = tools.find((tool) => tool.name === 'builds.list')!
      expect((buildsList.inputSchema as Record<string, unknown>).type).toBe('object')
      expect(buildsList.annotations).toMatchObject({ readOnlyHint: true })
      // Server instructions summarize how Autobuild works and point at the
      // repository listing.
      expect(MCP_SERVER_INSTRUCTIONS).toContain('repositories.list')

      const listing = await mcpClient.callTool({ name: 'repositories.list', arguments: {} })
      expect((listing.content as { text: string }[])[0]!.text).toBe(
        JSON.stringify({ repositories: [REPO] }),
      )

      const reads = await mcpClient.callTool({
        name: 'builds.list',
        arguments: { repo: REPO, scope: 'all' },
      })
      expect(reads.isError).toBeUndefined()
      expect(JSON.parse((reads.content as { text: string }[])[0]!.text)).toEqual([])
    } finally {
      await mcpClient.close()
    }
  })

  test('a mutating tool call stamps the operator and the via marker onto the event', async () => {
    const mcpClient = await connectClient(app, adaTokens!, registered!)
    try {
      const result = await mcpClient.callTool({
        name: 'repository.settings',
        arguments: { repo: REPO, setting: 'intake', enabled: false },
      })
      expect(result.isError).toBeUndefined()
      const body = JSON.parse((result.content as { text: string }[])[0]!.text) as {
        enabled: boolean
      }
      expect(body.enabled).toBe(false)
    } finally {
      await mcpClient.close()
    }
    // The durable event names the signed-in operator and the MCP client that
    // executed the call — the minted token's via survived the operator
    // server's registry execution.
    const event = (await backing.getRepoEvents(REPO)).at(-1)
    expect(event?.type).toBe('dispatcher.intake-set')
    expect(event?.actor).toEqual({
      kind: 'human',
      user: 'ada@example.com',
      via: { kind: 'mcp', client: 'e2e-mcp-client' },
    })
  })

  test('notes round-trip with the deposit metadata naming the user and via', async () => {
    const mcpClient = await connectClient(app, adaTokens!, registered!)
    try {
      const write = await mcpClient.callTool({
        name: 'notes.write',
        arguments: { repo: REPO, document: 'round 1 notes' },
      })
      expect(write.isError).toBeUndefined()
      const read = await mcpClient.callTool({ name: 'notes.read', arguments: { repo: REPO } })
      const body = JSON.parse((read.content as { text: string }[])[0]!.text) as {
        document: string
        metadata: { user: string; via: { kind: string; client: string } }
      }
      expect(body.document).toBe('round 1 notes')
      expect(body.metadata).toEqual({
        user: 'ada@example.com',
        via: { kind: 'mcp', client: 'e2e-mcp-client' },
      })
    } finally {
      await mcpClient.close()
    }
  })

  test('a tool call naming an unserved repository is refused', async () => {
    const mcpClient = await connectClient(app, adaTokens!, registered!)
    try {
      const result = await mcpClient.callTool({
        name: 'builds.list',
        arguments: { repo: 'https://github.com/owner/other', scope: 'all' },
      })
      expect(result.isError).toBe(true)
      expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toMatchObject({
        kind: 'validation',
      })
    } finally {
      await mcpClient.close()
    }
  })

  test('refresh works after access-token expiry', async () => {
    // A dedicated instance with a 1-second access token: waiting out the
    // production hour would be absurd in a test.
    const shortAuth = buildAuth({ ...baseEnv }, 1)
    const short = buildApp({ ...baseEnv }, shortAuth)
    const seeded = await seedUser(shortAuth, 'ada@example.com')
    const metadata = await discoverMetadata(short.app)
    const client = await dynamicRegister(short.app, metadata)
    const tokens = await authorizeFlow(short.app, seeded.cookie, client)
    expect(tokens.expires_in).toBe(1)
    await Bun.sleep(1200)

    const expired = await short.app(toolsListRequest(tokens.access_token!, 2))
    expect(expired.status).toBe(401)

    const refreshed = await refreshAuthorization(ORIGIN, {
      metadata,
      clientInformation: client,
      refreshToken: tokens.refresh_token!,
      fetchFn: routerFetch(short.app),
    })
    expect(refreshed.access_token).toBeTruthy()
    const works = await short.app(toolsListRequest(refreshed.access_token!, 3))
    expect(works.status).toBe(200)
  })

  test('a non-allowlisted operator completes authorization but is refused at the resource', async () => {
    const seeded = await seedUser(auth, 'mallory@example.com', db)
    const tokens = await authorizeFlow(app, seeded.cookie)
    const response = await app(toolsListRequest(tokens.access_token!, 4))
    expect(response.status).toBe(403)
  })

  test('DCR persists the authenticationScheme the plugin writes', async () => {
    // The pinned 1.4.18 MCP plugin's DCR writes `authenticationScheme` but
    // its declared oauthApplication schema omits it; the file-local plugin
    // declaration in createWebAuth restores it through the adapter factory.
    // The registered client used token_endpoint_auth_method 'none'.
    const row = db.oauthApplication?.find((candidate) => candidate.name === 'e2e-mcp-client')
    expect(row?.authenticationScheme).toBe('none')
    // Pin the DCR-carried fields the memory adapter persists, so the
    // postgres parity block below can assert the two adapters' visible
    // behavior matches without reaching across describe scopes. (Optional
    // fields left undefined — icon, userId here — are omitted by the
    // memory adapter but read back as NULL on Postgres, so only the
    // defined DCR-carried values are pinned.)
    expect(row).toMatchObject({
      name: 'e2e-mcp-client',
      type: 'public',
      authenticationScheme: 'none',
    })
    expect(row?.redirectUrls).toContain('https://claude.ai/api/mcp/auth_callback')
  })
})

const postgresUrl = process.env.AB_POSTGRES_TEST_URL?.trim()

if (postgresUrl) {
  describe('hosted MCP over OAuth (postgres adapter parity)', () => {
    test('the same flow runs against a migrated isolated schema', async () => {
      const { SQL } = await import('bun')
      const schema = `ab_mcp_e2e_${crypto.randomUUID().replaceAll('-', '')}`
      const admin = new SQL(postgresUrl)
      await admin.unsafe(`CREATE SCHEMA ${schema}`)
      await admin.close()
      const scoped = new URL(postgresUrl)
      scoped.searchParams.set('options', `-csearch_path=${schema}`)
      const url = scoped.toString()
      try {
        await migratePostgres(url)
        const env = { ...baseEnv, AB_POSTGRES_URL: url }
        const { Pool } = await import('pg')
        const pool = new Pool({ connectionString: url, max: 2 })
        const auth = createWebAuth(env, { database: pool })
        const { app } = buildApp(env, auth)
        const seeded = await seedUser(auth, 'ada@example.com')
        const tokens = await authorizeFlow(app, seeded.cookie)
        const response = await app(toolsListRequest(tokens.access_token!, 5))
        expect(response.status).toBe(200)
        const { result } = (await response.json()) as { result: { tools: unknown[] } }
        expect(result.tools).toHaveLength(TOOLS.length + 1)
        // DCR's client row really persisted through the pg adapter, with the
        // same authenticationScheme the memory adapter persists (the
        // registered client used token_endpoint_auth_method 'none'), and the
        // same column set the memory adapter carries.
        const sql = new SQL(url)
        const clients = await sql`SELECT * FROM "oauthApplication"`
        const names = clients.map((row: { name: string }) => row.name)
        expect(names).toContain('e2e-mcp-client')
        const e2e = clients.find((row: { name: string }) => row.name === 'e2e-mcp-client') as
          | Record<string, unknown>
          | undefined
        expect(e2e?.authenticationScheme).toBe('none')
        // The same DCR-carried fields the memory adapter persists (pinned
        // by the 'DCR persists the authenticationScheme' test above): the
        // two adapters' visible behavior matches. Optional fields left
        // undefined read back as NULL on Postgres, so only the defined
        // values are compared.
        expect(e2e).toMatchObject({
          name: 'e2e-mcp-client',
          type: 'public',
          authenticationScheme: 'none',
        })
        expect(e2e?.redirectUrls as string).toContain('https://claude.ai/api/mcp/auth_callback')
        await sql.close()
        await pool.end()
      } finally {
        const cleanup = new SQL(postgresUrl)
        await cleanup.unsafe(`DROP SCHEMA ${schema} CASCADE`)
        await cleanup.close()
      }
      expect(AUTH_SCHEMA_VERSION).toBe(3)
    })
  })
}
