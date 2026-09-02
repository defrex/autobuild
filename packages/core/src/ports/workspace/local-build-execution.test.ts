import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { signalProcessGroup } from '../../processes/process-group'
import { BUILD_RUNNER_OPTIONS_ENV, LocalBuildExecution } from './local-build-execution'

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
        parentPid: process.pid,
      })
      const second = await execution.start({
        slug: 'second',
        storeRef: '/store',
        instance: 'i-2',
        parentPid: process.pid,
      })
      firstPid = first.pid
      secondPid = second.pid
      expect(firstPid).toBeNumber()
      expect(secondPid).toBeNumber()
      expect(firstPid).not.toBe(secondPid)
      await Bun.sleep(50)
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
        { slug: 'first', storeRef: '/store', instance: 'i-1', parentPid: process.pid },
        { slug: 'second', storeRef: '/store', instance: 'i-2', parentPid: process.pid },
      ])
    } finally {
      forceCleanup(firstPid)
      forceCleanup(secondPid)
      await rm(tmp, { recursive: true, force: true })
    }
  })

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
        parentPid: process.pid,
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
        parentPid: process.pid,
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
        parentPid: process.pid,
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
        parentPid: process.pid,
      })
      expect(await handle.completion).toEqual({ exitCode: 0 })
      expect(Date.now() - started).toBeLessThan(1_000)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })
})
