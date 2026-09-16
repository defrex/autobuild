import { betterAuth, type BetterAuthPlugin } from 'better-auth'
import { jwt, mcp } from 'better-auth/plugins'
import { Pool } from 'pg'
import { isAllowedEmail, normalizeEmail, parseWebAuthEnv, type WebEnv } from './config'

/** The pinned 1.4.18 MCP plugin's provider-metadata endpoint
 * (getMCPProviderMetadata, backing /.well-known/oauth-authorization-server)
 * hardcodes jwks_uri `<baseURL>/mcp/jwks` — an endpoint that does not exist —
 * and then spreads the TOP-LEVEL `metadata` of the options it receives, but
 * MCPOptions omits the field: its declared shape only carries it under
 * oidcConfig, which flows to the protected-resource document alone
 * (getMCPProtectedResourceMetadata reads oidcConfig?.metadata). The runtime
 * test in auth.test.ts pins this plugin behavior. */
type McpPluginOptions = Parameters<typeof mcp>[0] & {
  metadata?: { jwks_uri: string }
}

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

/** The MCP plugin's options, carrying the jwks_uri override through BOTH
 * channels the pinned plugin reads (see McpPluginOptions for the seam).
 * Extracted so the shape stays a typed value — no cast, so excess-property
 * checking still rejects unknown fields. */
function mcpPluginOptions(
  config: ReturnType<typeof parseWebAuthEnv>,
  options?: CreateWebAuthOptions,
): McpPluginOptions {
  return {
    loginPage: '/sign-in',
    resource: config.mcpResource,
    metadata: { jwks_uri: `${config.baseURL}/api/auth/jwks` },
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
      // round-trips the field. Patching the plugin is out of scope.
      {
        id: 'oauth-application-authentication-scheme',
        schema: {
          oauthApplication: {
            fields: { authenticationScheme: { type: 'string', required: false } },
          },
        },
      } satisfies BetterAuthPlugin,
      // The MCP plugin turns this app into an OAuth 2.1 authorization server
      // and protected resource for /mcp; the jwt companion signs its tokens
      // and serves /api/auth/jwks. The pinned plugin would advertise the
      // nonexistent <baseURL>/mcp/jwks in both metadata documents, so the
      // jwks_uri override is fed through BOTH channels the plugin reads:
      // getMCPProviderMetadata (authorization-server document) spreads the
      // top-level `metadata` of these options, while
      // getMCPProtectedResourceMetadata (protected-resource document) reads
      // oidcConfig?.metadata. Both carry the same value — the endpoint that
      // actually exists — so the two documents agree; if a future plugin
      // version reads the other channel, the same value still flows, and if
      // the top-level spread disappears, the auth.test.ts regression test
      // fails loudly instead of silently re-advertising /mcp/jwks.
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
