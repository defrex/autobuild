import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync, chmodSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ChatGPTState } from './chatgpt-state'
import { LocalCredentials } from './local-credentials'
import {
  LocalAccountOwner,
  renewLocalAccounts,
  inspectLocalAccountEnvironment,
} from './local-owner'
import { localInference } from './local-inference'
import { accountPlaceholder } from '../config/accounts'

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
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ab-chatgpt-'))
  const credentials = new LocalCredentials(root)
  credentials.install('plan', descriptor, state)
  return { root, credentials, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
test('protected state and durable refresh serialize owners and latch uncertain failures', async () => {
  const f = fixture()
  try {
    expect(f.credentials.hostId()).toBe(f.credentials.hostId())
    let calls = 0
    const owner = new LocalAccountOwner(f.credentials, async () => {
      calls++
      throw new Error('sentinel-refresh')
    })
    owner.claim('plan')
    const second = new LocalAccountOwner(new LocalCredentials(f.root))
    expect(() => second.claim('plan')).toThrow('already owned')
    await expect(owner.tick({ plan: descriptor }, state.expiresAt - 50000)).rejects.toThrow(
      'sign in again',
    )
    expect(f.credentials.load('plan')?.status).toBe('failed')
    await expect(owner.tick({ plan: descriptor }, state.expiresAt - 40000)).rejects.toThrow()
    expect(calls).toBe(1)
    owner.release('plan')
    const file = join(f.credentials.directory, `${Buffer.from('plan').toString('hex')}.json`)
    expect(readFileSync(file, 'utf8')).toContain('failed')
    chmodSync(file, 0o644)
    expect(() => f.credentials.load('plan')).toThrow()
  } finally {
    f.cleanup()
  }
})
test('rotated credentials commit before delivery; replacement generation fences late refresh', async () => {
  const f = fixture()
  try {
    let resolve!: (value: ChatGPTState) => void
    const owner = new LocalAccountOwner(
      f.credentials,
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    owner.claim('plan')
    const pending = owner.tick({ plan: descriptor }, state.expiresAt - 50000)
    expect(f.credentials.load('plan')?.status).toBe('refreshing')
    f.credentials.install('plan', descriptor, { ...state, accessToken: 'new-login' })
    resolve({ ...state, accessToken: 'stale-refresh', refreshToken: 'rotated' })
    await pending
    expect(f.credentials.load('plan')?.state.accessToken).toBe('new-login')
  } finally {
    f.cleanup()
  }
})
test('loopback inference requires a private capability and reads each current token without refresh', async () => {
  const f = fixture()
  const seen: string[] = []
  const transport = localInference(
    f.credentials,
    'plan',
    async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.openai.com/v1/responses')
      seen.push(new Headers(init?.headers).get('authorization')!)
      return new Response('data: ok\n\n', { headers: { 'content-type': 'text/event-stream' } })
    },
  )
  try {
    expect(
      (await fetch(`${transport.baseUrl}/responses`, { method: 'POST', body: '{}' })).status,
    ).toBe(403)
    const call = () =>
      fetch(`${transport.baseUrl}/responses`, {
        method: 'POST',
        body: '{}',
        headers: { authorization: `Bearer ${transport.capability}` },
      })
    expect(await (await call()).text()).toContain('data: ok')
    f.credentials.install('plan', descriptor, { ...state, accessToken: 'sentinel-rotated' })
    await call()
    expect(seen).toEqual(['Bearer sentinel-access', 'Bearer sentinel-rotated'])
    expect(
      (
        await fetch(`${transport.baseUrl}/models`, {
          headers: { authorization: `Bearer ${transport.capability}` },
        })
      ).status,
    ).toBe(403)
  } finally {
    await transport.close()
    f.cleanup()
  }
})

import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose'
import { verifyIdentity } from './chatgpt-oauth'
test('real JOSE signature validation binds issuer, audience, nonce and expiration', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const jwks = createLocalJWKSet({
    keys: [{ ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256' }],
  })
  const sign = (audience = 'issued', expiry = Math.floor(Date.now() / 1000) + 60) =>
    new SignJWT({ nonce: 'nonce' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer('https://auth.openai.com')
      .setAudience(audience)
      .setSubject('subject')
      .setExpirationTime(expiry)
      .sign(privateKey)
  expect(await verifyIdentity(await sign(), 'issued', 'nonce', jwks)).toBe('subject')
  await expect(verifyIdentity(await sign(), 'issued', 'other', jwks)).rejects.toThrow()
  await expect(verifyIdentity(await sign('other'), 'issued', 'nonce', jwks)).rejects.toThrow()
  await expect(verifyIdentity(await sign('issued', 1), 'issued', 'nonce', jwks)).rejects.toThrow()
})

test('loopback forwarding streams immediately, filters split provider echoes, and latches rejection', async () => {
  const f = fixture()
  let rejected = false
  const transport = localInference(f.credentials, 'plan', async () => {
    if (rejected) return new Response('private provider detail', { status: 401 })
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: ready\n\nsentinel-acc'))
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode('ess\n\n'))
          controller.close()
        }, 10)
      },
    })
    return new Response(stream)
  })
  const call = () =>
    fetch(`${transport.baseUrl}/responses`, {
      method: 'POST',
      body: '{}',
      headers: { authorization: `Bearer ${transport.capability}` },
    })
  try {
    const response = await call()
    const text = await response.text()
    expect(text).toContain('data: ready')
    expect(text).toContain('[REDACTED]')
    expect(text).not.toContain(state.accessToken)
    rejected = true
    expect((await call()).status).toBe(401)
    expect(f.credentials.load('plan')?.status).toBe('failed')
    expect((await call()).status).toBe(401)
  } finally {
    await transport.close()
    f.cleanup()
  }
})

