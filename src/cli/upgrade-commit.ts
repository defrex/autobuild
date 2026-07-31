import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Exec } from '../ports/workspace/git-worktree'
import { spawnExec } from '../ports/workspace/git-worktree'
import type { UpgradeReport } from './upgrade'

export const UPGRADE_COMMIT_CONTEXT_ENV = 'AB_UPGRADE_COMMIT_CONTEXT'

export interface UpgradeCommitRecord {
  version: 1
  targetRepo: string
  gitRoot?: string
  head?: string
  dirtyPaths: string[]
  selfUpdatePaths: string[]
  suppression?: string
}

export interface UpgradeCommitContext {
  path: string
  record: UpgradeCommitRecord
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim()
}

function commandError(
  label: string,
  result: { stdout: string; stderr: string; exitCode: number },
): string {
  return `${label} failed (exit ${result.exitCode}): ${errorText(
    result.stderr || result.stdout || '(no output)',
  )}`
}

function nulPaths(output: string): string[] {
  return output.split('\0').filter((path) => path !== '')
}

async function git(
  exec: Exec,
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return exec(['git', ...args], { cwd })
}

async function dirtyPaths(exec: Exec, gitRoot: string): Promise<string[]> {
  const commands = [
    ['diff', '--no-renames', '--name-only', '-z'],
    ['diff', '--cached', '--no-renames', '--name-only', '-z'],
    ['ls-files', '--others', '--exclude-standard', '-z'],
  ]
  const paths = new Set<string>()
  for (const args of commands) {
    const result = await git(exec, gitRoot, args)
    if (result.exitCode !== 0) throw new Error(commandError(`git ${args[0]}`, result))
    for (const path of nulPaths(result.stdout)) paths.add(path)
  }
  return [...paths].sort()
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function operationSuppression(gitDir: string): Promise<string | undefined> {
  if (await exists(join(gitDir, 'MERGE_HEAD'))) return 'the target repository is mid-merge'
  if (
    (await exists(join(gitDir, 'rebase-merge'))) ||
    (await exists(join(gitDir, 'rebase-apply')))
  ) {
    return 'the target repository is mid-rebase'
  }
  if (await exists(join(gitDir, 'CHERRY_PICK_HEAD'))) {
    return 'the target repository is mid-cherry-pick'
  }
  return undefined
}

async function captureRecord(targetRepo: string, exec: Exec): Promise<UpgradeCommitRecord> {
  const requestedTarget = resolve(targetRepo)
  let target = requestedTarget
  try {
    target = await realpath(requestedTarget)
  } catch {
    // A missing/non-directory target will receive the ordinary non-Git reason.
  }
  const rootResult = await git(exec, target, ['rev-parse', '--show-toplevel'])
  if (rootResult.exitCode !== 0 || rootResult.stdout.trim() === '') {
    return {
      version: 1,
      targetRepo: target,
      dirtyPaths: [],
      selfUpdatePaths: [],
      suppression: `the target is not a Git repository (${errorText(rootResult.stderr || 'git could not resolve a worktree')})`,
    }
  }

  const gitRoot = await realpath(rootResult.stdout.trim())
  const headResult = await git(exec, gitRoot, ['rev-parse', '--verify', 'HEAD'])
  if (headResult.exitCode !== 0 || headResult.stdout.trim() === '') {
    return {
      version: 1,
      targetRepo: target,
      gitRoot,
      dirtyPaths: [],
      selfUpdatePaths: [],
      suppression: 'the target repository has no current HEAD',
    }
  }

  const gitDirResult = await git(exec, gitRoot, ['rev-parse', '--absolute-git-dir'])
  if (gitDirResult.exitCode !== 0 || gitDirResult.stdout.trim() === '') {
    return {
      version: 1,
      targetRepo: target,
      gitRoot,
      head: headResult.stdout.trim(),
      dirtyPaths: [],
      selfUpdatePaths: [],
      suppression: commandError('locating the target Git directory', gitDirResult),
    }
  }

  try {
    const operation = await operationSuppression(gitDirResult.stdout.trim())
    return {
      version: 1,
      targetRepo: target,
      gitRoot,
      head: headResult.stdout.trim(),
      dirtyPaths: await dirtyPaths(exec, gitRoot),
      selfUpdatePaths: [],
      ...(operation === undefined ? {} : { suppression: operation }),
    }
  } catch (error) {
    return {
      version: 1,
      targetRepo: target,
      gitRoot,
      head: headResult.stdout.trim(),
      dirtyPaths: [],
      selfUpdatePaths: [],
      suppression: `Git safety inspection failed: ${errorText(error)}`,
    }
  }
}

async function persist(context: UpgradeCommitContext): Promise<void> {
  await writeFile(context.path, `${JSON.stringify(context.record)}\n`, { mode: 0o600 })
}

/** Capture the only state that can distinguish operator work from upgrade writes. */
export async function createUpgradeCommitContext(
  targetRepo: string,
  exec: Exec = spawnExec,
): Promise<UpgradeCommitContext> {
  const dir = await mkdtemp(join(tmpdir(), 'ab-upgrade-commit-'))
  const context = { path: join(dir, 'context.json'), record: await captureRecord(targetRepo, exec) }
  await persist(context)
  return context
}

function parseRecord(value: unknown): UpgradeCommitRecord {
  if (typeof value !== 'object' || value === null) throw new Error('record is not an object')
  const record = value as Partial<UpgradeCommitRecord>
  if (
    record.version !== 1 ||
    typeof record.targetRepo !== 'string' ||
    !Array.isArray(record.dirtyPaths) ||
    record.dirtyPaths.some((path) => typeof path !== 'string') ||
    !Array.isArray(record.selfUpdatePaths) ||
    record.selfUpdatePaths.some((path) => typeof path !== 'string') ||
    (record.gitRoot !== undefined && typeof record.gitRoot !== 'string') ||
    (record.head !== undefined && typeof record.head !== 'string') ||
    (record.suppression !== undefined && typeof record.suppression !== 'string')
  ) {
    throw new Error('record has an invalid shape')
  }
  return record as UpgradeCommitRecord
}

/** Load the parent's baseline in the replacement binary; never recapture it. */
export async function loadUpgradeCommitContext(
  path: string,
  targetRepo: string,
): Promise<UpgradeCommitContext> {
  const record = parseRecord(JSON.parse(await readFile(path, 'utf8')))
  let requestedTarget = resolve(targetRepo)
  try {
    requestedTarget = await realpath(requestedTarget)
  } catch {
    // Keep the resolved spelling for the mismatch diagnostic below.
  }
  if (resolve(record.targetRepo) !== requestedTarget) {
    throw new Error(`upgrade commit handoff targets ${record.targetRepo}, not ${requestedTarget}`)
  }
  return { path, record }
}

function repositoryPath(gitRoot: string, absolutePath: string): string | undefined {
  const path = relative(gitRoot, resolve(absolutePath))
  if (path === '' || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path))
    return undefined
  return path.split(sep).join('/')
}

