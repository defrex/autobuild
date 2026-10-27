import { expect, test } from 'bun:test'
import { accountSchema, kimiEndpoint, selectAccount } from './accounts'
import { accountEnvironment, accountSettings } from '../ports/runner/account-env'
import { accountGuestEnvironment, accountPolicy } from '../ports/workspace/account-policy'

const accounts = {
  personal: { kind: 'claude-subscription', credentialEnv: 'PERSONAL_TOKEN' },
  overseas: { kind: 'kimi-code', credentialEnv: 'KIMI_KEY', region: 'overseas' },
  china: { kind: 'kimi-code', credentialEnv: 'CN_KEY', region: 'china' },
} as const

test('strict descriptors default only Kimi region and reject arbitrary endpoints', () => {
  expect(accountSchema.parse({ kind: 'kimi-code', credentialEnv: 'KEY' })).toEqual({
    kind: 'kimi-code',
    credentialEnv: 'KEY',
    region: 'overseas',
  })
  for (const value of [
    { kind: 'kimi-code', credentialEnv: 'KEY', region: '' },
    { kind: 'kimi-code', credentialEnv: 'KEY', baseUrl: 'https://elsewhere' },
    { kind: 'claude-subscription', credentialEnv: 'KEY', region: 'china' },
    { kind: 'kimi-code', credentialEnv: 'AB_TOKEN' },
  ])
    expect(accountSchema.safeParse(value).success).toBe(false)
})

test('selection preserves legacy routes and labels ambiguous or incompatible routes', () => {
  expect(selectAccount({}, 'claude', undefined, 'role "implement"')).toBeUndefined()
  expect(selectAccount(accounts, 'claude', undefined, 'role "implement"')?.name).toBe('personal')
  expect(() => selectAccount(accounts, 'pi', 'overseas', 'role "implement"')).toThrow(
    'role "implement"',
  )
  expect(() =>
    selectAccount({ ...accounts, second: accounts.personal }, 'claude', undefined, 'review'),
  ).toThrow('ambiguous')
})

test('account environment removes competing credentials without mutating inputs', () => {
  const ambient = {
    KIMI_KEY: 'sentinel-kimi',
    CLAUDE_CODE_OAUTH_TOKEN: 'wrong',
    ANTHROPIC_BASE_URL: 'wrong',
  }
  const selected = selectAccount(accounts, 'claude', 'overseas', 'test')!
  const env = accountEnvironment(ambient, selected)
  expect(env.ANTHROPIC_API_KEY).toBe('sentinel-kimi')
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  expect(env.ANTHROPIC_BASE_URL).toBe(kimiEndpoint('overseas').baseUrl)
  expect(ambient.CLAUDE_CODE_OAUTH_TOKEN).toBe('wrong')
  expect(JSON.parse(accountSettings(env, selected)[1]!).env.CLAUDE_CODE_OAUTH_TOKEN).toBe('')
})

test('host transforms isolate accounts by exact header and regional hostname', () => {
  const host = {
    PERSONAL_TOKEN: 'sentinel-claude',
    KIMI_KEY: 'sentinel-overseas',
    CN_KEY: 'sentinel-china',
  }
  const guest = accountGuestEnvironment(
    { ...host, ANTHROPIC_API_KEY: host.KIMI_KEY },
    accounts,
    host,
  )
  expect(JSON.stringify(guest)).not.toContain('sentinel-')
  const result = accountPolicy('allow-all', accounts, host)
  expect(result.missing).toEqual([])
  const serialized = JSON.stringify(result.policy)
  expect(serialized).toContain('sentinel-claude')
  const allow = (result.policy as { allow: Record<string, unknown> }).allow
  expect(JSON.stringify(allow['api.kimi.ai'])).toContain('sentinel-overseas')
  expect(JSON.stringify(allow['api.kimi.ai'])).not.toContain('sentinel-china')
  expect(JSON.stringify(allow['api.kimi.com'])).toContain('sentinel-china')
  expect(JSON.stringify(allow['api.kimi.com'])).not.toContain('sentinel-overseas')
  const rotated = accountPolicy('allow-all', accounts, { ...host, KIMI_KEY: 'rotated' })
  expect(JSON.stringify(rotated.policy)).not.toContain('sentinel-overseas')
  const missing = accountPolicy('allow-all', accounts, { ...host, KIMI_KEY: undefined })
  expect(missing.missing.join()).toContain('KIMI_KEY')
  expect(JSON.stringify(missing.policy)).not.toContain('sentinel-overseas')
})

