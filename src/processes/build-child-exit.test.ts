import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { signalProcessGroup } from './process-group'
import { BuildChildExitCoordinator } from './build-child-exit'

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
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

describe('BuildChildExitCoordinator', () => {
  test('preserves the first exit intent and launches exactly one helper across races', () => {
    const launches: unknown[] = []
    const exits: number[] = []
    let closes = 0
    const terminal = new BuildChildExitCoordinator({
      groupId: 123,
      stopTimeoutMs: 456,
      launchReaper: (options) => {
        launches.push(options)
        return 789
      },
      exit: (code) => exits.push(code),
    })
    terminal.setParentWatch({ close: () => closes++ })

    terminal.terminate(0)
    terminal.terminate(143)
    terminal.terminate(130)

    expect(launches).toEqual([{ groupId: 123, stopTimeoutMs: 456 }])
    expect(exits).toEqual([0])
    expect(closes).toBe(1)
  })

  test('keeps teardown ownership local and retries when helper creation fails', async () => {
    let attempts = 0
    const exits: number[] = []
    const terminal = new BuildChildExitCoordinator({
      groupId: 123,
      retryDelayMs: 1,
      launchReaper: () => {
        attempts++
        if (attempts === 1) throw new Error('temporary spawn failure')
        return 789
      },
      exit: (code) => exits.push(code),
    })

    terminal.terminate(1)
    expect(exits).toEqual([])
    await waitFor(() => exits.length === 1)
    expect(attempts).toBe(2)
    expect(exits).toEqual([1])
  })
})

test('natural exit with no descendants leaves no helper and stays on the fast path', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'ab-build-child-exit-empty-'))
  const helperFile = join(tmp, 'helper.pid')
  const childScript = join(tmp, 'child.ts')
  const terminalUrl = pathToFileURL(join(import.meta.dir, 'build-child-exit.ts')).href
  const reaperUrl = pathToFileURL(join(import.meta.dir, 'process-group-reaper.ts')).href
  await writeFile(
    childScript,
    `import { writeFileSync } from 'node:fs'
import { BuildChildExitCoordinator } from ${JSON.stringify(terminalUrl)}
import { launchProcessGroupReaper } from ${JSON.stringify(reaperUrl)}
const terminal = new BuildChildExitCoordinator({
  groupId: process.pid,
  stopTimeoutMs: 2_000,
  launchReaper: (options) => {
    const pid = launchProcessGroupReaper(options)
    writeFileSync(${JSON.stringify(helperFile)}, String(pid))
    return pid
  },
})
process.on('SIGTERM', () => terminal.terminate(143))
terminal.terminate(0)
`,
  )

  const started = Date.now()
  const child = Bun.spawn([process.execPath, childScript], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    detached: true,
  })
  let helperPid: number | undefined
  try {
    expect(await child.exited).toBe(0)
    await waitFor(() => Bun.file(helperFile).size > 0)
    helperPid = Number(await Bun.file(helperFile).text())
    await waitFor(() => !alive(helperPid!))
    expect(Date.now() - started).toBeLessThan(1_000)
  } finally {
    forceCleanup(child.pid)
    if (helperPid !== undefined && alive(helperPid)) process.kill(helperPid, 'SIGKILL')
    await rm(tmp, { recursive: true, force: true })
  }
})

test('natural leader exit hands stubborn descendants to a reaper that survives kernel death', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'ab-build-child-exit-'))
  const descendantFile = join(tmp, 'descendant.pid')
  const helperFile = join(tmp, 'helper.pid')
  const leaderFile = join(tmp, 'leader.pid')
  const buildScript = join(tmp, 'build.ts')
  const kernelScript = join(tmp, 'kernel.ts')
  const terminalUrl = pathToFileURL(join(import.meta.dir, 'build-child-exit.ts')).href
  const parentWatchUrl = pathToFileURL(join(import.meta.dir, 'build-parent-watch.ts')).href
  const reaperUrl = pathToFileURL(join(import.meta.dir, 'process-group-reaper.ts')).href
  const executionUrl = pathToFileURL(
    join(import.meta.dir, '../ports/workspace/local-build-execution.ts'),
  ).href

  await writeFile(
    buildScript,
    `import { writeFileSync } from 'node:fs'
import { BuildChildExitCoordinator } from ${JSON.stringify(terminalUrl)}
import { watchBuildParent } from ${JSON.stringify(parentWatchUrl)}
import { launchProcessGroupReaper } from ${JSON.stringify(reaperUrl)}

const terminal = new BuildChildExitCoordinator({
  groupId: process.pid,
  stopTimeoutMs: 500,
  launchReaper: (options) => {
    const pid = launchProcessGroupReaper(options)
    writeFileSync(${JSON.stringify(helperFile)}, String(pid))
    return pid
  },
})
terminal.setParentWatch(watchBuildParent(Number(process.env.EXPECTED_PARENT), () => {
  terminal.terminate(143)
}, 10))
const descendant = Bun.spawn(['sh', '-c', ${JSON.stringify(
      `trap '' TERM; echo $$ > ${descendantFile}; while :; do sleep 1; done`,
    )}], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
descendant.unref()
while (Bun.file(${JSON.stringify(descendantFile)}).size === 0) await Bun.sleep(5)
terminal.terminate(0)
`,
  )
  await writeFile(
    kernelScript,
    `import { writeFileSync } from 'node:fs'
import { LocalBuildExecution } from ${JSON.stringify(executionUrl)}
const execution = new LocalBuildExecution({
  entrypoint: ${JSON.stringify(buildScript)},
  env: { ...process.env, EXPECTED_PARENT: String(process.pid) },
  stopTimeoutMs: 500,
})
const handle = await execution.start({
  slug: 'natural-handoff', storeRef: '/store', instance: 'fixture', parentPid: process.pid,
})
writeFileSync(${JSON.stringify(leaderFile)}, String(handle.pid))
await handle.completion
`,
  )

  const unrelated = Bun.spawn(['sh', '-c', `trap '' TERM; while :; do sleep 1; done`], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    detached: true,
  })
  unrelated.unref()
  const kernel = Bun.spawn([process.execPath, kernelScript], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  })
  let leaderPid: number | undefined
  let descendantPid: number | undefined
  let helperPid: number | undefined
  try {
    await waitFor(
      () =>
        Bun.file(leaderFile).size > 0 &&
        Bun.file(descendantFile).size > 0 &&
        Bun.file(helperFile).size > 0,
      3_000,
    )
    leaderPid = Number(await Bun.file(leaderFile).text())
    descendantPid = Number(await Bun.file(descendantFile).text())
    helperPid = Number(await Bun.file(helperFile).text())
    expect(alive(descendantPid)).toBe(true)
    expect(alive(helperPid)).toBe(true)
    expect(alive(unrelated.pid)).toBe(true)

    kernel.kill('SIGKILL')
    await kernel.exited
    await waitFor(() => !alive(descendantPid!), 3_000)
    await waitFor(() => !alive(helperPid!), 3_000)

    expect(alive(descendantPid)).toBe(false)
    expect(alive(helperPid)).toBe(false)
    expect(alive(unrelated.pid)).toBe(true)
  } finally {
    if (kernel.exitCode === null) kernel.kill('SIGKILL')
    forceCleanup(leaderPid)
    forceCleanup(unrelated.pid)
    if (helperPid !== undefined && alive(helperPid)) process.kill(helperPid, 'SIGKILL')
    await rm(tmp, { recursive: true, force: true })
  }
})
