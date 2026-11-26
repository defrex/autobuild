import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  realpath,
  lstat,
  readdir,
  readlink,
} from 'node:fs/promises'
import { join, posix, resolve } from 'node:path'
import {
  packageDistribution,
  withDistributionSelection,
  type DistributionSelection,
} from '../distribution-packaging'
import { parse as parseToml } from 'smol-toml'
import { treeDigest, inside, type Manifest } from './dispatch-runtime-dependencies'
import type { Exec } from '../ports/workspace/git-worktree'

export interface SourceLaunch {
  repository: string
  commit: string
  baseline: string
}
export const sourceHash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid source package metadata')
  return value as Record<string, unknown>
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    )
  return value
}
export async function sourceCommand(
  cmd: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  const child = Bun.spawn(cmd, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
      : AbortSignal.timeout(120_000),
  })
  const [code, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  signal?.throwIfAborted()
  if (code !== 0) throw new Error('source runtime subprocess failed')
  return stdout
}
export async function sourceRepository(
  root: string,
  checkout: string,
): Promise<string | undefined> {
  try {
    const top = (await sourceCommand(['git', 'rev-parse', '--show-toplevel'], root)).trim()
    if ((await realpath(top)) !== (await realpath(root))) return undefined
    const common = async (cwd: string) =>
      realpath(
        (
          await sourceCommand(
            ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'],
            cwd,
          )
        ).trim(),
      )
    const own = await common(root)
    return own === (await common(checkout)) ? own : undefined
  } catch {
    return undefined
  }
}

/** No linked worktree, checkout, reset, or mutable reference is created here. */
export async function withSourceExport<T>(
  input: { checkout: string; sha: string; signal?: AbortSignal; exec?: Exec },
  use: (root: string) => Promise<T>,
): Promise<T> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.sha)) throw new Error('invalid source commit')
  const cache = join(input.checkout, '.autobuild/runtime')
  await mkdir(cache, { recursive: true })
  const stage = await mkdtemp(join(cache, '.preparing-source-'))
  try {
    const archive = join(stage, 'source.tar')
    const cmd = ['git', 'archive', '--format=tar', `--output=${archive}`, input.sha]
    if (input.exec) {
      const result = await input.exec(cmd, { cwd: input.checkout, signal: input.signal })
      if (result.exitCode !== 0) throw new Error('source commit export failed')
    } else await sourceCommand(cmd, input.checkout, input.signal)
    const names = await sourceCommand(['tar', '-tf', archive], stage, input.signal)
    for (const name of names.split('\n').filter(Boolean))
      if (!inside(stage, resolve(stage, name)) || name.startsWith('/'))
        throw new Error('unsafe source archive path')
    const root = join(stage, 'checkout')
    await mkdir(root)
    await sourceCommand(['tar', '-xf', archive, '-C', root], stage, input.signal)
    async function links(path: string): Promise<void> {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const file = join(path, entry.name)
        if (entry.isSymbolicLink()) {
          const target = resolve(path, await readlink(file))
          if (!inside(root, target)) throw new Error('source archive link escapes staging')
        } else if (entry.isDirectory()) await links(file)
        else if (!(await lstat(file)).isFile()) throw new Error('unsupported source archive entry')
      }
    }
    await links(root)
    input.signal?.throwIfAborted()
    return await use(root)
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

/** Bun package keys are hoisted package paths; scoped names form one component.
 * Resolve nearest nested record before walking the parent package contexts. */
