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
import { abWatch, KERNEL, steppingClock, type Exec } from '@defrex/autobuild/testing'
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
      build: 'remote-own',
      session: 's_remote_read',
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
      expect(denied.stderr).toContain('token scoped to build "remote-own"')
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
    build: '*',
    session: '*',
    exp: now.getTime() + 60_000,
  })
  try {
    const forwarded = await runBin(['builds', '--all'], { AB_STORE: server.url, AB_TOKEN: token })
    expect(forwarded.code).toBe(0)
    const missing = await runBin(['builds'], { AB_STORE: server.url })
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain('missing bearer token')
    const invalid = await runBin(['builds'], { AB_STORE: server.url, AB_TOKEN: 'invalid-token' })
    expect(invalid.code).toBe(1)
    expect(invalid.stderr).toContain('invalid or expired token')
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
    // The first GET is the initial scan's immediate read; the second is
    // the held request. It cannot complete before the abort — the build is
    // quiet and the hold bound is 25 s.
    while (eventReads < 2) await Bun.sleep(10)
    external.abort()
    await watch
    expect(Date.now() - started).toBeLessThan(5_000)
    // The cancelled read is the watch stopping, not a store failure.
    expect(err).toEqual([])
  } finally {
    await server.stop()
  }
})
