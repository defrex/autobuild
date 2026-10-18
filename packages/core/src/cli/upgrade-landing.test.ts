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
describe('landing policy upgrade', () => {
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
  test('preserves explicit empty rules byte for byte without journal access', async () => {
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
    ).toEqual({ changed: false })
    expect(await readFile(join(targetRepo, 'autobuild.toml'), 'utf8')).toBe(text)
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
