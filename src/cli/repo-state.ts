/**
 * Repository identity and sessionless local-state resolution.
 *
 * One resolver owns both concepts because they must agree in linked worktrees:
 * Git's repository/worktree metadata identifies the main checkout, whose
 * `.autobuild/` directory is the implicit state root. Local overrides are
 * normalized against that checkout so the dispatcher and agents cannot
 * interpret a relative path from different working directories.
 */
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { Exec } from '../ports/workspace/git-worktree'

export const LOCAL_STATE_DIR = '.autobuild'

export function isRemoteStoreRef(ref: string): boolean {
  return /^https?:\/\//i.test(ref)
}

function absoluteGitPath(path: string, target: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(target, path)
}

/**
 * Resolve the main checkout from Git's repository/worktree topology.
 *
 * A normal checkout (including a submodule or `--separate-git-dir` checkout)
 * has equal Git and common directories, so `--show-toplevel` is authoritative.
 * A linked worktree has a per-worktree Git directory and a shared common
 * directory; Git's worktree registry lists the main checkout first. This avoids
 * assuming the common directory is `<checkout>/.git`, which is false for
 * submodules and separately stored Git directories.
 *
 * Outside Git (or when Git cannot be executed), the resolved target directory
 * is the deterministic fallback.
 */
export async function resolveMainRepo(targetRepo: string, exec: Exec): Promise<string> {
  const target = resolve(targetRepo)
  try {
    const result = await exec(
      [
        'git',
        'rev-parse',
        '--path-format=absolute',
        '--git-dir',
        '--git-common-dir',
        '--show-toplevel',
      ],
      { cwd: target },
    )
    if (result.exitCode !== 0) return target
    const [gitDirRaw, commonDirRaw, topLevelRaw] = result.stdout
      .trimEnd()
      .split('\n')
    if (!gitDirRaw || !commonDirRaw || !topLevelRaw) return target

    const gitDir = absoluteGitPath(gitDirRaw, target)
    const commonDir = absoluteGitPath(commonDirRaw, target)
    const topLevel = absoluteGitPath(topLevelRaw, target)
    if (gitDir === commonDir) return topLevel

    const worktrees = await exec(
      ['git', 'worktree', 'list', '--porcelain', '-z'],
      { cwd: target },
    )
    if (worktrees.exitCode === 0) {
      const main = worktrees.stdout
        .split('\0')
        .find((entry) => entry.startsWith('worktree '))
        ?.slice('worktree '.length)
      if (main) return absoluteGitPath(main, target)
    }

    // Old Git versions without porcelain -z still have the ordinary linked
    // layout. Only derive from dirname when the common dir is literally .git;
    // otherwise the current worktree is safer than writing inside Git metadata.
    return basename(commonDir) === '.git' ? dirname(commonDir) : topLevel
  } catch {
    return target
  }
}

export interface RepoStatePaths {
  /** Main checkout used as repository identity in BuildStore records/journals. */
  repo: string
  /** The only implicit local state root. */
  defaultLocalRoot: string
  /** Normalized local path, or an unchanged HTTP(S) URL. */
  storeRef: string
  /** Root for local-only state (tickets and worktrees). */
  localStateRoot: string
  /** Local scratch root used by GitWorktreeProvider. */
  worktreeRoot: string
}

function nonBlank(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined
}

/**
 * Select state with one precedence rule for every sessionless command:
 * non-blank explicit `--store` > non-blank `AB_STORE` > repository-local default.
 *
 * A local selection relocates the whole local tree, including worktrees. A
 * remote store has no filesystem root, so its worktrees remain local beneath
 * the repository's implicit state root.
 */
export function resolveRepoStatePaths(opts: {
  repo: string
  storeRef?: string
  envStore?: string
}): RepoStatePaths {
  const repo = resolve(opts.repo)
  const defaultLocalRoot = join(repo, LOCAL_STATE_DIR)
  const selected = nonBlank(opts.storeRef) ?? nonBlank(opts.envStore) ?? defaultLocalRoot
  const remote = isRemoteStoreRef(selected)
  const storeRef = remote ? selected : resolve(repo, selected)
  const localStateRoot = remote ? defaultLocalRoot : storeRef
  return {
    repo,
    defaultLocalRoot,
    storeRef,
    localStateRoot,
    worktreeRoot: join(localStateRoot, 'worktrees'),
  }
}

/** Resolve repository identity, then select all state paths from it. */
export async function resolveRepoState(opts: {
  targetRepo: string
  exec: Exec
  storeRef?: string
  envStore?: string
}): Promise<RepoStatePaths> {
  const repo = await resolveMainRepo(opts.targetRepo, opts.exec)
  return resolveRepoStatePaths({
    repo,
    ...(opts.storeRef !== undefined ? { storeRef: opts.storeRef } : {}),
    ...(opts.envStore !== undefined ? { envStore: opts.envStore } : {}),
  })
}
