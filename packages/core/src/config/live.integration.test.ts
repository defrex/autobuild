import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScriptedAgentRunner, defaultTurnResult } from '../ports/runner/fake'
import type { RuntimeRegistry } from '../ports/runner/runtime'
import { parseConfig } from './load'
import { localConfigPath } from './local'
import { LiveConfig } from './live'
const base = `
capacity = 1

[tickets]
source = "file"
readyState = "ready"

[roles.default]
runtime = "pi"
model = "gpt-old"
`

const runtimes: RuntimeRegistry = {
  pi: {
    runner: new ScriptedAgentRunner({ script: () => defaultTurnResult() }),
    servesModels: ['gpt-'],
  },
}

describe('live dispatcher disk config', () => {
  test('retains the accepted disk snapshot across deletion and resumes after restoration', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ab-live-config-'))
    const source = join(dir, 'autobuild.toml')
    const published: string[] = []
    try {
      await writeFile(source, base)
      const live = new LiveConfig(
        source,
        parseConfig(base),
        base,
        runtimes,
        async ({ content }) => {
          published.push(content)
        },
      )
      const accepted = live.current()

      await unlink(source)
      const first = await live.refreshFromDisk()
      const duplicate = await live.refreshFromDisk()
      expect(first).toEqual({
        kind: 'rejected',
        error:
          `${source} is missing during live reload; the last valid configuration snapshot ` +
          'remains active — restore a valid autobuild.toml to resume live reload',
        notify: true,
      })
      expect(duplicate).toMatchObject({ kind: 'rejected', notify: false })
      expect(live.current()).toBe(accepted)
      expect(live.current().revision).toBe(0)
      expect(live.current().config.capacity).toBe(1)
      expect(published).toEqual([])

      const restored = base.replace('capacity = 1', 'capacity = 4')
      await writeFile(source, restored)
      expect(await live.refreshFromDisk()).toMatchObject({
        kind: 'adopted',
        snapshot: { revision: 1, config: { capacity: 4 } },
      })
      expect(live.current().revision).toBe(1)
      expect(live.current().config.capacity).toBe(4)
      expect(published).toEqual([restored])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('refreshFromDisk layers the local override file and follows its edits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ab-live-local-'))
    const source = join(dir, 'autobuild.toml')
    const localSource = localConfigPath(dir)
    const published: Array<{ content: string; settings?: string[] }> = []
    try {
      await writeFile(source, base)
      await mkdir(join(dir, '.autobuild'), { recursive: true })
      const live = new LiveConfig(
        source,
        parseConfig(base),
        base,
        runtimes,
        async ({ content, localOverrides }) => {
          published.push({
            content,
            ...(localOverrides ? { settings: localOverrides.settings } : {}),
          })
        },
        [],
        undefined,
        { localSource },
      )
      expect(await live.refreshFromDisk()).toEqual({ kind: 'unchanged' })

      await writeFile(localSource, 'capacity = 3\n')
      expect(await live.refreshFromDisk()).toMatchObject({
        kind: 'adopted',
        snapshot: {
          revision: 1,
          config: { capacity: 3 },
          localOverrides: { file: localSource, settings: ['capacity'] },
        },
      })

      await writeFile(localSource, 'capacity = 3\n[verify]\nsteps = []\n')
      const rejected = await live.refreshFromDisk()
      expect(rejected).toMatchObject({ kind: 'rejected', notify: true })
      expect(rejected.kind === 'rejected' && rejected.error).toStartWith(
        `${localSource}: verify can only be set in autobuild.toml`,
      )
      expect(await live.refreshFromDisk()).toMatchObject({ kind: 'rejected', notify: false })
      expect(live.current().config.capacity).toBe(3)

      await writeFile(localSource, 'capacity = 0\n')
      const invalid = await live.refreshFromDisk()
      expect(invalid.kind === 'rejected' && invalid.error).toStartWith(
        `${localSource}: invalid config\n  capacity:`,
      )

      await rm(localSource)
      await mkdir(localSource)
      const unreadable = await live.refreshFromDisk()
      expect(unreadable.kind === 'rejected' && unreadable.error).toContain(
        `${localSource} could not be read during live reload`,
      )
      expect(live.current().revision).toBe(1)

      await rm(localSource, { recursive: true })
      expect(await live.refreshFromDisk()).toMatchObject({
        kind: 'adopted',
        snapshot: { revision: 2, config: { capacity: 1 } },
      })
      expect(live.current().localOverrides).toBeUndefined()
      expect(published).toEqual([{ content: base, settings: ['capacity'] }, { content: base }])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('exact restoration resets missing-file notice deduplication without a new revision', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ab-live-config-'))
    const source = join(dir, 'autobuild.toml')
    const published: string[] = []
    try {
      await writeFile(source, base)
      const live = new LiveConfig(
        source,
        parseConfig(base),
        base,
        runtimes,
        async ({ content }) => {
          published.push(content)
        },
      )
      const accepted = live.current()
      const expectOriginalSnapshot = () => {
        expect(live.current()).toBe(accepted)
        expect(live.current().revision).toBe(0)
        expect(live.current().config.capacity).toBe(1)
        expect(published).toEqual([])
      }

      await unlink(source)
      expect(await live.refreshFromDisk()).toMatchObject({ kind: 'rejected', notify: true })
      expectOriginalSnapshot()
      expect(await live.refreshFromDisk()).toMatchObject({ kind: 'rejected', notify: false })
      expectOriginalSnapshot()

      await writeFile(source, base)
      expect(await live.refreshFromDisk()).toEqual({ kind: 'unchanged' })
      expectOriginalSnapshot()

      await unlink(source)
      expect(await live.refreshFromDisk()).toMatchObject({ kind: 'rejected', notify: true })
      expectOriginalSnapshot()
      expect(await live.refreshFromDisk()).toMatchObject({ kind: 'rejected', notify: false })
      expectOriginalSnapshot()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
