import { describe, expect, test } from 'bun:test'
import { isAllowedEmail, parseWebAuthEnv, safeWebConfig } from './config'

const env = {
  BETTER_AUTH_SECRET: '0123456789abcdef0123456789abcdef',
  BETTER_AUTH_URL: 'https://operator.example',
  GITHUB_CLIENT_ID: 'client',
  GITHUB_CLIENT_SECRET: 'github-secret',
  AB_WEB_AUTH_PROVIDERS: 'github',
  AB_WEB_ALLOWED_EMAILS: ' Ada@Example.com,grace@example.com,ada@example.com ',
  AB_WEB_REPOSITORIES: 'owner/one, owner/two',
  AB_POSTGRES_URL: 'postgres://secret',
}

describe('web auth configuration', () => {
  test('normalizes policy values and exposes only safe labels', () => {
    const config = parseWebAuthEnv(env)
    expect([...config.allowedEmails]).toEqual(['ada@example.com', 'grace@example.com'])
    expect(isAllowedEmail(config.allowedEmails, 'ADA@example.COM')).toBe(true)
    expect(safeWebConfig(config)).toEqual({
      providers: ['github'],
      repositories: ['owner/one', 'owner/two'],
    })
    expect(JSON.stringify(safeWebConfig(config))).not.toContain('secret')
  })

  test.each([
    ['unknown provider', { AB_WEB_AUTH_PROVIDERS: 'github,google' }],
    ['weak secret', { BETTER_AUTH_SECRET: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }],
    ['URL path', { BETTER_AUTH_URL: 'https://operator.example/path' }],
    ['blank allowlist entry', { AB_WEB_ALLOWED_EMAILS: 'ada@example.com,' }],
  ])('rejects %s', (_name, patch) => {
    expect(() => parseWebAuthEnv({ ...env, ...patch })).toThrow()
  })
})
