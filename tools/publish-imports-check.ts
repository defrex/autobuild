import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import ts from 'typescript'
import { repoRoot } from './git-tracked'
import {
  type PackRequest,
  type PackResult,
  type PackRunner,
  parsePackedPaths,
  spawnPack,
} from './publish-contents-check'
import { publishablePackages } from './release'
import { readWorkspaceManifests } from './workspace-manifest-check'
import { collectSpecifiers, UNPARSEABLE_MODULE } from './package-boundary-check'

/**
 * Fails when a `@defrex/autobuild/*` specifier imported by a published
 * package's packed files is not exported by the packed `@defrex/autobuild`
 * manifest, or when any exports entry of either side does not resolve inside
 * its own packed contents. This is the scratch-dir npm-install smoke (the one
 * that surfaced AUT-463's 6-of-8 export-import failure) in hermetic form: the
 * real packed byte sets, staged into a scratch `node_modules` layout, probed
 * with real module resolution — no network, no registry, no tarball.
 *
 * Ruling (AUT-476): the 0.8.0 skew is a release-tree skew, not a packaging
 * bug — see `RULING` below. The chosen arm is that the next `@defrex/autobuild`
 * publish (≥ 0.9.0) ships the workspace exports map, which already contains
 * `./operator`, `./hosted-tickets`, and `./testing`; no import is rewritten.
 * This check is the recurrence guard: it runs in the repository `check` gate
 * (every PR and the release quality gates), so a published package whose
 * packed files import a `@defrex/autobuild` subpath the packed provider does
 * not export fails before release, not in a consumer's `node_modules`.
 *
 * Mechanics, in order:
 *
 * 1. The publish set is enumerated with the release's own code:
 *    `readWorkspaceManifests` → `publishablePackages`. Whatever release would
 *    publish, the guard checks — no hand-maintained package list.
 * 2. Each publishable package is packed with `bun pm pack --ignore-scripts
 *    --dry-run` (the same packer `bun publish` runs; `--ignore-scripts`
 *    matches release's `PUBLISH_ARGS` and keeps the root `prepare` script from
 *    running `husky`, which is not on PATH in every sandbox) and the listing
 *    is parsed with `parsePackedPaths` from publish-contents-check.ts. The
 *    packed listing is the exact path set `bun publish` ships.
 * 3. Every packed file of every publishable package is staged into a scratch
 *    `<tmp>/<scratch>/node_modules/<name>/<packed path>` layout (extraction of
 *    a tarball is exactly files at their packed relative paths), read from the
 *    repository tree. The scratch root is removed in a `finally`.
 * 4. Every packed file of every dependent (every publishable package except
 *    the provider) whose suffix maps to a script kind — `.ts`, `.tsx`, `.mts`,
 *    `.cts` (including their `.d.ts`/`.d.mts`/`.d.cts` declaration variants),
 *    `.js`, `.mjs`, `.cjs`, and `.jsx`; matching is case-sensitive, and every
 *    other suffix (`.json`, `.md`, `.map`, …) is skipped — is scanned with
 *    `collectSpecifiers` from package-boundary-check.ts — the same
 *    parser-based, comment-safe, fail-closed scanner the test-boundary gate
 *    uses. A packed file that does not parse as its own kind is an
 *    `unparseable-file` violation, never a silent skip — for example, an HTML
 *    comment or a legacy octal literal in a packed `.js` file (Error TS1109
 *    /TS1005 and TS1121 respectively under typescript@5.9.3). The boundary is
 *    the opposite for JSX-shaped text: TypeScript's JS parser accepts
 *    JSX-shaped expressions (as type assertions/comparisons) with no
 *    Error-category diagnostic, and `require()`/`import()` specifiers inside
 *    JSX children/attributes are still collected, so JSX-shaped content in a
 *    packed `.js` file is scanned, not failed. Specifiers are filtered to
 *    exact `@defrex/autobuild` or
 *    `@defrex/autobuild/<sub>` (never `@defrex/autobuild-hosted-store-service/…`
 *    or `@defrex/autobuild-postgres-store/…`).
 * 5. Each collected specifier passes a static assertion first — it must be an
 *    exact key of the provider manifest's `exports` map (`.` for the bare
 *    name, `./<sub>` otherwise). That assertion is a fast pre-filter with a
 *    precise message, not the authority: if the root exports map ever gains
 *    wildcard patterns (`./feature/*`), exact-key matching would under-match,
 *    so the resolution probe below is the authoritative check and the static
 *    assertion only shapes the error message.
 * 6. Probes (all through the `resolveModule` seam): every scanned specifier
 *    from its own importing file's staged path; every exports-map target of
 *    every publishable package from its staged package root. A missing subpath
 *    or a target absent from the packed listing throws the runtime's
 *    npm-style resolution error — the exact failure an npm consumer hits.
 *
 * Scanning the provider's own packed files is deliberately out of scope: the
 * provider cannot be skewed against itself, and its `bin`/`skills`/`templates`
 * trees are workspace-internal surface, not the coupling this ruling pins.
 * Cross-package specifiers between the dependents themselves (for example
 * `@defrex/autobuild-hosted-store-service/…` imported by the dispatcher) are
 * a different coupling with its own guards; only the shared provider is
 * checked here.
 */