export function productionLockClosure(
  manifest: Manifest,
  raw: unknown,
  workspaces: Record<string, Manifest> = {},
): { records: Record<string, unknown>; graph: unknown } {
  const lock = object(raw)
  if (lock.lockfileVersion !== 1 && lock.lockfileVersion !== 2)
    throw new Error('unsupported source Bun lock version')
  const packages = object(lock.packages)
  const root = object(object(lock.workspaces)[''])
  const records: Record<string, unknown> = {}
  const ids = new Map<string, number>()
  const nodes: Array<{ record: unknown; edges: Record<string, number> }> = []
  const roots: Record<string, number> = {}
  const sections = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const
  for (const section of sections)
    for (const [name, declaration] of Object.entries(manifest[section] ?? {}))
      if (typeof declaration !== 'string' || object(root[section] ?? {})[name] !== declaration)
        throw new Error('source manifest and lock disagree')
  const components = (key: string) => key.match(/@[^/]+\/[^/]+|[^/]+/g) ?? []
  function visit(name: string, context: string, optional: boolean): number | undefined {
    const parents = components(context)
    let key: string | undefined
    for (;;) {
      const candidate = [...parents, name].join('/')
      if (Object.hasOwn(packages, candidate)) {
        key = candidate
        break
      }
      if (!parents.length) break
      parents.pop()
    }
    if (!key) {
      if (optional) return
      throw new Error(`missing production source lock dependency ${name}`)
    }
    if (ids.has(key)) return ids.get(key)
    const record = packages[key]
    if (
      !Array.isArray(record) ||
      typeof record[0] !== 'string' ||
      !record[0].startsWith(`${name}@`)
    )
      throw new Error('unsupported source lock record')
    if (record[0].includes('@file:') || record[0].includes('@link:'))
      throw new Error('unsupported local production source dependency')
    records[key] = record
    let meta = object(record[2] ?? {})
    if (record[0].startsWith(`${name}@workspace:`)) {
      const path = record[0].slice(`${name}@workspace:`.length)
      const workspace = workspaces[path]
      if (!workspace || workspace.name !== name)
        throw new Error('missing reachable source workspace manifest')
      const lockedWorkspace = object(object(lock.workspaces)[path])
      for (const section of sections)
        if (
          JSON.stringify(canonical(workspace[section] ?? {})) !==
          JSON.stringify(canonical(lockedWorkspace[section] ?? {}))
        )
          throw new Error('source workspace and lock disagree')
      meta = workspace
      records[key] = {
        record,
        manifest: canonical(
          Object.fromEntries(
            ['name', 'version', ...sections].map((field) => [field, workspace[field] ?? null]),
          ),
        ),
      }
    }
    const id = nodes.length
    ids.set(key, id)
    const node = { record: records[key], edges: {} as Record<string, number> }
    nodes.push(node)
    for (const section of sections)
      for (const dependency of Object.keys(object(meta[section] ?? {})).sort()) {
        if (typeof object(meta[section])[dependency] !== 'string')
          throw new Error('unsupported source dependency declaration')
        const dependencyId = visit(
          dependency,
          key,
          section === 'optionalDependencies' ||
            (section === 'peerDependencies' &&
              Array.isArray(meta.optionalPeers) &&
              meta.optionalPeers.includes(dependency)),
        )
        if (dependencyId !== undefined) node.edges[dependency] = dependencyId
      }
    return id
  }
  for (const section of sections)
    for (const name of Object.keys(manifest[section] ?? {}).sort()) {
      const id = visit(
        name,
        '',
        section === 'optionalDependencies' || !!manifest.peerDependenciesMeta?.[name]?.optional,
      )
      if (id !== undefined) roots[name] = id
    }
  return { records, graph: canonical({ roots, packages: nodes }) }
}

