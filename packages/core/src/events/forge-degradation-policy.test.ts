import { expect, test } from 'bun:test'
import {
  MAX_FORGE_DEGRADATION_MS,
  validateForgeDegradation,
  validateForgeResetHorizon,
} from './forge-degradation-policy'

const now = new Date('2026-01-01T00:00:00Z')
const payload = { forge: 'github', message: 'limit', firstFailureAt: now.toISOString() }
test('hosted deadline horizon is inclusive and expired observed deadlines remain valid', () => {
  for (const offset of [-1000, 0, MAX_FORGE_DEGRADATION_MS])
    expect(() =>
      validateForgeDegradation({ ...payload, resetAt: new Date(+now + offset).toISOString() }, now),
    ).not.toThrow()
  for (const resetAt of [
    undefined,
    '',
    'invalid',
    'Infinity',
    '9999-01-01T00:00:00Z',
    new Date(+now + MAX_FORGE_DEGRADATION_MS + 1).toISOString(),
  ])
    expect(() => validateForgeDegradation({ ...payload, resetAt }, now)).toThrow()
})

test('credential-limited facts share the hosted reset horizon', () => {
  const limited = {
    forge: 'github',
    process: 'build-runner b',
    credential: 'unauthenticated',
    missingCredential: 'GITHUB_TOKEN and GH_TOKEN are unset',
    message: 'API rate limit exceeded',
  }
  expect(() =>
    validateForgeResetHorizon(
      'forge.credential-limited',
      { ...limited, resetAt: new Date(+now + 60_000).toISOString() },
      now,
    ),
  ).not.toThrow()
  expect(() =>
    validateForgeResetHorizon(
      'forge.credential-limited',
      { ...limited, resetAt: new Date(+now + MAX_FORGE_DEGRADATION_MS + 1).toISOString() },
      now,
    ),
  ).toThrow('within 24 hours')
  expect(() =>
    validateForgeResetHorizon(
      'forge.credential-limited',
      { ...limited, credential: 'dispatcher', resetAt: now.toISOString() },
      now,
    ),
  ).toThrow()
})
