import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import type { Exec } from './git-worktree'

export const PHASE_SCRATCH_PREFIX = '.ab/'

async function git(exec: Exec, cwd: string, args: string[]): Promise<string> {
  const result = await exec(['git', ...args], { cwd })
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim() || '(no output)'}`,
    )
  }
  return result.stdout
}

/** Parse Git's -z path output without treating whitespace or quoting specially. */
export function parseNulPaths(output: string): string[] {
  if (output === '') return []
  if (!output.endsWith('\0')) throw new Error('git path output was not NUL-terminated')
  const paths = output.slice(0, -1).split('\0')
  if (paths.some((path) => path === '')) throw new Error('git path output contained an empty path')
  return paths
}

export async function trackedScratchPaths(
  exec: Exec,
  workspacePath: string,
  commit?: string,
): Promise<string[]> {
  const args = commit
    ? ['ls-tree', '-r', '--name-only', '-z', commit, '--', '.ab']
    : ['ls-files', '-z', '--', '.ab']
  return [...new Set(parseNulPaths(await git(exec, workspacePath, args)))].sort()
}

/** Restore the exact index versions removed by a disposable scratch wipe. */
export async function restoreTrackedScratch(
  exec: Exec,
  workspacePath: string,
  paths: readonly string[],
): Promise<void> {
  if (paths.length === 0) return
  await git(exec, workspacePath, ['checkout-index', '--force', '--', ...paths])
}

/** Keep generated scratch ignored even when a legacy repo tracks .ab/.gitignore. */
export async function ensureScratchExcluded(exec: Exec, workspacePath: string): Promise<void> {
  const raw = (await git(exec, workspacePath, ['rev-parse', '--git-path', 'info/exclude'])).trim()
  if (raw === '') throw new Error('git rev-parse returned no exclude path')
  const path = isAbsolute(raw) ? raw : join(workspacePath, raw)
  let content = ''
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const lines = content.split(/\r?\n/)
  if (lines.includes('.ab/')) return
  await mkdir(dirname(path), { recursive: true })
  const separator = content === '' || content.endsWith('\n') ? '' : '\n'
  await writeFile(path, `${content}${separator}.ab/\n`)
}

function collides(path: string, unavailable: ReadonlySet<string>): boolean {
  for (const other of unavailable) {
    if (path === other || path.startsWith(`${other}/`) || other.startsWith(`${path}/`)) return true
  }
  return false
}

/** Allocate a stable path relative to .ab without overwriting tracked content. */
export function allocateScratchPath(
  desired: string,
  tracked: ReadonlySet<string>,
  allocated: Set<string>,
): string {
  const unavailable = new Set([...tracked, ...allocated])
  const conventional = `${PHASE_SCRATCH_PREFIX}${desired}`
  if (!collides(conventional, unavailable)) {
    allocated.add(conventional)
    return desired
  }
  for (let index = 1; ; index += 1) {
    const candidate = `generated/${index}/${desired}`
    if (!collides(`${PHASE_SCRATCH_PREFIX}${candidate}`, unavailable)) {
      allocated.add(`${PHASE_SCRATCH_PREFIX}${candidate}`)
      return candidate
    }
  }
}

async function changedScratchPaths(
  exec: Exec,
  workspacePath: string,
  from: string,
  to: string,
): Promise<Set<string>> {
  return new Set(
    parseNulPaths(
      await git(exec, workspacePath, ['diff', '--name-only', '-z', from, to, '--', '.ab']),
    ),
  )
}

/** Every scratch path touched by any commit, including changes later reverted. */
export async function scratchPathsTouchedInRange(
  exec: Exec,
  workspacePath: string,
  base: string,
  head: string,
): Promise<string[]> {
  const commits = (await git(exec, workspacePath, ['rev-list', '--reverse', `${base}..${head}`]))
    .trim()
    .split('\n')
    .filter(Boolean)
  const touched = new Set<string>()
  for (const commit of commits) {
    const parents = (await git(exec, workspacePath, ['rev-list', '--parents', '-n', '1', commit]))
      .trim()
      .split(/\s+/)
      .slice(1)
    for (const parent of parents) {
      for (const path of await changedScratchPaths(exec, workspacePath, parent, commit)) {
        touched.add(path)
      }
    }
  }
  return [...touched].sort()
}

/** Merge-authored scratch differs from every parent; inherited bytes are safe. */
export async function reconcileScratchViolations(
  exec: Exec,
  workspacePath: string,
  head: string,
  parents: readonly string[],
): Promise<string[]> {
  let intersection: Set<string> | undefined
  for (const parent of parents) {
    const changed = await changedScratchPaths(exec, workspacePath, parent, head)
    intersection =
      intersection === undefined
        ? changed
        : new Set([...intersection].filter((path) => changed.has(path)))
  }
  return [...(intersection ?? [])].sort()
}

export function phaseScratchRejection(paths: readonly string[]): Error {
  return new Error(
    `publication rejected: commits must not add, modify, or delete paths under .ab/:\n` +
      `${paths.map((path) => `  ${path}`).join('\n')}\n` +
      'Unstage or drop the .ab/ change, amend the commit if needed, then retry completion.',
  )
}
