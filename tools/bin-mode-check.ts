import { stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { repoRoot } from './git-tracked'
import { readWorkspaceManifests, type WorkspaceManifest } from './workspace-manifest-check'

/**
 * Fails when a `bin` entry target is not git-tracked at mode 100755, or when
 * its working-tree file is missing or has lost the owner execute bit.
 *
 * Bun's installer marks the source files behind `bin` manifest entries
 * executable (0755 under a common umask such as 0022; git records only the
 * executable bit) when it creates the `node_modules/.bin` symlinks, and it
 * re-marks them on every install — including no-change re-runs. A bin source
 * committed 100644
 * therefore surfaces as an uncommitted 100644→100755 mode change in every
 * fresh checkout, and a mode-only change fails the finalize preflight's
 * clean-tree check (`requireFinalizeWorktreeClean`). Git maps a regular file
 * to index mode 100755 iff the owner execute bit is set, so the index alone
 * cannot see the other dirty direction: a bin source committed 100755 whose
 * working-tree file loses that bit shows as a 100755→100644 mode change in
 * `git status` while the index still reads 100755. The check therefore also
 * stats every tracked target and requires the owner execute bit — the same
 * evidence git itself uses when it reports the file dirty. The executable bit
 * is genuinely intended — every bin source is a shebang'd CLI entry — so the
 * stable state is committing it, and this check is how the invariant stays
 * true before a build reaches finalize.
 */

/** A `bin` entry resolved to a repo-root-relative target path. */
export interface BinEntry {
  /** Manifest that declares the entry, repo-root-relative (`package.json` for the root). */
  manifestPath: string
  /** The declaring package's name, or its manifest path when unnamed. */
  packageName: string
  /** The bin command name (the key in the manifest's `bin` map). */
  name: string
  /** Bin target, repo-root-relative. */
  target: string
}

export type BinModeViolation =
  | { kind: 'untracked'; entry: BinEntry }
  | { kind: 'mode'; entry: BinEntry; mode: string }
  | { kind: 'worktree-mode'; entry: BinEntry; indexMode: string }
  | { kind: 'conflict'; entry: BinEntry; modes: readonly string[] }

function binEntries(manifest: WorkspaceManifest): Iterable<[string, unknown]> {
  const bin = manifest.manifest.bin
  if (bin === undefined) return []
  if (typeof bin !== 'object' || bin === null || Array.isArray(bin)) {
    throw new Error(`${manifest.path}: bin must be an object mapping command names to paths`)
  }
  return Object.entries(bin)
}

/**
 * Every bin entry across the root manifest and all workspace manifests, with
 * targets resolved against the declaring package's directory. Rejects on a
 * malformed bin map or a target that escapes the repository root.
 */
export async function collectBinEntries(root: string): Promise<BinEntry[]> {
  const manifests = await readWorkspaceManifests(root)
  const entries: BinEntry[] = []
  for (const manifest of manifests) {
    const packageDirectory = dirname(join(root, manifest.path))
    const packageName =
      typeof manifest.manifest.name === 'string' ? manifest.manifest.name : manifest.path
    for (const [name, value] of binEntries(manifest)) {
      if (typeof value !== 'string') {
        throw new Error(`${manifest.path}: bin entry "${name}" must be a string path`)
      }
      const target = relative(root, resolve(packageDirectory, value))
      if (target.length === 0 || target.startsWith('..') || target === '.') {
        throw new Error(
          `${manifest.path}: bin entry "${name}" resolves to ${value}, which escapes the repository root`,
        )
      }
      entries.push({ manifestPath: manifest.path, packageName, name, target })
    }
  }
  return entries
}

/**
 * Index modes for each supplied repo-root-relative path, from `git ls-files -s`
 * run at `root`. A path git does not track is absent from the map; a conflicted
 * path maps to one mode per index stage.
 */
export async function trackedModes(
  root: string,
  paths: readonly string[],
): Promise<Map<string, string[]>> {
  if (paths.length === 0) return new Map()
  const processHandle = Bun.spawn(['git', 'ls-files', '-s', '-z', '--', ...paths], {
    cwd: root,
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
  const modes = new Map<string, string[]>()
  for (const record of stdout.split('\0')) {
    if (record.length === 0) continue
    const separator = record.indexOf('\t')
    if (separator < 0) {
      throw new Error(`git ls-files produced an unreadable record: ${JSON.stringify(record)}`)
    }
    const mode = record.slice(0, record.indexOf(' '))
    const path = record.slice(separator + 1)
    modes.set(path, [...(modes.get(path) ?? []), mode])
  }
  return modes
}

/**
 * Working-tree executability for each supplied repo-root-relative path, by
 * git's accounting: git maps a regular file to index mode 100755 iff the owner
 * execute bit is set (`ce_permissions()` in read-cache.c), so group/other
 * execute bits without the owner bit still count as non-executable — git
 * reports such a file as a 100755→100644 mode change. A missing file maps to
 * `false` (the same dirty state as a cleared bit); any other stat error
 * propagates so `runBinModeCheck`'s fail-closed catch reports it.
 */
export async function worktreeExecutability(
  root: string,
  paths: readonly string[],
): Promise<Map<string, boolean>> {
  const executability = new Map<string, boolean>()
  for (const path of paths) {
    try {
      const stats = await stat(join(root, path))
      executability.set(path, (stats.mode & 0o100) !== 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
        executability.set(path, false)
        continue
      }
      throw error
    }
  }
  return executability
}

export function evaluateBinModes(
  entries: readonly BinEntry[],
  modes: Map<string, readonly string[]>,
  executability: ReadonlyMap<string, boolean>,
): BinModeViolation[] {
  const violations: BinModeViolation[] = []
  for (const entry of entries) {
    const stages = modes.get(entry.target)
    if (stages === undefined) {
      violations.push({ kind: 'untracked', entry })
    } else if (stages.length > 1) {
      violations.push({ kind: 'conflict', entry, modes: stages })
    } else if (stages[0] !== '100755') {
      violations.push({ kind: 'mode', entry, mode: stages[0] ?? '' })
    } else if (executability.get(entry.target) !== true) {
      violations.push({ kind: 'worktree-mode', entry, indexMode: stages[0] })
    }
  }
  return violations
}

function describeViolation(violation: BinModeViolation): string {
  const { entry } = violation
  const label = `bin entry "${entry.packageName}#${entry.name}"`
  switch (violation.kind) {
    case 'mode':
      return (
        `${entry.target}: ${label} is committed ${violation.mode}; bun install marks ` +
        'bin-entry sources executable (0755 under a common umask such as 0022; git ' +
        'records only the executable bit) when it creates node_modules/.bin symlinks ' +
        '(and re-marks on every install, including no-change re-runs), so a 100644 ' +
        'bin source surfaces as an uncommitted 100644→100755 mode change in every ' +
        "fresh checkout and fails the finalize preflight's clean-tree check. Commit " +
        'the executable bit (chmod +x and commit).'
      )
    case 'untracked':
      return (
        `${entry.target}: ${label} is not tracked by git; bun install creates ` +
        'node_modules/.bin symlinks to every bin-entry source and marks them ' +
        'executable, so an untracked bin source always fails the finalize ' +
        "preflight's clean-tree check. Track the file and commit the executable " +
        'bit (chmod +x and commit).'
      )
    case 'worktree-mode':
      return (
        `${entry.target}: ${label} is committed ${violation.indexMode} but its working-tree ` +
        'file is missing or has lost the owner execute bit; git status reports a ' +
        `${violation.indexMode}→100644 mode change, which fails the finalize preflight's ` +
        'clean-tree check. Restore the executable bit (chmod +x); do not stage the mode ' +
        'change.'
      )
    case 'conflict':
      return (
        `${entry.target}: ${label} has merge-conflict stages in the index ` +
        `(${violation.modes.join(', ')}); resolve the conflict and commit the executable ` +
        'bit (chmod +x and commit).'
      )
  }
}

export interface BinModeCheckOutput {
  stdout(message: string): void
  stderr(message: string): void
}

/**
 * Runs the invariant against the repository at `root` and returns the process
 * exit code. Rejecting is fatal to a clean report: a check that cannot
 * enumerate its manifests or read the index must never report success.
 */
export async function runBinModeCheck(
  root: string,
  output: BinModeCheckOutput = {
    stdout: (message) => process.stdout.write(message),
    stderr: (message) => process.stderr.write(message),
  },
): Promise<number> {
  let entries: BinEntry[]
  try {
    entries = await collectBinEntries(root)
    const targets = entries.map((entry) => entry.target)
    const [modes, executability] = await Promise.all([
      trackedModes(root, targets),
      worktreeExecutability(root, targets),
    ])
    const violations = evaluateBinModes(entries, modes, executability)
    if (violations.length === 0) {
      output.stdout(
        `Bin entries tracked at 100755 with executable working-tree files (${entries.length}): ` +
          `${targets.join(', ') || 'none declared'}`,
      )
      return 0
    }
    for (const violation of violations) {
      output.stdout(`${describeViolation(violation)}\n`)
    }
    output.stderr(
      `${violations.length} of ${entries.length} bin entries violate the bin-mode invariant; ` +
        'see the messages above.\n',
    )
    return 1
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    output.stderr(`Could not check bin entry modes: ${message}\n`)
    return 1
  }
}

if (import.meta.main) {
  process.exitCode = await runBinModeCheck(repoRoot)
}
