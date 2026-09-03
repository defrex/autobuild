import { describe, expect, test } from 'bun:test'
import { MISSING_POSTGRES_URL_MESSAGE, resolvePostgresUrl } from './env'

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
