/**
 * Pipeline-source resolution (SPEC §16.1): where a build's build-owned config
 * sections come from. A build's pipeline is pinned to its own branch — the
 * branch head once the build has published commits there, otherwise the
 * recorded base commit its workspace was cut from. The dispatcher resolves
 * this once per deposit (launch and reload), records the exact commit in the
 * effective-config artifact's metadata, and never substitutes a later
 * base-branch change (the AUT-366 class of failure).
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AbEvent } from '../events/catalog'
import type { Forge } from '../ports/types'
import type { Exec } from '../ports/workspace/git-worktree'
import type { BuildRecord } from '../store/types'
import { parseConfig } from './load'
import type { Config } from './schema'

/** Which fact the pinned pipeline was read from. `legacy-fallback` marks the
 * no-migration path: no recorded base (or an unreadable one), so the deposit
 * is the dispatcher's live snapshot exactly as before this change.
 * `worktree-dirty` marks the checkout-mode worktree read whose git-normalized
 * content does not match the resolved branch head (uncommitted edits, or a
 * file never committed): no commit is recorded, because attributing worktree
 * content to the branch-head commit would be false provenance. */
export type PipelineSourceRef = 'branch-head' | 'base' | 'legacy-fallback' | 'worktree-dirty'

const PIPELINE_SOURCE_REFS: readonly PipelineSourceRef[] = [
  'branch-head',
  'base',
  'legacy-fallback',
  'worktree-dirty',
]

export function isPipelineSourceRef(value: unknown): value is PipelineSourceRef {
  return typeof value === 'string' && (PIPELINE_SOURCE_REFS as readonly string[]).includes(value)
}

/** Metadata recorded alongside every deposited effective-config artifact. */
export interface PipelineSourceMeta {
  ref: PipelineSourceRef
  /** Exact commit the pipeline sections were parsed from. Absent for the
   * legacy fallback (no build-branch/base read was possible) and for
   * `worktree-dirty` (worktree bytes that no commit claims). */
  commit?: string
}

export interface PipelineSource {
  meta: PipelineSourceMeta
  /** The parsed build-owned tables. */
  config: Config
}

export interface PipelineSourceInput {
  slug: string
  record: Pick<BuildRecord, 'branch'>
  events: readonly AbEvent[]
  /** 'origin' reads through the forge; 'checkout' reads through git exec in
   * the dispatcher's checkout (build branches are refs of the shared repo). */
  mode: 'origin' | 'checkout'
  /** Origin-mode read capability. Required to read through the forge; absent
   * degrades to the recorded base / legacy fallback. */
  forge?: Forge
  /** Checkout-mode seam: the physical main checkout and exec. */
  checkout?: string
  exec?: Exec
  /** Checkout-mode seam: the open build worktree, whose `autobuild.toml` is
   * the branch head. Preferred over `git show` when the file exists. */
  workspacePath?: string
  /** Optional degradation sink: one failure per read/parse attempt that forced
   * a fallback, in order. Callers surface the actionable ones as per-build
   * diagnostics (SPEC §16.1) instead of the resolver throwing. */
  onFailure?: (failure: PipelineSourceFailure) => void
}

/** Why a resolution degraded. `unpublished`, `base-source` and `no-base` are
 * the documented fallback order (a build whose branch is not published yet, a
 * legacy build with no readable recorded base) — normal operation, quiet.
 * `capability` and `branch-source` are failures an operator can act on: a
 * wiring gap, or a build-branch source that resolved but cannot be read or
 * parsed. */
export type PipelineSourceFailureKind =
  | 'capability'
  | 'unpublished'
  | 'branch-source'
  | 'base-source'
  | 'no-base'
  | 'store'

export interface PipelineSourceFailure {
  kind: PipelineSourceFailureKind
  detail: string
}

/** The failure kinds worth an operator-facing diagnostic: a wiring gap, a
 * build-branch source that resolved but cannot be read or parsed, or a store
 * failure — each something an operator (or the build's author) can fix. */
export function isActionablePipelineFailure(failure: PipelineSourceFailure): boolean {
  return (
    failure.kind === 'capability' || failure.kind === 'branch-source' || failure.kind === 'store'
  )
}

/** The recorded base commit of the build's latest workspace. The newest
 * `workspace.provisioned` wins: a re-provisioned workspace is what the build's
 * current environment was cut from. */
export function recordedBaseSha(events: readonly AbEvent[]): string | undefined {
  let base: string | undefined
  for (const event of events) {
    if (event.type === 'workspace.provisioned') base = event.payload.base.sha
  }
  return base
}

function buildBranch(record: Pick<BuildRecord, 'branch'>, slug: string): string {
  return record.branch ?? `ab/${slug}`
}

