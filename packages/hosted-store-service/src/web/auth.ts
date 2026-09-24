import { APIError, betterAuth, type BetterAuthPlugin } from 'better-auth'
import { createAuthMiddleware } from 'better-auth/api'
import { jwt, mcp } from 'better-auth/plugins'
import { Pool } from 'pg'
import { clientNameProblem } from './client-name-policy'
import { isAllowedEmail, normalizeEmail, parseWebAuthEnv, type WebEnv } from './config'

/** Admission policy is deliberately exported so provider callbacks can be
 * tested without OAuth or a database. */
export function admittedUser<T extends { email: string }>(
  allowed: ReadonlySet<string>,
  user: T,
): false | { data: T } {
  if (!isAllowedEmail(allowed, user.email)) return false
  return { data: { ...user, email: normalizeEmail(user.email) } }
}

export interface CreateWebAuthOptions {
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
      ...(options?.accessTokenExpiresIn !== undefined
        ? { accessTokenExpiresIn: options.accessTokenExpiresIn }
        : {}),
    },
  }
}

export function createWebAuth(env: WebEnv = process.env, options?: CreateWebAuthOptions) {
  const config = parseWebAuthEnv(env)
  const database = options?.database ?? new Pool({ connectionString: config.postgresURL, max: 5 })
  return betterAuth({
    database,
    secret: config.secret,
    baseURL: config.baseURL,
    trustedOrigins: [config.baseURL],
    advanced: { useSecureCookies: config.secureCookies },
    session: {
      expiresIn: 60 * 60 * 12,
      updateAge: 60 * 30,
    },
    account: {
      updateAccountOnSignIn: true,
      encryptOAuthTokens: true,
      accountLinking: { enabled: false },
    },
    user: { changeEmail: { enabled: false } },
    plugins: [
      // The pinned 1.4.18 MCP plugin's DCR endpoint writes
      // `authenticationScheme` but its declared oauthApplication schema
      // (dist/plugins/oidc-provider/schema.mjs) omits the field, so the
      // adapter factory's transformInput drops it before either adapter
      // persists it (verified: a live memory-adapter DCR probe stored a row
      // with no authenticationScheme). This declaration — at the documented
      // plugin-schema extension point, merged in by getAuthTables — restores
      // it, and pairs with the auth-schema v3 column so Postgres DCR
      // round-trips the field. That drift is separate from the
      // provider-metadata one and is deliberately worked around here rather
      // than folded into patches/better-auth@1.4.18.patch, which only fixes
      // the getMCPProviderMetadata read path.
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
      // and serves /api/auth/jwks. The pinned 1.4.18 plugin hardcodes the
      // nonexistent <baseURL>/mcp/jwks as jwks_uri in the provider metadata
      // (getMCPProviderMetadata, backing /.well-known/oauth-authorization-server);
      // under patches/better-auth@1.4.18.patch its call site instead passes
      // options?.oidcConfig — the channel the function's declared
      // (ctx, options?: OIDCOptions) signature already expects — so the single
      // declared oidcConfig.metadata field feeds BOTH documents: the
      // authorization-server one and getMCPProtectedResourceMetadata's
      // protected-resource one. The override is keyed to the exact plugin
      // version and must be re-derived or dropped on upgrade; if it goes
      // missing, the auth.test.ts regression test fails loudly instead of
      // silently re-advertising /mcp/jwks.
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
      user: {
        create: { before: async (user) => admittedUser(config.allowedEmails, user) },
        update: {
          before: async (user) => {
            if (typeof user.email !== 'string') return false
            return admittedUser(config.allowedEmails, user as typeof user & { email: string })
          },
        },
      },
    },
    onAPIError: { errorURL: '/sign-in?error=access_denied' },
  })
}

export type WebAuth = ReturnType<typeof createWebAuth>

let singleton: WebAuth | undefined
export function webAuth(): WebAuth {
  singleton ??= createWebAuth(process.env)
  return singleton
}
