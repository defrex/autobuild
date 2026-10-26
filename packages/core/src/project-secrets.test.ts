import { expect, test } from 'bun:test'
import { validateSecretName, validateSecretValue } from './project-secrets'
test('subscription names are usable and authority/process names are refused', () => {
  for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'KIMI_API_KEY'])
    expect(() => validateSecretName(name)).not.toThrow()
  for (const name of [
    'AB_TOKEN',
    'AB_PROJECT_SECRETS_KEY',
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'VERCEL_TOKEN',
    'CRON_SECRET',
    'DATABASE_URL',
    'POSTGRES_PASSWORD',
    'PGPASSWORD',
    'AWS_SECRET_ACCESS_KEY',
    'BLOB_READ_WRITE_TOKEN',
    'BETTER_AUTH_SECRET',
    'PATH',
    'XDG_CONFIG_HOME',
    'PYTHONPATH',
    'SHELLOPTS',
    'EDITOR',
    'HOME',
    'NODE_OPTIONS',
    'BUN_OPTIONS',
    'LD_PRELOAD',
    'HTTPS_PROXY',
    'GIT_SSH_COMMAND',
    'bad',
    '1TOKEN',
    '',
  ])
    expect(() => validateSecretName(name)).toThrow('invalid-secret')
})
test('values are bounded nonempty strings without NUL', () => {
  for (const value of ['', null, 'x\0x', 'x'.repeat(65537)])
    expect(() => validateSecretValue(value)).toThrow('invalid-secret')
  expect(() => validateSecretValue('x'.repeat(65536))).not.toThrow()
})
