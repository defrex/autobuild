import { isBuiltin } from 'node:module'
import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  readlink,
  copyFile,
  chmod,
  symlink,
} from 'node:fs/promises'
import { dirname, join, relative, resolve, isAbsolute } from 'node:path'

export type Manifest = {
  name?: string
  version?: string
  files?: string[]
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  devDependencies?: Record<string, string>
  [key: string]: unknown
}
export const excludedSnapshotNames = new Set(['node_modules', '.git', '.autobuild', '.ab', '.env'])
const dependencyExclusions = new Set(['node_modules'])
export function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
export async function readManifest(root: string): Promise<Manifest> {
  return JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
}
export async function installedPackage(name: string, start: string): Promise<string | undefined> {
  if (!/^(@[^/]+\/)?[^/]+$/.test(name) || name.includes('..'))
    throw new Error(`invalid dependency name ${name}`)
  let current = resolve(start)
  for (;;) {
    try {
      return await realpath(join(current, 'node_modules', name))
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/** Independent bytes, never hardlinks. Package-internal links are normalized;
 * an escaping asset link is rejected rather than silently following a checkout. */
export async function copySnapshotTree(
  source: string,
  target: string,
  boundary = source,
  stack = new Set<string>(),
  exclusions = excludedSnapshotNames,
): Promise<void> {
  const actual = await realpath(source)
  if (!inside(boundary, actual))
    throw new Error(`snapshot link escapes package: ${source} -> ${actual}`)
  if (stack.has(actual)) throw new Error(`cyclic snapshot asset link: ${source}`)
  const sourceStat = await lstat(source)
  if (sourceStat.isSymbolicLink()) {
    const mapped = resolve(target, relative(source, actual))
    await mkdir(dirname(target), { recursive: true })
    await symlink(relative(dirname(target), mapped), target)
    return
  }
  const stat = await lstat(actual)
  if (stat.isDirectory()) {
    await mkdir(target, { recursive: true })
    const next = new Set(stack).add(actual)
    for (const name of (await readdir(actual)).sort()) {
      if (exclusions.has(name) || (exclusions.has('.env') && name.startsWith('.env.'))) continue
      await copySnapshotTree(join(actual, name), join(target, name), boundary, next, exclusions)
    }
    await chmod(target, stat.mode & 0o777)
  } else if (stat.isFile()) {
    await mkdir(dirname(target), { recursive: true })
    await copyFile(actual, target)
    await chmod(target, stat.mode & 0o777)
  } else throw new Error(`unsupported snapshot asset: ${source}`)
}

/** Digest includes names, executable bits, bytes and internal link topology. */
export async function treeDigest(
  root: string,
  exclude = new Set<string>(),
  allowedLink?: string,
): Promise<string> {
  const hash = createHash('sha256')
  async function walk(path: string): Promise<void> {
    const rel = relative(root, path)
    const stat = await lstat(path)
    hash.update(JSON.stringify([rel, stat.mode & 0o111]))
    if (stat.isSymbolicLink()) {
      const link = await readlink(path)
      if (
        !inside(root, resolve(dirname(path), link)) &&
        resolve(dirname(path), link) !== allowedLink
      )
        throw new Error(`snapshot link escapes runtime: ${path}`)
      const actual = await realpath(path)
      if (!inside(root, actual) && actual !== allowedLink)
        throw new Error(`snapshot link escapes runtime: ${path}`)
      hash.update(`link:${relative(dirname(path), actual)}`)
    } else if (stat.isDirectory()) {
      hash.update('directory')
      for (const name of (await readdir(path)).sort())
        if (!exclude.has(name)) await walk(join(path, name))
    } else if (stat.isFile()) {
      hash.update('file')
      hash.update(await readFile(path))
    } else throw new Error(`unsupported snapshot file: ${path}`)
  }
  await walk(root)
  return hash.digest('hex')
}

export interface DependencyGraph {
  roots: Record<string, number>
  packages: Array<{
    source: string
    manifest: Manifest
    edges: Record<string, number>
    digest: string
  }>
  fingerprint: string
}
export async function scanDependencies(
  root: string,
  options: { dev?: boolean; coreRoot?: string; manifest?: Manifest } = {},
): Promise<DependencyGraph> {
  const packages: DependencyGraph['packages'] = []
  const ids = new Map<string, number>()
  async function edges(
    source: string,
    manifest: Manifest,
    dev = false,
  ): Promise<Record<string, number>> {
    const result: Record<string, number> = {}
    const names = {
      ...(dev ? manifest.devDependencies : {}),
      ...manifest.peerDependencies,
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    }
    for (const name of Object.keys(names).sort()) {
      if (name === '@defrex/autobuild' && options.coreRoot) continue
      const found = await installedPackage(name, source)
      if (!found) {
        if (
          Object.hasOwn(manifest.optionalDependencies ?? {}, name) ||
          manifest.peerDependenciesMeta?.[name]?.optional ||
          (dev &&
            !Object.hasOwn(manifest.dependencies ?? {}, name) &&
            !Object.hasOwn(manifest.peerDependencies ?? {}, name))
        )
          continue
        throw new Error(
          `missing installed dependency ${name} required by ${source}; repair the Autobuild installation before dispatch`,
        )
      }
      let id = ids.get(found)
      if (id === undefined) {
        id = packages.length
        ids.set(found, id)
        const entry = {
          source: found,
          manifest: await readManifest(found),
          edges: {},
          digest: await treeDigest(found, dependencyExclusions),
        }
        packages.push(entry)
        entry.edges = await edges(found, entry.manifest)
      }
      result[name] = id
    }
    return result
  }
  const roots = await edges(root, options.manifest ?? (await readManifest(root)), options.dev)
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ roots, packages: packages.map(({ source: _, ...rest }) => rest) }))
    .digest('hex')
  return { roots, packages, fingerprint }
}
export async function copyDependencies(
  graph: DependencyGraph,
  target: string,
  coreRoot?: string,
): Promise<void> {
  await mkdir(join(target, 'node_modules'), { recursive: true })
  const packagePath = (id: number) => join(target, 'node_modules', '.ab-packages', String(id))
  async function links(root: string, edges: Record<string, number>) {
    for (const [name, id] of Object.entries(edges)) {
      const link = join(root, 'node_modules', name)
      await mkdir(dirname(link), { recursive: true })
      await symlink(relative(dirname(link), packagePath(id)), link)
    }
    if (coreRoot) {
      const link = join(root, 'node_modules', '@defrex', 'autobuild')
      await mkdir(dirname(link), { recursive: true })
      await symlink(relative(dirname(link), coreRoot), link)
    }
  }
  for (const [id, entry] of graph.packages.entries()) {
    await copySnapshotTree(
      entry.source,
      packagePath(id),
      entry.source,
      new Set(),
      dependencyExclusions,
    )
    if ((await treeDigest(packagePath(id), dependencyExclusions)) !== entry.digest)
      throw new Error(`installed dependency changed while copying: ${entry.source}; retry dispatch`)
  }
  for (const [id, entry] of graph.packages.entries()) await links(packagePath(id), entry.edges)
  await links(target, graph.roots)
}

