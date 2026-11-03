import { isBuiltin } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { subset, validRange } from 'semver'
import { repoRoot } from './git-tracked'
import {
  type PackRequest,
  type PackResult,
  type PackRunner,
  parsePackedPaths,
  spawnPack,
} from './publish-contents-check'
import { packedScriptKind } from './publish-imports-check'
import { publishablePackages } from './release'
import { readWorkspaceManifests } from './workspace-manifest-check'
import { collectSpecifiers, UNPARSEABLE_MODULE } from './package-boundary-check'

/**
 * Fails when a published package's packed source imports a third-party
 * package its packed manifest does not declare, or when a library a published
 * package shares with `@defrex/autobuild` is declared with a range that does
 * not admit the root package's range.
 *
 * Why (#824): the hosted store service imported `zod` in 16 files without
 * declaring it. A standalone install worked only because the import happened
 * to resolve to the copy `@defrex/autobuild` brings in. Inside another
 * project's Bun workspace the undeclared import fell back to whatever `zod`
 * the isolated linker had shared, which another member pinned, and
 * `next build` failed its type check inside the service's own source.
 *
 * Mechanics:
 *
 * 1. The publish set is enumerated with the release's own code:
 *    `readWorkspaceManifests` → `publishablePackages`.
 * 2. Each publishable package is packed with `bun pm pack --ignore-scripts
 *    --dry-run`, the same seam publish-imports-check.ts uses. The listing is
 *    the exact path set `bun publish` ships; a failed pack is a violation,
 *    never a skip.
 * 3. Every packed script file (`packedScriptKind`) is parsed with
 *    `collectSpecifiers`, which fails closed and collects type-only imports.
 *    Type-only imports count on purpose: #824 was a type-check failure, so an
 *    `import type` from an undeclared package breaks a consumer's build as
 *    surely as a runtime import.
 * 4. A bare specifier passes when its package is the package itself, a Node
 *    or Bun builtin, or declared in `dependencies`, `peerDependencies` or
 *    `optionalDependencies`. `bun pm pack` ships those sections unchanged
 *    (it rewrites only `workspace:` values), so the names are read from the
 *    package's own `package.json`. `devDependencies` never count: consumers
 *    never install them.
 * 5. Anything else needs a `REVIEWED_ALLOWANCES` entry naming the package, the
 *    packed file and the exact specifier. Allowances are triple-scoped so no
 *    package-wide or specifier-wide exemption can hide the next undeclared
 *    import, and an allowance that matches nothing is itself a violation, so
 *    a removed import or a later declaration cannot leave one behind.
 * 6. Shared-dependency drift: for every publishable package other than
 *    `@defrex/autobuild`, every name it declares that the root package's
 *    `dependencies` also declares must carry a range that admits the root's
 *    (`semver.subset(rootRange, packageRange)`), so a consumer install
 *    resolves one shared copy. `REQUIRED_SHARED_DEPENDENCIES` additionally
 *    fails when a declaration that must exist disappears.
 *
 * It runs in `bun run check`, which is the `lint` verify step on every build
 * and the `lint` gate `tools/release.ts` runs before every publish. Its
 * sibling publish-imports-check.ts guards only `@defrex/autobuild/*` subpath
 * skew against the provider's exports map; this guard owns third-party
 * declarations.
 */

export const ROOT_PACKAGE = '@defrex/autobuild'

const DECLARING_SECTIONS = ['dependencies', 'peerDependencies', 'optionalDependencies'] as const

export interface ReviewedAllowance {
  packageName: string
  /** Packed path, relative to the package directory. */
  path: string
  specifier: string
  reason: string
}

/** Undeclared imports a reviewer accepted, each for one exact
 * (package, packed file, specifier) triple. */
export const REVIEWED_ALLOWANCES: readonly ReviewedAllowance[] = [
  {
    packageName: '@defrex/autobuild-hosted-store-service',
    path: 'app/api/dispatch/route.ts',
    specifier: '@defrex/autobuild-hosted-dispatcher/runtime',
    reason:
      'The dispatcher is optional and installed only by dispatcher-enabled deployments; it ' +
      'declares a peer on the service, so declaring it back would form a cycle. A state-only ' +
      'deployment never serves this route.',
  },
  {
    packageName: '@defrex/autobuild-hosted-store-service',
    path: 'app/access/session.ts',
    specifier: 'server-only',
    reason:
      "A Next.js marker that Next's bundler aliases to its own compiled copy; it is never " +
      'npm-resolved, and the packed deploy rehearsal builds without it installed.',
  },
  {
    packageName: '@defrex/autobuild',
    path: 'packages/core/src/ports/runner/pi-bridge.js',
    specifier: '@earendil-works/pi-coding-agent',
    reason:
      'A pi extension that pi-rpc.ts passes via --extension; the pi CLI loads it and resolves ' +
      'the import from its own install.',
  },
]

