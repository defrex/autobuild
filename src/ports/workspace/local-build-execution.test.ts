import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUILD_RUNNER_OPTIONS_ENV, LocalBuildExecution } from './local-build-execution'

async function alive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
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
      expect(first.pid).toBeNumber()
      expect(second.pid).toBeNumber()
      expect(first.pid).not.toBe(second.pid)
      await Bun.sleep(50)
      expect(await alive(first.pid!)).toBe(true)
      expect(await alive(second.pid!)).toBe(true)

      await first.stop()
      await first.stop()
      expect((await first.completion).exitCode).not.toBe(0)
      expect(await alive(first.pid!)).toBe(false)
      expect(await alive(second.pid!)).toBe(true)
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
      await rm(tmp, { recursive: true, force: true })
    }
  })
})
