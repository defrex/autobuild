import { stat, readFile, realpath } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import semver from 'semver'
import { PLUGIN_API_VERSION } from '../plugins/manifest'
import { defaultDistRoot } from './init'

export interface DistributionIdentity {
  root: string
  packageName: string
  version: string
  /** Bun records the resolved forge commit in a distribution-local `.bun-tag`. */
  commit?: string
  bunTag?: string
  sourceCheckout: boolean
  binaryPath: string
}

export type InstallScope = 'local' | 'global'

export interface BunForgeInstallation extends DistributionIdentity {
  sourceCheckout: false
  ownerRoot: string
  ownerManifest: string
  ownerLock: string
  owner: string
  repository: string
  dependency: string
  scope: InstallScope
}

export type InstallationInspection =
  | { kind: 'source'; identity: DistributionIdentity; reason: string }
  | { kind: 'bun-forge'; installation: BunForgeInstallation }
  | { kind: 'unknown'; identity: DistributionIdentity; reason: string }

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function exactVersion(value: unknown, path: string): string {
  if (typeof value !== 'string' || semver.valid(value) !== value) {
    throw new Error(`${path} has an invalid package version`)
  }
  return value
}

function binaryRelativePath(manifest: Record<string, unknown>, path: string): string {
  const bin = manifest.bin
  if (typeof bin === 'string' && bin !== '') return bin
  const entries = object(bin)
  const ab = entries?.ab
  if (typeof ab !== 'string' || ab === '') {
    throw new Error(`${path} does not declare the ab binary`)
  }
  return ab
}

/** Read only distribution-local metadata. This is the complete `ab --version`
 * path: no cwd, project configuration, package-manager command, or network. */
