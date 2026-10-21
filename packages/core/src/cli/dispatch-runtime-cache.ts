import { existsSync, renameSync } from 'node:fs'
import {
  reservePreparedRuntime,
  mutateRuntimeCache,
  ownCachedRuntime,
} from './dispatch-runtime-use'
import {
  cp,
  stat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  chmod,
  realpath,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { packageDistribution } from '../distribution-packaging'
import {
  copyDependencies,
  copySnapshotTree,
  excludedSnapshotNames,
  inside,
  readManifest,
  scanDependencies,
  treeDigest,
} from './dispatch-runtime-dependencies'

export const RUNTIME_CONFIG = '{}\n'
const requiredRuntimeEntries = [
  'bin/ab.ts',
  'bin/agent/ab',
  'bin/ab-dispatch-generation.ts',
  'bin/ab-dispatch-kernel.ts',
  'bin/ab-build-runner.ts',
  'bin/ab-harvest-runner.ts',
  'bin/ab-process-group-reaper.ts',
]
async function validateEntries(root: string): Promise<void> {
  for (const entry of requiredRuntimeEntries) {
    if (!existsSync(join(root, entry)))
      throw new Error(
        `incomplete Autobuild runtime: missing ${entry}; repair the Autobuild installation before dispatch`,
      )
  }
}

export interface CachedRuntime {
  version: 1
  id: string
  root: string
  digest: string
  dependencies: string
  archiveDigest: string
}
export async function cachedRuntime(root: string): Promise<CachedRuntime | undefined> {
  if (!ownCachedRuntime(root)) return undefined
  return JSON.parse(await readFile(join(dirname(root), 'runtime.json'), 'utf8')) as CachedRuntime
}
export function runtimeSpawnArguments(
  root: string,
  entrypoint: string,
  args: string[] = [],
): string[] {
  // Sync file presence is insufficient provenance; callers use this only for
  // their own completed distribution, whose metadata is checked at startup.
  return [
    process.execPath,
    '--no-install',
    '--tsconfig-override',
    join(root, 'tsconfig.json'),
    entrypoint,
    ...args,
  ]
}
export async function validateCoreConfigs(
  root: string,
  paths = ['bin', 'packages'],
): Promise<void> {
  const audited = new Set<string>()
  async function audit(file: string): Promise<void> {
    if (audited.has(file)) return
    audited.add(file)
    let config: Record<string, unknown>
    try {
      config = Bun.JSONC.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    } catch {
      throw new Error(`cannot validate runtime compiler configuration: ${file}`)
    }
    const compiler = config.compilerOptions as Record<string, unknown> | undefined
    const base =
      typeof compiler?.baseUrl === 'string'
        ? resolve(dirname(file), compiler.baseUrl)
        : dirname(file)
    if (!inside(root, base))
      throw new Error(`runtime compiler configuration escapes runtime: ${file}`)
    if (existsSync(join(base, '@defrex', 'autobuild')))
      throw new Error(`runtime compiler configuration redirects core imports: ${file}`)
    if (compiler?.paths) {
      for (const [name, targets] of Object.entries(compiler.paths as Record<string, string[]>)) {
        // A second core namespace would split SDK value/class identity.
        const core = '@defrex/autobuild'
        const prefix = name.split('*')[0]!
        const redirectsCore = name.includes('*')
          ? core.startsWith(prefix) || prefix.startsWith(`${core}/`)
          : name === core || name.startsWith(`${core}/`)
        if (redirectsCore)
          throw new Error(`runtime compiler configuration redirects core imports: ${file}`)
        if (
          !Array.isArray(targets) ||
          targets.some(
            (target) => typeof target !== 'string' || !inside(root, resolve(base, target)),
          )
        )
          throw new Error(`runtime compiler configuration escapes runtime: ${file}`)
      }
    }
    const targets = [config.extends].flat().filter((v): v is string => typeof v === 'string')
    for (const reference of (config.references ?? []) as Array<{ path: string }>)
      targets.push(reference.path)
    for (const target of targets) {
      let resolved = resolve(dirname(file), target)
      if (!target.startsWith('.') || !inside(root, resolved))
        throw new Error(`runtime compiler configuration escapes runtime: ${file}: ${target}`)
      try {
        if (!existsSync(resolved) && existsSync(`${resolved}.json`)) resolved += '.json'
        if ((await stat(resolved)).isDirectory()) resolved = join(resolved, 'tsconfig.json')
        if (!inside(root, await realpath(resolved))) throw new Error('external')
      } catch {
        throw new Error(`unresolved runtime compiler configuration: ${file}: ${target}`)
      }
      await audit(resolved)
    }
  }
  async function walk(path: string): Promise<void> {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const file = join(path, item.name)
      if (item.name === 'node_modules') continue
      if (item.isDirectory()) {
        await walk(file)
        continue
      }
      if (!/^(tsconfig|jsconfig)(\.[^.]+)?\.json$/.test(item.name)) continue
      if (item.isSymbolicLink()) throw new Error(`linked compiler configuration: ${file}`)
      await audit(file)
    }
  }
  // Third-party development configs are installed package bytes, never input
  // to this audit. Only Autobuild's sources are governed by this boundary.
  for (const path of paths) {
    try {
      await walk(join(root, path))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}
export const cachedAgentTrampoline = `#!/bin/sh
case "$0" in
  */*) launcher=$0 ;;
  *) launcher=$(command -v -- "$0") ;;
esac
runtime_root=$(CDPATH= cd -- "$(dirname -- "$launcher")/../.." && pwd -P) || exit 1
exec bun --no-install --tsconfig-override "$runtime_root/tsconfig.json" "$runtime_root/bin/ab.ts" "$@"
`

/** Publication, retention and process-use claims share this short lock. */
export const withCacheLock = mutateRuntimeCache

async function stageCode(source: string, target: string): Promise<void> {
  const manifest = await readManifest(source)
  if (manifest.gitHead === undefined) {
    try {
      const tag = (await readFile(join(source, '.bun-tag'), 'utf8')).trim()
      const commit = /-([a-f0-9]{40})$/.exec(tag)?.[1]
      if (commit) manifest.gitHead = commit
    } catch {
      /* Registry packages need not have a Bun forge tag. */
    }
  }
  if (!Array.isArray(manifest.files))
    throw new Error('Autobuild manifest must declare distribution files')
  await mkdir(target, { recursive: true })
  for (const entry of manifest.files) {
    if (entry.startsWith('!') || entry === 'tsconfig.json') continue
    if (!inside(source, resolve(source, entry)) || excludedSnapshotNames.has(entry))
      throw new Error(`unsafe distribution path: ${entry}`)
    await copySnapshotTree(join(source, entry), join(target, entry), source)
  }
  delete manifest.devDependencies
  delete manifest.patchedDependencies
  // Capture provenance while the source still exists; no .git link survives.
  try {
    const git = Bun.spawn(['git', 'rev-parse', 'HEAD'], {
      cwd: source,
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const gitHead = (await new Response(git.stdout).text()).trim()
    if ((await git.exited) === 0) {
      const top = Bun.spawn(['git', 'rev-parse', '--show-toplevel'], {
        cwd: source,
        stdout: 'pipe',
        stderr: 'ignore',
      })
      const topPath = (await new Response(top.stdout).text()).trim()
      if ((await top.exited) === 0 && (await realpath(topPath)) === source)
        manifest.gitHead = gitHead
    }
  } catch {
    /* Package provenance may be unknown without Git. */
  }
  manifest.files = [...manifest.files.filter((p) => p !== 'tsconfig.json'), 'tsconfig.json']
  await writeFile(join(target, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(join(target, 'tsconfig.json'), RUNTIME_CONFIG)
  await writeFile(join(target, 'bin/agent/ab'), cachedAgentTrampoline)
  await chmod(join(target, 'bin/agent/ab'), 0o755)
}
export async function validateRuntime(runtime: CachedRuntime): Promise<void> {
  if (!(await cachedRuntime(runtime.root)) || (await treeDigest(runtime.root)) !== runtime.digest)
    throw new Error(`corrupt completed runtime: ${runtime.root}`)
  const archive = await Bun.file(join(dirname(runtime.root), 'distribution.tgz')).arrayBuffer()
  if (new Bun.CryptoHasher('sha256').update(archive).digest('hex') !== runtime.archiveDigest)
    throw new Error(`corrupt runtime archive: ${runtime.root}`)
}

async function validateRuntimeImports(root: string, checkout: string): Promise<void> {
  const probe = Bun.spawn(runtimeSpawnArguments(root, join(root, 'bin/ab.ts'), ['--version']), {
    cwd: checkout,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, stderr] = await Promise.all([
    probe.exited,
    new Response(probe.stderr).text(),
    new Response(probe.stdout).text(),
  ])
  if (code !== 0) throw new Error(`cached runtime import validation failed: ${stderr}`)
}

export async function prepareRuntime(source: string, checkout: string): Promise<CachedRuntime> {
  source = await realpath(source)
  checkout = await realpath(checkout)
  const cache = join(checkout, '.autobuild', 'runtime')
  await mkdir(cache, { recursive: true })
  const stage = await mkdtemp(join(cache, '.preparing-'))
  const root = join(stage, 'distribution')
  try {
    const graph = await scanDependencies(source)
    await stageCode(source, root)
    const codeDigest = await treeDigest(root)
    const check = join(stage, 'source-check')
    await stageCode(source, check)
    if ((await treeDigest(check)) !== codeDigest)
      throw new Error('Autobuild source changed while preparing runtime; retry dispatch')
    await rm(check, { recursive: true })
    const layers = join(cache, 'layers')
    await mkdir(layers, { recursive: true })
    const layer = join(layers, graph.fingerprint)
    const layerStage = join(stage, 'layer')
    try {
      const expected = await readFile(join(layer, 'digest'), 'utf8')
      if ((await readFile(join(layer, 'distribution', 'tsconfig.json'), 'utf8')) !== RUNTIME_CONFIG)
        throw new Error(`corrupt dependency compiler boundary: ${layer}`)
      if ((await treeDigest(join(layer, 'distribution'))) !== expected)
        throw new Error(`corrupt dependency layer: ${layer}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (existsSync(layer)) throw new Error(`corrupt dependency layer: ${layer}`, { cause: error })
      await mkdir(join(layerStage, 'distribution'), { recursive: true })
      await copyDependencies(graph, join(layerStage, 'distribution'))
      await writeFile(join(layerStage, 'distribution', 'tsconfig.json'), RUNTIME_CONFIG)
      await writeFile(
        join(layerStage, 'digest'),
        await treeDigest(join(layerStage, 'distribution')),
      )
      withCacheLock(cache, () => {
        if (!existsSync(layer)) renameSync(layerStage, layer)
      })
    }
    await rm(layerStage, { recursive: true, force: true })
    await cp(join(layer, 'distribution', 'node_modules'), join(root, 'node_modules'), {
      recursive: true,
      verbatimSymlinks: true,
    })
    await validateEntries(root)
    await validateCoreConfigs(root)
    if ((await scanDependencies(source)).fingerprint !== graph.fingerprint)
      throw new Error('installed dependencies changed while preparing runtime; retry dispatch')
    await stageCode(source, check)
    if ((await treeDigest(check)) !== codeDigest)
      throw new Error('Autobuild source changed while preparing runtime; retry dispatch')
    await rm(check, { recursive: true })
    // Real Bun import graph validation uses the same pre-entry compiler boundary
    // as every generation and runner. No automatic installer can run here.
    await validateRuntimeImports(root, checkout)
    const digest = await treeDigest(root)
    const manifest = await readManifest(root)
    const id = `${String(manifest.version).replace(/[^\w.-]/g, '_')}-${digest}`
    const destination = join(cache, id)
    const archive = await packageDistribution(root)
    const archiveDigest = new Bun.CryptoHasher('sha256').update(archive).digest('hex')
    const extracted = join(stage, 'archive-check')
    await mkdir(extracted)
    const archiveFile = join(stage, 'distribution.tgz')
    await writeFile(archiveFile, archive)
    const unpack = Bun.spawn(
      ['tar', '-xzf', archiveFile, '--strip-components=1', '-C', extracted],
      { stdout: 'ignore', stderr: 'pipe' },
    )
    const unpackError = await new Response(unpack.stderr).text()
    if (
      (await unpack.exited) !== 0 ||
      (await readFile(join(extracted, 'tsconfig.json'), 'utf8')) !== RUNTIME_CONFIG
    )
      throw new Error(`runtime archive lost compiler boundary: ${unpackError}`)
    await validateEntries(extracted)
    await validateCoreConfigs(extracted)
    await cp(join(root, 'node_modules'), join(extracted, 'node_modules'), {
      recursive: true,
      verbatimSymlinks: true,
    })
    await validateRuntimeImports(extracted, checkout)
    await rm(extracted, { recursive: true })
    await writeFile(join(stage, 'distribution.tgz'), archive)
    const runtime: CachedRuntime = {
      version: 1,
      id,
      root: join(destination, 'distribution'),
      digest,
      dependencies: graph.fingerprint,
      archiveDigest,
    }
    await writeFile(join(stage, 'runtime.json'), JSON.stringify(runtime))
    reservePreparedRuntime(cache, id)
    const existing = await cachedRuntime(runtime.root)
    if (existing) await validateRuntime(existing)
    withCacheLock(cache, () => {
      if (!existsSync(destination)) renameSync(stage, destination)
    })
    const completed = await cachedRuntime(runtime.root)
    if (!completed) throw new Error(`runtime publication incomplete: ${destination}`)
    return completed
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}