/** Identity follows real pack rules, with provenance and transport timestamps removed. */
export async function sourceContent(
  root: string,
  repository: string,
  signal?: AbortSignal,
): Promise<{ key: string; version: string }> {
  signal?.throwIfAborted()
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Manifest
  if (typeof manifest.version !== 'string' || !manifest.version)
    throw new Error('source manifest has no version')
  const lock = object(Bun.JSONC.parse(await readFile(join(root, 'bun.lock'), 'utf8')))
  const workspaces: Record<string, Manifest> = {}
  for (const path of Object.keys(object(lock.workspaces))) {
    if (!path) continue
    if (!inside(root, resolve(root, path))) throw new Error('unsafe source workspace path')
    workspaces[path] = JSON.parse(await readFile(join(root, path, 'package.json'), 'utf8'))
  }
  const closure = productionLockClosure(manifest, lock, workspaces)
  const configuration: Record<string, unknown> = {}
  try {
    const config = parseToml(await readFile(join(root, 'bunfig.toml'), 'utf8'))
    const install = object(config.install ?? {})
    // Credentials, cache paths, logging and unrelated scopes cannot affect
    // the bytes selected by a frozen production lock.
    for (const key of ['peer', 'optional', 'linker'])
      if (install[key] !== undefined) configuration[key] = install[key]
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const workspaceContent: Record<string, string> = {}
  for (const value of Object.values(closure.records)) {
    if (Array.isArray(value)) continue
    const record = object(value).record as string[]
    const path = record[0]!.slice(record[0]!.indexOf('@workspace:') + 11)
    workspaceContent[path] = await packagedFingerprint(join(root, path), signal)
  }
  const packaged = await packagedFingerprint(root, signal)
  // The frozen lock is the authority for registry resolution/integrity.
  const key = sourceHash([
    'source',
    repository,
    packaged,
    closure.graph,
    canonical(configuration),
    canonical(workspaceContent),
  ])
  signal?.throwIfAborted()
  return { key, version: String(manifest.version) }
}

/** Exported for equivalence tests; `sourceContent` is the product entry. */
export async function packagedFingerprint(root: string, signal?: AbortSignal): Promise<string> {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Manifest
  for (const path of manifest.files ?? [])
    if (!path.startsWith('!') && !inside(root, resolve(root, path)))
      throw new Error('unsafe packaged source path')
  return (
    (await packedContentFingerprint(root, signal)) ??
    (await archivedPackageFingerprint(root, signal))
  )
}

/** The packed-contents digest from Bun's dry-run selection, with no archive.
 * `undefined` when the selection or its modes cannot be proven equal to what
 * an archive would carry; the caller then packs for real. */
export async function packedContentFingerprint(
  root: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  return withDistributionSelection(
    root,
    async (selection) => selectedTreeDigest(selection),
    undefined,
    signal ?? AbortSignal.timeout(120_000),
  )
}

/** Must stay byte-compatible with `treeDigest` over the
 * `tar -x --strip-components=1` extraction `archivedPackageFingerprint`
 * hashes. Directory bits `0o111` and staged file bits hold only because the
 * selection's creation-mode probe and `binModesSafe` passed. */
async function selectedTreeDigest(selection: DistributionSelection): Promise<string | undefined> {
  const { staging, files, manifest, modes } = selection
  if (!binModesSafe(manifest, files, modes)) return undefined
  type Node = Map<string, Node | null>
  const tree: Node = new Map()
  for (const file of files) {
    const segments = file.split('/')
    let node = tree
    for (const segment of segments.slice(0, -1)) {
      let child = node.get(segment)
      if (child === null) return undefined
      if (!child) {
        child = new Map()
        node.set(segment, child)
      }
      node = child
    }
    if (node.has(segments.at(-1)!)) return undefined
    node.set(segments.at(-1)!, null)
  }
  const hash = createHash('sha256')
  async function walk(rel: string, node: Node | null): Promise<void> {
    if (node === null) {
      hash.update(JSON.stringify([rel, modes.get(rel)! & 0o111]))
      hash.update('file')
      if (rel === 'package.json') {
        const packed = JSON.parse(await readFile(join(staging, rel), 'utf8'))
        delete packed.gitHead
        hash.update(JSON.stringify(canonical(packed)))
      } else hash.update(await readFile(join(staging, rel)))
      return
    }
    hash.update(JSON.stringify([rel, 0o111]))
    hash.update('directory')
    for (const name of [...node.keys()].sort())
      await walk(rel ? `${rel}/${name}` : name, node.get(name)!)
  }
  await walk('', tree)
  return hash.digest('hex')
}

/** Bun packs `bin` targets (and, without `bin`, direct children of
 * `directories.bin`) with every execute bit set. Rather than model that
 * rule, require every file in a superset of those targets to be executable
 * already, so marking changes nothing; anything else uses a real archive. */
function binModesSafe(
  manifest: Record<string, unknown>,
  files: string[],
  modes: Map<string, number>,
): boolean {
  const target = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || /[\\\u0000-\u001f\u007f]/.test(value)) return undefined
    const normal = posix.normalize(value.replace(/^\/+/, '')).replace(/\/+$/, '')
    if (!normal || normal === '.' || normal === '..' || normal.startsWith('../')) return undefined
    return normal
  }
  const executable = (file: string) => (modes.get(file)! & 0o111) === 0o111
  const { bin, directories } = manifest
  if (bin !== undefined) {
    const values =
      typeof bin === 'string'
        ? [bin]
        : bin && typeof bin === 'object' && !Array.isArray(bin)
          ? Object.values(bin)
          : undefined
    if (!values) return false
    for (const value of values) {
      const path = target(value)
      if (!path) return false
      if (modes.has(path) && !executable(path)) return false
    }
  }
  if (directories !== undefined) {
    if (!directories || typeof directories !== 'object' || Array.isArray(directories)) return false
    const directory = (directories as Record<string, unknown>).bin
    if (directory !== undefined) {
      const path = target(directory)
      if (!path) return false
      for (const file of files)
        if ((file === path || file.startsWith(`${path}/`)) && !executable(file)) return false
    }
  }
  return true
}

/** The identity as an extracted real pack archive; fallback and test oracle. */
export async function archivedPackageFingerprint(
  root: string,
  signal?: AbortSignal,
): Promise<string> {
  // Launch baselines also package the live checkout and its workspaces. Scratch
  // must never require write access beside either source root.
  const stage = await mkdtemp(join(tmpdir(), 'autobuild-source-fingerprint-'))
  try {
    await writeFile(
      join(stage, 'package.tgz'),
      await packageDistribution(root, undefined, signal ?? AbortSignal.timeout(120_000)),
    )
    const extracted = join(stage, 'packed')
    await mkdir(extracted)
    await sourceCommand(
      ['tar', '-xzf', join(stage, 'package.tgz'), '--strip-components=1', '-C', extracted],
      stage,
      signal,
    )
    const packed = JSON.parse(await readFile(join(extracted, 'package.json'), 'utf8'))
    delete packed.gitHead
    await writeFile(join(extracted, 'package.json'), JSON.stringify(canonical(packed)))
    return await treeDigest(extracted)
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}
