import { missingAccountCredentials } from './availability'
import { test, expect } from 'bun:test'
import { transaction, authorizationUrl, callback, parseTokens } from './chatgpt-oauth'
import { earliestRefreshAt, type ChatGPTState } from './chatgpt-state'
import { selectAccount, accountPlaceholder } from '../config/accounts'
import { accountGuestEnvironment, accountPolicy } from '../ports/workspace/account-policy'

const descriptor = { kind: 'chatgpt-subscription', credentialEnv: 'CHATGPT' } as const
const hostId = 'urn:uuid:00000000-0000-4000-8000-000000000000'
const state: ChatGPTState = {
  version: 1,
  hostId,
  clientId: 'issued',
  subject: 'subject',
  accessToken: 'sentinel-access',
  refreshToken: 'sentinel-refresh',
  idToken: 'sentinel-id',
  scopes: ['chatgpt.tokens.use.direct', 'offline_access'],
  expiresAt: Date.now() + 3600000,
}
test('ChatGPT requires explicit Codex selection and guest egress has only the exact bearer rule', () => {
  const accounts = { plan: descriptor }
  expect(selectAccount(accounts, 'codex', undefined, 'test')).toBeUndefined()
  expect(selectAccount(accounts, 'codex', 'plan', 'test')?.descriptor).toEqual(descriptor)
  expect(() => selectAccount(accounts, 'claude', 'plan', 'test')).toThrow('codex')
  const guest = accountGuestEnvironment(
    { CHATGPT: state.accessToken, ALIAS: state.accessToken },
    accounts,
    { CHATGPT: state.accessToken },
  )
  expect(JSON.stringify(guest)).not.toContain(state.accessToken)
  expect(guest.CHATGPT).toBe(accountPlaceholder('plan'))
  const policy = JSON.stringify(
    accountPolicy('allow-all', accounts, { CHATGPT: state.accessToken }).policy,
  )
  expect(policy).toContain('api.openai.com')
  expect(policy).toContain(`Bearer ${accountPlaceholder('plan')}`)
  expect(policy).not.toContain(state.refreshToken)
})
test('OAuth transactions bind state, client registration, PKCE and nonce', () => {
  const t = transaction('http://127.0.0.1:1234/auth/callback', hostId)
  const url = new URL(authorizationUrl(t))
  expect(url.searchParams.get('client_id')).toBe('dynamic_agent_client')
  expect(url.searchParams.get('agent_name_hint')).toBe('autobuild')
  expect(url.searchParams.get('code_challenge')).not.toBe(t.verifier)
  expect(url.searchParams.get('nonce')).toBe(t.nonce)
  const cb = new URL(t.redirectUri)
  cb.search = new URLSearchParams({ state: t.state, code: 'code', client_id: 'issued' }).toString()
  expect(callback(t, cb)).toEqual({ code: 'code', clientId: 'issued' })
  cb.searchParams.set('state', 'wrong')
  expect(() => callback(t, cb)).toThrow('authorization failed')
  cb.searchParams.set('state', t.state)
  cb.searchParams.delete('client_id')
  expect(() => callback(t, cb)).toThrow()
  const returning = { ...t, previous: state }
  expect(callback(returning, cb).clientId).toBe('issued')
  cb.searchParams.set('client_id', 'different')
  expect(() => callback(returning, cb)).toThrow()
})
test('refresh windows accept only finite absolute timestamps', () => {
  expect(earliestRefreshAt(100)).toBe(100000)
  expect(earliestRefreshAt('2030-01-01T00:00:00Z')).toBe(Date.parse('2030-01-01T00:00:00Z'))
  for (const value of [null, {}, true, Infinity, 'invalid'])
    expect(earliestRefreshAt(value)).toBeUndefined()
})
test('token parsing verifies identity and requires rotating refresh and plan scopes', async () => {
  const raw = {
    access_token: state.accessToken,
    refresh_token: state.refreshToken,
    id_token: state.idToken,
    token_type: 'Bearer',
    expires_in: 3600,
    scope: state.scopes.join(' '),
    earliest_refresh_at: 100,
  }
  const registration = { clientId: state.clientId, hostId, subject: state.subject, nonce: 'nonce' }
  let verified = false
  const verify = async (_token: string, client: string, nonce?: string) => {
    expect(client).toBe('issued')
    expect(nonce).toBe('nonce')
    verified = true
    return 'subject'
  }
  expect((await parseTokens(raw, registration, verify, 0)).expiresAt).toBe(3595000)
  expect(verified).toBe(true)
  for (const replacement of [
    { refresh_token: undefined },
    { token_type: 'other' },
    { scope: 'openid' },
    { expires_in: NaN },
  ])
    await expect(parseTokens({ ...raw, ...replacement }, registration, verify)).rejects.toThrow(
      'authorization failed',
    )
  await expect(parseTokens(raw, registration, async () => 'different')).rejects.toThrow()
})
test('unused descriptors remain redacted and available transforms survive route removal without being required', () => {
  const accounts = { selected: descriptor, unused: { ...descriptor, credentialEnv: 'UNUSED' } }
  const result = accountPolicy(
    'allow-all',
    accounts,
    { CHATGPT: 'opaque' },
    { selected: descriptor },
  )
  expect(result.missing).toEqual([])
  const protectedGuest = accountGuestEnvironment({ UNUSED: 'opaque-unused' }, accounts, {
    UNUSED: 'opaque-unused',
  })
  expect(protectedGuest.UNUSED).toBe(accountPlaceholder('unused'))
  const withUnused = accountPolicy(
    'allow-all',
    accounts,
    { CHATGPT: 'opaque', UNUSED: 'opaque-unused' },
    { selected: descriptor },
  )
  expect(JSON.stringify(withUnused.policy)).toContain(accountPlaceholder('unused'))
  expect(accountPolicy('allow-all', accounts, {}).missing).toHaveLength(2)
})

test('Claude admission follows local host-login and sandbox execution semantics', () => {
  const accounts = { personal: { kind: 'claude-subscription' as const, credentialEnv: 'CLAUDE' } }
  expect(missingAccountCredentials(accounts, {}, 'environment', 'git-worktree')).toEqual([])
  expect(missingAccountCredentials(accounts, {}, 'environment', 'vercel-sandbox')).toHaveLength(1)
  expect(missingAccountCredentials(accounts, {}, 'project-secrets', 'git-worktree')).toHaveLength(1)
})