export const PROVIDER_PACKAGE = '@defrex/autobuild'

const RULING =
  'Ruling (AUT-476): @defrex/autobuild@0.8.0 published 2026-09-16T16:26:03.781Z and ' +
  '@defrex/autobuild-hosted-store-service@0.8.0 published 2026-09-16T16:26:07.260Z — the ' +
  'same release run, ~3.5 s apart, autobuild first (the publishablePackages order), both cut ' +
  'from the v0.8.0 release commit (9effa49). The published 0.8.0 pair is self-consistent; the ' +
  'skew is the development tree (renamed subpaths ./operator, ./hosted-tickets, ./testing) ' +
  'versus the published 0.8.0, which lacks them. The chosen arm: the next @defrex/autobuild ' +
  'publish (>= 0.9.0) ships the workspace exports map, which already exports those subpaths, ' +
  'the service and dispatcher declare optional peerDependency @defrex/autobuild >= 0.9.0, and ' +
  'no import is rewritten anywhere. This check pins the coupling where releases are cut: a ' +
  'published package may import only @defrex/autobuild subpaths the packed provider exports.'

/** The script kind a packed file's suffix scans as, or `undefined` when the
 * file is not scanned at all. The scanned set is the TypeScript family
 * (`.ts`, `.tsx`, `.mts`, `.cts` — the declaration variants `.d.ts`/`.d.mts`/
 * `.d.cts` are covered by their suffixes) plus the JavaScript family
 * (`.js`, `.mjs`, `.cjs`) and JSX JavaScript (`.jsx`, symmetric with the
 * already-scanned `.tsx`). Matching is case-sensitive, like the `\.tsx?$`
 * filter this mapping replaced, so `.JS` or `.TS` is not scanned. The kinds
 * follow TypeScript's own `getScriptKindFromFileName`. Before this mapping,
 * only `\.tsx?$` files were scanned, so a packed dependent shipping a `.js`/
 * `.mjs`/`.cjs`/`.jsx` — or even a `.mts`/`.cts` — file importing a provider
 * subpath was silently skipped (AUT-479).
 */
export function packedScriptKind(path: string): ts.ScriptKind | undefined {
  if (path.endsWith('.ts') || path.endsWith('.mts') || path.endsWith('.cts')) {
    return ts.ScriptKind.TS
  }
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')) {
    return ts.ScriptKind.JS
  }
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX
  return undefined
}

/** True for exactly `@defrex/autobuild` and `@defrex/autobuild/<sub>` — never
 * for `@defrex/autobuild-hosted-store-service/…` or the other sibling names. */
export function isProviderSpecifier(specifier: string): boolean {
  return specifier === PROVIDER_PACKAGE || specifier.startsWith(`${PROVIDER_PACKAGE}/`)
}

/** The exports-map key a provider specifier needs: `.` for the bare name,
 * `./<sub>` for a subpath import. */
export function subpathOfProviderSpecifier(specifier: string): string {
  return specifier === PROVIDER_PACKAGE ? '.' : `./${specifier.slice(PROVIDER_PACKAGE.length + 1)}`
}

/** Every string target an exports-map value tree yields: a bare string entry,
 * or the string leaves of a conditions object (`types`/`import`/`default`/…).
 * Null leaves (`default: null`, "block an export") yield nothing. */
export function exportsTargets(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (typeof value !== 'object' || value === null) return []
  return Object.values(value).flatMap((entry) => exportsTargets(entry))
}

