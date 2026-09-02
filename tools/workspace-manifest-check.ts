import type { Dirent } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'

export interface PackageManifest {
  name?: unknown
  version?: unknown
  workspaces?: unknown
  engines?: unknown
  dependencies?: unknown
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

  const core = manifests.find((entry) => entry.manifest.name === '@autobuild/core')
  if (core === undefined) throw new Error('workspace @autobuild/core is required')
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
