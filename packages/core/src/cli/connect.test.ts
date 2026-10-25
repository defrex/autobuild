import { temporaryOriginScratch } from '../testing/temp-directories'
import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { abConnect, abDisconnect } from './connect'
import { ProjectCredentials } from './project-credentials'
import { normalizeServiceURL } from '../connection'
import { resolveRepoStatePaths } from './repo-state'
import type { Exec } from '../ports/workspace/git-worktree'
const trackOrigin = temporaryOriginScratch(afterEach)
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
const service = 'https://service.example',
  repo = 'https://github.com/example/project'
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'ab-connect-'))
  dirs.push(cwd)
  await writeFile(join(cwd, 'autobuild.toml'), '# preserved\n[tickets]\nreadyState = "Ready"\n')
  const env = { XDG_CONFIG_HOME: join(cwd, 'user') }
  const output: string[] = []
  const exec: Exec = async (command) =>
    command[1] === 'remote'
      ? { exitCode: 0, stdout: repo, stderr: '' }
      : { exitCode: 1, stdout: '', stderr: '' }
  let tokenId = '',
    calls: { path: string; body: unknown; authorization: string | null }[] = []
  const fetcher: (input: string, init?: RequestInit) => Promise<Response> = async (input, init) => {
    const path = new URL(String(input)).pathname
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path, body, authorization: new Headers(init?.headers).get('authorization') })
    if (path.endsWith('requests')) {
      tokenId = body.credentialId
      return Response.json({
        id: 'a'.repeat(32),
        capability: 'b'.repeat(64),
        code: '123456789A',
        interval: 5,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      })
    }
    return Response.json({ repo, credentialId: tokenId, status: 'approved', accepted: true })
  }
  return {
    cwd,
    env,
    exec,
    calls,
    output,
    print: (value: string) => output.push(value),
    fetch: fetcher,
    browser: async () => {},
    sleep: async () => {},
  }
}
test('URL validation and store precedence', () => {
  for (const url of [
    'file:///tmp/store',
    'http://example.com',
    'https://u:p@host',
    'https://host?q=a',
    'https://host/#x',
    '',
  ])
    expect(() => normalizeServiceURL(url)).toThrow()
  expect(normalizeServiceURL('https://HOST/base/')).toBe('https://host/base')
  expect(normalizeServiceURL('http://127.0.0.1:1234/')).toBe('http://127.0.0.1:1234')
  const state = { repo: '/tmp/repo', configStore: service }
  expect(resolveRepoStatePaths(state).storeRef).toBe(service)
  expect(resolveRepoStatePaths({ ...state, envStore: '  ' }).storeRef).toBe(service)
  expect(
    resolveRepoStatePaths({ ...state, envStore: 'https://env', storeRef: 'https://flag' }).storeRef,
  ).toBe('https://flag')
})
test('approval preserves TOML and persists private user credentials; status/disconnect use saved token', async () => {
  const f = await fixture()
  await abConnect(service, f)
  expect(await readFile(join(f.cwd, 'autobuild.toml'), 'utf8')).toContain('# preserved')
  const storage = new ProjectCredentials(f.env)
  const entry = storage.load(service, repo)!
  expect(entry.token).toStartWith(`abp_1_${entry.id}_`)
  expect((await stat(storage.directory)).mode & 0o777).toBe(0o700)
  const files = await Array.fromAsync(new Bun.Glob('*.json').scan(storage.directory))
  expect((await stat(join(storage.directory, files[0]!))).mode & 0o777).toBe(0o600)
  expect(f.output.join('\n')).not.toContain(entry.token)
  await abConnect(undefined, { ...f, env: { ...f.env, AB_TOKEN: 'override' } })
  expect(f.calls.at(-1)?.authorization).toBe(`Bearer ${entry.token}`)
  await abDisconnect(f)
  expect(storage.load(service, repo)).toBeUndefined()
  expect(await readFile(join(f.cwd, 'autobuild.toml'), 'utf8')).toContain(service)
})
test('denial leaves config and credential untouched, browser failure prints fallback', async () => {
  const f = await fixture(),
    original = await readFile(join(f.cwd, 'autobuild.toml'), 'utf8')
  await abConnect(service, {
    ...f,
    browser: async () => {
      throw new Error()
    },
    fetch: async (url, init) =>
      String(url).endsWith('/poll') ? Response.json({ status: 'denied' }) : f.fetch(url, init),
  })
  expect(await readFile(join(f.cwd, 'autobuild.toml'), 'utf8')).toBe(original)
  expect(new ProjectCredentials(f.env).load(service, repo)).toBeUndefined()
  expect(f.output.join('\n')).toContain('another device')
})
test('configuration conflict and absent origin fail before requesting approval', async () => {
  const f = await fixture()
  await writeFile(join(f.cwd, 'autobuild.toml'), '[store]\nurl="https://other.example"\n')
  await expect(abConnect(service, f)).rejects.toThrow('differs')
  await expect(
    abConnect(service, { ...f, exec: async () => ({ exitCode: 1, stdout: '', stderr: '' }) }),
  ).rejects.toThrow('origin')
  expect(f.calls).toHaveLength(0)
})
test('credential files separate services and projects and reject symlinks', async () => {
  const f = await fixture(),
    storage = new ProjectCredentials(f.env)
  const entry = {
    service,
    repo,
    id: 'c'.repeat(32),
    token: `abp_1_${'c'.repeat(32)}_${'d'.repeat(64)}`,
  }
  storage.save(entry)
  expect(storage.load('https://other.example', repo)).toBeUndefined()
  expect(storage.load(service, `${repo}-other`)).toBeUndefined()
  const files = await Array.fromAsync(new Bun.Glob('*.json').scan(storage.directory)),
    path = join(storage.directory, files[0]!)
  await rm(path)
  await symlink(join(f.cwd, 'autobuild.toml'), path)
  expect(() => storage.load(service, repo)).toThrow('Cannot read')
  expect(() => storage.save(entry)).toThrow('Cannot save')
})

