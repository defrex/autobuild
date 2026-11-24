import { expect, test } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { buildWebBundle, WEB_ASSET_DIR } from './build'

const repo = resolve(import.meta.dir, '../../../..')
const built = buildWebBundle()

async function requiredBun(): Promise<string> {
  const script = await Bun.file(join(repo, 'scripts/verify-bun.sh')).text()
  return /\d+\.\d+\.\d+/.exec(script)?.[0] ?? 'the verify Bun version'
}

test('the committed web bundle is fresh', async () => {
  const files = await built
  const committed = (await readdir(WEB_ASSET_DIR)).sort()
  const hint = `regenerate with \`bun run ui:web\` on Bun ${await requiredBun()} (running ${Bun.version})`
  if (JSON.stringify(committed) !== JSON.stringify([...files.keys()].sort()))
    throw new Error(`packages/core/src/web/assets has a stale file set; ${hint}`)
  for (const [name, bytes] of files) {
    const current = new Uint8Array(await Bun.file(join(WEB_ASSET_DIR, name)).arrayBuffer())
    if (!Buffer.from(current).equals(Buffer.from(bytes)))
      throw new Error(`packages/core/src/web/assets/${name} is stale; ${hint}`)
  }
  expect(committed).toEqual([...files.keys()].sort())
})

test('the served bundle stays within 250 KB gzipped', async () => {
  const files = await built
  const manifest = JSON.parse(new TextDecoder().decode(files.get('manifest.json'))) as {
    files: { path: string }[]
  }
  let total = 0
  for (const { path } of manifest.files) total += gzipSync(files.get(path)!).length
  expect(total).toBeLessThanOrEqual(250 * 1024)
})

test('the bundle embeds no checkout path, so every worktree builds the same bytes', async () => {
  const files = await built
  for (const [name, bytes] of files) {
    const text = Buffer.from(bytes).toString('latin1')
    if (text.includes(repo)) throw new Error(`${name} embeds the checkout path ${repo}`)
    expect(text.includes('/packages/ui/')).toBe(false)
  }
})
