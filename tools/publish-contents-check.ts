import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { repoRoot } from './git-tracked'

/**
 * Fails when `bun pm pack --dry-run` would pack anything outside a ruled
 * package's allowlist, or when a ruled package's manifest fails to pin the
 * ruling itself. Two rulings are enforced (see `ruledPackages`):
 *
 * - AUT-463 — `@defrex/autobuild-hosted-store-service` ships exactly
 *   `package.json`, `README.md`, and `src/**`. The ruling exists because
 *   AUT-409's move of the operator web app into the service package silently
 *   added `app/`, `server.ts`, `next.config.ts`, `vercel.json`,
 *   `tsconfig.json`, `next-env.d.ts`, and the internal
 *   `.impeccable/surfaces/` design brief to the published npm tarball: the
 *   manifest declared no `files` field, so npm's default
 *   (everything-not-ignored) packed the whole package directory. Every npm
 *   consumption path goes through the manifest's `exports` map and `bin`, all
 *   of which live under `src/`; the app and config files are
 *   release-checkout/Vercel surface read from the repository at deploy time,
 *   never from node_modules, and the Impeccable surface brief is internal.
 *   The allowlist is the durable fix: deny-by-default, so a file added to the
 *   package later stays out of the tarball unless deliberately allowlisted —
 *   the exact failure mode the move created.
 * - AUT-473 — `@defrex/autobuild-postgres-store` declares the same shape
 *   (`files: ["src", "README.md"]`) so its tarball ships exactly
 *   `package.json`, `README.md`, and `src/**` by manifest rather than by
 *   directory layout. Its directory today carries only `src/`, so the tarball
 *   was correct by accident of layout; deny-by-default keeps a future
 *   top-level addition (a scratch script, a live-test fixture, a dotenv file,
 *   an editor artifact) out of the tarball unless the allowlist and this
 *   check are updated together.
 *
 * Both rulings are enforced at the manifest level, not only against today's
 * listing: a ruled package must declare a non-empty `files` array (the
 * publishable surface is pinned by manifest, not by whatever happens to sit
 * in the package directory), and every `exports`/`bin` target in the manifest
 * must appear in the packed listing (the packed artifact must resolve
 * everything the manifest promises).
 *
 * Implementation notes:
 *
 * - The check packs through bun's own packer (`bun pm pack --dry-run`), the
 *   same packing implementation `bun publish` (which `tools/release.ts` uses)
 *   runs, so it asserts what would actually ship. `--dry-run` writes no tgz.
 * - The parser keys on bun 1.4.0's `packed <size> <path>` listing lines (the
 *   version `autobuild.toml` and the workspace engines pin). The tgz-name
 *   line and the `Total files:`/`Unpacked size:` trailer are ignored. A
 *   listing with no parseable packed lines is a failure, never a pass, so a
 *   format drift fails loudly here instead of silently retiring the
 *   invariant.
 * - `README.md` and `package.json` are always included by the packer
 *   regardless of the allowlist; requiring them in the listing means a
 *   listing that failed to parse or truncate cannot masquerade as a pass.
 * - The required `src/` presence is a presence check, not an exact-file
 *   check: the src tree evolves, and `package-boundary-check` plus the
 *   manifests' exports are the tripwires for what it may depend on. The
 *   rulings this check enforces are the *boundaries* (nothing outside
 *   `src/` + the two manifest-mandated files), not frozen file lists.
 * - Every ruled package is checked all the way through: one failing package
 *   never hides another's violations.
 */

/** A package whose npm tarball contents are ruled, and what the ruling requires. */
export interface TarballRuling {
  /** The package's npm name, used to label every message about it. */
  readonly name: string
  /** The package's directory, repo-root-relative. */
  readonly directory: string
  /** Paths the ruling requires in every tarball (`README.md` and `package.json` are always packed). */
  readonly requiredPackedPaths: readonly string[]
  /** Everything under this prefix is allowed; nothing else is. */
  readonly requiredPackedPrefix: string
  /** The ruling text, printed above the violations so the rationale ships with the failure. */
  readonly ruling: string
}

