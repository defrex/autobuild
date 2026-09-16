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

/** Where the owning package manager obtained the distribution: a `github:`
 * forge dependency, or a version range satisfied from the npm registry. */
export type InstallChannel = 'github' | 'npm'

interface ManagedInstallationBase extends DistributionIdentity {
  sourceCheckout: false
  ownerRoot: string
  ownerManifest: string
  ownerLock: string
  /** The owning manifest's direct dependency value, byte for byte. */
  dependency: string
  scope: InstallScope
}

export interface BunForgeInstallation extends ManagedInstallationBase {
  channel: 'github'
  owner: string
  repository: string
}

export interface NpmRegistryInstallation extends ManagedInstallationBase {
  channel: 'npm'
}

export type ManagedInstallation = BunForgeInstallation | NpmRegistryInstallation

export type InstallationInspection =
  | { kind: 'source'; identity: DistributionIdentity; reason: string }
  | { kind: 'bun-forge'; installation: BunForgeInstallation }
  | { kind: 'npm-registry'; installation: NpmRegistryInstallation }
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

/** A registry dependency is a semver range (what `bun add <pkg>@<version>`
 * writes) that the installed version satisfies. Aliases, tags, URLs, and
 * `file:`/`link:` specifiers are not registry installs. */
function registryDependency(value: unknown, installedVersion: string): boolean {
  if (typeof value !== 'string' || value.trim() === '') return false
  if (semver.validRange(value) === null) return false
  return semver.satisfies(installedVersion, value)
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

/** Validate Bun's direct install records before permitting mutation. A
 * `github:` dependency is a forge install whose repository comes from the
 * owning manifest/lock, never by splitting the ambiguous hyphen-delimited
 * `.bun-tag`. A semver-range dependency satisfied by the installed version,
 * whose lock record resolves to that exact registry version, is an npm
 * registry install. Anything else is a named refusal. */
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
    const registry = repository === undefined && registryDependency(dependency, identity.version)
    if ((repository === undefined && !registry) || typeof dependency !== 'string') {
      return {
        kind: 'unknown',
        identity,
        reason: `${ownerManifest} does not declare ${identity.packageName} as a direct github: dependency or an npm registry version range satisfied by ${identity.version}`,
      }
    }
    if (lockDependency(lock, identity.packageName) !== dependency) {
      return {
        kind: 'unknown',
        identity,
        reason: `${ownerLock} does not agree with the direct dependency in ${ownerManifest}`,
      }
    }
    const scope: InstallScope = (await samePath(join(options.globalBin, 'ab'), identity.binaryPath))
      ? 'global'
      : 'local'
    if (repository === undefined) {
      // Registry provenance: Bun records `<name>@<version>` with an empty
      // registry marker; a forge, tarball, or workspace resolution differs.
      const record = lockPackageRecord(lock, identity.packageName)
      if (
        record === undefined ||
        record[0] !== `${identity.packageName}@${identity.version}` ||
        record[1] !== ''
      ) {
        return {
          kind: 'unknown',
          identity,
          reason: `${ownerLock} does not resolve ${identity.packageName} to registry version ${identity.version}`,
        }
      }
      return {
        kind: 'npm-registry',
        installation: {
          ...identity,
          sourceCheckout: false,
          channel: 'npm',
          ownerRoot,
          ownerManifest,
          ownerLock,
          dependency,
          scope,
        },
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

    return {
      kind: 'bun-forge',
      installation: {
        ...identity,
        sourceCheckout: false,
        channel: 'github',
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