function git(
  args: string[],
  cwd: string,
  exec: Exec,
): Promise<{ stdout: string; exitCode: number; stderr: string }> {
  return exec(['git', ...args], { cwd })
}

async function readCheckoutFile(
  ref: string,
  path: string,
  checkout: string,
  exec: Exec,
): Promise<string> {
  const result = await git(['show', `${ref}:${path}`], checkout, exec)
  if (result.exitCode !== 0) {
    throw new Error(`git show ${ref}:${path} failed: ${result.stderr.trim() || '(no output)'}`)
  }
  return result.stdout
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Parse a read file into a pipeline source, or `undefined` when the TOML is
 * malformed. A branch-source parse failure is terminal: the build's own branch
 * exists but carries an unparseable pipeline, so falling back to the recorded
 * base would run the build under a pipeline that is not its own — the AUT-366
 * poisoning by another door. The caller keeps the build's last good deposit
 * instead (SPEC §16.1). */
function parsePipeline(
  commit: string | undefined,
  ref: PipelineSourceRef,
  content: string,
  onFailure: (failure: PipelineSourceFailure) => void,
): PipelineSource | undefined {
  const label = commit === undefined ? ref : `${ref}@${commit}`
  try {
    return {
      meta: commit === undefined ? { ref } : { ref, commit },
      config: parseConfig(content, `autobuild.toml@${label}`),
    }
  } catch (error) {
    onFailure({
      // `worktree-dirty` is a branch-source failure: the malformed file sits on
      // the build's own side (its open worktree), so a base fallback would run
      // the build under a pipeline that is not its own — same as `branch-head`.
      kind: ref === 'base' ? 'base-source' : 'branch-source',
      detail: `malformed autobuild.toml at ${label}: ${message(error)}`,
    })
    return undefined
  }
}

/**
 * Resolve the pipeline source for one build, or `undefined` for the legacy
 * fallback. Every failure — missing capability, missing base record, unread
 * file, malformed TOML — degrades to the fallback instead of failing the
 * caller: a config deposit is never allowed to fail a dispatcher tick or a
 * launch.
 *
 * The resolution rule (SPEC §16.1): the build's branch head once it resolves
 * (origin mode: the forge's remote branch; checkout mode: the shared repo's
 * branch ref), else the workspace's recorded base commit. The caller re-
 * resolves at every launch, so a build that publishes pipeline changes to its
 * own branch picks them up at its next launch.
 */
export async function resolvePipelineSource(
  input: PipelineSourceInput,
): Promise<PipelineSource | undefined> {
  const { slug, record, events } = input
  const onFailure = input.onFailure ?? (() => {})
  const branch = buildBranch(record, slug)
  const path = 'autobuild.toml'

  if (input.mode === 'origin') {
    const forge = input.forge
    if (forge === undefined) {
      onFailure({ kind: 'capability', detail: 'origin mode with no forge' })
      return undefined
    }
    const { remoteBranchSha, readFile: forgeRead } = forge
    if (remoteBranchSha === undefined || forgeRead === undefined) {
      onFailure({
        kind: 'capability',
        detail:
          `forge lacks the ${remoteBranchSha === undefined ? 'remoteBranchSha' : 'readFile'} ` +
          'capability the pipeline-source read needs',
      })
    } else {
      let head: string | undefined
      try {
        head = await remoteBranchSha.call(forge, branch)
      } catch (error) {
        // Branch not yet published (or the forge failed): fall through to the
        // recorded base commit, which is exactly what the workspace was cut
        // from. Surfaced as `unpublished` either way — the normal order.
        onFailure({
          kind: 'unpublished',
          detail: `forge remoteBranchSha(${branch}) failed: ${message(error)}`,
        })
      }
      if (head !== undefined) {
        let content: string | undefined
        try {
          content = await forgeRead.call(forge, path, head)
        } catch (error) {
          // The branch resolved but its file did not come back: an actionable
          // forge failure, not an unpublished branch.
          onFailure({
            kind: 'branch-source',
            detail: `forge readFile(${path}, ${head}) failed: ${message(error)}`,
          })
        }
        if (content !== undefined) {
          // A malformed build-branch file is terminal: the build's own branch
          // exists, so the recorded base is not its pipeline either.
          return parsePipeline(head, 'branch-head', content, onFailure)
        }
      }
    }
    const baseSha = recordedBaseSha(events)
    if (baseSha === undefined) {
      onFailure({ kind: 'no-base', detail: 'no recorded base commit (legacy build)' })
      return undefined
    }
    if (forgeRead === undefined) return undefined
    let baseContent: string | undefined
    try {
      baseContent = await forgeRead.call(forge, path, baseSha)
    } catch (error) {
      // Base file unreadable (legacy logs, deleted history): legacy fallback.
      onFailure({
        kind: 'base-source',
        detail: `forge readFile(${path}, base ${baseSha}) failed: ${message(error)}`,
      })
      return undefined
    }
    return parsePipeline(baseSha, 'base', baseContent, onFailure)
  }

  const { checkout, exec, workspacePath } = input
  if (checkout === undefined || exec === undefined) {
    onFailure({ kind: 'capability', detail: 'checkout mode with no checkout or exec seam' })
    return undefined
  }
  // The build branch is a ref of the shared repository: it exists from
  // provision time (cut from base) and survives workspace release, so the
  // committed head is readable at every launch boundary — including the
  // relaunch after finalize. The recorded commit is the exact sha read.
  let head: string | undefined
  try {
    const resolved = await git(['rev-parse', '--verify', `refs/heads/${branch}`], checkout, exec)
    if (resolved.exitCode === 0) {
      head = resolved.stdout.trim()
    } else {
      // Unpublished branch: the normal order, resolved from the base next.
      onFailure({
        kind: 'unpublished',
        detail: `git rev-parse refs/heads/${branch} failed: ${
          resolved.stderr.trim() || '(no output)'
        }`,
      })
    }
  } catch (error) {
    // Fall through to the recorded base commit.
    onFailure({
      kind: 'unpublished',
      detail: `git rev-parse refs/heads/${branch} failed: ${message(error)}`,
    })
  }
  if (head !== undefined) {
    // Checkout mode's primary read is the open build worktree's file — it is
    // the branch head. The committed ref read is the released-workspace
    // fallback, and the recorded commit stays the resolved branch head.
    if (workspacePath !== undefined) {
      try {
        const content = await readFile(join(workspacePath, path), 'utf8')
        // The worktree file may carry uncommitted edits, so it is only the
        // branch head's when git sees no difference between them. Compare
        // git-normalized identity, not raw bytes: the stored blob can differ
        // textually from the worktree file (core.autocrlf, eol attributes)
        // while carrying the same content, so byte equality against `git show`
        // output would misclassify a clean worktree as dirty. Hash the
        // worktree file the way git would store it — `git hash-object` run in
        // the workspace applies the same clean conversion as check-in — and
        // compare against the committed blob's oid. Equal → attribute to the
        // head commit as before; different bytes, a file the head never
        // carried, or any failed comparison (a non-git workspace, a transient
        // git error) → `worktree-dirty` with no commit: the provenance
        // declines to attribute worktree bytes to any commit. A comparison
        // failure is caught here, not by the committed-ref fallback below —
        // it degrades to dirty, never to a different source.
        let clean = false
        try {
          const [committedBlob, worktreeBlob] = await Promise.all([
            git(['rev-parse', '--verify', `${head}:${path}`], checkout, exec),
            exec(['git', 'hash-object', '--', path], { cwd: workspacePath }),
          ])
          clean =
            committedBlob.exitCode === 0 &&
            worktreeBlob.exitCode === 0 &&
            committedBlob.stdout.trim() === worktreeBlob.stdout.trim()
        } catch {
          clean = false
        }
        if (clean) {
          // A malformed worktree file is terminal: the committed ref carries the
          // same content, so the recorded base is not the build's pipeline
          // either. The caller keeps the build's last good deposit.
          return parsePipeline(head, 'branch-head', content, onFailure)
        }
        return parsePipeline(undefined, 'worktree-dirty', content, onFailure)
      } catch (error) {
        // Workspace released or unreadable: read the committed branch head.
        onFailure({
          kind: 'unpublished',
          detail: `workspace file ${join(workspacePath, path)} unreadable: ${message(error)}`,
        })
      }
    }
    let content: string | undefined
    try {
      content = await readCheckoutFile(head, path, checkout, exec)
    } catch (error) {
      // The ref resolved but its file did not come back: corruption or an
      // exec failure — actionable, unlike an unpublished branch.
      onFailure({
        kind: 'branch-source',
        detail: `git show ${head}:${path} failed: ${message(error)}`,
      })
    }
    if (content !== undefined) {
      // Malformed committed branch file: terminal, as above.
      const parsed = parsePipeline(head, 'branch-head', content, onFailure)
      if (parsed === undefined) return undefined
      return parsed
    }
  }
  const baseSha = recordedBaseSha(events)
  if (baseSha === undefined) {
    onFailure({ kind: 'no-base', detail: 'no recorded base commit (legacy build)' })
    return undefined
  }
  let baseContent: string | undefined
  try {
    baseContent = await readCheckoutFile(baseSha, path, checkout, exec)
  } catch (error) {
    // Base file unreadable: legacy fallback.
    onFailure({
      kind: 'base-source',
      detail: `git show ${baseSha}:${path} failed: ${message(error)}`,
    })
    return undefined
  }
  return parsePipeline(baseSha, 'base', baseContent, onFailure)
}
