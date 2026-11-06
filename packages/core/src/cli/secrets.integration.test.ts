import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Exec } from '../ports/workspace/git-worktree'
import { abSecrets, readSecretInput } from './secrets'
import { ProjectCredentials } from './project-credentials'
import { PassThrough } from 'node:stream'
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})
test('saved owner overrides AB_TOKEN, connected build service, write-only output and safe failures', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ab-secrets-'))
  dirs.push(cwd)
  const repo = 'https://github.com/acme/project',
    service = 'https://service.example'
  await writeFile(
    join(cwd, 'autobuild.toml'),
    `[store]\nurl = "${service}"\n[tickets]\nsource = "hosted"\nurl = "https://tickets.example"\n`,
  )
  const env = { XDG_CONFIG_HOME: join(cwd, 'user'), AB_TOKEN: 'guest-token' }
  const token = `abp_1_${'a'.repeat(32)}_${'b'.repeat(64)}`
  new ProjectCredentials(env).save({ repo, service, id: 'a'.repeat(32), token })
  const exec: Exec = async (cmd) =>
    cmd[1] === 'remote'
      ? { exitCode: 0, stdout: repo, stderr: '' }
      : { exitCode: 1, stdout: '', stderr: '' }
  const output: string[] = [],
    calls: RequestInit[] = []
  const opts = {
    cwd,
    env,
    exec,
    print: (s: string) => output.push(s),
    readValue: async () => 'marker-secret',
    fetch: async (input: string, init?: RequestInit) => {
      expect(String(input)).toStartWith(`${service}/secrets/v1/`)
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`)
      expect(init?.redirect).toBe('error')
      calls.push(init!)
      return Response.json({ version: 1, ok: true })
    },
  }
  await abSecrets('set', 'KIMI_API_KEY', opts)
  expect(JSON.parse(String(calls[0]!.body)).value).toBe('marker-secret')
  expect(output.join('')).not.toContain('marker-secret')
  await expect(
    abSecrets('set', 'KIMI_API_KEY', { ...opts, env: { ...env, AB_SESSION: 'session' } }),
  ).rejects.toThrow('unavailable inside')
  await expect(
    abSecrets('set', 'KIMI_API_KEY', {
      ...opts,
      fetch: async () => new Response('marker-secret', { status: 500 }),
    }),
  ).rejects.toThrow('refused (500)')
  await abSecrets('list', undefined, {
    ...opts,
    json: true,
    fetch: async () => Response.json({ version: 1, secrets: [] }),
  })
  expect(output.at(-1)).toBe('{"version":1,"secrets":[]}')
})
test('redirected stdin is bounded and strips one terminal newline', async () => {
  const input = new PassThrough()
  input.end('marker-secret\n')
  expect(await readSecretInput(input as unknown as NodeJS.ReadStream)).toBe('marker-secret')
})
test('hidden input disables echo and restores it in a real pseudo-terminal', async () => {
  const source = resolve('packages/core/src/cli/secrets.ts')
  const python = `import os,pty,subprocess,termios,select,time\nm,s=pty.openpty()\np=subprocess.Popen(['bun','-e',${JSON.stringify(`import {readSecretInput} from ${JSON.stringify(source)}; await readSecretInput(); process.exit(0)`)}],stdin=s,stdout=s,stderr=s)\ndata=b''\nend=time.time()+10\nwhile b'Secret value: ' not in data and time.time()<end:\n if select.select([m],[],[],0.1)[0]: data+=os.read(m,4096)\nassert b'Secret value: ' in data\nassert not (termios.tcgetattr(s)[3]&termios.ECHO)\nos.write(m,b'pty-marker-secret\\r')\np.wait(timeout=10)\nassert termios.tcgetattr(s)[3]&termios.ECHO\nwhile select.select([m],[],[],0.1)[0]:\n data+=os.read(m,4096)\nassert b'pty-marker-secret' not in data\nos.close(m);os.close(s)\n`
  const result = Bun.spawn(['python3', '-c', python], { stdout: 'pipe', stderr: 'pipe' })
  const stderr = await new Response(result.stderr).text()
  expect(await result.exited, stderr).toBe(0)
}, 15000)

test('exec subprocesses cannot regain the deployment encryption key from the ambient environment', async () => {
  const source = resolve('packages/core/src/ports/workspace/git-worktree.ts')
  const child = Bun.spawn(
    [
      'bun',
      '-e',
      `import {spawnExec} from ${JSON.stringify(source)}; const result=await spawnExec(['bun','-e','console.log(process.env.AB_PROJECT_SECRETS_KEY ?? "absent")'],{}); console.log(result.stdout.trim())`,
    ],
    {
      env: { ...process.env, AB_PROJECT_SECRETS_KEY: 'deployment-key-marker' },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  expect(await new Response(child.stdout).text()).toBe('absent\n')
  expect(await child.exited).toBe(0)
})

test('hidden input restores terminal state after success, cancellation, EOF and stream error', async () => {
  for (const ending of ['success', 'cancel', 'end', 'error']) {
    const input = new PassThrough() as PassThrough & {
      isTTY: boolean
      isRaw: boolean
      setRawMode: (raw: boolean) => void
    }
    input.isTTY = true
    input.isRaw = false
    const states: boolean[] = []
    input.setRawMode = (raw) => {
      input.isRaw = raw
      states.push(raw)
    }
    const result = readSecretInput(input as unknown as NodeJS.ReadStream, () => {})
    expect(states).toEqual([true])
    if (ending === 'success') input.emit('data', Buffer.from('marker\r'))
    if (ending === 'cancel') input.emit('data', Buffer.from('\x03'))
    if (ending === 'end') input.emit('end')
    if (ending === 'error') input.emit('error', new Error('private'))
    if (ending === 'success') expect(await result).toBe('marker')
    else await expect(result).rejects.toThrow('Secret input')
    expect(states).toEqual([true, false])
    expect(input.listenerCount('data')).toBe(0)
  }
})
