import { join } from 'node:path'
import { repoRoot } from './git-tracked'

/**
 * Fails when `bun pm pack --dry-run` in `packages/hosted-store-service` would
 * pack anything besides `package.json`, `README.md`, and `src/**` — the
 * tarball ruling recorded on AUT-463.
 *
 * The ruling exists because AUT-409's move of the operator web app into the
 * service package silently added `app/`, `server.ts`, `next.config.ts`,
 * `vercel.json`, `tsconfig.json`, `next-env.d.ts`, and the internal
 * `.impeccable/surfaces/` design brief to the published npm tarball: the
 * manifest declared no `files` field, so npm's default
 * (everything-not-ignored) packed the whole package directory. Every npm
 * consumption path goes through the manifest's `exports` map and `bin`, all of
 * which live under `src/`; the app and config files are release-checkout/
 * Vercel surface read from the repository at deploy time, never from
 * node_modules, and the Impeccable surface brief is internal. The
 * allowlist is the durable fix: deny-by-default, so a file added to the
 * package later stays out of the tarball unless deliberately allowlisted —
 * the exact failure mode the move created.
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
 *   manifest's exports are the tripwires for what it may depend on. The
 *   ruling this check enforces is the *boundary* (nothing outside
 *   `src/` + the two manifest-mandated files), not a frozen file list.
 */

/** The only package this ruling covers; widening is a separate ruling. */
export const servicePackageDirectory = 'packages/hosted-store-service'

/** Paths the ruling requires in every tarball (the latter two implicitly via `src/`). */
export const requiredPackedPaths: readonly string[] = ['package.json', 'README.md']

/** Everything under this prefix is allowed; nothing else is. */
export const requiredPackedPrefix = 'src/'

const RULING =
  'Ruling (AUT-463): the @defrex/autobuild-hosted-store-service npm tarball ships exactly ' +
  'package.json, README.md, and src/**. The Next.js app/ tree, server.ts, next.config.ts, ' +
  'vercel.json, tsconfig.json, next-env.d.ts, and the internal .impeccable/ surface brief are ' +
  'release-checkout/Vercel surface and must not publish. If the ruling changes, update the ' +
  "'files' allowlist in packages/hosted-store-service/package.json and this check together."

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

export function isAllowedPackedPath(path: string): boolean {
  return requiredPackedPaths.includes(path) || path.startsWith(`${requiredPackedPrefix}`)
}

export type PackedContentsViolation =
  | { kind: 'empty-listing' }
  | { kind: 'missing'; path: string }
  | { kind: 'missing-src' }
  | { kind: 'extra'; path: string }

/**
 * The pure ruling: the packed set must be exactly `package.json`, `README.md`,
 * and paths under `src/`. An empty parsed listing is a violation in itself so
 * an unreadable or format-drifted listing can never pass.
 */
export function evaluatePackedPaths(paths: readonly string[]): PackedContentsViolation[] {
  if (paths.length === 0) return [{ kind: 'empty-listing' }]
  const violations: PackedContentsViolation[] = []
  for (const required of requiredPackedPaths) {
    if (!paths.includes(required)) violations.push({ kind: 'missing', path: required })
  }
  if (!paths.some((path) => path.startsWith(`${requiredPackedPrefix}`))) {
    violations.push({ kind: 'missing-src' })
  }
  for (const path of paths) {
    if (!isAllowedPackedPath(path)) violations.push({ kind: 'extra', path })
  }
  return violations
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
      return `${violation.path} must not publish; it is release-checkout/Vercel surface or an internal artifact, not package content`
  }
}

export interface PublishContentsCheckEnvironment {
  /** Absolute path of the checked package's directory. */
  packageDirectory: string
  pack: PackRunner
}

export interface PublishContentsCheckOutput {
  stdout(message: string): void
  stderr(message: string): void
}

/**
 * Packs the service package dry-run and asserts the ruling. Every failure
 * mode — a thrown runner, a failing pack, an unparseable listing, a content
 * mismatch — reports nonzero; the check never reports success on ambiguity.
 */
export async function runPublishContentsCheck(
  env: PublishContentsCheckEnvironment,
  output: PublishContentsCheckOutput = {
    stdout: (message) => process.stdout.write(message),
    stderr: (message) => process.stderr.write(message),
  },
): Promise<number> {
  let result: PackResult
  try {
    result = await env.pack({
      command: 'bun',
      args: ['pm', 'pack', '--dry-run'],
      cwd: env.packageDirectory,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    output.stderr(`Could not check the hosted-store-service pack contents: ${message}\n`)
    return 1
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit status ${result.exitCode}`
    output.stderr(`bun pm pack --dry-run failed in ${env.packageDirectory}: ${detail}\n`)
    return 1
  }

  const paths = parsePackedPaths(result.stdout)
  const violations = evaluatePackedPaths(paths)
  if (violations.length === 0) {
    const srcCount = paths.filter((path) => path.startsWith(`${requiredPackedPrefix}`)).length
    output.stdout(
      `Hosted-store-service pack contents match the ruling: package.json, README.md, and ${srcCount} src/ file(s).`,
    )
    return 0
  }

  output.stdout(`${RULING}\n`)
  for (const violation of violations) {
    output.stdout(`${describeViolation(violation)}\n`)
  }
  output.stderr(
    `${violations.length} packed-contents violation(s) against the hosted-store-service tarball ruling; see the messages above.\n`,
  )
  return 1
}

export const realEnvironment: PublishContentsCheckEnvironment = {
  packageDirectory: join(repoRoot, servicePackageDirectory),
  pack: spawnPack,
}

if (import.meta.main) {
  process.exitCode = await runPublishContentsCheck(realEnvironment)
}
