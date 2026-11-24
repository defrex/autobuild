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
import { configuredStore } from './configured-store'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { Exec } from '../ports/workspace/git-worktree'
import type { BuildRecord } from '../store/types'
import { normalizeGitRemoteUrl } from '../kernel/origin'

export { normalizeGitRemoteUrl } from '../kernel/origin'

export const LOCAL_STATE_DIR = '.autobuild'

export function isRemoteStoreRef(ref: string): boolean {
  return /^https?:\/\//i.test(ref)
}

export { resolveMainRepo } from './main-checkout'
import { resolveMainRepo } from './main-checkout'

export interface RepoStatePaths {
  /** Validated repository setting used for this selection, when present. */
  configStore?: string
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
  /** Root for local-only state (database, blobs, tickets, accounts). */
  localStateRoot: string
  /** The state tree's own worktree directory, `<localStateRoot>/worktrees`.
   * GitWorktreeProvider uses it for build worktrees only when it resolves
   * outside the checkout; otherwise it is the legacy adoption root. */
  worktreeRoot: string
  /** Per-checkout build worktree root outside the checkout's package
   * ancestry: `<stateHome>/autobuild/worktrees/<checkout-name>-<hash12>`.
   * GitWorktreeProvider chooses between it and `worktreeRoot` on canonical
   * paths and validates the choice before provisioning. */
  isolatedWorktreeRoot: string
}

/**
 * The host's per-user state home: an absolute nonblank `XDG_STATE_HOME`, else
 * `~/.local/state`. A relative value is ignored, as the XDG Base Directory
 * specification requires. Read from the host process, never a command's
 * injected environment.
 */
export function hostStateHome(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const xdg = env.XDG_STATE_HOME
  return xdg !== undefined && xdg.trim() !== '' && isAbsolute(xdg)
    ? resolve(xdg)
    : join(home, '.local', 'state')
}

/** `<sanitized checkout basename>-<sha256(localStateRoot)[:12]>`: two
 * checkouts, or two state trees of one checkout, never share a root. */
function worktreeKey(checkout: string, localStateRoot: string): string {
  const name =
    basename(checkout)
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[.-]+/, '') || 'repo'
  const hash = createHash('sha256').update(localStateRoot).digest('hex').slice(0, 12)
  return `${name}-${hash}`
}

function nonBlank(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined
}

/**
 * Select state with one precedence rule for every sessionless command:
 * non-blank explicit `--store` > non-blank `AB_STORE` > `[store] url` > local default.
 *
 * A local selection relocates the whole local tree. A remote store has no
 * filesystem root, so its local state stays beneath the repository's implicit
 * state root. Build worktrees get two candidates — the state tree's own
 * `worktrees/` and a per-checkout root under the host state home — and
 * GitWorktreeProvider chooses between them on canonical paths, so a worktree
 * never sits inside the checkout's package ancestry.
 */
export function resolveRepoStatePaths(opts: {
  /** Repository identity: a normalized origin URL, or a local checkout path. */
  repo: string
  /** The physical checkout. Defaults to `repo` so origin-less fixtures —
   * where identity IS the path — need no extra argument. */
  checkout?: string
  storeRef?: string
  envStore?: string
  configStore?: string
  /** Test seam: the host state home. Defaults to `hostStateHome()`. */
  stateHome?: string
}): RepoStatePaths {
  const checkout = resolve(opts.checkout ?? opts.repo)
  const defaultLocalRoot = join(checkout, LOCAL_STATE_DIR)
  const selected =
    nonBlank(opts.storeRef) ??
    nonBlank(opts.envStore) ??
    nonBlank(opts.configStore) ??
    defaultLocalRoot
  const remote = isRemoteStoreRef(selected)
  const storeRef = remote ? selected : resolve(checkout, selected)
  const localStateRoot = remote ? defaultLocalRoot : storeRef
  return {
    ...(opts.configStore !== undefined ? { configStore: opts.configStore } : {}),
    repo: opts.repo,
    checkout,
    defaultLocalRoot,
    storeRef,
    localStateRoot,
    worktreeRoot: join(localStateRoot, 'worktrees'),
    isolatedWorktreeRoot: join(
      opts.stateHome ?? hostStateHome(),
      'autobuild',
      'worktrees',
      worktreeKey(checkout, localStateRoot),
    ),
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

/**
 * Whether a repo-scoped stream's recorded scope belongs to `identity` — the
 * same origin-aware first arm `buildInRepository` applies to builds, with the
 * recorded side normalized like `record.repoOrigin` there so the guard never
 * depends on the writer's normalizer vintage (an scp-like ssh-spelled scope
 * equals the https identity of the same origin).
 *
 * Full parity with `buildInRepository` is impossible by construction:
 * `StreamScope` carries no `repoOrigin`, so a legacy physical-path
 * `scope.repo` (which `normalizeGitRemoteUrl` passes through unchanged) has no
 * recorded origin to compare and can never match an origin identity — it stays
 * rejected. That is the accepted AUT-314-class limitation, not something this
 * guard can forgive.
 *
 * No `exec` parameter: the caller's identity is already resolved (the
 * context's `repo` is `origin ?? resolved checkout` from `resolveRepoState`),
 * so re-running git would be redundant.
 */
export function streamInRepository(scopeRepo: string, identity: string): boolean {
  return normalizeGitRemoteUrl(scopeRepo) === identity
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
  configStore?: string
  /** Test seam: the host state home. Defaults to `hostStateHome()`. */
  stateHome?: string
}): Promise<RepoStatePaths> {
  const checkout = await resolveMainRepo(opts.targetRepo, opts.exec)
  const origin = await resolveRepoOrigin(checkout, opts.exec)
  return resolveRepoStatePaths({
    configStore:
      opts.configStore ??
      (nonBlank(opts.storeRef) || nonBlank(opts.envStore) ? undefined : configuredStore(checkout)),
    repo: origin ?? checkout,
    checkout,
    ...(opts.storeRef !== undefined ? { storeRef: opts.storeRef } : {}),
    ...(opts.envStore !== undefined ? { envStore: opts.envStore } : {}),
    ...(opts.stateHome !== undefined ? { stateHome: opts.stateHome } : {}),
  })
}