const HOSTED_STORE_SERVICE_RULING =
  'Ruling (AUT-463): the @defrex/autobuild-hosted-store-service npm tarball ships exactly ' +
  'package.json, README.md, and src/**. The Next.js app/ tree, server.ts, next.config.ts, ' +
  'vercel.json, tsconfig.json, next-env.d.ts, and the internal .impeccable/ surface brief are ' +
  'release-checkout/Vercel surface and must not publish. If the ruling changes, update the ' +
  "'files' allowlist in packages/hosted-store-service/package.json and this check together."

const POSTGRES_STORE_RULING =
  'Ruling (AUT-473): the @defrex/autobuild-postgres-store npm tarball ships exactly ' +
  'package.json, README.md, and src/**. The allowlist pins the publishable surface by manifest ' +
  'rather than by directory layout: a future top-level file in packages/postgres-store (a ' +
  'scratch script, a live-test fixture, a dotenv file, an editor artifact) must not ride into ' +
  'the tarball. If the ruling changes, update the ' +
  "'files' allowlist in packages/postgres-store/package.json and this check together."

/** The packages whose tarball contents are ruled; widening is a separate ruling. */
export const ruledPackages: readonly TarballRuling[] = [
  {
    name: '@defrex/autobuild-hosted-store-service',
    directory: 'packages/hosted-store-service',
    requiredPackedPaths: ['package.json', 'README.md'],
    requiredPackedPrefix: 'src/',
    ruling: HOSTED_STORE_SERVICE_RULING,
  },
  {
    name: '@defrex/autobuild-postgres-store',
    directory: 'packages/postgres-store',
    requiredPackedPaths: ['package.json', 'README.md'],
    requiredPackedPrefix: 'src/',
    ruling: POSTGRES_STORE_RULING,
  },
]

/** A command to run on behalf of the check, with its working directory. */
export interface PackRequest {
  command: string
  args: readonly string[]
  cwd: string
}

