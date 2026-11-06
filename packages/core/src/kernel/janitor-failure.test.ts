import { describe, expect, test } from 'bun:test'
import { ForgeFailure } from '../ports/forge-failure'
import { ForgeRequestDeferred } from '../ports/forge-request-context'
import { ForgeCooldown } from './guarded-forge'
import { janitorDeferral } from './janitor-failure'
import { KernelGitUnavailable } from './kernel-git'
import { MixedVersionDeferral } from './mixed-version'

describe('janitorDeferral', () => {
  const resetAt = '2026-07-15T12:15:00.000Z'

  test('repository scheduling signals defer the janitor', () => {
    expect(janitorDeferral(new ForgeCooldown(`Forge cooldown until ${resetAt}`))).toBe(true)
    expect(janitorDeferral(new ForgeRequestDeferred('deferred'))).toBe(true)
    expect(janitorDeferral(new KernelGitUnavailable('git', 'missing'))).toBe(true)
  })

  test('a classified rate limit defers in class and wire form', () => {
    expect(janitorDeferral(new ForgeFailure('limit', { kind: 'rate-limited', resetAt }))).toBe(true)
    expect(
      janitorDeferral({
        forgeFailure: 'autobuild.forge-failure.v1',
        message: 'limit',
        details: { kind: 'rate-limited', resetAt },
      }),
    ).toBe(true)
  })

  test('genuine failures and unrelated deferrals are not forge deferrals', () => {
    expect(
      janitorDeferral(new ForgeFailure('flaky', { kind: 'transient', retry: 'retryable' })),
    ).toBe(false)
    expect(janitorDeferral(new Error('provider unavailable'))).toBe(false)
    expect(janitorDeferral('rate-limited')).toBe(false)
    expect(janitorDeferral(new MixedVersionDeferral())).toBe(false)
  })
})
