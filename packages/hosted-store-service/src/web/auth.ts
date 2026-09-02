import { betterAuth } from 'better-auth'
import { Pool } from 'pg'
import { isAllowedEmail, normalizeEmail, parseWebAuthEnv, type WebEnv } from './config'

export type WebAuth = ReturnType<typeof betterAuth>

/** Admission policy is deliberately exported so provider callbacks can be
 * tested without OAuth or a database. */
export function admittedUser<T extends { email: string }>(
  allowed: ReadonlySet<string>,
  user: T,
): false | { data: T } {
  if (!isAllowedEmail(allowed, user.email)) return false
  return { data: { ...user, email: normalizeEmail(user.email) } }
}

export function createWebAuth(env: WebEnv = process.env): WebAuth {
  const config = parseWebAuthEnv(env)
  const database = new Pool({ connectionString: config.postgresURL, max: 5 })
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

let singleton: WebAuth | undefined
export function webAuth(): WebAuth {
  singleton ??= createWebAuth(process.env)
  return singleton
}
