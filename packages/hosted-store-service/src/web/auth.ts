import { type HumanAccess, accessForEnv } from './access'
import { APIError, betterAuth, type BetterAuthPlugin } from 'better-auth'
import { createAuthMiddleware } from 'better-auth/api'
import { jwt, mcp, organization } from 'better-auth/plugins'
import { Pool } from 'pg'
import { clientNameProblem } from './client-name-policy'
import { normalizeEmail, parseWebAuthEnv, type WebEnv } from './config'

/** Admission policy is deliberately exported so provider callbacks can be
 * tested without OAuth or a database. */
export async function admittedUser<T extends { email: string }>(
  access: HumanAccess,
  user: T,
): Promise<false | { data: T }> {
  if (!(await access.principal(user.email))) return false
  return { data: { ...user, email: normalizeEmail(user.email) } }
}

export interface CreateWebAuthOptions {
  access?: HumanAccess
  /** Injectable database for tests (better-auth's memoryAdapter); production
   * opens the pg Pool. */
  database?: NonNullable<Parameters<typeof betterAuth>[0]>['database']
  /** Test hook: shorten the MCP access-token life so the refresh flow can be
   * driven end to end without waiting out the production hour. */
  accessTokenExpiresIn?: number
}

/** The MCP plugin's options. Extracted so the shape stays a typed value —
 * no cast, so excess-property checking still rejects unknown fields. */
function mcpPluginOptions(
  config: ReturnType<typeof parseWebAuthEnv>,
  options?: CreateWebAuthOptions,
): Parameters<typeof mcp>[0] {
  return {
    loginPage: '/sign-in',
    resource: config.mcpResource,
    oidcConfig: {
      loginPage: '/sign-in',
      consentPage: '/oauth/consent',
      useJWTPlugin: true,
      allowDynamicClientRegistration: true,
      metadata: { jwks_uri: `${config.baseURL}/api/auth/jwks` },
      // Each refresh rotates the refresh token with a fresh expiry, so a
      // connector stays signed in while it is used at least once a month.
      refreshTokenExpiresIn: 60 * 60 * 24 * 30,
      ...(options?.accessTokenExpiresIn !== undefined
        ? { accessTokenExpiresIn: options.accessTokenExpiresIn }
        : {}),
    },
  }
}