/** Standalone plugins have no manifest. Discover their literal native module
 * edges without evaluating consumer code or installing packages. Computed core
 * imports are covered by the canonical core link at every package boundary. */
export async function standalonePluginManifest(
  entry: string,
  boundary: string,
  files = new Set<string>(),
): Promise<Manifest> {
  const dependencies: Record<string, string> = {}
  const visited = new Set<string>()
  async function visit(file: string): Promise<void> {
    if (visited.has(file)) return
    visited.add(file)
    const actual = await realpath(file)
    if (!inside(boundary, actual))
      throw new Error(`standalone plugin link escapes its directory: ${file}`)
    files.add(file)
    const extension = file.split('.').at(-1)
    if (!['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'].includes(extension ?? '')) return
    const loader =
      extension === 'tsx' || extension === 'jsx'
        ? extension
        : extension === 'ts' || extension === 'mts' || extension === 'cts'
          ? 'ts'
          : 'js'
    const source = await readFile(file, 'utf8')
    // Literal package-relative assets retain their import.meta.url location.
    for (const match of source.matchAll(
      /new\s+URL\(\s*['"](\.[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g,
    )) {
      const asset = resolve(dirname(file), match[1]!)
      if (!inside(boundary, asset))
        throw new Error(`standalone plugin asset escapes its directory: ${asset}`)
      await visit(asset)
    }
    const imports = new Bun.Transpiler({ loader }).scanImports(source)
    for (const imported of imports) {
      const path = imported.path
      if (
        isBuiltin(path) ||
        path.startsWith('node:') ||
        path.startsWith('bun:') ||
        isAbsolute(path)
      )
        continue
      if (!path.startsWith('.')) {
        const parts = path.split('/')
        const name = path.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
        dependencies[name] = '*'
        continue
      }
      const base = resolve(dirname(file), path)
      if (!inside(boundary, base))
        throw new Error(`standalone plugin import escapes its directory: ${file}: ${path}`)
      for (const candidate of [
        base,
        ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.js'].map(
          (suffix) => base + suffix,
        ),
      ]) {
        try {
          if ((await lstat(candidate)).isFile()) {
            await visit(candidate)
            break
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    }
  }
  await visit(entry)
  return { name: 'autobuild-standalone-plugin', dependencies }
}
