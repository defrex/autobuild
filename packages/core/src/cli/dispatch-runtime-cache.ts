import { existsSync, renameSync, readFileSync, writeFileSync } from 'node:fs'
import {
  reservePreparedRuntime,
  mutateRuntimeCache,
  ownCachedRuntime,
} from './dispatch-runtime-use'
import {
  stat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
  chmod,
  realpath,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { packageDistribution, RUNTIME_ARCHIVE_GZIP_LEVEL } from '../distribution-packaging'
import { settleInOrder, withSpeculation } from './bounded-io'
import {
  copyDependencies,
  copySnapshotTree,
  copyTreeVerbatim,
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
  guestArchive?: {
    provenance: 'source' | 'registry'
    file: 'distribution.tgz' | 'guest-distribution.tgz'
    digest?: string
  }
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
  let bunTag: string | undefined
  try {
    const tag = (await readFile(join(source, '.bun-tag'), 'utf8')).trim()
    const commit = /-([a-f0-9]{7,40})$/i.exec(tag)?.[1]
    if (commit) {
      bunTag = tag
      if (manifest.gitHead === undefined && commit.length === 40) manifest.gitHead = commit
    }
  } catch {
    /* Registry packages need not have a Bun forge tag. */
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
  // Preserve Bun's forge provenance even when the tag only contains an abbreviated SHA.
  if (bunTag) {
    await writeFile(join(target, '.bun-tag'), bunTag)
    if (!manifest.files.includes('.bun-tag')) manifest.files.push('.bun-tag')
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
export async function guestArchiveProvenance(source: string): Promise<'source' | 'registry'> {
  const cached = await cachedRuntime(source)
  if (cached) {
    await validateRuntime(cached)
    return cached.guestArchive!.provenance
  }
  // Resolve installation evidence before staging removes package-manager paths.
  source = await realpath(source)
  if (existsSync(join(source, '.git')) || existsSync(join(source, '.bun-tag'))) return 'source'
  const manifest = await readManifest(source)
  const segments = source.split('/')
  if (!segments.includes('node_modules')) return 'source'
  if (
    segments.some(
      (part, index) =>
        segments[index - 1] === '.bun' &&
        (part === `@defrex+autobuild@${manifest.version}` ||
          part.startsWith(`@defrex+autobuild@${manifest.version}_`)),
    )
  )
    return 'registry'
  for (let owner = dirname(source); ; owner = dirname(owner)) {
    try {
      const lock = Bun.JSONC.parse(await readFile(join(owner, 'bun.lock'), 'utf8')) as {
        packages?: Record<string, unknown>
      }
      const record = lock?.packages?.['@defrex/autobuild']
      if (
        Array.isArray(record) &&
        typeof record[0] === 'string' &&
        /^@defrex\/autobuild@(file:|link:|workspace:|github:|git|https?:)/.test(record[0])
      )
        return 'source'
      if (
        Array.isArray(record) &&
        record[0] === `@defrex/autobuild@${manifest.version}` &&
        typeof record[1] === 'string'
      )
        return 'registry'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (dirname(owner) === owner) break
  }
  throw new Error(
    `cannot establish guest archive provenance for ${source}; retain the installation's Bun lock or forge tag`,
  )
}

export async function validateRuntime(runtime: CachedRuntime): Promise<void> {
  const recorded = await cachedRuntime(runtime.root)
  if (!recorded || (await treeDigest(runtime.root)) !== runtime.digest)
    throw new Error(`corrupt completed runtime: ${runtime.root}`)
  const archive = await Bun.file(join(dirname(runtime.root), 'distribution.tgz')).arrayBuffer()
  if (new Bun.CryptoHasher('sha256').update(archive).digest('hex') !== runtime.archiveDigest)
    throw new Error(`corrupt runtime archive: ${runtime.root}`)
  const guest = recorded.guestArchive
  if (
    !guest ||
    !['distribution.tgz', 'guest-distribution.tgz'].includes(guest.file) ||
    (guest.provenance === 'registry'
      ? guest.file !== 'guest-distribution.tgz'
      : guest.provenance !== 'source' || guest.file !== 'distribution.tgz')
  )
    throw new Error(
      `runtime lacks guest archive provenance; prepare a fresh runtime: ${runtime.root}`,
    )
  if (guest.digest === undefined) {
    if (guest.provenance !== 'registry')
      throw new Error(`source runtime lacks guest archive digest: ${runtime.root}`)
    return // Registry assets are resolved only when a guest first needs them.
  }
  const bytes = await readFile(join(dirname(runtime.root), guest.file))
  if (new Bun.CryptoHasher('sha256').update(bytes).digest('hex') !== guest.digest)
    throw new Error(`corrupt guest archive: ${runtime.root}`)
}

async function validateRuntimeImports(
  root: string,
  checkout: string,
  signal?: AbortSignal,
): Promise<void> {
  const probe = Bun.spawn(runtimeSpawnArguments(root, join(root, 'bin/ab.ts'), ['--version']), {
    cwd: checkout,
    stdout: 'pipe',
    stderr: 'pipe',
    signal,
  })
  const [code, stderr] = await Promise.all([
    probe.exited,
    new Response(probe.stderr).text(),
    new Response(probe.stdout).text(),
  ])
  if (code !== 0) throw new Error(`cached runtime import validation failed: ${stderr}`)
}

const guestFetches = new WeakMap<
  (version: string) => Promise<Uint8Array>,
  Map<string, Promise<Uint8Array>>
>()
function fetchGuestArchive(
  version: string,
  fetchRelease: (version: string) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  let versions = guestFetches.get(fetchRelease)
  if (!versions) {
    versions = new Map()
    guestFetches.set(fetchRelease, versions)
  }
  const existing = versions.get(version)
  if (existing) return existing
  const pending = Promise.resolve().then(() => fetchRelease(version))
  versions.set(version, pending)
  void pending
    .finally(() => {
      if (versions.get(version) === pending) versions.delete(version)
    })
    .catch(() => {})
  return pending
}

/** Verifies the content-addressed dependency layer for `graph`, building and
 * publishing it under the cache lock when absent. Returns its path. */
async function acquireLayer(
  cache: string,
  stage: string,
  graph: Awaited<ReturnType<typeof scanDependencies>>,
): Promise<string> {
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
    await writeFile(join(layerStage, 'digest'), await treeDigest(join(layerStage, 'distribution')))
    withCacheLock(cache, () => {
      if (!existsSync(layer)) renameSync(layerStage, layer)
    })
  }
  await rm(layerStage, { recursive: true, force: true })
  return layer
}

type PreparedArchive =
  | { kind: 'reuse'; id: string; reusable: CachedRuntime }
  | {
      kind: 'fresh'
      id: string
      destination: string
      digest: string
      archive: Uint8Array
      archiveDigest: string
    }

/** Round-trips the distribution archive: extracts it, checks its compiler
 * boundary, entries and configs, joins a copy of the snapshot's dependencies
 * and runs a real import probe against the result. */
async function verifyArchive(
  root: string,
  stage: string,
  checkout: string,
  takeArchive: () => Promise<Uint8Array>,
  signal: AbortSignal,
): Promise<{ archive: Uint8Array; archiveDigest: string }> {
  const extracted = join(stage, 'archive-check')
  const modules = join(stage, 'archive-modules')
  const [verified] = await settleInOrder([
    (async () => {
      const archive = await takeArchive()
      signal.throwIfAborted()
      const archiveDigest = new Bun.CryptoHasher('sha256').update(archive).digest('hex')
      await mkdir(extracted)
      const archiveFile = join(stage, 'distribution.tgz')
      await writeFile(archiveFile, archive)
      const unpack = Bun.spawn(
        ['tar', '-xzf', archiveFile, '--strip-components=1', '-C', extracted],
        { stdout: 'ignore', stderr: 'pipe', signal },
      )
      const unpackError = await new Response(unpack.stderr).text()
      if (
        (await unpack.exited) !== 0 ||
        (await readFile(join(extracted, 'tsconfig.json'), 'utf8')) !== RUNTIME_CONFIG
      )
        throw new Error(`runtime archive lost compiler boundary: ${unpackError}`)
      await validateEntries(extracted)
      await validateCoreConfigs(extracted)
      return { archive, archiveDigest }
    })(),
    copyTreeVerbatim(join(root, 'node_modules'), modules),
  ])
  signal.throwIfAborted()
  // Archived dependencies would shadow the snapshot's verified copy.
  if (existsSync(join(extracted, 'node_modules')))
    throw new Error('runtime archive must not contain node_modules')
  await rename(modules, join(extracted, 'node_modules'))
  await validateRuntimeImports(extracted, checkout, signal)
  await rm(extracted, { recursive: true })
  return verified
}

/** Digests the completed snapshot and reuses a matching runtime, or else
 * requires the archive round trip. That round trip runs speculatively beside
 * the digest, is aborted on reuse, and is awaited before this settles. */
async function prepareArchive(
  root: string,
  stage: string,
  cache: string,
  checkout: string,
  guest: { provenance: 'source' | 'registry' },
  takeArchive: () => Promise<Uint8Array>,
): Promise<PreparedArchive> {
  return withSpeculation(
    (signal) => verifyArchive(root, stage, checkout, takeArchive, signal),
    async (takeVerified): Promise<PreparedArchive> => {
      const digest = await treeDigest(root)
      const manifest = await readManifest(root)
      const id = `${String(manifest.version).replace(/[^\w.-]/g, '_')}-${guest.provenance}-guest1-${digest}`
      const destination = join(cache, id)
      const reusable = await cachedRuntime(join(destination, 'distribution'))
      if (reusable) return { kind: 'reuse', id, reusable }
      return { kind: 'fresh', id, destination, digest, ...(await takeVerified()) }
    },
  )
}

export async function prepareRuntime(
  source: string,
  checkout: string,
  publication?: { upgradeKey: string; commit: string },
  guest: {
    provenance: 'source' | 'registry'
  } = { provenance: 'source' },
): Promise<CachedRuntime> {
  source = await realpath(source)
  checkout = await realpath(checkout)
  const cache = join(checkout, '.autobuild', 'runtime')
  await mkdir(cache, { recursive: true })
  const stage = await mkdtemp(join(cache, '.preparing-'))
  const root = join(stage, 'distribution')
  const check = join(stage, 'source-check')
  const recheckSource = async (codeDigest: string): Promise<void> => {
    await stageCode(source, check)
    if ((await treeDigest(check)) !== codeDigest)
      throw new Error('Autobuild source changed while preparing runtime; retry dispatch')
    await rm(check, { recursive: true })
  }
  try {
    const scanned = scanDependencies(source)
    const staged = stageCode(source, root)
    // Every branch is joined before cleanup or publication, and each join
    // reports failures in the order the stages once ran serially. Packaging
    // reads only the staged code, so it starts as soon as that is complete and
    // is awaited, or aborted and awaited, before anything else proceeds.
    const { graph, prepared } = await withSpeculation(
      async (signal) => {
        await staged
        signal.throwIfAborted()
        return packageDistribution(root, undefined, signal, undefined, {
          gzipLevel: RUNTIME_ARCHIVE_GZIP_LEVEL,
        })
      },
      async (takeArchive) => {
        const [graph, codeDigest, layer] = await settleInOrder([
          scanned,
          (async () => {
            await staged
            const digest = await treeDigest(root)
            await recheckSource(digest)
            return digest
          })(),
          scanned.then((graph) => acquireLayer(cache, stage, graph)),
        ])
        await copyTreeVerbatim(
          join(layer, 'distribution', 'node_modules'),
          join(root, 'node_modules'),
        )
        await validateEntries(root)
        await validateCoreConfigs(root)
        // The snapshot is complete. These branches only read it or the source,
        // and nothing is reserved, returned or published until all of them pass.
        const [, , , prepared] = await settleInOrder([
          (async () => {
            if ((await scanDependencies(source)).fingerprint !== graph.fingerprint)
              throw new Error(
                'installed dependencies changed while preparing runtime; retry dispatch',
              )
          })(),
          recheckSource(codeDigest),
          // Real Bun import graph validation uses the same pre-entry compiler
          // boundary as every generation and runner. No automatic installer
          // can run here.
          validateRuntimeImports(root, checkout),
          prepareArchive(root, stage, cache, checkout, guest, takeArchive),
        ])
        return { graph, prepared }
      },
    )
    if (prepared.kind === 'reuse') {
      reservePreparedRuntime(cache, prepared.id)
      await validateRuntime(prepared.reusable)
      return prepared.reusable
    }
    const { id, destination, digest, archive, archiveDigest } = prepared
    await writeFile(join(stage, 'distribution.tgz'), archive)
    const guestArchive: NonNullable<CachedRuntime['guestArchive']> =
      guest.provenance === 'registry'
        ? { provenance: 'registry', file: 'guest-distribution.tgz' }
        : { provenance: 'source', file: 'distribution.tgz', digest: archiveDigest }
    const runtime: CachedRuntime = {
      version: 1,
      id,
      root: join(destination, 'distribution'),
      digest,
      dependencies: graph.fingerprint,
      archiveDigest,
      guestArchive,
    }
    await writeFile(join(stage, 'runtime.json'), JSON.stringify(runtime))
    if (publication)
      await writeFile(join(stage, 'source-receipt.json'), JSON.stringify(publication))
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

/** Complete guest delivery lazily; host launch and validation never fetch assets.
 * Publication happens under the cache lock and updates only sibling metadata. */
export async function resolveCachedGuestArchive(
  runtime: CachedRuntime,
  fetchRelease: (version: string) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  let current = (await cachedRuntime(runtime.root))!
  await validateRuntime(current)
  if (current.guestArchive!.digest)
    return new Uint8Array(await readFile(join(dirname(current.root), current.guestArchive!.file)))
  const version = String((await readManifest(current.root)).version)
  const bytes = await fetchGuestArchive(version, fetchRelease)
  if (!bytes.byteLength) throw new Error('published guest archive is empty')
  const entry = dirname(current.root)
  const stage = await mkdtemp(join(entry, '.guest-'))
  try {
    const archive = join(stage, 'guest-distribution.tgz')
    await writeFile(archive, bytes)
    const inspect = Bun.spawn(['tar', '-xOzf', archive, 'package/package.json'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [text, error, code] = await Promise.all([
      new Response(inspect.stdout).text(),
      new Response(inspect.stderr).text(),
      inspect.exited,
    ])
    if (code !== 0) throw new Error(`invalid published guest archive: ${error}`)
    if (JSON.parse(text).version !== version)
      throw new Error('published guest archive version contradicts runtime')
    const digest = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
    withCacheLock(dirname(entry), () => {
      current = JSON.parse(readFileSync(join(entry, 'runtime.json'), 'utf8')) as CachedRuntime
      if (current.guestArchive?.digest) return
      renameSync(archive, join(entry, 'guest-distribution.tgz'))
      current.guestArchive = { provenance: 'registry', file: 'guest-distribution.tgz', digest }
      const metadata = join(stage, 'runtime.json')
      writeFileSync(metadata, JSON.stringify(current))
      renameSync(metadata, join(entry, 'runtime.json'))
    })
    await validateRuntime(current)
    return new Uint8Array(await readFile(join(entry, current.guestArchive!.file)))
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}