/** Record files written by a successful local Bun update before re-exec. */
export async function addUpgradeSelfUpdatePaths(
  contextPath: string,
  paths: string[],
): Promise<void> {
  const context: UpgradeCommitContext = {
    path: contextPath,
    record: parseRecord(JSON.parse(await readFile(contextPath, 'utf8'))),
  }
  const gitRoot = context.record.gitRoot
  if (gitRoot === undefined) return
  const owned = paths
    .map((path) => repositoryPath(gitRoot, path))
    .filter((path): path is string => path !== undefined)
  context.record.selfUpdatePaths = [
    ...new Set([...context.record.selfUpdatePaths, ...owned]),
  ].sort()
  await persist(context)
}

function literalPathspec(path: string): string {
  return `:(literal)${path}`
}

function managedRoots(record: UpgradeCommitRecord, report: UpgradeReport): Map<string, string[]> {
  const roots = new Map<string, string[]>()
  if (record.gitRoot === undefined) return roots
  for (const { skill } of report.skills) {
    const paths = [
      join(record.targetRepo, '.agents', 'skills', skill),
      join(record.targetRepo, '.agents', 'skills', '.ab-pristine', skill),
      join(record.targetRepo, '.claude', 'skills', skill),
      // Upgrade also owns migration from the pre-standard singular root.
      join(record.targetRepo, '.agent', 'skills', skill),
      join(record.targetRepo, '.agent', 'skills', '.ab-pristine', skill),
    ]
      .map((path) => repositoryPath(record.gitRoot!, path))
      .filter((path): path is string => path !== undefined)
    roots.set(skill, paths)
  }
  return roots
}

function under(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}

function commitMessage(report: UpgradeReport, changedSkills: Set<string>): string {
  const lines = report.skills
    .filter(({ skill }) => changedSkills.has(skill))
    .map(({ skill, action }) => `- ${skill}: ${action}`)
  return [
    'ab upgrade: record updated vendored skills',
    ...(lines.length === 0 ? [] : ['', ...lines]),
  ].join('\n')
}

export interface FinishUpgradeCommitOptions {
  exec?: Exec
  stdout?: (line: string) => void
  stderr?: (line: string) => void
}

