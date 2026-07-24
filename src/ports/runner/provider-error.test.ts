import { describe, expect, test } from 'bun:test'
import { classifyProviderError } from './provider-error'

const KIMI_QUOTA =
  '403 {"error":{"type":"permission_error","message":"You\'ve reached your usage limit for this billing cycle. Please try again after your quota refreshes."}}'

describe('classifyProviderError', () => {
  test('preserves the AUT-28 Kimi quota error byte-for-byte and marks it permanent', () => {
    expect(classifyProviderError(KIMI_QUOTA)).toEqual({
      message: KIMI_QUOTA,
      permanent: true,
    })
  })

  test.each([401, 402, 403])('HTTP status %s is a positive permanent hint', (status) => {
    expect(classifyProviderError('provider rejected the request', { status }).permanent).toBe(true)
  })

  test.each([
    'authentication_failed',
    'permission_error',
    'billing_error',
    'insufficient_quota',
    'error_max_budget_usd',
    'oauth_org_not_allowed',
  ])('structured code %s is permanent', (code) => {
    expect(
      classifyProviderError('provider rejected the request', { codes: [code] }).permanent,
    ).toBe(true)
  })

  test.each([
    'Invalid API key',
    'Permission denied for this model',
    'Account quota exhausted',
    'Payment required',
    'Your subscription is expired',
    'Insufficient credits',
    'Budget exceeded',
  ])('unambiguous text is permanent: %s', (message) => {
    expect(classifyProviderError(message).permanent).toBe(true)
  })

  test.each([
    ['429 rate limit exceeded', 429, 'rate_limit'],
    ['503 provider overloaded', 503, 'overloaded'],
    ['request timed out', null, 'timeout'],
    ['socket closed unexpectedly', null, 'transport_error'],
    ['unknown execution error', null, 'unknown'],
  ] as const)('retry-policy error remains non-permanent: %s', (message, status, code) => {
    expect(classifyProviderError(message, { status, codes: [code] }).permanent).toBe(false)
  })
})
