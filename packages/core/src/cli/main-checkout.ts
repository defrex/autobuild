import { basename, dirname, isAbsolute, resolve } from 'node:path'
import type { Exec } from '../ports/workspace/git-worktree'
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
    const [gitDirRaw, commonDirRaw, topLevelRaw] = result.stdout.trimEnd().split('\n')
    if (!gitDirRaw || !commonDirRaw || !topLevelRaw) return target

    const gitDir = absoluteGitPath(gitDirRaw, target)
    const commonDir = absoluteGitPath(commonDirRaw, target)
    const topLevel = absoluteGitPath(topLevelRaw, target)
    if (gitDir === commonDir) return topLevel

    const worktrees = await exec(['git', 'worktree', 'list', '--porcelain', '-z'], { cwd: target })
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
