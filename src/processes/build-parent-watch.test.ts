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

test('a build child self-terminates when its parent kernel dies abruptly', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'ab-build-parent-watch-'))
  const pidFile = join(tmp, 'child.pid')
  const childScript = join(tmp, 'child.ts')
  const parentScript = join(tmp, 'parent.ts')
  const helper = pathToFileURL(join(import.meta.dir, 'build-parent-watch.ts')).href
  await writeFile(
    childScript,
    `import { watchBuildParent } from ${JSON.stringify(helper)}
const watch = watchBuildParent(process.ppid, () => process.exit(143), 10)
await Bun.sleep(60_000)
watch.close()
`,
  )
  await writeFile(
    parentScript,
    `const child = Bun.spawn([process.execPath, ${JSON.stringify(childScript)}], {
  stdin: 'ignore', stdout: 'ignore', stderr: 'ignore'
})
await Bun.write(${JSON.stringify(pidFile)}, String(child.pid))
await Bun.sleep(60_000)
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
    expect(alive(childPid)).toBe(true)

    parent.kill('SIGKILL')
    await parent.exited
    await waitFor(() => !alive(childPid!), 3_000)
    expect(alive(childPid)).toBe(false)
  } finally {
    if (parent.exitCode === null) parent.kill('SIGKILL')
    if (childPid !== undefined && alive(childPid)) process.kill(childPid, 'SIGKILL')
    await rm(tmp, { recursive: true, force: true })
  }
})
