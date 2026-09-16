import { betterAuth } from 'better-auth'
import { jwt, mcp } from 'better-auth/plugins'
import { Pool } from 'pg'
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
      // The MCP plugin turns this app into an OAuth 2.1 authorization server
      // and protected resource for /mcp; the jwt companion signs its tokens
      // and serves /api/auth/jwks. The jwks_uri override points discovery at
      // the endpoint that actually exists (the plugin would otherwise
      // advertise <baseURL>/mcp/jwks).
      jwt(),
      mcp({
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
      }),
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
