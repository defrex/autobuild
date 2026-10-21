import { renameSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { distributionRoot } from '../distribution'
import {
  cachedRuntime,
  RUNTIME_CONFIG,
  validateCoreConfigs,
  withCacheLock,
} from '../cli/dispatch-runtime-cache'
import { claimRuntimeForProcess } from '../cli/dispatch-runtime-use'
import {
  copyDependencies,
  copySnapshotTree,
  excludedSnapshotNames,
  readManifest,
  scanDependencies,
  standalonePluginManifest,
  treeDigest,
} from '../cli/dispatch-runtime-dependencies'

const loaded = new Map<string, Promise<string>>()
/** Selection remains repository-first. Only evaluation relocates, giving native
 * ESM and CommonJS one canonical SDK without loader hooks or source rewriting. */
export async function snapshotPlugin(resolved: string, local: boolean): Promise<string> {
  const core = await cachedRuntime(distributionRoot())
  if (!core) return resolved
  claimRuntimeForProcess(core.root)
  const key = `${core.root}:${resolved}`
  let pending = loaded.get(key)
  if (!pending) {
    pending = prepare(resolved, local, core.root)
    loaded.set(key, pending)
    pending.catch(() => loaded.delete(key))
  }
  return pending
}
async function prepare(selected: string, local: boolean, core: string): Promise<string> {
  selected = await realpath(selected)
  let boundary = dirname(selected)
  while (!existsSync(join(boundary, 'package.json'))) {
    const parent = dirname(boundary)
    if (parent === boundary) {
      boundary = dirname(selected)
      break
    }
    boundary = parent
  }
  // A standalone module has no declared edges; never invent a surrounding
  // monorepo as its package boundary.
  const hasManifest = existsSync(join(boundary, 'package.json'))
  const cache = dirname(dirname(core))
  const extensions = join(cache, 'extensions')
  await mkdir(extensions, { recursive: true })
  const stage = await mkdtemp(join(extensions, '.preparing-'))
  try {
    const tree = join(stage, 'distribution')
    const root = join(tree, 'package')
    const before = await treeDigest(boundary, excludedSnapshotNames)
    const manifest = hasManifest ? undefined : await standalonePluginManifest(selected, boundary)
    const scan = () =>
      scanDependencies(boundary, { dev: local, coreRoot: core, ...(manifest ? { manifest } : {}) })
    const graph = await scan()
    await copySnapshotTree(boundary, root)
    await writeFile(join(tree, 'tsconfig.json'), RUNTIME_CONFIG)
    await writeFile(join(root, 'tsconfig.json'), RUNTIME_CONFIG)
    if (manifest) await writeFile(join(root, 'package.json'), JSON.stringify(manifest))
    if (hasManifest) {
      const manifest = await readManifest(root)
      if (manifest.name === '@defrex/autobuild') {
        manifest.name = 'autobuild-local-plugin-snapshot'
        delete manifest.exports
        await writeFile(join(root, 'package.json'), JSON.stringify(manifest))
      }
    }
    await validateCoreConfigs(root, ['.'])
    await copyDependencies(graph, root, core)
    if (
      before !== (await treeDigest(boundary, excludedSnapshotNames)) ||
      graph.fingerprint !== (await scan()).fingerprint
    )
      throw new Error(`plugin changed while preparing snapshot: ${selected}`)
    const digest = await treeDigest(tree, new Set(), core)
    const destination = join(extensions, digest)
    await writeFile(join(stage, 'extension.json'), JSON.stringify({ version: 1, core, digest }))
    claimRuntimeForProcess(core, destination)
    if (
      existsSync(destination) &&
      (await treeDigest(join(destination, 'distribution'), new Set(), core)) !== digest
    )
      throw new Error(`corrupt plugin snapshot: ${destination}`)
    withCacheLock(cache, () => {
      if (!existsSync(destination)) renameSync(stage, destination)
    })
    return join(destination, 'distribution', 'package', relative(boundary, selected))
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}
