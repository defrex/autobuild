import { afterAll, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HookConfig } from '../config/schema'
import { runCommandHook } from './hook-command'
import { processGroupAlive } from './process-group'

const dirs: string[] = []
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ab-hook-command-'))
  dirs.push(dir)
  return dir
}

function hook(command: string, timeoutSeconds = 30): { name: string; config: HookConfig } {
  return { name: 'notify', config: { command, timeoutSeconds } }
}

const run = (command: string, line: string, cwd: string, timeoutSeconds?: number) =>
  runCommandHook(hook(command, timeoutSeconds), line, new AbortController().signal, {
    checkout: cwd,
    env: { ...process.env, AB_BUILD: 'leak', AB_SESSION: 'leak' },
    stopTimeoutMs: 200,
  })

test('stdin carries exactly the record line, from the checkout, with AB_HOOK and no build identity', async () => {
  const dir = await scratch()
  const line = `${JSON.stringify({ id: 'repo:1', cursor: 'v1.x' })}\n`
  expect(
    await run(
      'cat > stdin.txt; pwd > cwd.txt; printf "%s|%s" "$AB_HOOK" "$(printenv AB_BUILD || echo unset)" > env.txt',
      line,
      dir,
    ),
  ).toEqual({ ok: true })
  expect(await readFile(join(dir, 'stdin.txt'), 'utf8')).toBe(line)
  expect((await readFile(join(dir, 'cwd.txt'), 'utf8')).trim()).toEndWith(dir.split('/').at(-1)!)
  expect(await readFile(join(dir, 'env.txt'), 'utf8')).toBe('notify|unset')
})

test('a nonzero exit is a failure carrying the output tail', async () => {
  const dir = await scratch()
  expect(await run('echo first; echo "no route to host" >&2; exit 3', '{}\n', dir)).toEqual({
    ok: false,
    error: 'exit status 3: first\nno route to host',
  })
})

test('descendants left behind by a successful command are reaped', async () => {
  const dir = await scratch()
  const result = await run('sleep 30 & echo $! > child.pid; exit 0', '{}\n', dir)
  expect(result).toEqual({ ok: true })
  const child = Number((await readFile(join(dir, 'child.pid'), 'utf8')).trim())
  let alive = true
  try {
    process.kill(child, 0)
  } catch {
    alive = false
  }
  expect(alive).toBe(false)
})

// A record larger than the pipe buffer, to a command that never reads stdin.
const backpressured = `${JSON.stringify({ id: 'repo:1', pad: 'x'.repeat(1024 * 1024) })}\n`

test('a backpressured stdin write does not hold a command past its timeout', async () => {
  const dir = await scratch()
  const started = Date.now()
  const result = await run('sleep 30 & echo $! > child.pid; sleep 30', backpressured, dir, 1)
  expect(result).toEqual({ ok: false, error: 'timed out after 1s' })
  expect(Date.now() - started).toBeLessThan(10_000)
  const child = Number((await readFile(join(dir, 'child.pid'), 'utf8')).trim())
  let alive = true
  try {
    process.kill(child, 0)
  } catch {
    alive = false
  }
  expect(alive).toBe(false)
})

test('an abort stops a command whose stdin write is backpressured', async () => {
  const dir = await scratch()
  const controller = new AbortController()
  const started = Date.now()
  const pending = runCommandHook(
    hook('echo $$ > group.pid; sleep 30'),
    backpressured,
    controller.signal,
    { checkout: dir, env: process.env, stopTimeoutMs: 200 },
  )
  for (let i = 0; i < 100; i++) {
    if (await Bun.file(join(dir, 'group.pid')).exists()) break
    await Bun.sleep(20)
  }
  controller.abort()
  expect(await pending).toEqual({ ok: false, error: 'stopped' })
  expect(Date.now() - started).toBeLessThan(10_000)
  const group = Number((await readFile(join(dir, 'group.pid'), 'utf8')).trim())
  expect(processGroupAlive(group)).toBe(false)
})
