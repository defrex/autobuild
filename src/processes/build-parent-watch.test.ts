import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

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

interface ParentDeathScenario {
  delayWatch: boolean
  waitUntilReady: boolean
}

async function runParentDeathScenario(scenario: ParentDeathScenario): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), 'ab-build-parent-watch-'))
  const pidFile = join(tmp, 'child.pid')
  const readyFile = join(tmp, 'child.ready')
  const childScript = join(tmp, 'child.ts')
  const parentScript = join(tmp, 'parent.ts')
  const helper = pathToFileURL(join(import.meta.dir, 'build-parent-watch.ts')).href
  await writeFile(
    childScript,
    `import { watchBuildParent } from ${JSON.stringify(helper)}
${scenario.delayWatch ? 'await Bun.sleep(250)' : ''}
const expectedParent = Number(process.env.EXPECTED_PARENT)
const watch = watchBuildParent(expectedParent, () => process.exit(143), 10)
await Bun.write(${JSON.stringify(readyFile)}, 'ready')
await Bun.sleep(60_000)
watch.close()
`,
  )
  await writeFile(
    parentScript,
    `const child = Bun.spawn([process.execPath, ${JSON.stringify(childScript)}], {
  env: { ...process.env, EXPECTED_PARENT: String(process.pid) },
  stdin: 'ignore', stdout: 'ignore', stderr: 'ignore'
})
await Bun.write(${JSON.stringify(pidFile)}, String(child.pid))
${scenario.waitUntilReady ? 'await Bun.sleep(60_000)' : 'process.exit(0)'}
`,
  )

  const parent = Bun.spawn([process.execPath, parentScript], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  })
  let childPid: number | undefined
  try {
    await waitFor(() => Bun.file(pidFile).size > 0)
    childPid = Number(await Bun.file(pidFile).text())
    expect(childPid).toBeInteger()

    if (scenario.waitUntilReady) {
      // Remove module-load timing from the ordinary watchdog assertion: kill
      // only after the child confirms the watch is armed.
      await waitFor(() => Bun.file(readyFile).size > 0)
      expect(alive(childPid)).toBe(true)
      parent.kill('SIGKILL')
    }
    await parent.exited
    await waitFor(() => !alive(childPid!), 3_000)
    expect(alive(childPid)).toBe(false)
  } finally {
    if (parent.exitCode === null) parent.kill('SIGKILL')
    if (childPid !== undefined && alive(childPid)) process.kill(childPid, 'SIGKILL')
    await rm(tmp, { recursive: true, force: true })
  }
}

test('an armed build child self-terminates when its parent kernel dies abruptly', async () => {
  await runParentDeathScenario({ delayWatch: false, waitUntilReady: true })
})

test('the immutable parent pid closes the death-during-module-startup window', async () => {
  // The parent exits immediately after recording the child pid, while the
  // child deliberately delays watch creation until after reparenting.
  await runParentDeathScenario({ delayWatch: true, waitUntilReady: false })
})
