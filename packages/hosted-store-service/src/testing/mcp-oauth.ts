/** Shared OAuth + MCP fixtures for the hosted MCP endpoint tests. */
import { testAccess } from './access'
import type { HumanAccess } from '../web/access'
import { MemoryTicketPolicyStore } from '@defrex/autobuild-postgres-store/ticket-policy'
import { testProjects } from './projects'
import { expect } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  auth as sdkAuth,
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
import type { CanonicalSkillBundle } from '@defrex/autobuild/operator'
import { createHostedStoreService, type HostedStoreServiceOptions } from '../service'
import { createWebAuth, type WebAuth } from '../web/auth'
import { parseWebAuthEnv } from '../web/config'
import { createMcpEndpoint } from '../web/mcp'
import { repositoryMcpResource } from '../web/mcp-resource'

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
  AB_WEB_SUPER_USER_EMAILS: 'ada@example.com',
  AB_WEB_REPOSITORIES: REPO,
  AB_POSTGRES_URL: 'postgres://database-canary',
  AB_STORE_SECRET: 'store-secret-canary',
  // The hosted service's env parser requires a blob backend even when the
  // opener is injected; dummies satisfy it (service.io.integration.test.ts precedent).
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

/** The canonical skill bundle the test service serves for a repository with
 * no captured agent context. */
export const TEST_CANONICAL_SKILLS: CanonicalSkillBundle = {
  version: '0.0.0-test',
  skills: [
    {
      installName: 'ab-operate',
      files: [
        {
          path: 'SKILL.md',
          content: '---\nname: ab-operate\ndescription: Operate builds.\n---\nUse ab abort.',
        },
      ],
    },
  ],
}

/** Better Auth on the memory adapter with the plugin configuration
 * createWebAuth uses. */
export function buildAuth(env: Record<string, string>, accessTokenExpiresIn?: number): WebAuth {
  return createWebAuth(env, {
    access: testAccess(env),
    database: memoryAdapter(emptyDB()),
    ...(accessTokenExpiresIn === undefined ? {} : { accessTokenExpiresIn }),
  })
}

/** The hosted service with a real (memory) store behind the authenticated
 * protocol; the MCP endpoint delegates to it in-process and advertises the
 * service's served table, as production does. `serviceEnv` replaces the env
 * handed to the hosted service only (default `env`); Better Auth and the MCP
 * endpoint config always use `env`. */
export function buildApp(
  env: Record<string, string>,
  auth: WebAuth,
  access: HumanAccess = testAccess(env, testProjects([REPO])),
  options: {
    serviceEnv?: Record<string, string>
    projects?: string[]
    /** Observes every request the MCP endpoint delegates to the service. */
    onDelegate?: (request: Request) => void
    /** Replaces the per-repository sandbox listing gate (default: the
     * service's `listsSandboxTools`). */
    sandboxListed?: (repo: string) => Promise<boolean>
  } & Pick<
    HostedStoreServiceOptions,
    | 'composeOperatorSandbox'
    | 'issueDispatcherCredential'
    | 'reportInternalError'
    | 'background'
    | 'canonicalSkills'
  > = {},
): {
  app: App
  backing: MemoryBuildStore
  service: ReturnType<typeof createHostedStoreService>
} {
  const backing = new MemoryBuildStore()
  const config = parseWebAuthEnv(env)
  const projects = options.projects ?? [REPO]
  const service = createHostedStoreService({
    openTicketPolicy: async () => new MemoryTicketPolicyStore(),
    openProjectRegistry: async () => testProjects(projects),
    env: options.serviceEnv ?? env,
    openStore: async () => backing,
    ...(options.composeOperatorSandbox !== undefined
      ? { composeOperatorSandbox: options.composeOperatorSandbox }
      : {}),
    ...(options.issueDispatcherCredential !== undefined
      ? { issueDispatcherCredential: options.issueDispatcherCredential }
      : {}),
    ...(options.reportInternalError !== undefined
      ? { reportInternalError: options.reportInternalError }
      : {}),
    ...(options.background !== undefined ? { background: options.background } : {}),
    // In memory, never the distribution's skills tree: unit tests do no IO.
    canonicalSkills: options.canonicalSkills ?? (async () => TEST_CANONICAL_SKILLS),
  })
  const endpoint = createMcpEndpoint({
    access,
    projects: testProjects(projects),
    config,
    auth,
    storeSecret: env.AB_STORE_SECRET!,
    delegate: (request) => {
      options.onDelegate?.(request)
      return service.fetch(request)
    },
    entries: service.operatorTools,
    sandboxListed: options.sandboxListed ?? ((repo) => service.listsSandboxTools(repo)),
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
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource/')) {
      return auth.handler(rewrite(request, `/api/auth${url.pathname}`))
    }
    if (url.pathname.startsWith('/api/auth/')) return auth.handler(request)
    if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) return endpoint.fetch(request)
    return Response.json({ error: `no route: ${request.method} ${url.pathname}` }, { status: 404 })
  }
  return { app, backing, service }
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