test('concurrent config edits cancel the new credential and preserve the changed file', async () => {
  const f = await fixture()
  const path = join(f.cwd, 'autobuild.toml')
  const changed = '# concurrent edit\n[tickets]\nreadyState="Ready"\n'
  await expect(
    abConnect(service, {
      ...f,
      fetch: async (url, init) => {
        if (url.endsWith('/poll')) await writeFile(path, changed)
        return f.fetch(url, init)
      },
    }),
  ).rejects.toThrow('could not be saved')
  expect(await readFile(path, 'utf8')).toBe(changed)
  expect(f.calls.at(-1)?.path).toEndWith('/cancel')
})
test('a failed credential save revokes the new authority and restores TOML', async () => {
  const f = await fixture(),
    path = join(f.cwd, 'autobuild.toml'),
    original = await readFile(path, 'utf8')
  await expect(
    abConnect(service, {
      ...f,
      fetch: async (url, init) => {
        if (url.endsWith('/poll'))
          await writeFile(f.env.XDG_CONFIG_HOME, 'blocked configuration directory')
        return f.fetch(url, init)
      },
    }),
  ).rejects.toThrow('could not be saved')
  expect(await readFile(path, 'utf8')).toBe(original)
  expect(f.calls.at(-1)?.path).toEndWith('/cancel')
})
test('reconnect swaps only after approval and revokes the old credential with its own token', async () => {
  const f = await fixture()
  await abConnect(service, f)
  const storage = new ProjectCredentials(f.env),
    old = storage.load(service, repo)!
  await abConnect(service, f)
  const current = storage.load(service, repo)!
  expect(current.id).not.toBe(old.id)
  expect(f.calls.at(-1)?.path).toEndWith('/revoke')
  expect(f.calls.at(-1)?.authorization).toBe(`Bearer ${old.token}`)
})
test('timeout confirms cancellation without writing local state', async () => {
  const f = await fixture()
  await abConnect(service, { ...f, now: () => Date.now() + 120000 })
  expect(f.calls.at(-1)?.path).toEndWith('/cancel')
  expect(new ProjectCredentials(f.env).load(service, repo)).toBeUndefined()
  expect(f.output.join('\n')).toContain('timed out')
})