import { CodexAgentRunner, type CodexCliInvocation } from '../ports/runner/codex'
test('Codex completion and continued sessions share the isolated placeholder provider and final routing overrides', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-codex-account-'))
  const calls: CodexCliInvocation[] = []
  const runner = new CodexAgentRunner({
    runCli: async (call) => {
      calls.push(call)
      return {
        exitCode: 0,
        stderr: '',
        stdout: [
          { type: 'thread.started', thread_id: 'thread-account' },
          { type: 'item.completed', item: { type: 'agent_message', text: 'OK' } },
          { type: 'turn.completed', usage: {} },
        ]
          .map((e) => JSON.stringify(e))
          .join('\n'),
      }
    },
  })
  const account = { name: 'plan', descriptor }
  const env = {
    AB_ACCOUNT_PLACEHOLDERS: '1',
    CHATGPT: 'sentinel-accidental-forward',
    ALIAS: 'sentinel-accidental-forward',
    OPENAI_API_KEY: 'wrong-key',
  }
  try {
    await runner.complete({
      cwd: root,
      env,
      account,
      prompt: 'OK',
      args: ['-c', 'model_provider="wrong"'],
    })
    const started = await runner.start({
      workspacePath: root,
      env,
      account,
      skill: 'ab-plan',
      invocation: 'b',
    })
    await runner.continue(started.session, 'continue')
    expect(calls).toHaveLength(3)
    expect(calls[2]!.args).toContain('resume')
    for (const call of calls) {
      expect(call.env.AUTOBUILD_CHATGPT_BEARER).toBe(accountPlaceholder('plan'))
      expect(call.env.OPENAI_API_KEY).toBeUndefined()
      expect(call.env.ALIAS).toBeUndefined()
      expect(call.env.CODEX_HOME).toBe(join(root, '.ab', 'codex-chatgpt'))
      expect(call.args).toContain('model_providers.autobuild_chatgpt.supports_websockets=false')
      expect(call.args.lastIndexOf('model_provider="autobuild_chatgpt"')).toBeGreaterThan(
        call.args.indexOf('model_provider="wrong"'),
      )
      expect(JSON.stringify(call)).not.toContain('sentinel-accidental-forward')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

import { mkdirSync, symlinkSync } from 'node:fs'
import { chatgptProvider } from '../ports/runner/chatgpt-provider'
test('managed Codex state refuses parent and leaf symlinks without opening user auth state', async () => {
  for (const parent of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), 'ab-codex-isolation-'))
    try {
      const ambient = join(root, 'ambient')
      mkdirSync(ambient, { mode: 0o700 })
      if (parent) symlinkSync(ambient, join(root, '.ab'))
      else {
        mkdirSync(join(root, '.ab'))
        symlinkSync(ambient, join(root, '.ab', 'codex-chatgpt'))
      }
      await expect(
        chatgptProvider({ name: 'plan', descriptor }, { AB_ACCOUNT_PLACEHOLDERS: '1' }, root),
      ).rejects.toThrow('isolated Codex')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

test('ChatGPT isolates CODEX_HOME while preserving the shell HOME and Git identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-chatgpt-home-'))
  try {
    const home = join(root, 'operator-home')
    mkdirSync(home)
    await Bun.write(
      join(home, '.gitconfig'),
      '[user]\nname = Operator\nemail = operator@example.test\n',
    )
    const provider = await chatgptProvider(
      { name: 'plan', descriptor },
      { HOME: home, AB_ACCOUNT_PLACEHOLDERS: '1' },
      root,
    )
    try {
      expect(provider.env.HOME).toBe(home)
      expect(provider.env.CODEX_HOME).toBe(join(root, '.ab', 'codex-chatgpt'))
      expect(provider.args).toContain('--ignore-user-config')
      const git = Bun.spawn(['git', 'var', 'GIT_AUTHOR_IDENT'], {
        cwd: root,
        env: { PATH: process.env.PATH, ...provider.env },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(await new Response(git.stdout).text()).toContain('Operator <operator@example.test>')
      expect(await git.exited).toBe(0)
    } finally {
      await provider.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('dispatcher renewal recovers an expired access token after restart', async () => {
  const f = fixture()
  try {
    const now = Date.now()
    f.credentials.install('plan', descriptor, { ...state, expiresAt: now - 3600000 })
    let calls = 0
    const owner = new LocalAccountOwner(f.credentials, async (previous) => {
      calls++
      expect(previous.refreshToken).toBe(state.refreshToken)
      return { ...state, accessToken: 'renewed-after-downtime', expiresAt: now + 3600000 }
    })
    const env: Record<string, string> = {}
    const claimed = new Set<string>()
    await renewLocalAccounts(owner, { plan: descriptor }, env, claimed, now)
    expect(calls).toBe(1)
    expect(env.CHATGPT).toBe('renewed-after-downtime')
    expect(claimed.has('plan')).toBe(true)
    expect(f.credentials.load('plan')?.status).toBe('ready')
    owner.release('plan')
  } finally {
    f.cleanup()
  }
})

test('dispatcher cannot take a live validator claim during its refresh', async () => {
  const f = fixture()
  try {
    let finish!: (state: ChatGPTState) => void
    const validator = new LocalAccountOwner(
      f.credentials,
      () =>
        new Promise((r) => {
          finish = r
        }),
    )
    validator.claim('plan')
    const pending = validator.tick({ plan: descriptor }, state.expiresAt - 50000)
    const dispatcher = new LocalAccountOwner(new LocalCredentials(f.root), async () => {
      throw new Error('dispatcher must not refresh')
    })
    const env = { CHATGPT: 'stale' }
    await renewLocalAccounts(dispatcher, { plan: descriptor }, env, new Set())
    expect(f.credentials.load('plan')?.status).toBe('refreshing')
    expect(f.credentials.load('plan')?.owner).toBe(validator.id)
    expect(env.CHATGPT).toBeUndefined()
    finish({ ...state, accessToken: 'validator-rotated', expiresAt: Date.now() + 3600000 })
    await pending
    validator.release('plan')
    await renewLocalAccounts(dispatcher, { plan: descriptor }, env, new Set())
    expect(env.CHATGPT).toBe('validator-rotated')
    dispatcher.release('plan')
  } finally {
    f.cleanup()
  }
})

test('only a proven dead owner can be reclaimed and uncertain refresh stays failed', async () => {
  const f = fixture()
  try {
    const child = Bun.spawn([process.execPath, '-e', ''], { stdout: 'ignore', stderr: 'ignore' })
    await child.exited
    for (const status of ['ready', 'refreshing'] as const) {
      f.credentials.save('plan', {
        ...f.credentials.load('plan')!,
        owner: 'dead-owner',
        ownerPid: child.pid,
        status,
      })
      const successor = new LocalAccountOwner(f.credentials)
      successor.claim('plan')
      expect(f.credentials.load('plan')?.status).toBe(status === 'ready' ? 'ready' : 'failed')
      successor.release('plan')
    }
  } finally {
    f.cleanup()
  }
})

for (const floorOffset of [undefined, -30000, 0, 30000]) {
  test(`local refresh gates one-minute margin and provider floor: ${floorOffset}`, async () => {
    const f = fixture()
    try {
      const expiresAt = 2_000_003_600_000
      const threshold = expiresAt - 60000
      const floor = floorOffset === undefined ? undefined : threshold + floorOffset
      const due = Math.max(threshold, floor ?? 0)
      f.credentials.install('plan', descriptor, {
        ...state,
        expiresAt,
        earliestRefreshAt: floor,
      })
      let calls = 0
      const owner = new LocalAccountOwner(f.credentials, async (saved) => {
        calls++
        expect(saved.refreshToken).toBe(state.refreshToken)
        return {
          ...saved,
          accessToken: 'renewed',
          refreshToken: 'rotated',
          expiresAt: due + 3600000,
        }
      })
      owner.claim('plan')
      for (const now of [threshold - 300000, due - 1]) {
        expect(await owner.tick({ plan: descriptor }, now)).toEqual({ CHATGPT: state.accessToken })
        expect(calls).toBe(0)
      }
      expect(await owner.tick({ plan: descriptor }, due)).toEqual({ CHATGPT: 'renewed' })
      expect(await owner.tick({ plan: descriptor }, due + 1)).toEqual({ CHATGPT: 'renewed' })
      expect(calls).toBe(1)
      owner.release('plan')
    } finally {
      f.cleanup()
    }
  })
}

test('no local record preserves an external token; a failed or mismatched record fails closed', async () => {
  const f = fixture()
  try {
    const owner = new LocalAccountOwner(f.credentials)
    const env: Record<string, string | undefined> = { EXTERNAL: 'opaque' }
    await renewLocalAccounts(
      owner,
      { external: { ...descriptor, credentialEnv: 'EXTERNAL' } },
      env,
      new Set(),
    )
    expect(Boolean(env.EXTERNAL)).toBe(true)
    const record = f.credentials.load('plan')!
    f.credentials.save('plan', { ...record, status: 'failed' })
    const local: Record<string, string | undefined> = { CHATGPT: 'opaque' }
    await renewLocalAccounts(owner, { plan: descriptor }, local, new Set())
    expect(local.CHATGPT).toBeUndefined()
    f.credentials.save('plan', { ...record, descriptor: { ...descriptor, credentialEnv: 'OTHER' } })
    await renewLocalAccounts(owner, { plan: descriptor }, local, new Set())
    expect(local.CHATGPT).toBeUndefined()
  } finally {
    f.cleanup()
  }
})
test('handoff inspection recognizes only the actual predecessor and never claims or rotates', () => {
  const f = fixture()
  try {
    const owner = new LocalAccountOwner(f.credentials, async () => {
      throw new Error('must not refresh')
    })
    owner.claim('plan')
    const before = f.credentials.load('plan')!
    expect(
      inspectLocalAccountEnvironment(f.credentials, { plan: descriptor }, {}).CHATGPT,
    ).toBeUndefined()
    expect(
      Boolean(
        inspectLocalAccountEnvironment(f.credentials, { plan: descriptor }, {}, process.pid)
          .CHATGPT,
      ),
    ).toBe(true)
    expect(
      Boolean(
        inspectLocalAccountEnvironment(f.credentials, { plan: descriptor }, {}, undefined, true)
          .CHATGPT,
      ),
    ).toBe(true)
    expect(f.credentials.load('plan')).toEqual(before)
    owner.release('plan')
  } finally {
    f.cleanup()
  }
})
