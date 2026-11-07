import { describe, expect, test } from 'bun:test'
import type { Account } from '../config/accounts'
import type { ProjectSecretMetadata } from '../project-secrets'
import {
  HOSTED_ACCOUNT_READINESS_ENV,
  hostedReadinessNames,
  withHostedReadiness,
} from '../accounts/hosted-readiness'
import { staticSecretEligible, staticSecretReadiness } from './init-hosted-accounts'

const claude: Account = { kind: 'claude-subscription', credentialEnv: 'CLAUDE_CODE_OAUTH_TOKEN' }
const kimi: Account = { kind: 'kimi-code', credentialEnv: 'KIMI_KEY', region: 'overseas' }
const chatgpt: Account = { kind: 'chatgpt-subscription', credentialEnv: 'PLAN_ACCESS' }
const hosted = { connected: true, remoteReadiness: true }

const entry = (overrides: Partial<ProjectSecretMetadata> = {}): ProjectSecretMetadata => ({
  name: 'CLAUDE_CODE_OAUTH_TOKEN',
  kind: 'static',
  owner: 'maintainer',
  setAt: '2026-10-27T00:00:00.000Z',
  fingerprint: 'a'.repeat(16),
  status: 'ready',
  failureCode: null,
  lastSuppliedAt: null,
  ...overrides,
})

describe('staticSecretEligible', () => {
  test('admits Claude and Kimi accounts on a connected remote-readiness project without a local variable', () => {
    expect(staticSecretEligible(claude, {}, hosted)).toBe(true)
    expect(staticSecretEligible(kimi, { KIMI_KEY: '' }, hosted)).toBe(true)
  })

  test('keeps the local path when the variable is set, the project is local, or the provider has no remote readiness', () => {
    expect(staticSecretEligible(claude, { CLAUDE_CODE_OAUTH_TOKEN: 'local' }, hosted)).toBe(false)
    expect(staticSecretEligible(claude, {}, { connected: false, remoteReadiness: true })).toBe(
      false,
    )
    expect(staticSecretEligible(claude, {}, { connected: true, remoteReadiness: false })).toBe(
      false,
    )
    expect(staticSecretEligible(chatgpt, {}, hosted)).toBe(false)
  })
})

describe('staticSecretReadiness', () => {
  test('reports a ready static secret from metadata only', () => {
    const check = staticSecretReadiness('claude', claude, [entry()])
    expect(check).toEqual({
      name: 'account "claude"',
      status: 'pass',
      ready: true,
      detail:
        'Hosted credential ready; owner maintainer; set 2026-10-27T00:00:00.000Z. Hosted Claude and Kimi accounts are checked by metadata; the first hosted build is the live check.',
    })
    expect(staticSecretReadiness('kimi', kimi, [entry({ name: 'KIMI_KEY' })]).ready).toBe(true)
  })

  test('a missing secret names both remedies', () => {
    expect(staticSecretReadiness('claude', claude, []).detail).toBe(
      'CLAUDE_CODE_OAUTH_TOKEN is missing; set the project secret with bun ab secrets set CLAUDE_CODE_OAUTH_TOKEN, or run claude setup-token and provide the local variable',
    )
    expect(staticSecretReadiness('kimi', kimi, undefined).detail).toBe(
      'KIMI_KEY is missing; set the project secret with bun ab secrets set KIMI_KEY, or provide the Kimi Code membership key in the local variable',
    )
  })

  test('a non-ready or differently kinded secret fails', () => {
    const failed = staticSecretReadiness('claude', claude, [
      entry({ status: 'failed', failureCode: 'refresh-failed' }),
    ])
    expect(failed.status).toBe('fail')
    expect(failed.detail).toBe(
      'Hosted credential failed (refresh-failed); owner maintainer; set 2026-10-27T00:00:00.000Z; set the project secret with bun ab secrets set CLAUDE_CODE_OAUTH_TOKEN, or run claude setup-token and provide the local variable',
    )
    const refreshing = staticSecretReadiness('claude', claude, [
      entry({ kind: 'chatgpt-subscription' }),
    ])
    expect(refreshing.ready).toBe(false)
    expect(refreshing.detail).toContain('is missing')
  })
})

test('hosted readiness names round-trip and tolerate an absent variable', () => {
  expect(hostedReadinessNames({})).toEqual([])
  const env = { [HOSTED_ACCOUNT_READINESS_ENV]: withHostedReadiness({}, 'claude') }
  expect(
    hostedReadinessNames({ [HOSTED_ACCOUNT_READINESS_ENV]: withHostedReadiness(env, 'kimi') }),
  ).toEqual(['claude', 'kimi'])
})