export async function readDistributionIdentity(
  root = defaultDistRoot(),
): Promise<DistributionIdentity> {
  const distributionRoot = resolve(root)
  const packagePath = join(distributionRoot, 'package.json')
  let manifest: Record<string, unknown>
  try {
    manifest = object(JSON.parse(await readFile(packagePath, 'utf8'))) ?? {}
  } catch (error) {
    throw new Error(
      `cannot read installed Autobuild metadata at ${packagePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  if (typeof manifest.name !== 'string' || manifest.name === '') {
    throw new Error(`${packagePath} has no package name`)
  }
  const binary = binaryRelativePath(manifest, packagePath)
  const sourceCheckout = await exists(join(distributionRoot, '.git'))
  let bunTag: string | undefined
  let commit: string | undefined
  try {
    bunTag = (await readFile(join(distributionRoot, '.bun-tag'), 'utf8')).trim()
    const match = /-([0-9a-f]{7,40})$/i.exec(bunTag)
    if (match?.[1] !== undefined) commit = match[1]
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return {
    root: distributionRoot,
    packageName: manifest.name,
    version: exactVersion(manifest.version, packagePath),
    ...(commit === undefined ? {} : { commit }),
    ...(bunTag === undefined ? {} : { bunTag }),
    sourceCheckout,
    binaryPath: resolve(distributionRoot, binary),
  }
}

export function formatInstalledVersion(identity: DistributionIdentity): string {
  return [
    `autobuild ${identity.version}${identity.commit === undefined ? '' : ` (commit ${identity.commit})`}`,
    `plugin API ${PLUGIN_API_VERSION}`,
  ].join('\n')
}

function ownerRootForPackage(identity: DistributionIdentity): string | undefined {
  const packageSegments = identity.packageName.split('/')
  if (packageSegments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return undefined
  }
  const suffix = [sep, 'node_modules', sep, packageSegments.join(sep)].join('')
  if (!identity.root.endsWith(suffix)) return undefined
  const owner = identity.root.slice(0, -suffix.length)
  return owner === '' ? sep : owner
}

function githubDependency(value: unknown): { owner: string; repository: string } | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:#([^\s]+))?$/.exec(value)
  if (match?.[1] === undefined || match[2] === undefined) return undefined
  return { owner: match[1], repository: match[2] }
}

async function parseJson(path: string): Promise<Record<string, unknown>> {
  try {
    return object(JSON.parse(await readFile(path, 'utf8'))) ?? {}
  } catch (error) {
    throw new Error(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

async function parseJsonc(path: string): Promise<Record<string, unknown>> {
  try {
    const value = Bun.JSONC.parse(await readFile(path, 'utf8'))
    return object(value) ?? {}
  } catch (error) {
    throw new Error(
      `${path} is not valid JSONC: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function lockDependency(lock: Record<string, unknown>, packageName: string): unknown {
  const workspace = object(object(lock.workspaces)?.[''])
  return object(workspace?.dependencies)?.[packageName]
}

function lockPackageRecord(
  lock: Record<string, unknown>,
  packageName: string,
): unknown[] | undefined {
  const value = object(lock.packages)?.[packageName]
  return Array.isArray(value) ? value : undefined
}

async function samePath(left: string, right: string): Promise<boolean> {
  try {
    return (await realpath(left)) === (await realpath(right))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Validate Bun's direct forge-install records before permitting mutation.
 * The repository comes from the owning manifest/lock, never by splitting the
 * ambiguous hyphen-delimited `.bun-tag`. */
export async function inspectInstallation(options: {
  distRoot?: string
  globalBin: string
}): Promise<InstallationInspection> {
  const identity = await readDistributionIdentity(options.distRoot)
  if (identity.sourceCheckout) {
    return {
      kind: 'source',
      identity,
      reason: 'running from a source checkout (.git is present)',
    }
  }

  const ownerRoot = ownerRootForPackage(identity)
  if (ownerRoot === undefined) {
    return {
      kind: 'unknown',
      identity,
      reason: 'the distribution is not a direct Bun node_modules package',
    }
  }
  const ownerManifest = join(ownerRoot, 'package.json')
  const ownerLock = join(ownerRoot, 'bun.lock')

  try {
    const manifest = await parseJson(ownerManifest)
    const lock = await parseJsonc(ownerLock)
    const dependency = object(manifest.dependencies)?.[identity.packageName]
    const repository = githubDependency(dependency)
    if (repository === undefined || typeof dependency !== 'string') {
      return {
        kind: 'unknown',
        identity,
        reason: `${ownerManifest} does not declare ${identity.packageName} as a direct github: dependency`,
      }
    }
    if (lockDependency(lock, identity.packageName) !== dependency) {
      return {
        kind: 'unknown',
        identity,
        reason: `${ownerLock} does not agree with the direct dependency in ${ownerManifest}`,
      }
    }
    const expectedTagPrefix = `${repository.owner}-${repository.repository}-`
    if (
      identity.bunTag === undefined ||
      !identity.bunTag.startsWith(expectedTagPrefix) ||
      identity.commit === undefined
    ) {
      return {
        kind: 'unknown',
        identity,
        reason: 'the installed .bun-tag is malformed or contradicts the owning dependency',
      }
    }
    const record = lockPackageRecord(lock, identity.packageName)
    const resolvedPackage =
      `${identity.packageName}@github:${repository.owner}/${repository.repository}` +
      `#${identity.commit}`
    if (record === undefined || record[0] !== resolvedPackage || record[2] !== identity.bunTag) {
      return {
        kind: 'unknown',
        identity,
        reason: `${ownerLock} does not contain matching Bun forge provenance`,
      }
    }

    const scope: InstallScope = (await samePath(join(options.globalBin, 'ab'), identity.binaryPath))
      ? 'global'
      : 'local'
    return {
      kind: 'bun-forge',
      installation: {
        ...identity,
        sourceCheckout: false,
        ownerRoot,
        ownerManifest,
        ownerLock,
        owner: repository.owner,
        repository: repository.repository,
        dependency,
        scope,
      },
    }
  } catch (error) {
    return {
      kind: 'unknown',
      identity,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}