/** Shared libraries a published package must keep declaring, so removing the
 * declaration fails by name rather than only through the import scan. */
export const REQUIRED_SHARED_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
  '@defrex/autobuild-hosted-store-service': ['zod'],
}

/** The package a bare specifier names: `@scope/name` for scoped specifiers,
 * the first path segment otherwise. */
export function packageNameOfSpecifier(specifier: string): string {
  const segments = specifier.split('/')
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]!
}

/** False for relative (`./`, `../`, `.`, `..`), absolute, `#` subpath-import
 * and any `scheme:` specifier; true for a package name, optionally with a
 * subpath. */
export function isBareSpecifier(specifier: string): boolean {
  if (specifier === '' || specifier === '.' || specifier === '..') return false
  if (specifier.startsWith('./') || specifier.startsWith('../')) return false
  if (specifier.startsWith('/') || specifier.startsWith('#')) return false
  return !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier)
}

/** Node builtins (with or without `node:`) and Bun builtins (`bun`, `bun:*`). */
export function isBuiltinSpecifier(specifier: string): boolean {
  return (
    specifier === 'bun' ||
    specifier.startsWith('bun:') ||
    specifier.startsWith('node:') ||
    isBuiltin(specifier)
  )
}

/** The union of names a manifest declares for consumers to install. */
export function declaredNames(manifest: Record<string, unknown>): Set<string> {
  const names = new Set<string>()
  for (const section of DECLARING_SECTIONS) {
    const value = manifest[section]
    if (typeof value === 'object' && value !== null) {
      for (const name of Object.keys(value)) names.add(name)
    }
  }
  return names
}

function declaredRanges(manifest: Record<string, unknown>): Map<string, unknown> {
  const ranges = new Map<string, unknown>()
  for (const section of DECLARING_SECTIONS) {
    const value = manifest[section]
    if (typeof value === 'object' && value !== null) {
      for (const [name, range] of Object.entries(value)) {
        if (!ranges.has(name)) ranges.set(name, range)
      }
    }
  }
  return ranges
}

export type PublishDependenciesViolation =
  | { kind: 'pack'; packageName: string; directory: string; detail: string }
  | { kind: 'unparseable-file'; packageName: string; path: string }
  | {
      kind: 'undeclared-import'
      packageName: string
      path: string
      line: number
      specifier: string
      dependency: string
    }
  | { kind: 'stale-allowance'; allowance: ReviewedAllowance }
  | {
      kind: 'shared-range-drift'
      packageName: string
      dependency: string
      range: string
      rootRange: string
    }
  | {
      kind: 'invalid-range'
      packageName: string
      dependency: string
      range: string
    }
  | {
      kind: 'missing-shared-declaration'
      packageName: string
      dependency: string
      rootRange: string | undefined
    }

export interface PublishDependenciesCheckEnvironment {
  /** Absolute path of the repository root. */
  repoRoot: string
  /** The pack seam: `bun pm pack --ignore-scripts --dry-run` at a package directory. */
  pack: PackRunner
  /** Reads a packed file from the repository tree (absolute path). */
  readFile: (absolutePath: string) => Promise<string>
}

export interface PublishDependenciesReport {
  violations: PublishDependenciesViolation[]
  packedPackages: number
  scannedFiles: number
  /** Bare, non-builtin specifiers checked against a manifest. */
  checkedSpecifiers: number
  allowancesUsed: number
}

function packRequest(env: PublishDependenciesCheckEnvironment, directory: string): PackRequest {
  return {
    command: 'bun',
    args: ['pm', 'pack', '--ignore-scripts', '--dry-run'],
    cwd: join(env.repoRoot, directory),
  }
}