export interface PackResult {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * The process seam: injected so tests never spawn a real `bun pm pack`.
 * Same shape as `tools/release.ts`'s `CommandRunner`.
 */
export type PackRunner = (request: PackRequest) => Promise<PackResult>

/** The real runner: `bun pm pack --dry-run` at `cwd`, output captured. */
export const spawnPack: PackRunner = async (request) => {
  try {
    const processHandle = Bun.spawn([request.command, ...request.args], {
      cwd: request.cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
      processHandle.exited,
    ])
    return { exitCode, stdout, stderr }
  } catch (error) {
    return {
      exitCode: 127,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Paths bun would pack, from `bun pm pack --dry-run` output. Only
 * `packed <size> <path>` lines are listings; the banner (`bun pack v…`), the
 * tgz-name line, and the `Total files:`/`Unpacked size:` trailer carry no
 * paths and are ignored. The path is everything after the first two
 * whitespace-separated tokens, so size spellings (`320B`, `2.1KB`) and
 * bracketed route paths (`app/api/auth/[...all]/route.ts`) parse as-is.
 */
export function parsePackedPaths(listing: string): string[] {
  const paths: string[] = []
  for (const line of listing.split(/\r?\n/)) {
    const match = /^packed (\S+) (.+)$/.exec(line)
    if (match !== null) paths.push(match[2]!)
  }
  return paths
}

export function isAllowedPackedPath(path: string, ruling: TarballRuling): boolean {
  return ruling.requiredPackedPaths.includes(path) || path.startsWith(ruling.requiredPackedPrefix)
}

export type PackedContentsViolation =
  | { kind: 'empty-listing' }
  | { kind: 'missing'; path: string }
  | { kind: 'missing-src' }
  | { kind: 'extra'; path: string }
  | { kind: 'no-files-allowlist' }
  | { kind: 'missing-target'; path: string }

/**
 * The pure ruling, for one ruled package: the packed set must be exactly the
 * required manifest-mandated files plus paths under the ruling's prefix, and
 * every manifest `exports`/`bin` target must be packed. An empty parsed
 * listing is a violation in itself so an unreadable or format-drifted listing
 * can never pass. The manifest-level `no-files-allowlist` kind is produced by
 * the runner (it is a fact about the manifest, not the listing); everything
 * else is derivable here.
 */
export function evaluatePackedPaths(
  paths: readonly string[],
  ruling: TarballRuling,
  targets: readonly string[] = [],
): PackedContentsViolation[] {
  if (paths.length === 0) return [{ kind: 'empty-listing' }]
  const violations: PackedContentsViolation[] = []
  for (const required of ruling.requiredPackedPaths) {
    if (!paths.includes(required)) violations.push({ kind: 'missing', path: required })
  }
  if (!paths.some((path) => path.startsWith(ruling.requiredPackedPrefix))) {
    violations.push({ kind: 'missing-src' })
  }
  for (const path of paths) {
    if (!isAllowedPackedPath(path, ruling)) violations.push({ kind: 'extra', path })
  }
  for (const target of targets) {
    if (!paths.includes(target)) violations.push({ kind: 'missing-target', path: target })
  }
  return violations
}

/**
 * Package-relative paths a manifest promises the tarball carries: every
 * `./`-prefixed string reachable in the `exports` map (a bare string, or a
 * condition object recursed to its string leaves) plus every `bin` value,
 * each stripped of its leading `./`. Subpath patterns or external references
 * are not present in the ruled manifests; if one appears, the target
 * cross-check fails visibly, which is the intended tripwire.
 */
export function packedTargetsFromManifest(manifest: {
  exports?: unknown
  bin?: unknown
}): string[] {
  const targets = new Set<string>()
  const addBin = (value: string): void => {
    targets.add(value.startsWith('./') ? value.slice('./'.length) : value)
  }
  const walkExports = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.startsWith('./')) targets.add(value.slice('./'.length))
      return
    }
    if (typeof value === 'object' && value !== null) {
      for (const entry of Object.values(value)) walkExports(entry)
    }
  }
  walkExports(manifest.exports)
  if (typeof manifest.bin === 'string') {
    addBin(manifest.bin)
  } else if (typeof manifest.bin === 'object' && manifest.bin !== null) {
    for (const value of Object.values(manifest.bin)) {
      if (typeof value === 'string') addBin(value)
    }
  }
  return [...targets]
}

function describeViolation(violation: PackedContentsViolation): string {
  switch (violation.kind) {
    case 'empty-listing':
      return (
        'the pack listing contained no `packed <size> <path>` lines, so the tarball contents ' +
        'could not be checked; if bun changed its pack output format, update this parser'
      )
    case 'missing':
      return `${violation.path} is missing from the tarball; the ruling requires it packed`
    case 'missing-src':
      return 'no src/ file is packed; the ruling requires the src/ tree (every exports and bin target lives there)'
    case 'extra':
      return (
        `${violation.path} must not publish; only package.json, README.md, and ` +
        'src/** are allowed by the ruling'
      )
    case 'no-files-allowlist':
      return (
        'the manifest declares no non-empty `files` allowlist; the ruling pins the publishable ' +
        'surface by manifest rather than by directory layout, so the package must declare one ' +
        '(e.g. `"files": ["src", "README.md"]`)'
      )
    case 'missing-target':
      return (
        `${violation.path} is an exports/bin target in the manifest but is missing from the ` +
        'tarball; every manifest target must resolve from the packed artifact'
      )
  }
}

export interface PublishContentsCheckEnvironment {
  /** Absolute path of the repository root. */
  repositoryRoot: string
  pack: PackRunner
  /** Reads a ruled package's manifest; receives the ruling's repo-root-relative directory. */
  readManifest: (directory: string) => Promise<string>
}

export interface PublishContentsCheckOutput {
  stdout(message: string): void
  stderr(message: string): void
}

const PACK_COMMAND = 'bun'
const PACK_ARGS = ['pm', 'pack', '--dry-run'] as const

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseManifestObject(text: string, label: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${label}: invalid package manifest: ${detail}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label}: invalid package manifest: must contain a JSON object`)
  }
  return value as Record<string, unknown>
}

/**
 * Checks one ruled package end to end. Never throws and never short-circuits
 * the caller's loop: every failure mode — a thrown runner, a failing pack, an
 * unreadable or unparseable manifest, a missing allowlist, a content
 * mismatch — reports nonzero, and the caller keeps checking the remaining
 * rulings.
 */
async function checkRuledPackage(
  ruling: TarballRuling,
  env: PublishContentsCheckEnvironment,
  output: PublishContentsCheckOutput,
): Promise<boolean> {
  const packageDirectory = join(env.repositoryRoot, ruling.directory)

  let manifestText: string
  try {
    manifestText = await env.readManifest(ruling.directory)
  } catch (error) {
    output.stderr(`Could not check the ${ruling.name} pack contents: ${errorMessage(error)}\n`)
    return false
  }
  let manifest: Record<string, unknown>
  try {
    manifest = parseManifestObject(manifestText, `${ruling.directory}/package.json`)
  } catch (error) {
    output.stderr(`Could not check the ${ruling.name} pack contents: ${errorMessage(error)}\n`)
    return false
  }

  const violations: PackedContentsViolation[] = []
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    violations.push({ kind: 'no-files-allowlist' })
  }
  const targets = packedTargetsFromManifest(manifest)

  let result: PackResult
  try {
    result = await env.pack({
      command: PACK_COMMAND,
      args: PACK_ARGS,
      cwd: packageDirectory,
    })
  } catch (error) {
    output.stderr(`Could not check the ${ruling.name} pack contents: ${errorMessage(error)}\n`)
    return false
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit status ${result.exitCode}`
    output.stderr(`bun pm pack --dry-run failed in ${packageDirectory}: ${detail}\n`)
    return false
  }

  const paths = parsePackedPaths(result.stdout)
  violations.push(...evaluatePackedPaths(paths, ruling, targets))
  if (violations.length === 0) {
    const srcCount = paths.filter((path) => path.startsWith(ruling.requiredPackedPrefix)).length
    output.stdout(
      `${ruling.name} pack contents match the ruling: package.json, README.md, and ${srcCount} src/ file(s).\n`,
    )
    return true
  }

  output.stdout(`${ruling.ruling}\n`)
  for (const violation of violations) {
    output.stdout(`${describeViolation(violation)}\n`)
  }
  output.stderr(
    `${violations.length} packed-contents violation(s) against the ${ruling.name} tarball ruling; see the messages above.\n`,
  )
  return false
}

/**
 * Packs every ruled package dry-run and asserts its ruling. Every failure
 * mode — a thrown runner, a failing pack, an unreadable or unparseable
 * manifest, a missing allowlist, a content mismatch — reports nonzero; the
 * check never reports success on ambiguity, and one failing package never
 * hides another's violations.
 */
export async function runPublishContentsCheck(
  env: PublishContentsCheckEnvironment,
  output: PublishContentsCheckOutput = {
    stdout: (message) => process.stdout.write(message),
    stderr: (message) => process.stderr.write(message),
  },
): Promise<number> {
  let failed = false
  for (const ruling of ruledPackages) {
    const passed = await checkRuledPackage(ruling, env, output)
    if (!passed) failed = true
  }
  return failed ? 1 : 0
}

const readPackageManifest =
  (repositoryRoot: string) =>
  async (directory: string): Promise<string> =>
    await readFile(join(repositoryRoot, directory, 'package.json'), 'utf8')

export const realEnvironment: PublishContentsCheckEnvironment = {
  repositoryRoot: repoRoot,
  pack: spawnPack,
  readManifest: readPackageManifest(repoRoot),
}

if (import.meta.main) {
  process.exitCode = await runPublishContentsCheck(realEnvironment)
}
