/**
 * End-to-end smoke tests for the REAL `ab` binary.
 *
 * These exist because every other CLI test calls `runCli` directly and so
 * never traverses the real process entries and shared `src/cli/binary.ts`
 * wiring. That wiring routes sessionless commands on SESSIONLESS_COMMANDS and
 * sends everything else through `resolveCliEnv`,
 * which REQUIRES AB_STORE/AB_BUILD/AB_PHASE/AB_SESSION and returns 1 before
 * `runCli` routes anything. A command missing from the set therefore ships
 * broken while the entire unit suite stays green — a green `bun test` is not
 * evidence here, so the binary itself is executed.
 *
 * Most smoke cases point AB_STORE at a temporary override, and the session
 * keys stay unset — exactly the condition that would trip resolveCliEnv if
 * routing regressed. A separate real-Git case exercises the implicit
 * repository-local root with no override.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KERNEL } from '../events/envelope'
import { spawnExec } from '../ports/workspace/git-worktree'
import { openLocalStore } from '../store/local/store'

const ROOT = join(import.meta.dir, '..', '..')
const BIN = join(ROOT, 'bin', 'ab.ts')

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ab-bin-'))
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

function testEnv(): Record<string, string> {
  return {
    PATH: process.env['PATH'] ?? '',
    HOME: process.env['HOME'] ?? '',
    // The store is a temp dir; AB_BUILD/AB_PHASE/AB_SESSION are deliberately
    // absent — resolveCliEnv would reject on them if routing regressed.
    AB_STORE: join(tmp, 'store'),
  }
}

async function runBin(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return collect(Bun.spawn(['bun', BIN, ...args], {
    cwd: tmp,
    env: { ...testEnv(), ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  }))
}

async function runDev(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return collect(Bun.spawn(['bun', 'run', 'dev', '--', ...args], {
    cwd: ROOT,
    env: testEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  }))
}

async function runBinAt(
  cwd: string,
  args: string[],
  home: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return collect(Bun.spawn(['bun', BIN, ...args], {
    cwd,
    // Deliberately omit every AB_* variable: this is the implicit-root path.
    env: { PATH: process.env['PATH'] ?? '', HOME: home },
    stdout: 'pipe',
    stderr: 'pipe',
  }))
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await spawnExec(['git', ...args], { cwd })
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout)
}

test('ab builds runs with no session environment set', async () => {
  const result = await runBin(['builds'])
  expect(result.stderr).not.toContain('AB_BUILD')
  expect(result.stderr).not.toContain('runs inside a build session')
  expect(result.code).toBe(0)
  expect(result.stdout).toContain('no active builds')
})

test('ab builds --json emits parseable JSON and no ANSI', async () => {
  const result = await runBin(['builds', '--all', '--json'])
  expect(result.code).toBe(0)
  expect(result.stdout).not.toContain('\x1b')
  expect(JSON.parse(result.stdout)).toEqual([])
})

test('the repo dev script forwards a complete CLI invocation and exits under --hot', async () => {
  const result = await runDev(['builds', '--all', '--json'])
  expect(result.code).toBe(0)
  expect(result.stdout).not.toContain('\x1b')
  expect(JSON.parse(result.stdout)).toEqual([])
})

test('ab build status runs sessionless and exits 1 on an unknown slug', async () => {
  const result = await runBin(['build', 'status', 'no-such-build'])
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('no-such-build')
  expect(result.stderr).not.toContain('AB_BUILD')
})

test('a real sessionless control command reaches the store and writes a human event', async () => {
  const local = openLocalStore(join(tmp, 'store'))
  await local.createBuild({ slug: 'controlled', repo: await realpath(tmp) })
  await local.append('controlled', {
    actor: KERNEL,
    type: 'runner.attached',
    payload: { instance: 'runner-1', host: 'host-1', resumedFromSeq: 0 },
  })
  await local.close()

  const result = await runBin(['pause', 'controlled'])
  expect(result.code).toBe(0)
  expect(result.stderr).toBe('')
  expect(result.stdout).toContain('pause requested')

  const reopened = openLocalStore(join(tmp, 'store'))
  const event = (await reopened.getEvents('controlled')).at(-1)
  expect(event?.type).toBe('build.pause-requested')
  expect(event?.actor).toEqual({ kind: 'human', user: 'dashboard' })
  await reopened.close()
})

test('artifact download alone is sessionless and preserves binary bytes', async () => {
  const local = openLocalStore(join(tmp, 'store'))
  await local.createBuild({ slug: 'finished', repo: await realpath(tmp) })
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255])
  await local.putArtifact('finished', {
    kind: 'dashboard-frame:mixed-wide:png',
    content: bytes,
  })
  await local.close()

  const result = await runBin([
    'artifact',
    'download',
    'finished',
    'dashboard-frame:mixed-wide:png@0',
    '--output',
    'downloads/frame.png',
  ])
  expect(result.code).toBe(0)
  expect(result.stderr).toBe('')
  expect(result.stdout).toContain('dashboard-frame:mixed-wide:png@0')
  expect(await Bun.file(join(tmp, 'downloads', 'frame.png')).bytes()).toEqual(
    bytes,
  )
})

test('artifact put/get still route through ambient phase auth', async () => {
  for (const argv of [
    ['artifact', 'put', 'kind', 'file'],
    ['artifact', 'get', 'kind'],
  ]) {
    const result = await runBin(argv)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('AB_BUILD')
  }
})

test('the real binary rejects an own-phase control without changing the log', async () => {
  const local = openLocalStore(join(tmp, 'store'))
  await local.createBuild({ slug: 'self-controlled', repo: await realpath(tmp) })
  await local.append('self-controlled', {
    actor: KERNEL,
    type: 'runner.attached',
    payload: { instance: 'runner-1', host: 'host-1', resumedFromSeq: 0 },
  })
  const before = await local.getEvents('self-controlled')
  await local.close()

  const result = await runBin(['abort', 'self-controlled'], {
    AB_SESSION: 'phase-session',
    AB_BUILD: 'self-controlled',
  })
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('own phase session')
  expect(result.stderr).toContain('AB_SESSION/AB_BUILD conflict')

  const reopened = openLocalStore(join(tmp, 'store'))
  expect(await reopened.getEvents('self-controlled')).toEqual(before)
  await reopened.close()
})

test('implicit state is shared by a main checkout and its linked worktree and ignores HOME', async () => {
  const main = join(tmp, 'main')
  const linked = join(tmp, 'linked')
  const fakeHome = join(tmp, 'home')
  await git(tmp, 'init', '-b', 'main', main)
  await git(main, 'config', 'user.email', 'test@example.com')
  await git(main, 'config', 'user.name', 'Test')
  await writeFile(join(main, 'README.md'), 'fixture\n')
  await git(main, 'add', 'README.md')
  await git(main, 'commit', '-m', 'fixture')
  await git(main, 'worktree', 'add', '-b', 'linked', linked)

  const canonicalMain = await realpath(main)
  const local = openLocalStore(join(main, '.autobuild'))
  await local.createBuild({ slug: 'repo-build', repo: canonicalMain })
  await local.append('repo-build', {
    actor: KERNEL,
    type: 'runner.attached',
    payload: { instance: 'i1', host: 'h1', resumedFromSeq: 0 },
  })
  await local.close()

  // Poison the old machine-level shape. Repository-local resolution must never
  // discover this otherwise valid store through HOME.
  const poison = openLocalStore(join(fakeHome, '.autobuild'))
  await poison.createBuild({ slug: 'home-only', repo: canonicalMain })
  await poison.close()

  const fromMain = await runBinAt(main, ['builds', '--all', '--json'], fakeHome)
  const fromLinked = await runBinAt(linked, ['builds', '--all', '--json'], fakeHome)
  expect(fromMain.code).toBe(0)
  expect(fromLinked.code).toBe(0)
  expect(fromMain.stderr).toBe('')
  expect(fromLinked.stderr).toBe('')
  expect(JSON.parse(fromMain.stdout).map((build: { slug: string }) => build.slug)).toEqual([
    'repo-build',
  ])
  expect(JSON.parse(fromLinked.stdout)).toEqual(JSON.parse(fromMain.stdout))
})

test('a session command still demands its environment', async () => {
  // The complement: routing did not accidentally make everything sessionless.
  const result = await runBin(['context'])
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('AB_BUILD')
})
