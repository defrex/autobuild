import { readdir, readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import { repoRoot } from './git-tracked'

/**
 * Fails when a workspace test file imports into a sibling workspace package's
 * src tree via a relative specifier (`../../<pkg>/src/*`). Cross-package tests
 * import through the owning package's public or testing subpath exports — the
 * convention the AUT-407/#385/AUT-423 migration established; until now it was
 * enforced only by a one-off grep. This check is how the migration stays true.
 *
 * Scope: test files (`*.test.ts` / `*.test.tsx`, which covers `*.live.test.ts`)
 * under `packages/<pkg>/src/`. Files outside `packages/` — notably `tools/` —
 * are not scanned, and neither are production files; tools legitimately reach
 * into workspace src trees and are governed by a separate proposal.
 *
 * Known limitation: specifiers are extracted with regular expressions over the
 * full file text, not an AST, so prose that merely looks like an import
 * position could match. Test files do not contain such text in practice, and a
 * false positive fails visibly and is fixable — it cannot silently pass.
 */

export interface ScannedFile {
  /** Repo-root-relative, POSIX separators. */
  path: string
  contents: string
}

export interface Violation {
  path: string
  line: number
  specifier: string
  fromPackage: string
  toPackage: string
}

// `from` covers static imports (including type-only) and `export … from`.
// Side-effect `import '…'`, dynamic `import('…')`, and `require('…')` are
// spelled out separately. Applied to full text so multi-line statements match.
const SPECIFIER_PATTERNS = [
  /\bfrom\s*['"](\.[^'"]+)['"]/g,
  /\bimport\s+['"](\.[^'"]+)['"]/g,
  /\bimport\s*\(\s*['"](\.[^'"]+)['"]/g,
  /\brequire\s*\(\s*['"](\.[^'"]+)['"]/g,
] as const

const ownsSpecifier = (specifier: string): boolean =>
  specifier.startsWith('./') || specifier.startsWith('../')

const owningPackageOf = (path: string, packages: readonly string[]): string | undefined =>
  packages.find((pkg) => path.startsWith(`packages/${pkg}/`))

const srcPrefixOf = (pkg: string): string => `packages/${pkg}/src`

/**
 * True when the relative specifier, resolved against the importing file's
 * directory, lands inside a different workspace package's src tree.
 */
export function resolvesIntoSiblingSrc(
  filePath: string,
  specifier: string,
  packages: readonly string[],
): { toPackage: string } | undefined {
  const fromPackage = owningPackageOf(filePath, packages)
  if (fromPackage === undefined) return undefined
  const resolved = posix.normalize(posix.join(posix.dirname(filePath), specifier))
  for (const pkg of packages) {
    if (pkg === fromPackage) continue
    const prefix = srcPrefixOf(pkg)
    if (resolved === prefix || resolved.startsWith(`${prefix}/`)) {
      return { toPackage: pkg }
    }
  }
  return undefined
}

/**
 * The pure scanner: every supplied file in order. Specifier matches carry
 * offsets, so line numbers are resolved here and a violation always reports
 * where a reader can find it.
 */
export function findBoundaryViolations(
  files: Iterable<ScannedFile>,
  packages: readonly string[],
): Violation[] {
  const violations: Violation[] = []
  for (const file of files) {
    for (const pattern of SPECIFIER_PATTERNS) {
      pattern.lastIndex = 0
      for (const match of file.contents.matchAll(pattern)) {
        const specifier = match[1]!
        if (!ownsSpecifier(specifier)) continue
        const target = resolvesIntoSiblingSrc(file.path, specifier, packages)
        if (target === undefined) continue
        violations.push({
          path: file.path,
          line: file.contents.slice(0, match.index).split('\n').length,
          specifier,
          fromPackage: owningPackageOf(file.path, packages)!,
          toPackage: target.toPackage,
        })
      }
    }
  }
  return violations
}

/** Scope of the guard: test files under a workspace package's src tree. */
export function isScannedTestFile(path: string, packages: readonly string[]): boolean {
  if (!/\.test\.(ts|tsx)$/.test(path)) return false
  return packages.some((pkg) => path.startsWith(`packages/${pkg}/src/`))
}

export interface PackageBoundaryCheckEnvironment {
  /** Workspace package directory names. Rejecting is fatal: see `runPackageBoundaryCheck`. */
  listWorkspacePackages: () => Promise<readonly string[]>
  /** Every file under `packages/`, repo-root-relative, recursively. Rejecting is fatal. */
  listFilesUnderPackages: () => Promise<readonly string[]>
  readFile: (path: string) => Promise<Uint8Array>
}

export interface ScanReport {
  violations: Violation[]
  scanned: number
}

/**
 * Reads every collected test file from the working tree — walking the
 * filesystem rather than asking git means untracked files are scanned too, so
 * an in-progress edit is caught before it is ever committed.
 */
export async function scanWorkspace(env: PackageBoundaryCheckEnvironment): Promise<ScanReport> {
  const packages = await env.listWorkspacePackages()
  const testPaths = (await env.listFilesUnderPackages()).filter((path) =>
    isScannedTestFile(path, packages),
  )
  const files: ScannedFile[] = []
  for (const path of testPaths) {
    files.push({ path, contents: new TextDecoder().decode(await env.readFile(path)) })
  }
  return { violations: findBoundaryViolations(files, packages), scanned: files.length }
}

export interface PackageBoundaryCheckOutput {
  stdout(message: string): void
  stderr(message: string): void
}

const convention =
  'Cross-package tests import through the owning package’s public or testing ' +
  'subpath exports, never a relative ../../<pkg>/src/* specifier into a ' +
  'sibling package’s src tree.'

export async function runPackageBoundaryCheck(
  env: PackageBoundaryCheckEnvironment,
  output: PackageBoundaryCheckOutput = {
    stdout: (message) => process.stdout.write(message),
    stderr: (message) => process.stderr.write(message),
  },
): Promise<number> {
  let report: ScanReport
  try {
    report = await scanWorkspace(env)
  } catch (error) {
    // A check that cannot enumerate or read must never report success.
    const message = error instanceof Error ? error.message : String(error)
    output.stderr(`Could not check the package boundary across test files: ${message}\n`)
    return 1
  }

  if (report.violations.length === 0) {
    output.stdout(
      `Package boundary check: ${report.scanned} test files scanned, no cross-package src imports.\n`,
    )
    return 0
  }

  for (const violation of report.violations) {
    output.stdout(
      `${violation.path}:${violation.line}: specifier '${violation.specifier}' reaches ` +
        `${srcPrefixOf(violation.toPackage)} from ${violation.fromPackage} tests\n`,
    )
  }
  output.stderr(`${convention}\n${report.violations.length} violation(s) found.\n`)
  return 1
}

// `dirent.path` (a Bun/Node 20+ addition) would make this a one-liner, but the
// explicit prefix keeps the walk working on the pinned TypeScript lib too.
async function walkFiles(root: string, prefix: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const paths: string[] = []
  for (const entry of entries) {
    const relative = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      // Dependencies and metadata are never workspace test files.
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      paths.push(...(await walkFiles(`${root}/${entry.name}`, relative)))
    } else if (entry.isFile()) {
      paths.push(relative)
    }
  }
  return paths
}

export const realEnvironment: PackageBoundaryCheckEnvironment = {
  listWorkspacePackages: async () => {
    const entries = await readdir(`${repoRoot}packages`, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  },
  listFilesUnderPackages: () => walkFiles(`${repoRoot}packages`, 'packages'),
  readFile: (path) => readFile(`${repoRoot}${path}`),
}

if (import.meta.main) {
  process.exitCode = await runPackageBoundaryCheck(realEnvironment)
}
