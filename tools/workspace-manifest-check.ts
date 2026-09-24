import type { Dirent } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'

export interface PackageManifest {
  name?: unknown
  version?: unknown
  workspaces?: unknown
  engines?: unknown
  dependencies?: unknown
  devDependencies?: unknown
  peerDependencies?: unknown
  private?: unknown
  bin?: unknown
  patchedDependencies?: unknown
}

export interface WorkspaceManifest {
  path: string
  text: string
  manifest: PackageManifest
}

function parseManifest(path: string, text: string): PackageManifest {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('must contain a JSON object')
    }
    return value as PackageManifest
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${path}: invalid package manifest: ${detail}`)
  }
}

async function expandWorkspacePattern(root: string, pattern: string): Promise<string[]> {
  const normalized = pattern.replaceAll('\\', '/')
  if (!normalized.endsWith('/*') || normalized.slice(0, -2).includes('*')) {
    throw new Error(
      `package.json: unsupported workspace pattern "${pattern}"; expected a directory/* glob`,
    )
  }
  const parent = resolve(root, normalized.slice(0, -2))
  let entries: Dirent[]
  try {
    entries = await readdir(parent, { withFileTypes: true })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `package.json: cannot read workspace directory ${normalized.slice(0, -2)}: ${detail}`,
    )
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(parent, entry.name))
}

export async function readWorkspaceManifests(root: string): Promise<WorkspaceManifest[]> {
  const rootPath = join(root, 'package.json')
  const rootText = await readFile(rootPath, 'utf8')
  const rootManifest = parseManifest('package.json', rootText)
  if (!Array.isArray(rootManifest.workspaces) || rootManifest.workspaces.length === 0) {
    throw new Error('package.json: workspaces must be a non-empty array')
  }
  const directories: string[] = []
  for (const pattern of rootManifest.workspaces) {
    if (typeof pattern !== 'string' || pattern.length === 0) {
      throw new Error('package.json: every workspace pattern must be a non-empty string')
    }
    directories.push(...(await expandWorkspacePattern(root, pattern)))
  }
  const unique = [...new Set(directories)].sort()
  if (unique.length === 0) throw new Error('package.json: workspace patterns matched no packages')

  const workspaces: WorkspaceManifest[] = []
  for (const directory of unique) {
    const path = join(directory, 'package.json')
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(
        `${relative(root, path)}: missing or unreadable workspace manifest: ${detail}`,
      )
    }
    workspaces.push({
      path: relative(root, path),
      text,
      manifest: parseManifest(relative(root, path), text),
    })
  }
  return [{ path: 'package.json', text: rootText, manifest: rootManifest }, ...workspaces]
}

function stringMap(value: unknown, label: string): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') throw new Error(`${label}.${key} must be a string`)
    result[key] = entry
  }
  return result
}

function bunEngine(entry: WorkspaceManifest): string {
  const engines = stringMap(entry.manifest.engines, `${entry.path} engines`)
  const bun = engines.bun
  if (bun === undefined) throw new Error(`${entry.path}: engines.bun is required`)
  return bun
}

/**
 * Dependency names whose exact pins are deliberately duplicated between the
 * `@defrex/autobuild-web-dashboard-capture` package manifest (for the web
 * capture tool in `packages/web-dashboard-capture/src`) and
 * `packages/hosted-store-service/package.json` (for the hosted store app): the
 * two manifests' pins for these names must move in lockstep, because under
 * Bun's isolated linker a skew gives the capture tool its own react copy
 * (two React instances, subtle capture-tool breakage).
 */
const mirroredReactPins = ['react', 'react-dom', '@types/react', '@types/react-dom']

function pinnedVersion(manifest: PackageManifest, name: string): string | undefined {
  const dependencies =
    typeof manifest.dependencies === 'object' && manifest.dependencies !== null
      ? (manifest.dependencies as Record<string, unknown>)
      : undefined
  const devDependencies =
    typeof manifest.devDependencies === 'object' && manifest.devDependencies !== null
      ? (manifest.devDependencies as Record<string, unknown>)
      : undefined
  for (const section of [dependencies, devDependencies]) {
    const version = section?.[name]
    if (typeof version === 'string') return version
  }
  return undefined
}

function describe(value: string | undefined): string {
  return value ?? 'not pinned'
}

/** Derive the package name from a `patchedDependencies` key. Keys look like
 * `<name>@<version>`; cut at the last `@` that follows the name — for scoped
 * names (`@scope/pkg@1.2.3`) the leading `@` belongs to the scope, so a key
 * whose only `@` is the leading one carries no version to strip. */
function patchedPackageName(key: string): string {
  const at = key.lastIndexOf('@')
  return at > 0 ? key.slice(0, at) : key
}

