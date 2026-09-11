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

  test('accepts the conventional DATABASE_URL but never ambient AWS credentials', () => {
    expect(
      parsePostgresStoreEnv({
        DATABASE_URL: 'postgres://ambient',
        AB_BLOB_BACKEND: 'vercel',
        AB_VERCEL_BLOB_ACCESS: 'private',
        BLOB_READ_WRITE_TOKEN: 'token',
      }).url,
    ).toBe('postgres://ambient')
    expect(
      parsePostgresStoreEnv({
        ...base,
        DATABASE_URL: 'postgres://ambient',
        AB_BLOB_BACKEND: 'vercel',
        AB_VERCEL_BLOB_ACCESS: 'private',
        BLOB_READ_WRITE_TOKEN: 'token',
      }).url,
    ).toBe('postgres://db/app')
    expect(() =>
      parsePostgresStoreEnv({
        DATABASE_URL: 'postgres://ambient',
        AB_BLOB_BACKEND: 's3',
        AB_S3_BUCKET: 'b',
        AB_S3_REGION: 'r',
        AWS_ACCESS_KEY_ID: 'ambient',
        AWS_SECRET_ACCESS_KEY: 'ambient',
      }),
    ).toThrow('AB_S3_ACCESS_KEY_ID')
    expect(() => parsePostgresStoreEnv({ AB_BLOB_BACKEND: 's3' })).toThrow(
      'AB_POSTGRES_URL or DATABASE_URL',
    )
  })

  test('AB_ARTIFACT_RETENTION_MAX_REVISIONS: absent means default, valid flows through, invalid rejected', () => {
    // Absent ⇒ no retention override; the store's documented default applies.
    expect(
      parsePostgresStoreEnv({
        ...base,
        AB_BLOB_BACKEND: 'vercel',
        AB_VERCEL_BLOB_ACCESS: 'private',
        BLOB_READ_WRITE_TOKEN: 'rw',
      }).retention,
    ).toBeUndefined()

    // A valid value flows through to the retention option on either backend.
    expect(
      parsePostgresStoreEnv({
        ...base,
        AB_BLOB_BACKEND: 's3',
        AB_S3_BUCKET: 'bucket',
        AB_S3_REGION: 'region',
        AB_S3_ACCESS_KEY_ID: 'key',
        AB_S3_SECRET_ACCESS_KEY: 'secret',
        AB_ARTIFACT_RETENTION_MAX_REVISIONS: ' 50 ',
      }).retention,
    ).toEqual({ maxRevisions: 50 })
    expect(
      parsePostgresStoreEnv({
        ...base,
        AB_BLOB_BACKEND: 'vercel',
        AB_VERCEL_BLOB_ACCESS: 'private',
        BLOB_READ_WRITE_TOKEN: 'rw',
        AB_ARTIFACT_RETENTION_MAX_REVISIONS: '1',
      }).retention,
    ).toEqual({ maxRevisions: 1 })

    // Non-integer, zero, and negative values are rejected with the variable named.
    // (A blank value is treated as absent, matching this file's optional() convention.)
    for (const bad of ['zero', '0', '-5', '2.5']) {
      expect(() =>
        parsePostgresStoreEnv({
          ...base,
          AB_BLOB_BACKEND: 'vercel',
          AB_VERCEL_BLOB_ACCESS: 'private',
          BLOB_READ_WRITE_TOKEN: 'rw',
          AB_ARTIFACT_RETENTION_MAX_REVISIONS: bad,
        }),
      ).toThrow('AB_ARTIFACT_RETENTION_MAX_REVISIONS')
    }
  })

  test('root full-stack manifest has no blob provider SDK dependency', async () => {
    const manifest = (await Bun.file('package.json').json()) as {
      dependencies?: Record<string, string>
    }
    const names = Object.keys(manifest.dependencies ?? {})
    expect(names).not.toContain('@aws-sdk/client-s3')
    expect(names).not.toContain('@vercel/blob')
    expect(manifest.dependencies?.pg).toBe('8.18.0')
    expect(names).not.toContain('postgres')
  })
})
