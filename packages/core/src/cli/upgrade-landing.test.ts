import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryBuildStore } from '../store/memory'
import { humanActor } from '../events/envelope'
import { spawnExec } from '../ports/workspace/git-worktree'
import { migrateLandingPolicy } from './upgrade-landing'
import { parseConfig } from '../config/load'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const source =
  '# Preserve this comment\nbaseBranch = "main"\n[tickets]\nsource = "file"\nreadyState = "ready"\n'
async function fixture(text = source) {
  const root = await mkdtemp(join(tmpdir(), 'landing-upgrade-'))
  roots.push(root)
  await spawnExec(['git', 'init', root], {})
  await writeFile(join(root, 'autobuild.toml'), text)
  return root
}
describe('merge policy upgrade', () => {
  test.each([true, false, undefined])(
    'preserves the old default %s and is idempotent',
    async (enabled) => {
      const targetRepo = await fixture()
      const store = new MemoryBuildStore()
      await store.ensureRepo(targetRepo)
      if (enabled !== undefined)
        await store.appendRepo(targetRepo, {
          actor: humanActor('operator'),
          type: 'dispatcher.auto-merge-default-set',
          payload: { enabled },
        })
      const opts = { targetRepo, exec: spawnExec, openStore: () => store }
      expect(await migrateLandingPolicy(opts)).toEqual({
        changed: true,
        legacyDefault: enabled ?? false,
      })
      const path = join(targetRepo, 'autobuild.toml')
      const result = await readFile(path, 'utf8')
      expect(result.startsWith(source)).toBe(true)
      expect(parseConfig(result).landing).toEqual([
        { from: 'leaf', mode: enabled ? 'auto' : 'consent' },
        { from: 'node', mode: 'consent' },
      ])
      expect(
        await migrateLandingPolicy({
          ...opts,
          openStore: () => {
            throw new Error('must not open')
          },
        }),
      ).toEqual({ changed: false })
      expect(await readFile(path, 'utf8')).toBe(result)
    },
  )
  test('a never-created local journal migrates the old OFF default', async () => {
    const targetRepo = await fixture()
    expect(await migrateLandingPolicy({ targetRepo, exec: spawnExec })).toEqual({
      changed: true,
      legacyDefault: false,
    })
    expect(parseConfig(await readFile(join(targetRepo, 'autobuild.toml'), 'utf8')).landing).toEqual(
      [
        { from: 'leaf', mode: 'consent' },
        { from: 'node', mode: 'consent' },
      ],
    )
  })
  test('renames explicit empty rules preserving surrounding bytes without journal access', async () => {
    const text = `landing = [] # explicit fallback\n${source}`
    const targetRepo = await fixture(text)
    expect(
      await migrateLandingPolicy({
        targetRepo,
        exec: spawnExec,
        openStore: () => {
          throw new Error('must not open')
        },
      }),
    ).toEqual({ changed: true, legacyDefault: undefined })
    expect(await readFile(join(targetRepo, 'autobuild.toml'), 'utf8')).toBe(
      text.replace('landing =', 'merge ='),
    )
  })
  test('unavailable journal fails without changing configuration', async () => {
    const targetRepo = await fixture()
    await expect(
      migrateLandingPolicy({
        targetRepo,
        exec: spawnExec,
        openStore: () => {
          throw new Error('offline')
        },
      }),
    ).rejects.toThrow('restore store access')
    expect(await readFile(join(targetRepo, 'autobuild.toml'), 'utf8')).toBe(source)
  })
  test('uses configured hosted store instead of ambient AB_STORE', async () => {
    const targetRepo = await fixture(`${source}\n[store]\nurl = "https://store.example"\n`)
    const store = new MemoryBuildStore()
    const opened: string[] = []
    await migrateLandingPolicy({
      targetRepo,
      exec: spawnExec,
      env: { AB_STORE: '/wrong', AB_TOKEN: 'test' },
      openStore: (ref) => {
        opened.push(ref)
        return store
      },
    })
    expect(opened).toEqual(['https://store.example'])
  })
})

test.each(['landing', '"landing"', "'landing'"])(
  'renames %s policy headers without journal access or changes to comments and strings',
  async (key) => {
    const text = `${source}\n# [[merge]] stays in comments\n[[${key}]] # policy\nmode = "consent"\nlabel = "merge"\n[[${key}]]\nfrom = "node"\nmode = "auto"\n`
    const targetRepo = await fixture(text)
    const opts = {
      targetRepo,
      exec: spawnExec,
      openStore: () => {
        throw new Error('must not open')
      },
    }
    expect(await migrateLandingPolicy(opts)).toEqual({ changed: true, legacyDefault: undefined })
    const result = await readFile(join(targetRepo, 'autobuild.toml'), 'utf8')
    expect(result).toBe(
      text.replaceAll(`[[${key}]]`, '[[merge]]').replace('# [[merge]] stays', '# [[merge]] stays'),
    )
    expect(await migrateLandingPolicy(opts)).toEqual({ changed: false })
  },
)
test('dual keys and unsupported escaped spellings leave original bytes intact', async () => {
  for (const text of [`merge = []\nlanding = []\n${source}`, `"merge\\u0069ng" = []\n${source}`]) {
    const targetRepo = await fixture(text)
    await expect(migrateLandingPolicy({ targetRepo, exec: spawnExec })).rejects.toThrow()
    expect(await readFile(join(targetRepo, 'autobuild.toml'), 'utf8')).toBe(text)
  }
})
