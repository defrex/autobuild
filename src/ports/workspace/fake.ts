/**
 * FakeWorkspaceProvider (SPEC §3.2): WorkspaceProvider for seam tests. Its
 * default filesystem mode copies a source working tree so the returned path
 * has the same usable-path semantics as GitWorktreeProvider. High-volume
 * process-decision tests may explicitly select `logical` mode when their
 * synthetic repo/path values are intentionally not filesystem fixtures.
 *
 * Shape parity with GitWorktreeProvider: `ref` and `path` are the same
 * string (`<root>/<branch>`), provision is idempotent per branch (resume is
 * a re-run, not a special path — constitution #2), and release of an
 * unknown or already-released workspace is a no-op, never an error.
 */
import { cp, mkdir, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { WorkspaceBase } from '../../ontology'
import type { WorkspaceHandle, WorkspaceProvider, WorkspaceProvisionResult } from '../types'

export interface ProvisionRecord {
  repo: string
  baseBranch: string
  branch: string
}

export type FakeWorkspaceMode = 'filesystem' | 'logical'

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export class FakeWorkspaceProvider implements WorkspaceProvider {
  readonly name = 'fake'

  /** Journals — public so tests assert directly on call order and args. */
  readonly provisions: ProvisionRecord[] = []
  readonly releases: WorkspaceHandle[] = []

  private readonly root: string
  private readonly initialBase: WorkspaceBase
  private readonly mode: FakeWorkspaceMode
  /** ref → handle for workspaces provisioned and not yet released. */
  private readonly active = new Map<string, WorkspaceHandle>()
  /** Durable fake branch heads survive release, like real Git branches. */
  private readonly branchHeads = new Map<string, string>()
  private readonly failures = new Map<'provision' | 'release', Error>()

  constructor(
    opts: {
      root?: string
      base?: WorkspaceBase
      /** Default `filesystem` enforces a real usable working-copy path. */
      mode?: FakeWorkspaceMode
    } = {},
  ) {
    this.root = resolve(opts.root ?? '/fake/workspaces')
    this.initialBase = opts.base ?? { source: 'remote', sha: 'fake-base-sha' }
    this.mode = opts.mode ?? 'filesystem'
  }

  /**
   * Injectable failure: while set, the named operation throws `error` on
   * every call (pass `null` to clear). Lets tests drive the provision/release
   * failure paths without a real provider.
   */
  setFailure(op: 'provision' | 'release', error: Error | null): void {
    if (error === null) this.failures.delete(op)
    else this.failures.set(op, error)
  }

  /** Whether the workspace at `ref` is currently provisioned. */
  isActive(ref: string): boolean {
    return this.active.has(ref)
  }

  /** Test seam for commits made between provision calls. */
  setBranchHead(branch: string, sha: string): void {
    this.branchHeads.set(branch, sha)
  }

  async provision(opts: {
    repo: string
    baseBranch: string
    branch: string
  }): Promise<WorkspaceProvisionResult> {
    const failure = this.failures.get('provision')
    if (failure) throw failure
    const ref = resolve(join(this.root, opts.branch))
    const existing = this.active.get(ref)
    if (existing) {
      if (this.mode === 'logical' || (await pathExists(existing.path))) {
        this.provisions.push({ ...opts })
        return {
          ...existing,
          base: {
            source: 'existing',
            sha: this.branchHeads.get(opts.branch) ?? this.initialBase.sha,
          },
        }
      }
      // The active map is only process-local bookkeeping. If its filesystem
      // working copy disappeared out of band, forget that stale registration
      // and rematerialize below without changing the durable fake branch head.
      this.active.delete(ref)
    }

    if (this.mode === 'filesystem') {
      await mkdir(dirname(ref), { recursive: true })
      // The fake owns its root. Remove an out-of-band leftover before making
      // the new active working copy, just as worktree prune permits recovery.
      await rm(ref, { recursive: true, force: true })
      await cp(opts.repo, ref, { recursive: true })
    }

    const handle: WorkspaceHandle = {
      provider: this.name,
      ref,
      path: ref,
      branch: opts.branch,
    }
    this.active.set(ref, handle)
    this.provisions.push({ ...opts })

    const existingSha = this.branchHeads.get(opts.branch)
    if (existingSha !== undefined) {
      return { ...handle, base: { source: 'existing', sha: existingSha } }
    }
    this.branchHeads.set(opts.branch, this.initialBase.sha)
    return { ...handle, base: { ...this.initialBase } }
  }

  /** Idempotent: releasing an unknown or already-released handle is a no-op
   * (matching GitWorktreeProvider's already-gone-worktree behavior). */
  async release(handle: WorkspaceHandle): Promise<void> {
    const failure = this.failures.get('release')
    if (failure) throw failure
    this.releases.push({
      provider: handle.provider,
      ref: handle.ref,
      path: handle.path,
      branch: handle.branch,
    })
    const active = this.active.get(handle.ref)
    if (!active) return
    if (this.mode === 'filesystem') {
      await rm(active.path, { recursive: true, force: true })
    }
    this.active.delete(handle.ref)
  }
}