/** The exports map of a parsed manifest as subpath key → target strings.
 * A manifest without `exports` yields an empty map, which fails every
 * specifier against it — the fail-closed direction for this guard. */
export function exportsSubpaths(manifest: unknown): Map<string, string[]> {
  const exports = (manifest as { exports?: unknown } | undefined)?.exports
  const map = new Map<string, string[]>()
  if (typeof exports === 'object' && exports !== null) {
    for (const [key, value] of Object.entries(exports as Record<string, unknown>)) {
      map.set(key, exportsTargets(value))
    }
  }
  return map
}

export type PublishImportsViolation =
  | { kind: 'pack'; directory: string; detail: string }
  | { kind: 'unparseable-file'; packageName: string; path: string }
  | {
      kind: 'missing-export'
      packageName: string
      specifier: string
      subpath: string
      path: string
      line: number
    }
  | {
      kind: 'unresolved-import'
      packageName: string
      specifier: string
      path: string
      line: number
      reason: string
    }
  | { kind: 'unresolved-exports-target'; packageName: string; target: string; reason: string }

export interface PublishImportsCheckEnvironment {
  /** Absolute path of the repository root. */
  repoRoot: string
  /** The pack seam: `bun pm pack --ignore-scripts --dry-run` at a package directory. */
  pack: PackRunner
  /** Reads a packed file from the repository tree (absolute path). */
  readFile: (absolutePath: string) => Promise<Uint8Array>
  /** Stages one packed file: copies `sourceAbsolutePath` to `destinationAbsolutePath`,
   * creating parent directories. Tarball extraction is exactly this. */
  stage: (sourceAbsolutePath: string, destinationAbsolutePath: string) => Promise<void>
  /** The resolution probe; default `Bun.resolveSync`, which throws the
   * runtime's npm-style error on failure. Tests may inject a fake. */
  resolveModule: (specifier: string, fromPath: string) => string
  /** Creates a fresh scratch root for the staged `node_modules` layout. */
  createScratchRoot: () => Promise<string>
  /** Removes the scratch root (called from a `finally`; must not throw past cleanup). */
  removeScratchRoot: (root: string) => Promise<void>
}

export interface PublishImportsReport {
  violations: PublishImportsViolation[]
  /** Publishable packages whose packed listings were checked. */
  packedPackages: number
  /** Packed dependent files scanned for provider specifiers — those whose
   * suffix `packedScriptKind` maps to a script kind (the TS family, the JS
   * family, and `.jsx`). */
  scannedFiles: number
  /** Specifiers that passed the static assertion and were resolution-probed. */
  probedSpecifiers: number
}

/** A publishable package whose packed listing was parsed, with its manifest
 * path for exports-map lookup. */
interface PackedPackage {
  name: string
  directory: string
  manifestPath: string
  packedPaths: readonly string[]
}

function packRequest(env: PublishImportsCheckEnvironment, directory: string): PackRequest {
  return {
    command: 'bun',
    args: ['pm', 'pack', '--ignore-scripts', '--dry-run'],
    cwd: join(env.repoRoot, directory),
  }
}

/**
 * Packs every publishable package, stages the packed layouts, scans the
 * dependents' packed script files (the `packedScriptKind` set) for provider
 * specifiers, and probes
 * resolution. Structural failures (manifest enumeration, a missing or
 * ambiguous provider, a failed provider pack) throw; per-package pack failures
 * and every specifier/target finding are collected as violations — the caller
 * decides the exit code, and any violation fails it. The scratch layout is
 * always removed.
 */
