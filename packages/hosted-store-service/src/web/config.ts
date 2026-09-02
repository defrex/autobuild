export type WebAuthProvider = 'github'
export type WebEnv = Record<string, string | undefined>

export interface WebAuthConfig {
  secret: string
  baseURL: string
  providers: readonly WebAuthProvider[]
  allowedEmails: ReadonlySet<string>
  repositories: readonly string[]
  github: { clientId: string; clientSecret: string }
  postgresURL: string
  secureCookies: boolean
}

function required(env: WebEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required and must be nonblank`)
  return value
}

function csv(env: WebEnv, name: string): string[] {
  const raw = required(env, name)
  const values = raw.split(',').map((value) => value.trim())
  if (values.some((value) => value.length === 0)) throw new Error(`${name} contains a blank entry`)
  return [...new Set(values)]
}

export function normalizeEmail(value: string): string {
  return value.trim().toLocaleLowerCase('en-US')
}

export function isAllowedEmail(
  allowed: ReadonlySet<string>,
  email: string | null | undefined,
): boolean {
  return typeof email === 'string' && allowed.has(normalizeEmail(email))
}

export function parseWebAuthEnv(env: WebEnv): WebAuthConfig {
  const secret = required(env, 'BETTER_AUTH_SECRET')
  if (secret.length < 32 || new Set(secret).size < 8) {
    throw new Error('BETTER_AUTH_SECRET must contain at least 32 high-entropy characters')
  }
  const rawURL = required(env, 'BETTER_AUTH_URL')
  let url: URL
  try {
    url = new URL(rawURL)
  } catch {
    throw new Error('BETTER_AUTH_URL must be an absolute http(s) origin')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'BETTER_AUTH_URL must be an absolute http(s) origin without credentials or a path',
    )
  }
  if (env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new Error('BETTER_AUTH_URL must use https in production')
  }
  const providers = csv(env, 'AB_WEB_AUTH_PROVIDERS')
  if (providers.some((provider) => provider !== 'github')) {
    throw new Error('AB_WEB_AUTH_PROVIDERS currently supports only "github"')
  }
  const emails = csv(env, 'AB_WEB_ALLOWED_EMAILS').map(normalizeEmail)
  if (emails.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw new Error('AB_WEB_ALLOWED_EMAILS contains an invalid email address')
  }
  const repositories = csv(env, 'AB_WEB_REPOSITORIES')
  if (repositories.some((repo) => /[\0\r\n]/.test(repo))) {
    throw new Error('AB_WEB_REPOSITORIES contains an unsafe repository name')
  }
  return {
    secret,
    baseURL: url.origin,
    providers: providers as WebAuthProvider[],
    allowedEmails: new Set(emails),
    repositories,
    github: {
      clientId: required(env, 'GITHUB_CLIENT_ID'),
      clientSecret: required(env, 'GITHUB_CLIENT_SECRET'),
    },
    postgresURL: required(env, 'AB_POSTGRES_URL'),
    secureCookies: url.protocol === 'https:',
  }
}

export function safeWebConfig(config: WebAuthConfig) {
  return { providers: [...config.providers], repositories: [...config.repositories] }
}
