import { S3Client } from '@aws-sdk/client-s3'
import type { Clock } from 'autobuild/plugin-sdk'
import { S3BlobStore } from './s3'
import { openPostgresBuildStore, type PostgresBuildStore } from './store'
import { VercelBlobStore } from './vercel'

type Env = Record<string, string | undefined>
const required = (env: Env, name: string): string => {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required and must be nonblank`)
  return value
}
const optional = (env: Env, name: string): string | undefined => env[name]?.trim() || undefined
const bool = (env: Env, name: string): boolean | undefined => {
  const value = optional(env, name)
  if (value === undefined) return undefined
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`${name} must be "true" or "false"`)
}

export type PostgresStoreConfig =
  | {
      url: string
      backend: 's3'
      bucket: string
      region: string
      accessKeyId: string
      secretAccessKey: string
      endpoint?: string
      sessionToken?: string
      forcePathStyle?: boolean
      prefix?: string
    }
  | {
      url: string
      backend: 'vercel'
      access: 'public' | 'private'
      prefix?: string
      token?: string
      oidcToken?: string
      storeId?: string
    }

export function parsePostgresStoreEnv(env: Env): PostgresStoreConfig {
  const url = required(env, 'AB_POSTGRES_URL')
  const backend = required(env, 'AB_BLOB_BACKEND')
  const prefix = optional(env, 'AB_BLOB_PREFIX')
  if (backend === 's3') {
    const endpoint = optional(env, 'AB_S3_ENDPOINT')
    const sessionToken = optional(env, 'AB_S3_SESSION_TOKEN')
    const forcePathStyle = bool(env, 'AB_S3_FORCE_PATH_STYLE')
    return {
      url,
      backend,
      bucket: required(env, 'AB_S3_BUCKET'),
      region: required(env, 'AB_S3_REGION'),
      accessKeyId: required(env, 'AB_S3_ACCESS_KEY_ID'),
      secretAccessKey: required(env, 'AB_S3_SECRET_ACCESS_KEY'),
      ...(endpoint ? { endpoint } : {}),
      ...(sessionToken ? { sessionToken } : {}),
      ...(forcePathStyle !== undefined ? { forcePathStyle } : {}),
      ...(prefix ? { prefix } : {}),
    }
  }
  if (backend === 'vercel') {
    const access = required(env, 'AB_VERCEL_BLOB_ACCESS')
    if (access !== 'public' && access !== 'private') {
      throw new Error('AB_VERCEL_BLOB_ACCESS must be "public" or "private"')
    }
    const token = optional(env, 'BLOB_READ_WRITE_TOKEN')
    const oidcToken = optional(env, 'VERCEL_OIDC_TOKEN')
    const storeId = optional(env, 'BLOB_STORE_ID')
    if (!token && !(oidcToken && storeId)) {
      throw new Error(
        'Vercel Blob requires BLOB_READ_WRITE_TOKEN or both VERCEL_OIDC_TOKEN and BLOB_STORE_ID',
      )
    }
    return {
      url,
      backend,
      access,
      ...(prefix ? { prefix } : {}),
      ...(token ? { token } : { oidcToken: oidcToken!, storeId: storeId! }),
    }
  }
  throw new Error('AB_BLOB_BACKEND must be "s3" or "vercel"')
}

export async function openPostgresBuildStoreFromEnv(
  env: Env,
  options: { clock?: Clock } = {},
): Promise<PostgresBuildStore> {
  const config = parsePostgresStoreEnv(env)
  if (config.backend === 's3') {
    const client = new S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      ...(config.forcePathStyle !== undefined ? { forcePathStyle: config.forcePathStyle } : {}),
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
      },
    })
    return openPostgresBuildStore(
      config.url,
      new S3BlobStore({
        client,
        bucket: config.bucket,
        ...(config.prefix ? { prefix: config.prefix } : {}),
      }),
      options,
    )
  }
  return openPostgresBuildStore(
    config.url,
    new VercelBlobStore({
      access: config.access,
      ...(config.prefix ? { prefix: config.prefix } : {}),
      ...(config.token
        ? { token: config.token }
        : { oidcToken: config.oidcToken!, storeId: config.storeId! }),
    }),
    options,
  )
}