/**
 * A fetch that routes in-process through `app`. An abort of the request's
 * signal cancels the server's response body, as a real fetch does. Without
 * that, closing an SDK client never reaches the server's standalone SSE
 * stream, and the SDK server's keep-alive interval outlives the test (#1215).
 */
export function routerFetch(app: App): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init)
    const response = await app(request)
    return abortable(response, request.signal)
  }) as unknown as typeof fetch
}

function abortable(response: Response, signal: AbortSignal): Response {
  if (response.body === null) return response
  const reader = response.body.getReader()
  let onAbort: (() => void) | undefined
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      onAbort = () => {
        reader.cancel(signal.reason).catch(() => {})
        try {
          controller.error(signal.reason)
        } catch {}
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    },
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) {
        signal.removeEventListener('abort', onAbort!)
        controller.close()
      } else controller.enqueue(value)
    },
    cancel(reason) {
      signal.removeEventListener('abort', onAbort!)
      return reader.cancel(reason)
    },
  })
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
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

/** The per-repository MCP URL the test deployment serves for `repo`. */
export function perRepositoryURL(repo: string = REPO): string {
  return repositoryMcpResource(`${ORIGIN}/mcp`, repo)
}

/** The signed-in operator visits an authorization URL and consents;
 * returns the authorization code the redirect carries. */
export async function approveAuthorization(
  app: App,
  cookie: string,
  authorizationUrl: URL,
): Promise<string> {
  authorizationUrl.searchParams.set('prompt', 'consent')
  const authorizeResponse = await app(
    new Request(authorizationUrl, { headers: { cookie }, redirect: 'manual' }),
  )
  expect(authorizeResponse.status).toBe(302)
  const consentCode = new URL(authorizeResponse.headers.get('location')!, ORIGIN).searchParams.get(
    'consent_code',
  )
  const consentResponse = await app(
    new Request(`${ORIGIN}/api/auth/oauth2/consent`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ accept: true, consent_code: consentCode }),
    }),
  )
  expect(consentResponse.status).toBe(200)
  const { redirectURI } = (await consentResponse.json()) as { redirectURI: string }
  return new URL(redirectURI).searchParams.get('code')!
}

/** Authorize from the server URL alone, as a standard MCP client does: the
 * SDK's top-level `auth()` discovers metadata from the URL, registers
 * dynamically, and starts authorization; the signed-in operator consents;
 * `auth()` then exchanges the code. Returns the tokens and the token
 * request bodies the client sent. */
export async function authorizeWithDiscovery(
  app: App,
  cookie: string,
  serverUrl: string,
): Promise<{
  tokens: OAuthTokens
  client: OAuthClientInformationMixed
  tokenRequests: URLSearchParams[]
  challenge: string | null
}> {
  const tokenRequests: URLSearchParams[] = []
  const base = routerFetch(app)
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init)
    if (new URL(request.url).pathname === '/api/auth/mcp/token')
      tokenRequests.push(new URLSearchParams(await request.clone().text()))
    return base(request)
  }) as typeof fetch
  const unauthenticated = await app(
    new Request(serverUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    }),
  )
  expect(unauthenticated.status).toBe(401)
  const challenge = unauthenticated.headers.get('www-authenticate')
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge ?? '')?.[1]
  let authorizationUrl: URL | undefined
  const authProvider = provider()
  authProvider.redirectToAuthorization = (url: URL) => {
    authorizationUrl = url
  }
  const resourceMetadataUrl = metadataUrl === undefined ? undefined : new URL(metadataUrl)
  expect(
    await sdkAuth(authProvider, {
      serverUrl,
      ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
      fetchFn,
    }),
  ).toBe('REDIRECT')
  const code = await approveAuthorization(app, cookie, authorizationUrl!)
  expect(
    await sdkAuth(authProvider, {
      serverUrl,
      authorizationCode: code,
      ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
      fetchFn,
    }),
  ).toBe('AUTHORIZED')
  return {
    tokens: (await authProvider.tokens())!,
    client: (await authProvider.clientInformation())!,
    tokenRequests,
    challenge,
  }
}

/** An MCP SDK client connected over Streamable HTTP with pre-loaded tokens. */
export async function connectClient(
  app: App,
  tokens: OAuthTokens,
  clientInformation: OAuthClientInformationMixed,
  serverUrl: string = `${ORIGIN}/mcp`,
): Promise<Client> {
  const authProvider = provider()
  authProvider.saveTokens(tokens)
  if (clientInformation !== undefined) authProvider.saveClientInformation(clientInformation)
  const mcpClient = new Client({ name: 'e2e-mcp-client', version: '1.0.0' })
  await mcpClient.connect(
    new StreamableHTTPClientTransport(new URL(serverUrl), {
      authProvider,
      fetch: routerFetch(app),
    }),
  )
  return mcpClient
}

export function toolsListRequest(token: string, id: number, url = `${ORIGIN}/mcp`): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params: {} }),
  })
}