export async function scanPublishedImports(
  env: PublishImportsCheckEnvironment,
): Promise<PublishImportsReport> {
  const manifests = await readWorkspaceManifests(env.repoRoot)
  const packages = publishablePackages(manifests)
  const providers = packages.filter((pkg) => pkg.name === PROVIDER_PACKAGE)
  if (providers.length !== 1) {
    throw new Error(
      `expected exactly one ${PROVIDER_PACKAGE} package in the publish set, found ${providers.length}`,
    )
  }

  const packed: PackedPackage[] = []
  const violations: PublishImportsViolation[] = []
  for (const pkg of packages) {
    let result: PackResult
    try {
      result = await env.pack(packRequest(env, pkg.directory))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (pkg.name === PROVIDER_PACKAGE)
        throw new Error(`packing ${PROVIDER_PACKAGE} failed: ${detail}`)
      violations.push({ kind: 'pack', directory: pkg.directory, detail })
      continue
    }
    if (result.exitCode !== 0) {
      const detail =
        result.stderr.trim() || result.stdout.trim() || `exit status ${result.exitCode}`
      if (pkg.name === PROVIDER_PACKAGE) {
        throw new Error(
          `${packRequest(env, pkg.directory).args.join(' ')} failed in ${pkg.directory}: ${detail}`,
        )
      }
      violations.push({ kind: 'pack', directory: pkg.directory, detail })
      continue
    }
    const packedPaths = parsePackedPaths(result.stdout)
    // The packer always packs package.json; its absence means the listing
    // failed to parse (format drift) and nothing here can be trusted.
    if (!packedPaths.includes('package.json')) {
      const detail = 'the pack listing has no package.json entry; the listing could not be parsed'
      if (pkg.name === PROVIDER_PACKAGE) throw new Error(`${PROVIDER_PACKAGE}: ${detail}`)
      violations.push({ kind: 'pack', directory: pkg.directory, detail })
      continue
    }
    packed.push({
      name: pkg.name,
      directory: pkg.directory,
      manifestPath: pkg.manifestPath,
      packedPaths,
    })
  }
  const stagedProvider = packed.find((entry) => entry.name === PROVIDER_PACKAGE)
  if (stagedProvider === undefined) {
    throw new Error(`${PROVIDER_PACKAGE} could not be packed; the provider layout cannot be staged`)
  }

  const manifestTextOf = (entry: PackedPackage): unknown => {
    const manifest = manifests.find((candidate) => candidate.path === entry.manifestPath)
    if (manifest === undefined) {
      throw new Error(`${entry.manifestPath} vanished from the workspace manifests mid-check`)
    }
    return JSON.parse(manifest.text)
  }
  const providerExports = exportsSubpaths(manifestTextOf(stagedProvider))

  const scratchRoot = await env.createScratchRoot()
  const stagedPathOf = (name: string, relativePath: string): string =>
    join(scratchRoot, 'node_modules', name, relativePath)
  try {
    for (const entry of packed) {
      for (const relativePath of entry.packedPaths) {
        await env.stage(
          join(env.repoRoot, entry.directory, relativePath),
          stagedPathOf(entry.name, relativePath),
        )
      }
    }

    // Provider integrity: every exports target must resolve inside the staged
    // provider tarball, not merely inside the worktree. A real manifest's
    // conditions object repeats one target across types/import/default, so an
    // identical (package, target) finding is reported once.
    const reportedTargets = new Set<string>()
    const probeExportsTargets = (packageName: string, exports: Map<string, string[]>): void => {
      for (const [subpath, targets] of exports) {
        for (const target of targets) {
          const identity = `${packageName}|${subpath} → ${target}`
          if (reportedTargets.has(identity)) continue
          try {
            env.resolveModule(target, stagedPathOf(packageName, ''))
            reportedTargets.add(identity)
          } catch (error) {
            reportedTargets.add(identity)
            violations.push({
              kind: 'unresolved-exports-target',
              packageName,
              target: `${subpath} → ${target}`,
              reason: error instanceof Error ? error.message : String(error),
            })
          }
        }
      }
    }
    probeExportsTargets(PROVIDER_PACKAGE, providerExports)

    let scannedFiles = 0
    let probedSpecifiers = 0
    for (const entry of packed) {
      // Each publishable package's own exports targets must resolve inside its
      // own staged tarball (the provider's were probed above).
      if (entry.name !== PROVIDER_PACKAGE) {
        probeExportsTargets(entry.name, exportsSubpaths(manifestTextOf(entry)))
      }

      if (entry.name === PROVIDER_PACKAGE) continue // the provider cannot be skewed against itself
      for (const relativePath of entry.packedPaths) {
        const scriptKind = packedScriptKind(relativePath)
        if (scriptKind === undefined) continue
        const bytes = await env.readFile(join(env.repoRoot, entry.directory, relativePath))
        const contents = new TextDecoder().decode(bytes)
        const collected = collectSpecifiers(contents, scriptKind)
        scannedFiles += 1
        const stagedFile = stagedPathOf(entry.name, relativePath)
        const path = `${entry.directory}/${relativePath}`
        for (const { specifier, line } of collected) {
          if (specifier === UNPARSEABLE_MODULE) {
            violations.push({ kind: 'unparseable-file', packageName: entry.name, path })
            continue
          }
          if (!isProviderSpecifier(specifier)) continue
          const subpath = subpathOfProviderSpecifier(specifier)
          // Fast pre-filter with the precise message; the resolution probe is
          // the authority (see the header's wildcard caveat).
          if (!providerExports.has(subpath)) {
            violations.push({
              kind: 'missing-export',
              packageName: entry.name,
              specifier,
              subpath,
              path,
              line,
            })
            continue
          }
          probedSpecifiers += 1
          try {
            env.resolveModule(specifier, stagedFile)
          } catch (error) {
            violations.push({
              kind: 'unresolved-import',
              packageName: entry.name,
              specifier,
              path,
              line,
              reason: error instanceof Error ? error.message : String(error),
            })
          }
        }
      }
    }
    return { violations, packedPackages: packed.length, scannedFiles, probedSpecifiers }
  } finally {
    await env.removeScratchRoot(scratchRoot)
  }
}

