/** Shared OAuth + MCP fixtures for the hosted MCP endpoint tests. */
import { MemoryTicketPolicyStore } from '@defrex/autobuild-postgres-store/ticket-policy'
import { testProjects } from './projects'
import { expect } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  exchangeAuthorization,
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
import { MemoryBuildStore } from '@defrex/autobuild/plugin-sdk'
import { createHostedStoreService } from '../service'
import { createWebAuth, type WebAuth } from '../web/auth'
import { parseWebAuthEnv } from '../web/config'
import { createMcpEndpoint } from '../web/mcp'

export const ORIGIN = 'https://operator.example'
export const REPO = 'https://github.com/owner/repo'
export const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback'
export const SCOPE = 'openid profile email offline_access'

export const baseEnv: Record<string, string> = {
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

export const emptyDB = (): Record<string, Record<string, unknown>[]> => ({
  user: [],
  session: [],
  account: [],
  verification: [],
  jwks: [],
  oauthApplication: [],
  oauthAccessToken: [],
  oauthConsent: [],
})

export type App = (request: Request) => Promise<Response>

/** Better Auth on the memory adapter with the plugin configuration
 * createWebAuth uses. */
export function buildAuth(env: Record<string, string>, accessTokenExpiresIn?: number): WebAuth {
  return createWebAuth(env, {
    database: memoryAdapter(emptyDB()),
    ...(accessTokenExpiresIn === undefined ? {} : { accessTokenExpiresIn }),
  })
}

/** The hosted service with a real (memory) store behind the authenticated
 * protocol; the MCP endpoint delegates to it in-process. */
export function buildApp(
  env: Record<string, string>,
  auth: WebAuth,
): {
  app: App
  backing: MemoryBuildStore
} {
  const backing = new MemoryBuildStore()
  const config = parseWebAuthEnv(env)
  const service = createHostedStoreService({
    openTicketPolicy: async () => new MemoryTicketPolicyStore(),
    openProjectRegistry: async () => testProjects([REPO]),
    env,
    openStore: async () => backing,
  })
  const endpoint = createMcpEndpoint({
    projects: testProjects(['https://github.com/owner/repo']),
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

export function rewrite(request: Request, pathname: string): Request {
  const url = new URL(request.url)
  return new Request(`${url.origin}${pathname}`, {
    method: request.method,
    headers: request.headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
  })
}

/** Sign the session cookie exactly as better-call's setSignedCookie does, so
 * a session created through the auth context authenticates a browser request. */
export async function sessionCookie(token: string, secret: string): Promise<string> {
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

export async function seedUser(
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
export function provider(): OAuthClientProvider & {
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

export const CLIENT_METADATA: OAuthClientMetadata = {
  client_name: 'e2e-mcp-client',
  redirect_uris: [REDIRECT_URI],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
}

export async function discoverMetadata(
  app: App,
): Promise<Parameters<typeof registerClient>[1]['metadata']> {
  const response = await app(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`))
  expect(response.status).toBe(200)
  const metadata = (await response.json()) as Parameters<typeof registerClient>[1]['metadata']
  expect(metadata).toMatchObject({ authorization_endpoint: `${ORIGIN}/api/auth/mcp/authorize` })
  return metadata
}

export async function discoverProtectedResource(app: App): Promise<void> {
  const response = await app(new Request(`${ORIGIN}/.well-known/oauth-protected-resource`))
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    resource: `${ORIGIN}/mcp`,
    authorization_servers: [ORIGIN],
  })
}

export async function dynamicRegister(
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

export function routerFetch(app: App): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) =>
    app(new Request(input, init))) as unknown as typeof fetch
}

/** Drive the full authorization-code + PKCE + consent flow for one session
 * cookie, returning the tokens the client would hold. */
export async function authorizeFlow(
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
export async function connectClient(
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

export function toolsListRequest(token: string, id: number): Request {
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