export function createWebAuth(env: WebEnv = process.env, options?: CreateWebAuthOptions) {
  const config = parseWebAuthEnv(env)
  const access = options?.access ?? accessForEnv(env)
  const database = options?.database ?? new Pool({ connectionString: config.postgresURL, max: 5 })
  const auth = betterAuth({
    database,
    secret: config.secret,
    baseURL: config.baseURL,
    trustedOrigins: [config.baseURL],
    advanced: { useSecureCookies: config.secureCookies },
    // Sliding: a session used at least once a month stays signed in. Access
    // is re-checked on every request, so revocation does not wait on expiry.
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    account: {
      updateAccountOnSignIn: true,
      encryptOAuthTokens: true,
      accountLinking: { enabled: false },
    },
    user: { changeEmail: { enabled: false } },
    plugins: [
      organization({ allowUserToCreateOrganization: false }),
      // The pinned 1.4.18 MCP plugin's DCR endpoint writes
      // `authenticationScheme` but its declared oauthApplication schema
      // (dist/plugins/oidc-provider/schema.mjs) omits the field, so the
      // adapter factory's transformInput drops it before either adapter
      // persists it (verified: a live memory-adapter DCR probe stored a row
      // with no authenticationScheme). This declaration — at the documented
      // plugin-schema extension point, merged in by getAuthTables — restores
      // it, and pairs with the auth-schema v3 column so Postgres DCR
      // round-trips the field. That drift is separate from the
      // provider-metadata one, corrected at the HTTP boundary below.
      {
        id: 'oauth-application-authentication-scheme',
        schema: {
          oauthApplication: {
            fields: { authenticationScheme: { type: 'string', required: false } },
          },
        },
      } satisfies BetterAuthPlugin,
      // The pinned 1.4.18 MCP plugin's DCR endpoint (/mcp/register) writes
      // `client_name` straight into the oauthApplication row, and DCR is
      // unauthenticated when allowDynamicClientRegistration is true — so a
      // client-supplied name is untrusted input on a security-decision
      // surface (the consent page renders it). This hook rejects a name
      // violating the client-name policy with the RFC 7591 error shape the
      // endpoint itself uses for other metadata problems. The matcher pins
      // the exact endpoint path the same way the jwks_uri fix is keyed to
      // its call site: if an upgrade moved the endpoint, the auth.test.ts
      // rejection tests fail loudly instead of the guard going silently
      // inert. A name is not an identity — the consent page keeps the raw
      // client_id visible precisely for that reason.
      {
        id: 'client-name-policy',
        hooks: {
          before: [
            {
              matcher: (context) => context.path === '/mcp/register',
              handler: createAuthMiddleware(async (ctx) => {
                const clientName = (ctx.body as { client_name?: unknown } | undefined)?.client_name
                if (typeof clientName !== 'string') return
                const problem = clientNameProblem(clientName)
                if (problem) {
                  throw new APIError('BAD_REQUEST', {
                    error: 'invalid_client_metadata',
                    error_description: problem,
                  })
                }
              }),
            },
          ],
        },
      } satisfies BetterAuthPlugin,
      // The MCP plugin turns this app into an OAuth 2.1 authorization server
      // and protected resource for /mcp; the jwt companion signs its tokens
      // and serves /api/auth/jwks. The HTTP adapter below corrects the pinned
      // plugin's authorization-server metadata to advertise this endpoint.
      jwt(),
      mcp(mcpPluginOptions(config, options)),
    ],
    socialProviders: {
      github: {
        clientId: config.github.clientId,
        clientSecret: config.github.clientSecret,
        overrideUserInfoOnSignIn: true,
      },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const user = await (await auth.$context).internalAdapter.findUserById(session.userId)
            if (!user || !(await access.principal(user.email))) return false
            await (await access.store()).materialize(user.id, user.email)
            return { data: session }
          },
        },
      },
      user: {
        create: {
          before: async (user) => admittedUser(access, user),
          after: async (user) => {
            await (await access.store()).materialize(user.id, user.email)
          },
        },
        update: {
          before: async (user) => {
            if (typeof user.email !== 'string') return false
            return admittedUser(access, user as typeof user & { email: string })
          },
        },
      },
    },
    onAPIError: { errorURL: '/sign-in?error=access_denied' },
  })
  return {
    ...auth,
    handler: authHTTPHandler(
      auth.handler,
      mcpPluginOptions(config, options)?.oidcConfig?.metadata?.jwks_uri ??
        `${config.baseURL}/api/auth/jwks`,
    ),
  }
}

export type WebAuth = ReturnType<typeof createWebAuth>

let singleton: WebAuth | undefined
export function webAuth(): WebAuth {
  singleton ??= createWebAuth(process.env)
  return singleton
}

/** Adapt public discovery rewrites and the pinned MCP metadata bug in the
 * published package, so every production HTTP caller gets the same contract. */
export function authHTTPHandler(
  handler: (request: Request) => Promise<Response>,
  jwksURI: string,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url)
    // Decode repeatedly to reject encoded separators and nested encodings before
    // the provider router gets any opportunity to canonicalize the path.
    let path = url.pathname
    try {
      for (let i = 0; i < 8; i++) {
        const next = decodeURIComponent(path)
        if (next === path) break
        path = next
      }
    } catch {
      return new Response(null, { status: 400 })
    }
    if (
      path
        .replaceAll('\\', '/')
        .split('/')
        .some((part) => part.toLowerCase() === 'organization')
    )
      return new Response(null, { status: 403 })
    const discovery =
      url.pathname === '/.well-known/oauth-authorization-server' ||
      url.pathname === '/.well-known/oauth-protected-resource'
    if (discovery) {
      url.pathname = `/api/auth${url.pathname}`
      request = new Request(url, request.clone())
    }
    const response = await handler(request)
    if (url.pathname !== '/api/auth/.well-known/oauth-authorization-server' || !response.ok)
      return response
    const metadata = await response.json()
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    return new Response(JSON.stringify({ ...metadata, jwks_uri: jwksURI }), {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
}
