/**
 * The real-`ab`-binary remote seam (the hosted package owns the protocol
 * servers, so this seam lives here): the binary's ambient session identity
 * over a real in-process store server, its credential handling on the same
 * seam, and a watch abort tearing down a real held remote request.
 *
 * Spawned tests run `bin/ab.ts` via the repo-root relative path, exactly like
 * the core bin suite — they traverse the real process entries rather than
 * `runCli` in-process.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { abWatch, DISPATCHER, KERNEL, steppingClock, type Exec } from '@defrex/autobuild/testing'
import { MemoryBuildStore } from '@defrex/autobuild/plugin-sdk'
import { mintToken, RemoteBuildStore } from '@defrex/autobuild/remote-store'
import { startStoreServer } from './remote-store-server'

const ROOT = join(import.meta.dir, '..', '..', '..')
const BIN = join(ROOT, 'bin', 'ab.ts')
const REPO = '/main/repo'

const fakeExec: Exec = async (cmd) =>
  cmd[1] === 'remote'
    ? // No origin remote: identity falls back to the resolved checkout path.
      { stdout: '', stderr: "error: No such remote 'origin'\n", exitCode: 2 }
    : {
        stdout: `${REPO}/.git\n${REPO}/.git\n${REPO}\n`,
        stderr: '',
        exitCode: 0,
      }

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ab-bin-remote-'))
  // Scoped binary composition reads the build worktree's config before
  // selecting its forge. Sessionless cases ignore this fixture.
  await writeFile(join(tmp, 'autobuild.toml'), '[tickets]\nsource = "file"\nreadyState = "ready"\n')
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

async function collect(
  proc: Bun.ReadableSubprocess,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, code }
}

function bareEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
  }
}

async function runBin(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return collect(
    Bun.spawn(['bun', BIN, ...args], {
      cwd: tmp,
      env: { ...bareEnv(), ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    }),
  )
}

test('complete remote phase identity has the same query allow/deny matrix', async () => {
  const repo = await realpath(tmp)
  const backing = new MemoryBuildStore()
  for (const slug of ['remote-own', 'remote-foreign']) {
    await backing.createBuild({ slug, repo })
    await backing.putArtifact(slug, { kind: 'evidence', content: slug })
  }
  const secret = 'ambient-read-secret'
  const server = startStoreServer({ store: backing, secret })
  const env = {
    AB_STORE: server.url,
    AB_BUILD: 'remote-own',
    AB_PHASE: 'implement@1',
    AB_SESSION: 's_remote_read',
    AB_TOKEN: mintToken(secret, {
      version: 1,
      ownerAdmin: { user: 'owner' },
      exp: Date.now() + 60_000,
    }),
  }
  try {
    const ownStatus = await runBin(['build', 'status', 'remote-own', '--json'], env)
    expect(ownStatus.code).toBe(0)
    expect(JSON.parse(ownStatus.stdout).slug).toBe('remote-own')

    const ownDownload = await runBin(
      ['artifact', 'download', 'remote-own', 'evidence', '--output', 'downloads/remote-own.txt'],
      env,
    )
    expect(ownDownload.code).toBe(0)
    expect(await Bun.file(join(tmp, 'downloads', 'remote-own.txt')).text()).toBe('remote-own')

    for (const argv of [
      ['builds', '--all'],
      ['build', 'status', 'remote-foreign'],
      [
        'artifact',
        'download',
        'remote-foreign',
        'evidence',
        '--output',
        'downloads/remote-foreign.txt',
      ],
    ]) {
      const denied = await runBin(argv, env)
      expect(denied.code).toBe(1)
      expect(denied.stderr).toContain('phase-session store scoped to build "remote-own"')
    }
    expect(await Bun.file(join(tmp, 'downloads', 'remote-foreign.txt')).exists()).toBe(false)
  } finally {
    await server.stop()
    await backing.close()
  }
})

test('the binary forwards a bearer token to remote HTTP and rejects missing or invalid credentials', async () => {
  const secret = 'store-opening-secret'
  const now = new Date('2026-07-15T12:00:00.000Z')
  const backing = new MemoryBuildStore({ clock: () => now })
  const server = startStoreServer({ store: backing, secret, clock: () => now })
  const token = mintToken(secret, {
    version: 1,
    ownerAdmin: { user: 'owner:fixture' },
    exp: now.getTime() + 60_000,
  })
  try {
    const forwarded = await runBin(['builds', '--all'], { AB_STORE: server.url, AB_TOKEN: token })
    expect(forwarded.code).toBe(0)
    const missing = await runBin(['builds'], { AB_STORE: server.url })
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain('missing bearer credential')
    const invalid = await runBin(['builds'], { AB_STORE: server.url, AB_TOKEN: 'invalid-token' })
    expect(invalid.code).toBe(1)
    expect(invalid.stderr).toContain('credential format changed')
  } finally {
    await server.stop()
    await backing.close()
  }
})

async function seedRunningBuild(store: MemoryBuildStore, slug: string): Promise<void> {
  await store.createBuild({ slug, repo: REPO })
  await store.append(slug, {
    actor: KERNEL,
    type: 'runner.attached',
    payload: { instance: 'i1', host: 'h1', resumedFromSeq: 0 },
  })
}

test('an abort mid-hold tears down a real held remote request promptly', async () => {
  // A REAL remote client over a real in-process server: the held read is a
  // real held HTTP request, so this exercises the signal reaching the
  // underlying fetch — the seam the fake-store tests above cannot prove.
  const backing = new MemoryBuildStore({ clock: steppingClock() })
  const server = startStoreServer({ store: backing })
  try {
    let eventReads = 0
    const fetchFn = (async (input, init) => {
      if (
        typeof input === 'string' &&
        input.includes('/events?') &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        eventReads += 1
      }
      return fetch(input, init)
    }) as typeof fetch
    const store = new RemoteBuildStore({ url: server.url, fetchFn })
    await seedRunningBuild(store as never, 'b1')

    const out: string[] = []
    const err: string[] = []
    const external = new AbortController()
    const started = Date.now()
    const watch = abWatch({
      targetRepo: REPO,
      env: {},
      exec: fakeExec,
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      storeRef: server.url,
      openStore: () => store,
      slugs: ['b1'],
      timeout: '60',
      json: true,
      signal: external.signal,
    })
    // Registration uses a persisted seed; the first event GET is the held
    // request. It cannot complete before the abort — the build is
    // quiet and the hold bound is 25 s.
    while (eventReads < 1) await Bun.sleep(10)
    external.abort()
    await watch
    expect(Date.now() - started).toBeLessThan(5_000)
    // The cancelled read is the watch stopping, not a store failure.
    expect(err).toEqual([])
  } finally {
    await server.stop()
  }
})

test('saved project credential serves real CLI processes in the main checkout and linked worktree without AB_STORE/AB_TOKEN', async () => {
  const { spawnExec } = await import('@defrex/autobuild/testing')
  const { ProjectCredentials } = await import('@defrex/autobuild/testing')
  const { abConnect } = await import('@defrex/autobuild/testing')
  const { MachineAuthError } = await import('./machine-auth')
  const repo = 'https://github.com/example/connected-project'
  const configRoot = join(tmp, 'user-config'),
    linked = join(tmp, 'linked')
  async function git(args: string[]) {
    const result = await spawnExec(['git', ...args], { cwd: tmp })
    if (result.exitCode !== 0) throw new Error(result.stderr)
  }
  await git(['init', '-b', 'main'])
  await git(['config', 'user.email', 'fixture@example.com'])
  await git(['config', 'user.name', 'Fixture'])
  await git(['remote', 'add', 'origin', repo])
  await writeFile(
    join(tmp, 'autobuild.toml'),
    'forge="local-git"\n[tickets]\nsource="file"\nreadyState="Ready"\n[roles.default]\nruntime="codex"\nmodel="gpt-5.6"\n',
  )
  let acceptedToken: string | undefined
  const seen: string[] = []
  const backing = new MemoryBuildStore()
  await backing.createBuild({ slug: 'connected-fixture', repo })
  const server = startStoreServer({
    store: backing,
    secret: 'unused',
    auth: {
      authenticate: async (request) => {
        const token = request.headers.get('authorization')?.replace(/^Bearer /, '')
        if (!acceptedToken || token !== acceptedToken)
          throw new MachineAuthError(401, 'unknown credential')
        seen.push(token)
        return {
          kind: 'project',
          repo,
          user: 'fixture@example.com',
          credential: {
            id: 'a'.repeat(32),
            repo,
            createdAt: new Date().toISOString(),
            createdBy: 'fixture@example.com',
            purpose: 'project-owner',
            revokedAt: null,
            expiresAt: null,
            lastUsedAt: null,
          },
        }
      },
    },
  })
  const service = server.url
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('AB_')),
  ) as Record<string, string>
  env.XDG_CONFIG_HOME = configRoot
  let credentialId = ''
  try {
    await abConnect(service, {
      cwd: tmp,
      env,
      exec: spawnExec,
      print: () => {},
      browser: async () => {},
      sleep: async () => {},
      fetch: async (url, init) => {
        if (url.endsWith('/requests')) {
          credentialId = JSON.parse(String(init?.body)).credentialId
          return Response.json({
            id: 'a'.repeat(32),
            capability: 'b'.repeat(64),
            code: '123456789A',
            interval: 5,
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          })
        }
        return Response.json({ repo, credentialId, status: 'approved' })
      },
    })
    acceptedToken = new ProjectCredentials(env).load(service, repo)!.token
    await git(['add', 'autobuild.toml'])
    await git(['commit', '-m', 'Configure connected fixture'])
    await git(['worktree', 'add', '-b', 'linked', linked])
    for (const cwd of [tmp, linked]) {
      const result = await collect(
        Bun.spawn([process.execPath, BIN, 'builds', '--all', '--json'], {
          cwd,
          env,
          stdout: 'pipe',
          stderr: 'pipe',
        }),
      )
      expect(result.code).toBe(0)
      expect(result.stdout).toContain('connected-fixture')
      const ticket = await collect(
        Bun.spawn([process.execPath, BIN, 'ticket', 'list'], {
          cwd,
          env,
          stdout: 'pipe',
          stderr: 'pipe',
        }),
      )
      expect(ticket.code).toBe(0)
    }
    await backing.append('connected-fixture', { actor: DISPATCHER, type: 'pr.closed', payload: {} })
    const dispatched = await collect(
      Bun.spawn([process.execPath, BIN, 'dispatch', '--once', '--plain'], {
        cwd: linked,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    )
    expect(dispatched.stderr).toBe('')
    expect(dispatched.code).toBe(0)
    expect(seen.length).toBeGreaterThan(0)
    const override = await collect(
      Bun.spawn([process.execPath, BIN, 'builds', '--all', '--json'], {
        cwd: linked,
        env: { ...env, AB_TOKEN: 'wrong-override' },
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    )
    expect(override.code).toBe(1)
    new ProjectCredentials(env).remove(service, repo)
    const disconnected = await collect(
      Bun.spawn([process.execPath, BIN, 'builds'], {
        cwd: linked,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    )
    expect(disconnected.code).toBe(1)
    expect(disconnected.stderr).toContain('ab connect')
    expect(await Bun.file(join(tmp, '.autobuild', 'store.sqlite')).exists()).toBe(false)
  } finally {
    await server.stop()
    await backing.close()
  }
}, 20000)
