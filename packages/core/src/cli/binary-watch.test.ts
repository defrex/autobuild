import { expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openLocalStore } from '../store/local/store'
import { humanActor } from '../events/envelope'

const entry = resolve(import.meta.dir, '../../../..', 'bin/ab.ts')
async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('watch subprocess did not reach expected state')
    await Bun.sleep(10)
  }
}

async function fixture(
  run: (f: {
    child: ChildProcess
    exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
    store: ReturnType<typeof openLocalStore>
    repo: string
    output: () => string
    errors: () => string
  }) => Promise<void>,
  timeout = '0',
): Promise<void> {
  const repo = await mkdtemp(join(tmpdir(), 'ab-watch-termination-'))
  const state = join(repo, 'state')
  const git = Bun.spawnSync(['git', 'init', '--quiet', repo])
  expect(git.exitCode).toBe(0)
  const store = openLocalStore(state)
  await store.ensureRepo(repo)
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('AB_')) delete env[key]
  const child = spawn(
    process.execPath,
    [
      entry,
      'watch',
      '--operator',
      '--repository',
      '--event',
      '*',
      '--json',
      '--timeout',
      timeout,
      '--interval',
      '1s',
      '--store',
      state,
    ],
    {
      cwd: repo,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let output = ''
  let errors = ''
  child.stdout!.on('data', (chunk) => {
    output += chunk.toString()
  })
  child.stderr!.on('data', (chunk) => {
    errors += chunk.toString()
  })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    },
  )
  try {
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`watch exited early: ${errors}`)
      return (await store.listOperatorPresence(repo)).length === 1
    })
    await run({ child, exited, store, repo, output: () => output, errors: () => errors })
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await exited
    await store.close()
    await rm(repo, { recursive: true, force: true })
  }
}

for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) {
  test(`real flagged watch withdraws immediately on ${signal} and retains process outcome`, async () => {
    await fixture(async ({ child, exited, store, repo, output, errors }) => {
      child.kill(signal)
      const outcome = await exited
      expect(outcome).toEqual(
        signal === 'SIGINT' ? { code: 0, signal: null } : { code: null, signal },
      )
      expect(await store.listOperatorPresence(repo)).toEqual([])
      if (signal === 'SIGINT')
        expect(JSON.parse(output().trim().split('\n').at(-1)!).cursor).toStartWith('v1.')
      else expect(output()).toBe('')
      expect(errors()).toBe('')
    })
  }, 10_000)
}

test('real stdout EPIPE withdraws and retains failure exit without additional cursor output', async () => {
  await fixture(async ({ child, exited, store, repo, output }) => {
    // Close only this test child's pipe; a later event forces asynchronous EPIPE.
    child.stdout!.destroy()
    await waitFor(async () => {
      await store.appendRepo(repo, {
        actor: humanActor('test'),
        type: 'dispatcher.operator-reported',
        payload: { run: 'test-run', level: 'info', message: 'force pipe write' },
      })
      await Bun.sleep(50)
      return child.exitCode !== null
    })
    expect(await exited).toEqual({ code: 1, signal: null })
    expect(await store.listOperatorPresence(repo)).toEqual([])
    expect(output()).toBe('')
  })
}, 10_000)

test('EPIPE from the final timeout cursor still withdraws before closing the store', async () => {
  await fixture(async ({ child, exited, store, repo }) => {
    child.stdout!.destroy()
    expect(await exited).toEqual({ code: 1, signal: null })
    expect(await store.listOperatorPresence(repo)).toEqual([])
  }, '1')
}, 10_000)