function sharedDependencyViolations(
  packageName: string,
  manifest: Record<string, unknown>,
  rootDependencies: Record<string, unknown>,
): PublishDependenciesViolation[] {
  const violations: PublishDependenciesViolation[] = []
  const ranges = declaredRanges(manifest)
  for (const dependency of REQUIRED_SHARED_DEPENDENCIES[packageName] ?? []) {
    const rootRange = rootDependencies[dependency]
    if (!ranges.has(dependency) || typeof rootRange !== 'string') {
      violations.push({
        kind: 'missing-shared-declaration',
        packageName,
        dependency,
        rootRange: typeof rootRange === 'string' ? rootRange : undefined,
      })
    }
  }
  for (const [dependency, range] of ranges) {
    const rootRange = rootDependencies[dependency]
    if (rootRange === undefined) continue
    if (typeof rootRange !== 'string' || validRange(rootRange) === null) {
      violations.push({
        kind: 'invalid-range',
        packageName: ROOT_PACKAGE,
        dependency,
        range: String(rootRange),
      })
      continue
    }
    if (typeof range !== 'string' || validRange(range) === null) {
      violations.push({ kind: 'invalid-range', packageName, dependency, range: String(range) })
      continue
    }
    if (!subset(rootRange, range)) {
      violations.push({ kind: 'shared-range-drift', packageName, dependency, range, rootRange })
    }
  }
  return violations
}

/**
 * Packs every publishable package, scans its packed script files for bare
 * specifiers its manifest does not declare, and checks shared-dependency
 * ranges against the root package. Enumeration failures throw; every other
 * finding is a violation.
 */
export async function scanPublishedDependencies(
  env: PublishDependenciesCheckEnvironment,
): Promise<PublishDependenciesReport> {
  const manifests = await readWorkspaceManifests(env.repoRoot)
  const packages = publishablePackages(manifests)
  const manifestOf = (manifestPath: string): Record<string, unknown> => {
    const entry = manifests.find((candidate) => candidate.path === manifestPath)
    if (entry === undefined)
      throw new Error(`${manifestPath} vanished from the workspace manifests`)
    return JSON.parse(entry.text) as Record<string, unknown>
  }
  const roots = packages.filter((pkg) => pkg.name === ROOT_PACKAGE)
  if (roots.length !== 1) {
    throw new Error(
      `expected exactly one ${ROOT_PACKAGE} package in the publish set, found ${roots.length}`,
    )
  }
  const rootDependencies = (manifestOf(roots[0]!.manifestPath).dependencies ?? {}) as Record<
    string,
    unknown
  >

  const violations: PublishDependenciesViolation[] = []
  const usedAllowances = new Set<ReviewedAllowance>()
  let scannedFiles = 0
  let checkedSpecifiers = 0
  for (const pkg of packages) {
    const manifest = manifestOf(pkg.manifestPath)
    if (pkg.name !== ROOT_PACKAGE) {
      violations.push(...sharedDependencyViolations(pkg.name, manifest, rootDependencies))
    }

    let result: PackResult
    try {
      result = await env.pack(packRequest(env, pkg.directory))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      violations.push({ kind: 'pack', packageName: pkg.name, directory: pkg.directory, detail })
      continue
    }
    if (result.exitCode !== 0) {
      const detail =
        result.stderr.trim() || result.stdout.trim() || `exit status ${result.exitCode}`
      violations.push({ kind: 'pack', packageName: pkg.name, directory: pkg.directory, detail })
      continue
    }
    const packedPaths = parsePackedPaths(result.stdout)
    // The packer always packs package.json; its absence means the listing
    // failed to parse and nothing here can be trusted.
    if (!packedPaths.includes('package.json')) {
      violations.push({
        kind: 'pack',
        packageName: pkg.name,
        directory: pkg.directory,
        detail: 'the pack listing has no package.json entry; the listing could not be parsed',
      })
      continue
    }

    const declared = declaredNames(manifest)
    for (const path of packedPaths) {
      const scriptKind = packedScriptKind(path)
      if (scriptKind === undefined) continue
      scannedFiles++
      const contents = await env.readFile(join(env.repoRoot, pkg.directory, path))
      for (const { specifier, line } of collectSpecifiers(contents, scriptKind)) {
        if (specifier === UNPARSEABLE_MODULE) {
          violations.push({ kind: 'unparseable-file', packageName: pkg.name, path })
          continue
        }
        if (isBuiltinSpecifier(specifier) || !isBareSpecifier(specifier)) continue
        checkedSpecifiers++
        const dependency = packageNameOfSpecifier(specifier)
        if (dependency === pkg.name || declared.has(dependency)) continue
        const allowance = REVIEWED_ALLOWANCES.find(
          (candidate) =>
            candidate.packageName === pkg.name &&
            candidate.path === path &&
            candidate.specifier === specifier,
        )
        if (allowance !== undefined) {
          usedAllowances.add(allowance)
          continue
        }
        violations.push({
          kind: 'undeclared-import',
          packageName: pkg.name,
          path,
          line,
          specifier,
          dependency,
        })
      }
    }
  }

  // A pack failure leaves that package's files unscanned, so its allowances
  // cannot be judged stale.
  const unpacked = new Set(
    violations.flatMap((violation) => (violation.kind === 'pack' ? [violation.packageName] : [])),
  )
  for (const allowance of REVIEWED_ALLOWANCES) {
    if (!usedAllowances.has(allowance) && !unpacked.has(allowance.packageName)) {
      violations.push({ kind: 'stale-allowance', allowance })
    }
  }

  return {
    violations,
    packedPackages: packages.length - unpacked.size,
    scannedFiles,
    checkedSpecifiers,
    allowancesUsed: usedAllowances.size,
  }
}