/** Commit only upgrade-owned final dirt. Every failure is warning-only. */
export async function finishUpgradeCommit(
  context: UpgradeCommitContext,
  report: UpgradeReport,
  options: FinishUpgradeCommitOptions = {},
): Promise<void> {
  const exec = options.exec ?? spawnExec
  const stdout = options.stdout ?? (() => {})
  const stderr = options.stderr ?? (() => {})
  // A successful local self-update appends its owner files to the handoff
  // record. Reload so this process and a replacement child observe one source.
  let record: UpgradeCommitRecord
  try {
    record = parseRecord(JSON.parse(await readFile(context.path, 'utf8')))
    context.record = record
  } catch (error) {
    stderr(`ab upgrade did not commit: could not read its Git baseline: ${errorText(error)}`)
    return
  }
  const blockers: string[] = []
  if (report.skills.some(({ action }) => action === 'conflicted')) {
    blockers.push(
      `content conflicts remain for ${report.skills
        .filter(({ action }) => action === 'conflicted')
        .map(({ skill }) => skill)
        .join(', ')}`,
    )
  }
  if (report.discoveryConflicts.length > 0) {
    blockers.push(
      `Claude discovery conflicts remain for ${report.discoveryConflicts
        .map(({ skill }) => skill)
        .join(', ')}`,
    )
  }
  if (record.suppression !== undefined) blockers.push(record.suppression)

  let changed: string[] = []
  const roots = managedRoots(record, report)
  if (record.gitRoot !== undefined && blockers.length === 0) {
    try {
      const rootResult = await git(exec, record.targetRepo, ['rev-parse', '--show-toplevel'])
      if (rootResult.exitCode !== 0 || rootResult.stdout.trim() === '') {
        blockers.push('the target is no longer a Git repository')
      } else if ((await realpath(rootResult.stdout.trim())) !== record.gitRoot) {
        blockers.push('the target now resolves to a different Git worktree')
      }

      const headResult = await git(exec, record.gitRoot, ['rev-parse', '--verify', 'HEAD'])
      if (headResult.exitCode !== 0 || headResult.stdout.trim() !== record.head) {
        blockers.push('HEAD changed while ab upgrade was running')
      }
      const gitDirResult = await git(exec, record.gitRoot, ['rev-parse', '--absolute-git-dir'])
      if (gitDirResult.exitCode !== 0 || gitDirResult.stdout.trim() === '') {
        blockers.push(
          commandError('locating the target Git directory after the merge', gitDirResult),
        )
      } else {
        const operation = await operationSuppression(gitDirResult.stdout.trim())
        if (operation !== undefined) blockers.push(operation)
      }

      if (blockers.length === 0) {
        const dirty = await dirtyPaths(exec, record.gitRoot)
        const ownedRoots = [...roots.values()].flat()
        changed = dirty.filter(
          (path) =>
            record.selfUpdatePaths.includes(path) || ownedRoots.some((root) => under(path, root)),
        )
        const overlap = changed.filter((path) => record.dirtyPaths.includes(path))
        if (overlap.length > 0) {
          blockers.push(
            `upgrade-owned paths were already modified before the run: ${overlap.join(', ')}`,
          )
        }
      }
    } catch (error) {
      blockers.push(`Git safety inspection failed after the merge: ${errorText(error)}`)
    }
  }

  if (blockers.length > 0) {
    for (const reason of blockers) stderr(`ab upgrade did not commit: ${reason}`)
    return
  }
  if (record.gitRoot === undefined || changed.length === 0) return

  const changedSkills = new Set<string>()
  for (const [skill, skillRoots] of roots) {
    if (changed.some((path) => skillRoots.some((root) => under(path, root))))
      changedSkills.add(skill)
  }
  const pathspecs = changed.map(literalPathspec)
  try {
    const add = await git(exec, record.gitRoot, ['add', '-A', '--', ...pathspecs])
    if (add.exitCode !== 0) throw new Error(commandError('staging upgrade-owned paths', add))
    const commit = await git(exec, record.gitRoot, [
      'commit',
      '--only',
      '-m',
      commitMessage(report, changedSkills),
      '--',
      ...pathspecs,
    ])
    if (commit.exitCode !== 0)
      throw new Error(commandError('committing upgrade-owned paths', commit))
    stdout('ab upgrade: committed upgrade-owned changes')
  } catch (error) {
    stderr(`ab upgrade could not commit its changes: ${errorText(error)}`)
  }
}

export async function cleanupUpgradeCommitContext(context: UpgradeCommitContext): Promise<void> {
  try {
    await rm(resolve(context.path, '..'), { recursive: true, force: true })
  } catch {
    // Temporary-state cleanup must never replace the merge-derived exit status.
  }
}
