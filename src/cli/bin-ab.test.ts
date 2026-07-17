/**
 * End-to-end smoke tests for the REAL `ab` binary.
 *
 * These exist because every other CLI test calls `runCli` directly and so
 * never traverses `bin/ab.ts`. That file routes sessionless commands on
 * SESSIONLESS_COMMANDS and sends everything else through `resolveCliEnv`,
 * which REQUIRES AB_STORE/AB_BUILD/AB_PHASE/AB_SESSION and returns 1 before
 * `runCli` routes anything. A command missing from the set therefore ships
 * broken while the entire unit suite stays green — a green `bun test` is not
 * evidence here, so the binary itself is executed.
 *
 * AB_STORE points at a temp dir (never the operator's real ~/.autobuild), and
 * the session keys stay unset — which is exactly the condition that would trip
 * resolveCliEnv if routing regressed.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BIN = join(import.meta.dir, '..', '..', 'bin', 'ab.ts')

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ab-bin-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

async function runBin(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(['bun', BIN, ...args], {
    cwd: tmp,
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: process.env['HOME'] ?? '',
      // The store is a temp dir; AB_BUILD/AB_PHASE/AB_SESSION are deliberately
      // absent — resolveCliEnv would reject on them if routing regressed.
      AB_STORE: join(tmp, 'store'),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, code }
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

test('ab build status runs sessionless and exits 1 on an unknown slug', async () => {
  const result = await runBin(['build', 'status', 'no-such-build'])
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('no-such-build')
  expect(result.stderr).not.toContain('AB_BUILD')
})

test('a session command still demands its environment', async () => {
  // The complement: routing did not accidentally make everything sessionless.
  const result = await runBin(['context'])
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('AB_BUILD')
})
