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
import {
  PACKAGE_CONCURRENCY,
  TREE_IO_CONCURRENCY,
  drainStack,
  forEachBounded,
  orderedPrefetch,
} from './bounded-io'

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

/** Applies recorded directory modes deepest level first, so a read-only
 * directory is restricted only after every descendant has been written. */
async function applyDirectoryModes(
  directories: Array<{ target: string; mode: number; depth: number }>,
): Promise<void> {
  const levels = new Map<number, Array<{ target: string; mode: number }>>()
  for (const directory of directories) {
    const level = levels.get(directory.depth)
    if (level) level.push(directory)
    else levels.set(directory.depth, [directory])
  }
  for (const depth of [...levels.keys()].sort((a, b) => b - a))
    await forEachBounded(levels.get(depth)!, TREE_IO_CONCURRENCY, ({ target, mode }) =>
      chmod(target, mode),
    )
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
  type Item = { source: string; target: string; stack: Set<string>; depth: number }
  const directories: Array<{ target: string; mode: number; depth: number }> = []
  await drainStack<Item>(
    [{ source, target, stack, depth: 0 }],
    TREE_IO_CONCURRENCY,
    async (item, push) => {
      const actual = await realpath(item.source)
      if (!inside(boundary, actual))
        throw new Error(`snapshot link escapes package: ${item.source} -> ${actual}`)
      if (item.stack.has(actual)) throw new Error(`cyclic snapshot asset link: ${item.source}`)
      // A child's parent directory was created before the child was queued.
      const root = item.depth === 0
      const sourceStat = await lstat(item.source)
      if (sourceStat.isSymbolicLink()) {
        const mapped = resolve(item.target, relative(item.source, actual))
        if (root) await mkdir(dirname(item.target), { recursive: true })
        await symlink(relative(dirname(item.target), mapped), item.target)
        return
      }
      const stat = await lstat(actual)
      if (stat.isDirectory()) {
        await mkdir(item.target, { recursive: true })
        directories.push({ target: item.target, mode: stat.mode & 0o777, depth: item.depth })
        const next = new Set(item.stack).add(actual)
        const names = (await readdir(actual))
          .sort()
          .filter(
            (name) =>
              !exclusions.has(name) && !(exclusions.has('.env') && name.startsWith('.env.')),
          )
        for (let index = names.length - 1; index >= 0; index--)
          push({
            source: join(actual, names[index]!),
            target: join(item.target, names[index]!),
            stack: next,
            depth: item.depth + 1,
          })
      } else if (stat.isFile()) {
        if (root) await mkdir(dirname(item.target), { recursive: true })
        await copyFile(actual, item.target)
        await chmod(item.target, stat.mode & 0o777)
      } else throw new Error(`unsupported snapshot asset: ${item.source}`)
    },
  )
  await applyDirectoryModes(directories)
}

/** Copies an already validated runtime tree: link strings verbatim, file bytes
 * and permission bits. Every result is digested or import-checked by callers. */
export async function copyTreeVerbatim(source: string, target: string): Promise<void> {
  type Item = { source: string; target: string; depth: number }
  const directories: Array<{ target: string; mode: number; depth: number }> = []
  await drainStack<Item>(
    [{ source, target, depth: 0 }],
    TREE_IO_CONCURRENCY,
    async (item, push) => {
      const stat = await lstat(item.source)
      if (stat.isSymbolicLink()) await symlink(await readlink(item.source), item.target)
      else if (stat.isDirectory()) {
        await mkdir(item.target, { recursive: item.depth === 0 })
        directories.push({ target: item.target, mode: stat.mode & 0o777, depth: item.depth })
        for (const name of await readdir(item.source))
          push({
            source: join(item.source, name),
            target: join(item.target, name),
            depth: item.depth + 1,
          })
      } else if (stat.isFile()) {
        await copyFile(item.source, item.target)
        await chmod(item.target, stat.mode & 0o777)
      } else throw new Error(`unsupported runtime tree entry: ${item.source}`)
    },
  )
  await applyDirectoryModes(directories)
}

/** Digest includes names, executable bits, bytes and internal link topology.
 * Metadata is gathered concurrently, then hashed in sorted pre-order with file
 * bytes read through a bounded in-order window, so the digest is independent
 * of completion order. */
