import { lstat, readFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Fails when a tracked file spells the product's name as two words or with a
 * hyphen. The convention itself is stated in `skills/guide/SKILL.md` under
 * "The product's name", where it ships with the product; this check is only
 * how the convention stays true in this repository.
 */

// Written as a character class so this file does not contain the spelling it
// bans. Scanning is line-scoped, so a prose line wrap between the two halves is
// not a match.
const SPLIT_PRODUCT_NAME = /auto[ \t-]+build/i

// Spelled from parts so this file does not trip its own check.
const LINEAR_TEAM = `Auto${'-'}build`

/**
 * Verbatim quotations of names owned by external systems. Autobuild does not
 * rename another system's records, so the exact line is exempt — not the file,
 * and not the spelling in general. A second occurrence in the same file, or a
 * reworded version of this line, still fails.
 */
const EXTERNAL_QUOTATIONS = [
  {
    file: 'autobuild.toml',
    line: `teamKey = "AUT"                 # Linear team key ("${LINEAR_TEAM}")`,
    why: 'The Linear team this repository dispatches from is literally named this.',
  },
] as const

export interface ScannedFile {
  path: string
  contents: string
}

export interface Violation {
  path: string
  line: number
  text: string
}

function isExternalQuotation(path: string, text: string): boolean {
  return EXTERNAL_QUOTATIONS.some((quotation) => quotation.file === path && quotation.line === text)
}

/**
 * The pure scanner: every line of every supplied file, in order. Splitting on
 * newlines here rather than in the caller keeps line numbers the scanner's
 * responsibility, so a violation always reports where a reader can find it.
 */
export function findProductNameViolations(files: Iterable<ScannedFile>): Violation[] {
  const violations: Violation[] = []
  for (const file of files) {
    const lines = file.contents.split('\n')
    for (const [index, rawLine] of lines.entries()) {
      const text = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      if (!SPLIT_PRODUCT_NAME.test(text)) {
        continue
      }
      if (isExternalQuotation(file.path, text)) {
        continue
      }
      violations.push({ path: file.path, line: index + 1, text })
    }
  }
  return violations
}

export type TrackedPathKind =
  | { kind: 'file' }
  | { kind: 'symlink' }
  | { kind: 'missing' }
  | { kind: 'unsupported'; found: string }

export interface ProductNameCheckEnvironment {
  /** Tracked paths, repo-root-relative. Rejecting is fatal: see `runProductNameCheck`. */
  listTrackedPaths: () => Promise<readonly string[]>
  /** Classifies without following links — `lstat`, never `stat` and never `Bun.file`. */
  lstat: (path: string) => Promise<TrackedPathKind>
  readLink: (path: string) => Promise<string>
  readFile: (path: string) => Promise<Uint8Array>
}

export interface ScanTally {
  tracked: number
  text: number
  symlink: number
  binary: number
  missing: number
}

export interface ScanReport {
  violations: Violation[]
  tally: ScanTally
}

const decoder = new TextDecoder()

/**
 * Reads every tracked path from the working tree — not from the index, because
 * the check runs before work is finished and index contents would let an
 * unstaged edit pass.
 *
 * Git's content for a mode-120000 entry is the link target text, so a symlink
 * is scanned as that text under its own path. Following it instead would read a
 * directory (an error) or transparently yield another tracked file's bytes,
 * which would attribute a violation to the wrong path and leave the link's own
 * tracked content unscanned.
 */
export async function scanTrackedPaths(env: ProductNameCheckEnvironment): Promise<ScanReport> {
  const paths = await env.listTrackedPaths()
  const files: ScannedFile[] = []
  const tally: ScanTally = { tracked: paths.length, text: 0, symlink: 0, binary: 0, missing: 0 }

  for (const path of paths) {
    const type = await env.lstat(path)
    switch (type.kind) {
      case 'symlink': {
        files.push({ path, contents: await env.readLink(path) })
        tally.symlink += 1
        break
      }
      case 'file': {
        const bytes = await env.readFile(path)
        if (bytes.includes(0)) {
          tally.binary += 1
          break
        }
        files.push({ path, contents: decoder.decode(bytes) })
        tally.text += 1
        break
      }
      case 'missing': {
        // `git ls-files` lists tracked paths that may be deleted in the working
        // tree; a deleted file has no content to check.
        tally.missing += 1
        break
      }
      case 'unsupported': {
        throw new Error(`${path}: tracked path is a ${type.found}, which this check cannot scan`)
      }
    }
  }

  return { violations: findProductNameViolations(files), tally }
}

export interface ProductNameCheckOutput {
  stdout(message: string): void
  stderr(message: string): void
}

const convention =
  "The product's name is one word: `Autobuild` in prose, `autobuild` in " +
  'identifiers, commands, and paths. See "The product\'s name" in ' +
  'skills/guide/SKILL.md.'

function describeTally(tally: ScanTally): string {
  return (
    `Scanned ${tally.text} text files and ${tally.symlink} symlinks; skipped ` +
    `${tally.binary} binary and ${tally.missing} missing, of ${tally.tracked} tracked paths.`
  )
}

export async function runProductNameCheck(
  env: ProductNameCheckEnvironment,
  output: ProductNameCheckOutput = {
    stdout: (message) => process.stdout.write(message),
    stderr: (message) => process.stderr.write(message),
  },
): Promise<number> {
  let report: ScanReport
  try {
    report = await scanTrackedPaths(env)
  } catch (error) {
    // A check that cannot enumerate or read must never report success.
    const message = error instanceof Error ? error.message : String(error)
    output.stderr(`Could not check the product's name across tracked files: ${message}\n`)
    return 1
  }

  if (report.violations.length === 0) {
    return 0
  }

  for (const violation of report.violations) {
    output.stdout(`${violation.path}:${violation.line}: ${violation.text}\n`)
  }
  output.stderr(`${convention}\n${describeTally(report.tally)}\n`)
  return 1
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

export const gitTrackedPaths = async (): Promise<readonly string[]> => {
  const processHandle = Bun.spawn(['git', 'ls-files', '-z'], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(`git ls-files exited with status ${exitCode}: ${stderr.trim()}`)
  }
  return stdout.split('\0').filter((path) => path.length > 0)
}

const absolute = (path: string): string => join(repoRoot, path)

export const realEnvironment: ProductNameCheckEnvironment = {
  listTrackedPaths: gitTrackedPaths,
  lstat: async (path) => {
    try {
      const stats = await lstat(absolute(path))
      if (stats.isSymbolicLink()) {
        return { kind: 'symlink' }
      }
      if (stats.isFile()) {
        return { kind: 'file' }
      }
      return { kind: 'unsupported', found: stats.isDirectory() ? 'directory' : 'special file' }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { kind: 'missing' }
      }
      throw error
    }
  },
  readLink: (path) => readlink(absolute(path)),
  readFile: (path) => readFile(absolute(path)),
}

if (import.meta.main) {
  process.exitCode = await runProductNameCheck(realEnvironment)
}
