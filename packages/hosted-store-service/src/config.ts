import { parsePostgresStoreEnv, type PostgresStoreConfig } from '@defrex/autobuild-postgres-store'

export type HostedStoreEnv = Record<string, string | undefined>
/** Decoded bytes per build artifact. Artifacts travel inline as base64 JSON,
 * so this stays under Vercel's 4.5 MB function payload cap
 * (https://vercel.com/docs/functions/limitations): 2.5 MiB encodes to about
 * 3.5 MB. It admits full-page website and dashboard capture frames, which
 * reached 2.3 MB on 2026-10-28. */
export const HOSTED_ARTIFACT_MAX_BYTES = 2.5 * 1024 * 1024
/** The largest ticket-asset request or response body the hosted deployment
 * carries: under Vercel's 4.5 MB function payload cap
 * (https://vercel.com/docs/functions/limitations). The effective per-asset
 * limit it implies is about 2.8 MiB after base64 and JSON overhead. */
export const HOSTED_TICKET_ASSET_REQUEST_MAX_BYTES = 4 * 1024 * 1024

/**
 * Ceiling for a held event read (`wait` on the build/repo event routes), in
 * whole seconds (AUT-334). Requests above it clamp to 25, never reject. The
 * value must stay well under the machine routes' `maxDuration` (60 s), which
 * exists to cover this hold; see packages/hosted-store-service/README.md.
 */
export const HOSTED_EVENT_WAIT_MAX_SECONDS = 25

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

export function retiredTicketDiagnostic(env: HostedStoreEnv): string | undefined {
  if (env.AB_TICKET_BACKEND === undefined && env.LINEAR_API_KEY === undefined) return undefined
  return "The hosted service no longer contacts Linear. AB_TICKET_BACKEND and LINEAR_API_KEY are ignored; remove them from the service environment. External ticket sources are accessed directly by each project's dispatcher."
}
