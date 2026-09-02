import { parsePostgresStoreEnv, type PostgresStoreConfig } from '@autobuild/postgres-store'

export type HostedStoreEnv = Record<string, string | undefined>
export const HOSTED_ARTIFACT_MAX_BYTES = 1024 * 1024

export interface HostedStoreConfig {
  secret: string
  hostname: string
  port: number
  postgres: PostgresStoreConfig
}

function required(env: HostedStoreEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required and must be nonblank`)
  return value
}

export function parseHostedStoreEnv(env: HostedStoreEnv): HostedStoreConfig {
  const rawPort = env.PORT?.trim() || '3000'
  if (!/^\d+$/.test(rawPort)) throw new Error('PORT must be an integer from 1 through 65535')
  const port = Number(rawPort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 through 65535')
  }
  return {
    secret: required(env, 'AB_STORE_SECRET'),
    hostname: env.AB_HOST?.trim() || '0.0.0.0',
    port,
    postgres: parsePostgresStoreEnv(env),
  }
}
