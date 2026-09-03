import { describe, expect, test } from 'bun:test'
import { describePostgresTarget, MISSING_POSTGRES_URL_MESSAGE, resolvePostgresUrl } from './env'

describe('PostgreSQL URL resolution', () => {
  test('prefers the explicit Autobuild variable', () => {
    expect(
      resolvePostgresUrl({
        AB_POSTGRES_URL: ' postgres://explicit ',
        DATABASE_URL: 'postgres://ambient',
      }),
    ).toBe('postgres://explicit')
  })

  test('falls back to the conventional DATABASE_URL', () => {
    expect(resolvePostgresUrl({ DATABASE_URL: 'postgres://ambient' })).toBe('postgres://ambient')
    expect(resolvePostgresUrl({ AB_POSTGRES_URL: '  ', DATABASE_URL: 'postgres://ambient' })).toBe(
      'postgres://ambient',
    )
  })

  test('names both variables when neither is set', () => {
    expect(() => resolvePostgresUrl({})).toThrow(MISSING_POSTGRES_URL_MESSAGE)
    expect(() =>
      resolvePostgresUrl({
        AB_POSTGRES_URL: '',
        DATABASE_URL_UNPOOLED: 'postgres://direct',
        POSTGRES_URL: 'postgres://legacy',
      }),
    ).toThrow(MISSING_POSTGRES_URL_MESSAGE)
  })
})

describe('PostgreSQL target description', () => {
  test('names the host and database without credentials', () => {
    expect(
      describePostgresTarget(
        'postgresql://neondb_owner:hunter2@ep-example-pooler.neon.tech/neondb?sslmode=require',
      ),
    ).toBe('ep-example-pooler.neon.tech/neondb')
    expect(describePostgresTarget('postgres://user:secret@db.internal:6432')).toBe(
      'db.internal:6432',
    )
  })

  test('never echoes an unparsable value', () => {
    expect(describePostgresTarget('not a url with secret')).toBe('the configured database')
  })
})
