/**
 * Repository identity and sessionless local-state resolution.
 *
 * Repository identity (SPEC §7.2, §12) is the checkout's normalized origin
 * URL (`normalizeGitRemoteUrl`), not the checkout path: a path-based identity
 * makes two hosts disagree about which repository they operate. A checkout
 * with no `origin` remote falls back to its resolved path, so origin-less
 * local fixtures keep today's behavior. `RepoStatePaths` therefore carries
 * BOTH: `repo` is the store-keyed identity, `checkout` is the physical main
 * checkout every filesystem consumer (config path, plugin loading, forge
 * `repoRoot`, worktree root, live-reload source) keeps using.
 *
 * Records written before the identity change are keyed by checkout path and
 * are NOT migrated; they remain visible where their recorded `repoOrigin`
 * matches the querying checkout (see `buildInRepository`).
 *
 * One resolver owns both concepts because they must agree in linked worktrees:
 * Git's repository/worktree metadata identifies the main checkout, whose
 * `.autobuild/` directory is the implicit state root. Local overrides are
 * normalized against that checkout so the dispatcher and agents cannot
 * interpret a relative path from different working directories.
 */
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { Exec } from '../ports/workspace/git-worktree'
import type { BuildRecord } from '../store/types'
import { normalizeGitRemoteUrl } from '../kernel/origin'

export { normalizeGitRemoteUrl } from '../kernel/origin'

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

export interface RepoStatePaths {
  /** Repository identity in BuildStore records/journals: the checkout's
   * normalized origin URL, falling back to the resolved checkout path only
   * when the checkout has no origin remote. Opaque to the store schema. */
  repo: string
  /** The physical main checkout — the value `repo` held before the origin
   * identity. Every filesystem consumer (config path, plugin loading, forge
   * `repoRoot`, worktree root, live-reload source) uses this. */
  checkout: string
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
  /** Repository identity: a normalized origin URL, or a local checkout path. */
  repo: string
  /** The physical checkout. Defaults to `repo` so origin-less fixtures —
   * where identity IS the path — need no extra argument. */
  checkout?: string
  storeRef?: string
  envStore?: string
}): RepoStatePaths {
  const checkout = resolve(opts.checkout ?? opts.repo)
  const defaultLocalRoot = join(checkout, LOCAL_STATE_DIR)
  const selected = nonBlank(opts.storeRef) ?? nonBlank(opts.envStore) ?? defaultLocalRoot
  const remote = isRemoteStoreRef(selected)
  const storeRef = remote ? selected : resolve(checkout, selected)
  const localStateRoot = remote ? defaultLocalRoot : storeRef
  return {
    repo: opts.repo,
    checkout,
    defaultLocalRoot,
    storeRef,
    localStateRoot,
    worktreeRoot: join(localStateRoot, 'worktrees'),
  }
}

/**
 * The normalized origin remote of a checkout, or undefined when the checkout
 * has no `origin` remote or git fails (non-zero exit or thrown). Never throws.
 */
export async function resolveRepoOrigin(repo: string, exec: Exec): Promise<string | undefined> {
  try {
    const result = await exec(['git', 'remote', 'get-url', 'origin'], { cwd: repo })
    if (result.exitCode !== 0) return undefined
    const raw = result.stdout.trim()
    return raw === '' ? undefined : normalizeGitRemoteUrl(raw)
  } catch {
    return undefined
  }
}

/**
 * Whether a build record belongs to the repository checked out at `checkout`.
 * Identity is the checkout's normalized origin (falling back to the checkout
 * path when there is no origin remote); for new records `record.repo` IS that
 * origin, so equality is the whole test. Records written before the origin
 * identity are keyed by checkout path and are NOT migrated (decision
 * 2026-09-10); a mismatch is forgiven only when the record carries a
 * normalized origin equal to the checkout's identity — a differently located
 * checkout of the same repository (a sandbox guest, a second host clone) is
 * the same repository, while a different origin (or an origin-less record)
 * is foreign.
 */
export async function buildInRepository(
  record: BuildRecord,
  checkout: string,
  exec: Exec,
): Promise<boolean> {
  const origin = await resolveRepoOrigin(checkout, exec)
  const identity = origin ?? resolve(checkout)
  if (record.repo === identity) return true
  if (record.repoOrigin === undefined) return false
  // The recorded side is normalized too (idempotent for records written by
  // this code) so a guard never depends on the writer's normalizer vintage —
  // an ssh-spelled recorded origin still equals the https spelling computed
  // here.
  return normalizeGitRemoteUrl(record.repoOrigin) === identity
}

/** Resolve repository identity, then select all state paths from it.
 *
 * Identity is the resolved main checkout's normalized origin remote, falling
 * back to the checkout path when the checkout has no origin (local fixtures,
 * tests). `checkout` carries the resolved path for every filesystem
 * consumer. */
export async function resolveRepoState(opts: {
  targetRepo: string
  exec: Exec
  storeRef?: string
  envStore?: string
}): Promise<RepoStatePaths> {
  const checkout = await resolveMainRepo(opts.targetRepo, opts.exec)
  const origin = await resolveRepoOrigin(checkout, opts.exec)
  return resolveRepoStatePaths({
    repo: origin ?? checkout,
    checkout,
    ...(opts.storeRef !== undefined ? { storeRef: opts.storeRef } : {}),
    ...(opts.envStore !== undefined ? { envStore: opts.envStore } : {}),
  })
}
