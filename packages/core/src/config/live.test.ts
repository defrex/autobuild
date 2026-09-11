import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScriptedAgentRunner, defaultTurnResult } from '../ports/runner/fake'
import type { RuntimeRegistry } from '../ports/runner/runtime'
import { parseConfig } from './load'
import {
  CONFIG_RELOAD_CLASSIFICATION,
  LiveConfig,
  composeReloadedConfig,
  restartRequiredChanges,
} from './live'
import { TOP_LEVEL_KEYS } from './schema'

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

describe('live dispatcher config', () => {
  test('classifies every root key and pins only startup adapter fields', () => {
    expect(Object.keys(CONFIG_RELOAD_CLASSIFICATION).sort()).toEqual([...TOP_LEVEL_KEYS].sort())
    const startup = parseConfig(base)
    const candidate = parseConfig(
      base
        .replace('capacity = 1', 'capacity = 3\nforge = "local-git"')
        .replace('readyState = "ready"', 'readyState = "queued"')
        .replace('model = "gpt-old"', 'model = "gpt-new"'),
    )
    expect(restartRequiredChanges(startup, candidate)).toEqual(['forge'])
    const effective = composeReloadedConfig(startup, candidate)
    expect(effective.capacity).toBe(3)
    expect(effective.forge).toBe(startup.forge)
    expect(effective.tickets.readyState).toBe('queued')
    expect(effective.roles.default?.model).toBe('gpt-new')
  })

  test('publishes before adoption and retries the same valid body after publication failure', async () => {
    const published: string[] = []
    let fail = true
    const live = new LiveConfig(
      'autobuild.toml',
      parseConfig(base),
      base,
      runtimes,
      async ({ content }) => {
        published.push(content)
        if (fail) throw new Error('store unavailable')
      },
    )
    const changed = base.replace('capacity = 1', 'capacity = 2')
    expect(await live.refresh(changed)).toEqual({
      kind: 'publication-failed',
      error: 'store unavailable',
    })
    expect(live.current().revision).toBe(0)
    expect(live.current().config.capacity).toBe(1)

    fail = false
    const adopted = await live.refresh(changed)
    expect(adopted.kind).toBe('adopted')
    expect(live.current().revision).toBe(1)
    expect(live.current().config.capacity).toBe(2)
    expect(published).toHaveLength(2)
  })

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

  test('refreshFrom adopts hot changes from a non-disk source and holds restart-required fields', async () => {
    // Origin mode: the dispatcher reads autobuild.toml from the forge. A hot
    // change (capacity) adopts immediately; a restart-classified change
    // (forge) keeps the startup adapter and is reported as restart-required.
    const published: string[] = []
    const live = new LiveConfig(
      'https://github.com/acme/app/autobuild.toml@main',
      parseConfig(base),
      base,
      runtimes,
      async ({ content, restartRequired }) => {
        published.push(content)
        expect(restartRequired).toBeDefined()
      },
    )
    const forge = { content: base }
    const read = async (): Promise<string> => forge.content

    const hot = base.replace('capacity = 1', 'capacity = 3')
    forge.content = hot
    const adopted = await live.refreshFrom(read)
    expect(adopted).toMatchObject({
      kind: 'adopted',
      snapshot: { revision: 1, config: { capacity: 3 } },
    })
    expect((adopted as { restartRequired?: string[] }).restartRequired).toEqual([])
    expect(published).toEqual([hot])

    // A read failure keeps the last valid snapshot and is reported once.
    const failing = async (): Promise<string> => {
      throw new Error('GitHub API rate limited')
    }
    const rejected = await live.refreshFrom(failing)
    expect(rejected).toMatchObject({
      kind: 'rejected',
      error: expect.stringContaining(
        'could not be read during live reload: GitHub API rate limited',
      ),
      notify: true,
    })
    expect(await live.refreshFrom(failing)).toMatchObject({ kind: 'rejected', notify: false })
    expect(live.current().config.capacity).toBe(3)

    // Restart-classified changes hold the startup-built adapter fields.
    const restart = hot.replace('capacity = 3', 'capacity = 3\nforge = "local-git"')
    forge.content = restart
    const outcome = await live.refreshFrom(read)
    expect(outcome).toMatchObject({ kind: 'adopted', restartRequired: ['forge'] })
    expect(live.current().config.forge).toBe('github')
    expect(live.current().config.capacity).toBe(3)
    expect(live.current().revision).toBe(2)
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

  test('keeps the last valid snapshot, suppresses duplicate invalid notices, then recovers', async () => {
    const live = new LiveConfig('autobuild.toml', parseConfig(base), base, runtimes, async () => {})
    const invalid = base.replace('capacity = 1', 'capacity = 0')
    const first = await live.refresh(invalid)
    const second = await live.refresh(invalid)
    expect(first).toMatchObject({ kind: 'rejected', notify: true })
    expect(second).toMatchObject({ kind: 'rejected', notify: false })
    expect(live.current().config.capacity).toBe(1)

    expect((await live.refresh(base.replace('capacity = 1', 'capacity = 4'))).kind).toBe('adopted')
    expect(live.current().config.capacity).toBe(4)
  })

  test('validates a new route against the startup runtime catalog before publication', async () => {
    let publishes = 0
    const live = new LiveConfig('autobuild.toml', parseConfig(base), base, runtimes, async () => {
      publishes += 1
    })
    const incompatible = base.replace('model = "gpt-old"', 'model = "claude-new"')
    const outcome = await live.refresh(incompatible)
    expect(outcome).toMatchObject({ kind: 'rejected', notify: true })
    expect(publishes).toBe(0)
    expect(live.current().resolver.resolve('implement').model).toBe('gpt-old')
  })
})