export async function treeDigest(
  root: string,
  exclude = new Set<string>(),
  allowedLink?: string,
): Promise<string> {
  type Node = {
    path: string
    mode: number
    kind: 'link' | 'directory' | 'file'
    link?: string
    children?: Node[]
  }
  const top: Node = { path: root, mode: 0, kind: 'file' }
  await drainStack([top], TREE_IO_CONCURRENCY, async (node, push) => {
    const path = node.path
    const stat = await lstat(path)
    node.mode = stat.mode
    if (stat.isSymbolicLink()) {
      node.kind = 'link'
      const link = await readlink(path)
      if (
        !inside(root, resolve(dirname(path), link)) &&
        resolve(dirname(path), link) !== allowedLink
      )
        throw new Error(`snapshot link escapes runtime: ${path}`)
      const actual = await realpath(path)
      if (!inside(root, actual) && actual !== allowedLink)
        throw new Error(`snapshot link escapes runtime: ${path}`)
      node.link = relative(dirname(path), actual)
    } else if (stat.isDirectory()) {
      node.kind = 'directory'
      const children = (await readdir(path))
        .sort()
        .filter((name) => !exclude.has(name))
        .map((name): Node => ({ path: join(path, name), mode: 0, kind: 'file' }))
      node.children = children
      for (let index = children.length - 1; index >= 0; index--) push(children[index]!)
    } else if (stat.isFile()) node.kind = 'file'
    else throw new Error(`unsupported snapshot file: ${path}`)
  })
  const order: Node[] = []
  const pending = [top]
  while (pending.length) {
    const node = pending.pop()!
    order.push(node)
    const children = node.children ?? []
    for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]!)
  }
  const hash = createHash('sha256')
  let emitted = 0
  const emitThrough = (end: number) => {
    for (; emitted < end; emitted++) {
      const node = order[emitted]!
      hash.update(JSON.stringify([relative(root, node.path), node.mode & 0o111]))
      if (node.kind === 'link') hash.update(`link:${node.link}`)
      else if (node.kind === 'directory') hash.update('directory')
    }
  }
  const files: number[] = []
  for (const [index, node] of order.entries()) if (node.kind === 'file') files.push(index)
  await orderedPrefetch(
    files,
    TREE_IO_CONCURRENCY,
    (index) => readFile(order[index]!.path),
    (bytes, index) => {
      emitThrough(index + 1)
      hash.update('file')
      hash.update(bytes)
    },
  )
  emitThrough(order.length)
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
    const sorted = Object.keys(names)
      .sort()
      .filter((name) => !(name === '@defrex/autobuild' && options.coreRoot))
    // Resolution is independent per edge; ids are still assigned in sorted
    // depth-first order below, which the fingerprint encodes.
    const resolved: Array<string | undefined> = []
    await forEachBounded(sorted, TREE_IO_CONCURRENCY, async (name, index) => {
      resolved[index] = await installedPackage(name, source)
    })
    for (const [index, name] of sorted.entries()) {
      const found = resolved[index]
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
          digest: '',
        }
        packages.push(entry)
        entry.edges = await edges(found, entry.manifest)
      }
      result[name] = id
    }
    return result
  }
  const roots = await edges(root, options.manifest ?? (await readManifest(root)), options.dev)
  await forEachBounded(packages, PACKAGE_CONCURRENCY, async (entry) => {
    entry.digest = await treeDigest(entry.source, dependencyExclusions)
  })
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
  await forEachBounded(graph.packages, PACKAGE_CONCURRENCY, async (entry, id) => {
    await copySnapshotTree(
      entry.source,
      packagePath(id),
      entry.source,
      new Set(),
      dependencyExclusions,
    )
    if ((await treeDigest(packagePath(id), dependencyExclusions)) !== entry.digest)
      throw new Error(`installed dependency changed while copying: ${entry.source}; retry dispatch`)
  })
  // Links are published only after every package copy has been verified.
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
      let resolved: string
      try {
        // Relative-only resolution stays offline and follows Bun's native
        // extension substitutions and directory entry rules without loading code.
        resolved = Bun.resolveSync(path, dirname(file))
      } catch (cause) {
        throw new Error(`cannot resolve standalone plugin import: ${file}: ${path}`, { cause })
      }
      await visit(resolved)
    }
  }
  await visit(entry)
  return { name: 'autobuild-standalone-plugin', dependencies }
}
