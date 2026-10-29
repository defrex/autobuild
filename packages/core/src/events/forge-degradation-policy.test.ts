import { expect, test } from 'bun:test'
import { MAX_FORGE_DEGRADATION_MS, validateForgeDegradation } from './forge-degradation-policy'

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