test('origin-mode dispatch reads the forge config and forwards the exact saved service/project token', async () => {
  trackOrigin(repo)
  const { abDispatch } = await import('./dispatch')
  const f = await fixture(),
    storage = new ProjectCredentials(f.env)
  const id = 'e'.repeat(32),
    token = `abp_1_${id}_${'f'.repeat(64)}`
  storage.save({ service, repo, id, token })
  const config = `[store]\nurl="${service}"\n[tickets]\nsource="file"\nreadyState="Ready"\n[roles.default]\nruntime="codex"\nmodel="gpt-5.6"\n`
  let reached = false
  await expect(
    abDispatch({
      targetRepo: f.cwd,
      repository: repo,
      exec: f.exec,
      env: { ...f.env, GITHUB_TOKEN: 'forge-fixture' },
      originConfigTransport: async () => ({
        status: 200,
        headers: {},
        bytes: new TextEncoder().encode(config),
      }),
      stdout: () => {},
      stderr: () => {},
      once: true,
      plain: true,
      wire: async (_config, opts, state) => {
        expect(state.storeRef).toBe(service)
        expect(opts.env.AB_STORE).toBe(service)
        expect(opts.env.AB_TOKEN).toBe(token)
        reached = true
        throw new Error('verified stored authority')
      },
    }),
  ).rejects.toThrow('verified stored authority')
  expect(reached).toBe(true)
})

test('ticket-only connect publishes policy before dispatch and leaves the build store alone', async () => {
  const f = await fixture()
  await writeFile(join(f.cwd, 'autobuild.toml'), '[tickets]\nsource = "hosted"\nteamKey = "ENG"\n')
  const fetcher = f.fetch
  const policyCalls: unknown[] = []
  await abConnect(service, {
    ...f,
    tickets: true,
    fetch: async (url, init) => {
      if (url.endsWith('/tickets/policy')) {
        policyCalls.push(JSON.parse(String(init?.body)))
        return Response.json({ ok: true })
      }
      return fetcher(url, init)
    },
  })
  const text = await readFile(join(f.cwd, 'autobuild.toml'), 'utf8')
  expect(text).toContain(`url = "${service}"`)
  expect(text).not.toContain('[store]')
  expect(policyCalls).toEqual([
    {
      context: { repo, teamKey: 'ENG' },
      input: {
        version: 1,
        tickets: {
          source: 'hosted',
          teamKey: 'ENG',
          readyState: 'ready',
          triageState: 'triage',
          claimedState: 'doing',
          doneState: 'done',
          createState: 'triage',
          proposalState: 'triage',
        },
      },
    },
  ])
  await abDisconnect({ ...f, tickets: true })
  expect(new ProjectCredentials(f.env).load(service, repo)).toBeUndefined()
})

test('failed ticket policy publication restores configuration and retains the prior credential', async () => {
  const f = await fixture()
  const before = '[tickets]\nsource = "hosted"\nteamKey = "ENG"\n'
  await writeFile(join(f.cwd, 'autobuild.toml'), before)
  const fetcher = f.fetch
  await expect(
    abConnect(service, {
      ...f,
      tickets: true,
      fetch: async (url, init) =>
        url.endsWith('/tickets/policy')
          ? Response.json(
              { error: 'ticket policy temporarily unavailable', kind: 'conflict' },
              { status: 503 },
            )
          : fetcher(url, init),
    }),
  ).rejects.toThrow('ticket policy temporarily unavailable')
  expect(await readFile(join(f.cwd, 'autobuild.toml'), 'utf8')).toBe(before)
  expect(new ProjectCredentials(f.env).load(service, repo)).toBeUndefined()
  expect(f.calls.some((call) => call.path.endsWith('/cancel'))).toBe(true)
})
