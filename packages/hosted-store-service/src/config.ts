import { parsePostgresStoreEnv, type PostgresStoreConfig } from '@autobuild/postgres-store'

export type HostedStoreEnv = Record<string, string | undefined>
export const HOSTED_ARTIFACT_MAX_BYTES = 1024 * 1024

export interface HostedStoreConfig {
  secret: string
  hostname: string
  port: number
  postgres: PostgresStoreConfig
  ticketBackend: 'database' | 'linear'
  ticketLifecycle: { triage: string; ready: string; doing: string; done: string }
  linearApiKey?: string
}

function required(env: HostedStoreEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required and must be nonblank`)
  return value
}

function state(env: HostedStoreEnv, name: string, fallback: string): string {
  if (env[name] === undefined) return fallback
  const value = env[name]!.trim()
  if (!value) throw new Error(`${name} must be nonblank`)
  return value
}

export function parseHostedStoreEnv(env: HostedStoreEnv): HostedStoreConfig {
  const rawPort = env.PORT?.trim() || '3000'
  if (!/^\d+$/.test(rawPort)) throw new Error('PORT must be an integer from 1 through 65535')
  const port = Number(rawPort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 through 65535')
  }
  const ticketBackend = env.AB_TICKET_BACKEND?.trim() || 'database'
  if (ticketBackend !== 'database' && ticketBackend !== 'linear') {
    throw new Error('AB_TICKET_BACKEND must be "database" or "linear"')
  }
  const ticketLifecycle = {
    triage: state(env, 'AB_TICKET_TRIAGE_STATE', 'Triage'),
    ready: state(env, 'AB_TICKET_READY_STATE', 'Ready'),
    doing: state(env, 'AB_TICKET_DOING_STATE', 'Doing'),
    done: state(env, 'AB_TICKET_DONE_STATE', 'Done'),
  }
  if (new Set(Object.values(ticketLifecycle)).size !== 4) {
    throw new Error('AB_TICKET lifecycle states must be distinct')
  }
  const linearApiKey = ticketBackend === 'linear' ? required(env, 'LINEAR_API_KEY') : undefined
  return {
    secret: required(env, 'AB_STORE_SECRET'),
    hostname: env.AB_HOST?.trim() || '0.0.0.0',
    port,
    postgres: parsePostgresStoreEnv(env),
    ticketBackend,
    ticketLifecycle,
    ...(linearApiKey !== undefined ? { linearApiKey } : {}),
  }
}
