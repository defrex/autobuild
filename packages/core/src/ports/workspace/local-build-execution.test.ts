import { temporaryDirectories as ownTempDirectories } from '../../testing/temp-directories'
import { afterEach, describe, expect, test } from 'bun:test'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { signalProcessGroup } from '../../processes/process-group'
import { BUILD_RUNNER_OPTIONS_ENV, LocalBuildExecution } from './local-build-execution'

const mkdtemp = ownTempDirectories(afterEach)

async function alive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for process state')
    await Bun.sleep(10)
  }
}

function forceCleanup(groupId: number | undefined): void {
  if (groupId === undefined) return
  try {
    signalProcessGroup(groupId, 'SIGKILL')
  } catch {
    // Best-effort fixture cleanup after a failed assertion.
  }
}

describe('LocalBuildExecution', () => {
  test('starts distinct ignored-stdio children with immutable identity and reaps them', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'ab-build-execution-'))
    const entrypoint = join(tmp, 'child.ts')
    const records = join(tmp, 'records.txt')
    await writeFile(
      entrypoint,
      `import { appendFile } from 'node:fs/promises'
const input = process.env.${BUILD_RUNNER_OPTIONS_ENV}
await appendFile(process.env.RECORDS!, input + '\\n')
await Bun.sleep(60_000)
`,
    )
    let firstPid: number | undefined
    let secondPid: number | undefined
    try {
      const execution = new LocalBuildExecution({
        entrypoint,
        env: { ...process.env, RECORDS: records },
        stopTimeoutMs: 100,
      })
      const first = await execution.start({
        slug: 'first',
        storeRef: '/store',
        instance: 'i-1',
        workspaceRef: '/workspace/first',
      })
      const second = await execution.start({
        slug: 'second',
        storeRef: '/store',
        instance: 'i-2',
        workspaceRef: '/workspace/second',
      })
      firstPid = first.pid
      secondPid = second.pid
      expect(firstPid).toBeNumber()
      expect(secondPid).toBeNumber()
      expect(firstPid).not.toBe(secondPid)
      // A cold bun child on a loaded host can take well over 50 ms to reach
      // its first statement; stop only after both have written their record.
      await waitFor(
        async () =>
          (await Bun.file(records).exists()) &&
          (await Bun.file(records).text()).trim().split('\n').length === 2,
        10_000,
      )
      expect(await alive(firstPid!)).toBe(true)
      expect(await alive(secondPid!)).toBe(true)

      await first.stop()
      await first.stop()
      expect((await first.completion).exitCode).not.toBe(0)
      expect(await alive(firstPid!)).toBe(false)
      expect(await alive(secondPid!)).toBe(true)
      await second.stop()
      await second.completion

      const lines = (await Bun.file(records).text())
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .sort((a, b) => a.slug.localeCompare(b.slug))
      expect(lines).toEqual([
        {
          slug: 'first',
          storeRef: '/store',
          instance: 'i-1',
          workspaceRef: '/workspace/first',
          supervision: { kind: 'local-parent', parentPid: process.pid },
        },
        {
          slug: 'second',
          storeRef: '/store',
          instance: 'i-2',
          workspaceRef: '/workspace/second',
          supervision: { kind: 'local-parent', parentPid: process.pid },
        },
      ])
    } finally {
      forceCleanup(firstPid)
      forceCleanup(secondPid)
      await rm(tmp, { recursive: true, force: true })
    }
  })

  test('graceful stop keeps descendants alive until slow leader persistence finishes', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'ab-build-slow-stop-'))
    const entrypoint = join(tmp, 'child.ts')
    const ready = join(tmp, 'ready')
    const persisted = join(tmp, 'persisted')
    await writeFile(
      entrypoint,
      `
import { writeFile } from 'node:fs/promises'

const descendant = Bun.spawn(['sleep', '60'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
let stopping = false
process.on('SIGTERM', async () => {
  if (stopping) return
  stopping = true
  await Bun.sleep(5200)
  process.kill(descendant.pid, 0)
  await writeFile(${JSON.stringify(persisted)}, 'complete')
  process.exit(0)
})
await writeFile(${JSON.stringify(ready)}, String(descendant.pid))
await Bun.sleep(60000)
`,
    )
    let leader: number | undefined
    try {
      const execution = new LocalBuildExecution({ entrypoint, stopTimeoutMs: 20 })
      const handle = await execution.start({
        slug: 'slow-stop',
        workspaceRef: tmp,
        storeRef: '/store',
        instance: 'slow',
      })
      leader = handle.pid
      await waitFor(() => Bun.file(ready).size > 0)
      const descendant = Number(await Bun.file(ready).text())
      const stopping = handle.stop()
      await Bun.sleep(5100)
      expect(await alive(leader!)).toBe(true)
      expect(await alive(descendant)).toBe(true)
      await stopping
      expect(await Bun.file(persisted).text()).toBe('complete')
      expect((await handle.completion).exitCode).toBe(0)
      expect(await alive(descendant)).toBe(false)
    } finally {
      forceCleanup(leader)
      await rm(tmp, { recursive: true, force: true })
    }
  }, 15000)

  test('explicit stop force-terminates a stubborn inherited descendant', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'ab-build-tree-stop-'))
    const entrypoint = join(tmp, 'child.ts')
    const descendantFile = join(tmp, 'descendant.pid')
    await writeFile(
      entrypoint,
      `const descendant = Bun.spawn(['sh', '-c', ${JSON.stringify(
        `trap '' TERM; echo $$ > ${descendantFile}; while :; do sleep 1; done`,
      )}], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
await Bun.sleep(60_000)
`,
    )
    let leaderPid: number | undefined
    try {
      const execution = new LocalBuildExecution({ entrypoint, stopTimeoutMs: 100 })
      const handle = await execution.start({
        slug: 'stubborn',
        storeRef: '/store',
        instance: 'i-stubborn',
        workspaceRef: '/workspace/stubborn',
      })
      leaderPid = handle.pid
      await waitFor(() => Bun.file(descendantFile).size > 0)
      const descendantPid = Number(await Bun.file(descendantFile).text())
      expect(await alive(descendantPid)).toBe(true)

      const started = Date.now()
      await handle.stop()
      await handle.completion
      expect(Date.now() - started).toBeGreaterThanOrEqual(80)
      expect(await alive(leaderPid!)).toBe(false)
      expect(await alive(descendantPid)).toBe(false)
    } finally {
      forceCleanup(leaderPid)
      await rm(tmp, { recursive: true, force: true })
    }
  })

  test('natural leader exit reaps a surviving descendant before completion', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'ab-build-tree-natural-'))
    const entrypoint = join(tmp, 'child.ts')
    const descendantFile = join(tmp, 'descendant.pid')
    await writeFile(
      entrypoint,
      `const descendant = Bun.spawn(['sh', '-c', ${JSON.stringify(
        `echo $$ > ${descendantFile}; while :; do sleep 1; done`,
      )}], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
descendant.unref()
while (Bun.file(${JSON.stringify(descendantFile)}).size === 0) await Bun.sleep(5)
`,
    )
    let leaderPid: number | undefined
    try {
      const execution = new LocalBuildExecution({ entrypoint, stopTimeoutMs: 500 })
      const handle = await execution.start({
        slug: 'natural',
        storeRef: '/store',
        instance: 'i-natural',
        workspaceRef: '/workspace/natural',
      })
      leaderPid = handle.pid
      await waitFor(() => Bun.file(descendantFile).size > 0)
      const descendantPid = Number(await Bun.file(descendantFile).text())
      expect(await handle.completion).toEqual({ exitCode: 0 })
      expect(await alive(leaderPid!)).toBe(false)
      expect(await alive(descendantPid)).toBe(false)
    } finally {
      forceCleanup(leaderPid)
      await rm(tmp, { recursive: true, force: true })
    }
  })

  test('explicit stop with no descendants does not wait for the stop timeout', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'ab-build-tree-stop-empty-'))
    const entrypoint = join(tmp, 'child.ts')
    await writeFile(entrypoint, 'await Bun.sleep(60_000)\n')
    let leaderPid: number | undefined
    try {
      const execution = new LocalBuildExecution({ entrypoint, stopTimeoutMs: 2_000 })
      const handle = await execution.start({
        slug: 'stop-empty',
        storeRef: '/store',
        instance: 'i-stop-empty',
        workspaceRef: '/workspace/stop-empty',
      })
      leaderPid = handle.pid
      await waitFor(() => alive(leaderPid!))
      const started = Date.now()
      await handle.stop()
      expect(Date.now() - started).toBeLessThan(1_000)
      expect(await alive(leaderPid!)).toBe(false)
    } finally {
      forceCleanup(leaderPid)
      await rm(tmp, { recursive: true, force: true })
    }
  })

  test('a natural exit with no descendants does not wait for the stop timeout', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'ab-build-tree-empty-'))
    const entrypoint = join(tmp, 'child.ts')
    await writeFile(entrypoint, '')
    try {
      const execution = new LocalBuildExecution({ entrypoint, stopTimeoutMs: 2_000 })
      const started = Date.now()
      const handle = await execution.start({
        slug: 'empty',
        storeRef: '/store',
        instance: 'i-empty',
        workspaceRef: '/workspace/empty',
      })
      expect(await handle.completion).toEqual({ exitCode: 0 })
      expect(Date.now() - started).toBeLessThan(1_000)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })
})

