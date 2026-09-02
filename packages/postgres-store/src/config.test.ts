import { describe, expect, test } from 'bun:test'
import { parsePostgresStoreEnv } from './config'

const base = { AB_POSTGRES_URL: 'postgres://db/app' }

describe('PostgreSQL store environment', () => {
  test('parses explicit S3-compatible configuration', () => {
    expect(
      parsePostgresStoreEnv({
        ...base,
        AB_BLOB_BACKEND: 's3',
        AB_S3_BUCKET: 'bucket',
        AB_S3_REGION: 'region',
        AB_S3_ENDPOINT: 'https://objects.example',
        AB_S3_ACCESS_KEY_ID: 'key',
        AB_S3_SECRET_ACCESS_KEY: 'secret',
        AB_S3_SESSION_TOKEN: 'session',
        AB_S3_FORCE_PATH_STYLE: 'true',
        AB_BLOB_PREFIX: '/builds/',
      }),
    ).toEqual({
      url: 'postgres://db/app',
      backend: 's3',
      bucket: 'bucket',
      region: 'region',
      endpoint: 'https://objects.example',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      sessionToken: 'session',
      forcePathStyle: true,
      prefix: '/builds/',
    })
  })

  test('supports token and complete OIDC Vercel authentication', () => {
    expect(
      parsePostgresStoreEnv({
        ...base,
        AB_BLOB_BACKEND: 'vercel',
        AB_VERCEL_BLOB_ACCESS: 'private',
        BLOB_READ_WRITE_TOKEN: 'rw',
      }),
    ).toMatchObject({ backend: 'vercel', access: 'private', token: 'rw' })
    expect(
      parsePostgresStoreEnv({
        ...base,
        AB_BLOB_BACKEND: 'vercel',
        AB_VERCEL_BLOB_ACCESS: 'public',
        VERCEL_OIDC_TOKEN: 'oidc',
        BLOB_STORE_ID: 'store',
      }),
    ).toMatchObject({ backend: 'vercel', access: 'public', oidcToken: 'oidc', storeId: 'store' })
  })

  test('rejects missing, malformed, and incomplete values', () => {
    expect(() => parsePostgresStoreEnv({ AB_BLOB_BACKEND: 's3' })).toThrow('AB_POSTGRES_URL')
    expect(() => parsePostgresStoreEnv({ ...base, AB_BLOB_BACKEND: 'other' })).toThrow('s3')
    expect(() =>
      parsePostgresStoreEnv({
        ...base,
        AB_BLOB_BACKEND: 's3',
        AB_S3_BUCKET: 'b',
        AB_S3_REGION: 'r',
        AB_S3_ACCESS_KEY_ID: 'k',
        AB_S3_SECRET_ACCESS_KEY: 's',
        AB_S3_FORCE_PATH_STYLE: 'yes',
      }),
    ).toThrow('true')
    expect(() =>
      parsePostgresStoreEnv({
        ...base,
        AB_BLOB_BACKEND: 'vercel',
        AB_VERCEL_BLOB_ACCESS: 'private',
        VERCEL_OIDC_TOKEN: 'only',
      }),
    ).toThrow('BLOB_STORE_ID')
  })

  test('does not consult ambient database or AWS credential variables', () => {
    expect(() =>
      parsePostgresStoreEnv({
        DATABASE_URL: 'postgres://ambient',
        AB_BLOB_BACKEND: 's3',
        AWS_ACCESS_KEY_ID: 'ambient',
      }),
    ).toThrow('AB_POSTGRES_URL')
  })

  test('root CLI manifest has no provider SDK or PostgreSQL driver dependency', async () => {
    const manifest = (await Bun.file('package.json').json()) as {
      dependencies?: Record<string, string>
    }
    const names = Object.keys(manifest.dependencies ?? {})
    expect(names).not.toContain('@aws-sdk/client-s3')
    expect(names).not.toContain('@vercel/blob')
    expect(names).not.toContain('pg')
    expect(names).not.toContain('postgres')
  })
})