import { createRuntimeResolver } from '../ports/runner/routing'
import { ScriptedAgentRunner, defaultTurnResult } from '../ports/runner/fake'
import { parseConfig } from './load'

const runner = new ScriptedAgentRunner({ script: () => defaultTurnResult() })
const registry = {
  claude: { runner, servesModels: ['claude-'], defaultModel: 'claude-sonnet-4-6' },
}

test('routes preserve account inheritance, alternate overlays and Kimi-specific model compatibility', () => {
  const resolver = createRuntimeResolver(
    registry,
    {
      default: { runtime: 'claude', account: 'overseas' },
      implement: { alternates: [{ account: 'china', model: 'k3.1-pro-highspeed[1m]' }] },
      review: { account: 'personal', model: 'claude-sonnet-4-6' },
    },
    3600,
    accounts,
  )
  expect(resolver.resolve('implement').model).toBe('kimi-for-coding')
  expect(resolver.resolve('implement').account?.name).toBe('overseas')
  expect(resolver.resolve('implement').alternates[0]?.account?.descriptor).toEqual(accounts.china)
  expect(resolver.resolve('missing', 'review').account?.name).toBe('personal')
  expect(() =>
    createRuntimeResolver(
      registry,
      { default: { runtime: 'claude', account: 'overseas', model: 'claude-sonnet-4-6' } },
      3600,
      accounts,
    ),
  ).toThrow()
})

test('configuration rejects ambiguous defaults and names incompatible role references before runtime loading', () => {
  const base = '[tickets]\nsource="file"\nreadyState="Ready"\n[roles.default]\nruntime="claude"\n'
  const declared = '\n[accounts.a]\nkind="claude-subscription"\ncredentialEnv="TOKEN_A"\n'
  expect(parseConfig(base + declared).accounts.a?.kind).toBe('claude-subscription')
  expect(() =>
    parseConfig(
      `${base + declared}\n[accounts.b]\nkind="claude-subscription"\ncredentialEnv="TOKEN_B"`,
    ),
  ).toThrow('role "default"')
  expect(() => parseConfig(`${base}\n[roles.implement]\nruntime="pi"\naccount="missing"`)).toThrow(
    'role "implement"',
  )
})

test.each(['AB_BUILD_RUNNER_OPTIONS', 'AB_HARVEST_RUNNER_OPTIONS'])(
  'first account added after a remote launch uses placeholders (%s)',
  (launchVariable) => {
    const account = selectAccount(accounts, 'claude', 'overseas', 'test')!
    const ambient = {
      [launchVariable]: JSON.stringify({ supervision: { kind: 'environment' } }),
      KIMI_KEY: 'sentinel-previously-forwarded',
      CUSTOM_ALIAS: 'sentinel-previously-forwarded',
    }
    const selected = accountEnvironment(ambient, account)
    expect(selected.ANTHROPIC_API_KEY).toBe('autobuild-account-6f76657273656173')
    expect(selected.KIMI_KEY).toBe('autobuild-account-6f76657273656173')
    expect(JSON.stringify(selected)).not.toContain('sentinel-previously-forwarded')
    expect(ambient.KIMI_KEY).toBe('sentinel-previously-forwarded')
  },
)

test('ChatGPT configuration requires Codex and a unique host-resolved credential slot', () => {
  const base =
    '[tickets]\nsource="file"\nreadyState="Ready"\n[roles.default]\nruntime="codex"\naccount="plan"\n'
  const declaration =
    '\n[accounts.plan]\nkind="chatgpt-subscription"\ncredentialEnv="PLAN_ACCESS"\n'
  expect(parseConfig(base + declaration).accounts.plan?.kind).toBe('chatgpt-subscription')
  expect(() =>
    parseConfig(base.replace('runtime="codex"', 'runtime="claude"') + declaration),
  ).toThrow('codex')
  expect(() =>
    parseConfig(
      `${base + declaration}\n[accounts.other]\nkind="chatgpt-subscription"\ncredentialEnv="PLAN_ACCESS"`,
    ),
  ).toThrow('distinct')
})