test('launch authority replaces the parent secret without putting it in serialized identity', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'ab-launch-authority-'))
  try {
    const entrypoint = join(tmp, 'record.ts')
    const record = join(tmp, 'record.json')
    await writeFile(
      entrypoint,
      `await Bun.write(process.env.RECORD!, JSON.stringify({ token: process.env.AB_TOKEN, identity: process.env.AB_BUILD_RUNNER_OPTIONS }))`,
    )
    const executor = new LocalBuildExecution({
      entrypoint,
      env: { AB_TOKEN: 'parent-project-canary', RECORD: record },
    })
    const input = {
      slug: 'one',
      storeRef: 'https://store.test',
      instance: 'i',
      workspaceRef: '/workspace',
    }
    await expect(executor.start(input)).rejects.toThrow('delegated authority')
    const child = await executor.start(input, { token: 'scoped-runner-canary' })
    expect((await child.completion).exitCode).toBe(0)
    const bytes = await Bun.file(record).text()
    expect(bytes).not.toContain('parent-project-canary')
    expect(JSON.parse(bytes).token).toBe('scoped-runner-canary')
    expect(JSON.parse(bytes).identity).not.toContain('canary')
    const local = await executor.start({ ...input, storeRef: '/local-store' })
    expect((await local.completion).exitCode).toBe(0)
    expect(JSON.parse(await Bun.file(record).text()).token).toBeUndefined()
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})
