/**
 * Build the `ab web` client bundle and write it, committed, to
 * `packages/core/src/web/assets/`. Files there that the build no longer
 * emits are removed.
 *
 *   bun run ui:web
 */
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { buildWebBundle, WEB_ASSET_DIR } from '../src/app/build'

const files = await buildWebBundle()
await mkdir(WEB_ASSET_DIR, { recursive: true })
for (const name of await readdir(WEB_ASSET_DIR))
  if (!files.has(name)) await rm(join(WEB_ASSET_DIR, name), { recursive: true, force: true })
let gzipped = 0
for (const [name, bytes] of files) {
  await writeFile(join(WEB_ASSET_DIR, name), bytes)
  if (!name.endsWith('.txt') && name !== 'manifest.json') gzipped += gzipSync(bytes).length
}
console.log(`wrote ${files.size} files to ${WEB_ASSET_DIR}`)
console.log(`served gzipped: ${(gzipped / 1024).toFixed(1)} KB`)