function describeViolation(violation: PublishImportsViolation): string {
  switch (violation.kind) {
    case 'pack':
      return `${violation.directory}: could not pack the tarball to check its imports: ${violation.detail}`
    case 'unparseable-file':
      return `${violation.packageName}: ${violation.path}: the file does not parse, so its imports could not be scanned; fix the file before publishing`
    case 'missing-export':
      return (
        `${violation.path}:${violation.line}: '${violation.specifier}' is not exported by the packed ` +
        `${PROVIDER_PACKAGE} (exports key '${violation.subpath}' is absent from its exports map); ` +
        `an npm consumer installing the tarball cannot resolve it`
      )
    case 'unresolved-import':
      return (
        `${violation.path}:${violation.line}: '${violation.specifier}' did not resolve from the staged ` +
        `packed layout: ${violation.reason}`
      )
    case 'unresolved-exports-target':
      return (
        `${violation.packageName}: exports target '${violation.target}' is not present in the package's ` +
        `packed files: ${violation.reason}`
      )
  }
}

export interface PublishImportsCheckOutput {
  stdout(message: string): void
  stderr(message: string): void
}

/**
 * Runs the published-imports guard. Every failure mode — a thrown enumeration,
 * a failed pack, a missing subpath, an unresolved target — reports nonzero;
 * the check never reports success on ambiguity.
 */
export async function runPublishImportsCheck(
  env: PublishImportsCheckEnvironment,
  output: PublishImportsCheckOutput = {
    stdout: (message) => process.stdout.write(message),
    stderr: (message) => process.stderr.write(message),
  },
): Promise<number> {
  let report: PublishImportsReport
  try {
    report = await scanPublishedImports(env)
  } catch (error) {
    // A check that cannot enumerate or pack must never report success.
    const message = error instanceof Error ? error.message : String(error)
    output.stderr(
      `Could not check published imports against the packed ${PROVIDER_PACKAGE} tarball: ${message}\n`,
    )
    return 1
  }

  if (report.violations.length === 0) {
    output.stdout(
      `Published-imports check: ${report.packedPackages} publishable packages packed, ` +
        `${report.scannedFiles} dependent files scanned, ` +
        `${report.probedSpecifiers} ${PROVIDER_PACKAGE} specifiers resolved against the staged tarball layout.`,
    )
    return 0
  }

  output.stdout(`${RULING}\n`)
  for (const violation of report.violations) {
    output.stdout(`${describeViolation(violation)}\n`)
  }
  output.stderr(
    `${report.violations.length} published-imports violation(s); a published package imports a ` +
      `${PROVIDER_PACKAGE} surface the packed provider does not ship.\n` +
      `Recovery: export the missing subpath from the root package.json exports map (the next ` +
      `${PROVIDER_PACKAGE} publish ships it), or move the import back inside the published surface.\n`,
  )
  return 1
}

export const realEnvironment: PublishImportsCheckEnvironment = {
  repoRoot,
  pack: spawnPack,
  readFile: (path) => readFile(path),
  stage: async (source, destination) => {
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(source, destination)
  },
  resolveModule: (specifier, fromPath) => Bun.resolveSync(specifier, fromPath),
  createScratchRoot: () => mkdtemp(join(tmpdir(), 'publish-imports-check-')),
  removeScratchRoot: (root) => rm(root, { recursive: true, force: true }),
}

if (import.meta.main) {
  process.exitCode = await runPublishImportsCheck(realEnvironment)
}