export function describeViolation(violation: PublishDependenciesViolation): string {
  switch (violation.kind) {
    case 'pack':
      return `${violation.packageName}: bun pm pack failed in ${violation.directory}: ${violation.detail}`
    case 'unparseable-file':
      return `${violation.packageName}: ${violation.path}: the packed file does not parse, so its imports cannot be checked`
    case 'undeclared-import':
      return (
        `${violation.packageName}: ${violation.path}:${violation.line}: '${violation.specifier}' ` +
        `imports ${violation.dependency}, which the packed manifest does not declare in ` +
        `dependencies, peerDependencies or optionalDependencies`
      )
    case 'stale-allowance':
      return (
        `${violation.allowance.packageName}: ${violation.allowance.path}: the reviewed allowance ` +
        `for '${violation.allowance.specifier}' matches no undeclared import; delete it`
      )
    case 'shared-range-drift':
      return (
        `${violation.packageName}: declares ${violation.dependency} '${violation.range}', which ` +
        `does not admit ${ROOT_PACKAGE}'s '${violation.rootRange}'; declare a range that admits ` +
        `${ROOT_PACKAGE}'s ${violation.rootRange}`
      )
    case 'invalid-range':
      return `${violation.packageName}: ${violation.dependency} '${violation.range}' is not a valid semver range`
    case 'missing-shared-declaration':
      return violation.rootRange === undefined
        ? `${ROOT_PACKAGE}: does not declare ${violation.dependency}, which published packages must share with it`
        : `${violation.packageName}: must declare ${violation.dependency}; declare a range that ` +
            `admits ${ROOT_PACKAGE}'s ${violation.rootRange}`
  }
}

export interface PublishDependenciesCheckOutput {
  stdout(message: string): void
  stderr(message: string): void
}

/** Runs the guard. Every failure mode, including a thrown enumeration,
 * reports nonzero. */
export async function runPublishDependenciesCheck(
  env: PublishDependenciesCheckEnvironment,
  output: PublishDependenciesCheckOutput = {
    stdout: (message) => process.stdout.write(message),
    stderr: (message) => process.stderr.write(message),
  },
): Promise<number> {
  let report: PublishDependenciesReport
  try {
    report = await scanPublishedDependencies(env)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    output.stderr(`Could not check published dependency declarations: ${message}\n`)
    return 1
  }

  if (report.violations.length === 0) {
    output.stdout(
      `Published-dependencies check: ${report.packedPackages} publishable packages packed, ` +
        `${report.scannedFiles} files scanned, ${report.checkedSpecifiers} bare specifiers ` +
        `checked, ${report.allowancesUsed} reviewed allowances used.\n`,
    )
    return 0
  }

  for (const violation of report.violations) {
    output.stdout(`${describeViolation(violation)}\n`)
  }
  output.stderr(
    `${report.violations.length} published-dependencies violation(s); a consumer install would ` +
      `not resolve what the packed source imports.\n` +
      `Recovery: declare the package in dependencies, peerDependencies or optionalDependencies ` +
      `with a range that admits ${ROOT_PACKAGE}'s where both declare it, or add a reviewed ` +
      `allowance in tools/publish-dependencies-check.ts naming the package, file and specifier.\n`,
  )
  return 1
}

export const realEnvironment: PublishDependenciesCheckEnvironment = {
  repoRoot,
  pack: spawnPack,
  readFile: (path) => readFile(path, 'utf8'),
}

if (import.meta.main) {
  process.exitCode = await runPublishDependenciesCheck(realEnvironment)
}
