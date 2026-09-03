/** PostgreSQL connection URL selection shared by the adapter, the migration
 * CLI, and the hosted web session store. */
export type PostgresEnv = Record<string, string | undefined>

/** Variables consulted in precedence order: the explicit Autobuild name wins
 * over the conventional `DATABASE_URL` that hosting integrations inject. */
export const POSTGRES_URL_VARIABLES = ['AB_POSTGRES_URL', 'DATABASE_URL'] as const

export const MISSING_POSTGRES_URL_MESSAGE =
  'AB_POSTGRES_URL or DATABASE_URL is required and must be nonblank'

/** Resolve the first nonblank connection URL. Blank values are skipped so an
 * empty override cannot shadow the conventional variable. */
export function resolvePostgresUrl(env: PostgresEnv): string {
  for (const name of POSTGRES_URL_VARIABLES) {
    const value = env[name]?.trim()
    if (value) return value
  }
  throw new Error(MISSING_POSTGRES_URL_MESSAGE)
}

/** Credential-free description of a connection URL for logs: host and database. */
export function describePostgresTarget(url: string): string {
  try {
    const parsed = new URL(url)
    const database = parsed.pathname.replace(/^\/+/, '')
    return database ? `${parsed.host}/${database}` : parsed.host
  } catch {
    return 'the configured database'
  }
}
