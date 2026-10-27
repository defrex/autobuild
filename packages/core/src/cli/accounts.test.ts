import { test, expect } from 'bun:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'
import { abAccountsLogin } from './accounts'
import { ProjectCredentials } from './project-credentials'
import { LocalCredentials } from '../accounts/local-credentials'
import { spawnExec } from '../ports/workspace/git-worktree'

const base = `[tickets]
source="file"
readyState="Ready"
[roles.default]
runtime="codex"
account="plan"
[accounts.plan]
kind="chatgpt-subscription"
credentialEnv="CHATGPT_ACCESS"
`
async function fixture(project = false) {
  const root = await mkdtemp(join(tmpdir(), 'ab-account-login-'))
  await spawnExec(['git', 'init', '-q'], { cwd: root })
  await spawnExec(
    ['git', 'remote', 'add', 'origin', 'https://github.com/example/account-login.git'],
    { cwd: root },
  )
  await writeFile(
    join(root, 'autobuild.toml'),
    base + (project ? '\n[store]\nurl="https://service.example"\n' : ''),
  )
  return { root, env: { HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config') } }
}
test('login refuses phase sessions and unknown account descriptors before opening a browser', async () => {
  const f = await fixture()
  let opened = false
  const opts = {
    cwd: f.root,
    env: f.env,
    exec: spawnExec,
    print: () => {},
    browser: async () => {
      opened = true
    },
  }
  try {
    await expect(abAccountsLogin('missing', opts)).rejects.toThrow('declared')
    await expect(
      abAccountsLogin('plan', { ...opts, env: { ...f.env, AB_SESSION: 'session' } }),
    ).rejects.toThrow('unavailable')
    expect(opened).toBe(false)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})
test('loopback callback rejects wrong state without installing credentials and retains its protected host identity', async () => {
  const f = await fixture()
  const messages: string[] = []
  try {
    await expect(
      abAccountsLogin('plan', {
        cwd: f.root,
        env: f.env,
        exec: spawnExec,
        print: (s) => messages.push(s),
        browser: async (raw) => {
          const auth = new URL(raw)
          expect(auth.origin).toBe('https://auth.openai.com')
          expect(auth.searchParams.get('client_id')).toBe('dynamic_agent_client')
          const cb = new URL(auth.searchParams.get('redirect_uri')!)
          cb.search = new URLSearchParams({
            state: 'wrong',
            code: 'private-code',
            client_id: 'issued',
          }).toString()
          await fetch(cb)
        },
      }),
    ).rejects.toThrow('sign-in failed')
    const local = new LocalCredentials(join(f.root, '.autobuild'))
    expect(local.load('plan')).toBeUndefined()
    expect(local.hostId()).toBe(local.hostId())
    expect(messages[0]).toContain('local dispatcher')
    expect(messages.join('')).not.toContain('private-code')
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})
test('project login validates real signed identity and writes only to the hosted owner without saving renewable local state', async () => {
  const f = await fixture(true)
  const messages: string[] = []
  const originalFetch = globalThis.fetch
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const key = { ...(await exportJWK(publicKey)), kid: 'cli-login-test', alg: 'RS256' }
  const hostId = 'urn:uuid:00000000-0000-4000-8000-000000000000'
  let nonce = '',
    writes = 0
  const access = 'sentinel-cli-access',
    refresh = 'sentinel-cli-refresh'
  const ownerId = 'a'.repeat(32),
    ownerToken = `abp_1_${ownerId}_${'b'.repeat(64)}`
  new ProjectCredentials(f.env).save({
    service: 'https://service.example',
    repo: 'https://github.com/example/account-login',
    id: ownerId,
    token: ownerToken,
  })
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('https://service.example/secrets/v1/chatgpt-host')) {
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${ownerToken}`)
        return Response.json({ version: 1, hostId })
      }
      if (url === 'https://auth.openai.com/.well-known/jwks.json')
        return Response.json({ keys: [key] })
      if (url === 'https://auth.openai.com/api/accounts/oauth/token') {
        const form = new URLSearchParams(String(init?.body))
        expect(form.get('client_id')).toBe('issued')
        expect(form.get('grant_type')).toBe('authorization_code')
        expect(form.has('client_secret')).toBe(false)
        const id = await new SignJWT({ nonce })
          .setProtectedHeader({ alg: 'RS256', kid: key.kid })
          .setIssuer('https://auth.openai.com')
          .setAudience('issued')
          .setSubject('subject')
          .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
          .sign(privateKey)
        return Response.json({
          access_token: access,
          refresh_token: refresh,
          id_token: id,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'openid offline_access chatgpt.tokens.use.direct',
        })
      }
      if (url === 'https://service.example/secrets/v1/chatgpt') {
        const body = JSON.parse(String(init?.body))
        expect(body.name).toBe('CHATGPT_ACCESS')
        expect(body.state.hostId).toBe(hostId)
        expect(body.state.accessToken).toBe(access)
        expect(body.state.refreshToken).toBe(refresh)
        writes++
        return Response.json({ version: 1, ok: true })
      }
      return originalFetch(input, init)
    },
    { preconnect: originalFetch.preconnect },
  )
  try {
    await abAccountsLogin('plan', {
      cwd: f.root,
      env: f.env,
      exec: spawnExec,
      print: (s) => messages.push(s),
      browser: async (raw) => {
        expect(messages[0]).toContain('connected project')
        const auth = new URL(raw)
        nonce = auth.searchParams.get('nonce')!
        expect(auth.searchParams.get('ext_agent_host_id')).toBe(hostId)
        const cb = new URL(auth.searchParams.get('redirect_uri')!)
        cb.search = new URLSearchParams({
          state: auth.searchParams.get('state')!,
          code: 'private-code',
          client_id: 'issued',
        }).toString()
        await originalFetch(cb)
      },
    })
    expect(writes).toBe(1)
    expect(new LocalCredentials(join(f.root, '.autobuild')).load('plan')).toBeUndefined()
    for (const token of [access, refresh, ownerToken, 'private-code'])
      expect(messages.join('')).not.toContain(token)
  } finally {
    globalThis.fetch = originalFetch
    await rm(f.root, { recursive: true, force: true })
  }
})