export async function validateWorkspaceManifests(root: string): Promise<WorkspaceManifest[]> {
  const manifests = await readWorkspaceManifests(root)
  const rootManifest = manifests[0]!
  if (typeof rootManifest.manifest.version !== 'string') {
    throw new Error('package.json: version must be a string')
  }
  const rootVersion = rootManifest.manifest.version
  const rootBun = bunEngine(rootManifest)
  if (rootBun !== '>=1.4.0') {
    throw new Error(`package.json: engines.bun must declare the Bun 1.4 minimum as ">=1.4.0"`)
  }
  for (const workspace of manifests.slice(1)) {
    if (workspace.manifest.version !== rootVersion) {
      throw new Error(`${workspace.path}: version must match root ${rootVersion}`)
    }
    if (bunEngine(workspace) !== rootBun) {
      throw new Error(`${workspace.path}: engines.bun must match root ${rootBun}`)
    }
  }

  const core = manifests.find((entry) => entry.manifest.name === '@defrex/autobuild-core')
  if (core === undefined) throw new Error('workspace @defrex/autobuild-core is required')
  const rootDependencies = stringMap(
    rootManifest.manifest.dependencies,
    'package.json dependencies',
  )
  const coreDependencies = stringMap(core.manifest.dependencies, `${core.path} dependencies`)
  const allNames = [
    ...new Set([...Object.keys(rootDependencies), ...Object.keys(coreDependencies)]),
  ].sort()
  for (const name of allNames) {
    if (coreDependencies[name] !== rootDependencies[name]) {
      throw new Error(
        `${core.path}: dependency ${name} must match root (${rootDependencies[name] ?? 'missing'}; found ${coreDependencies[name] ?? 'missing'})`,
      )
    }
  }

  // The packed dependency set must not include a package the root manifest
  // patches. The distribution packer strips `patchedDependencies` from the
  // packed manifest (`packedManifestOmittedFields` in
  // packages/core/src/ports/workspace/distribution-archive.ts) because bun
  // resolves a consumed manifest's patch declarations against the consuming
  // project's root and panics on one naming a package in the consumer tree —
  // so a patched package in the root `dependencies` (the packed dependency
  // set) would ship unpatched to every consumer while the workspace installs
  // the patched copy. `devDependencies` is allowed: it is stripped from the
  // packed manifest and never production-installed in guests. This check
  // makes the better-auth avoidance deliberate: a root manifest that needs a
  // patched package fails here with the remedy instead of silently shipping
  // the divergence.
  const patchedRaw = rootManifest.manifest.patchedDependencies
  if (patchedRaw !== undefined) {
    const patchedDependencies = stringMap(patchedRaw, 'package.json patchedDependencies')
    for (const key of Object.keys(patchedDependencies)) {
      const name = patchedPackageName(key)
      if (rootDependencies[name] !== undefined) {
        throw new Error(
          `package.json: patchedDependencies entry ${key} patches ${name}, which is in the root dependencies: the packer strips patchedDependencies from the packed manifest (packedManifestOmittedFields in packages/core/src/ports/workspace/distribution-archive.ts), so a patched package in the packed dependency set would ship unpatched to every consumer while the workspace installs the patched copy — declare the dependency in the workspace package that imports it instead, as @defrex/autobuild-hosted-store-service does for better-auth`,
        )
      }
    }
  }

  const hostedStore = manifests.find(
    (entry) => entry.manifest.name === '@defrex/autobuild-hosted-store-service',
  )
  if (hostedStore === undefined) {
    throw new Error('workspace @defrex/autobuild-hosted-store-service is required')
  }
  const capturePackage = manifests.find(
    (entry) => entry.manifest.name === '@defrex/autobuild-web-dashboard-capture',
  )
  if (capturePackage === undefined) {
    throw new Error('workspace @defrex/autobuild-web-dashboard-capture is required')
  }
  for (const name of mirroredReactPins) {
    const capturePin = pinnedVersion(capturePackage.manifest, name)
    const hostedPin = pinnedVersion(hostedStore.manifest, name)
    if (capturePin !== hostedPin) {
      throw new Error(
        `${capturePackage.path} and ${hostedStore.path}: ${name} pin drift (web-dashboard-capture ${describe(capturePin)}; hosted-store-service ${describe(hostedPin)}): the workspace react pins must move in lockstep — packages/web-dashboard-capture/src must resolve the same react copy as the hosted store app under Bun's isolated linker`,
      )
    }
  }
  return manifests
}

if (import.meta.main) {
  try {
    const manifests = await validateWorkspaceManifests(process.cwd())
    console.log(
      `Workspace manifests valid: ${manifests.map((entry) => basename(dirname(entry.path)) || 'root').join(', ')}`,
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
