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
 * is the dispatcher's live snapshot exactly as before this change. */
export type PipelineSourceRef = 'branch-head' | 'base' | 'legacy-fallback'

const PIPELINE_SOURCE_REFS: readonly PipelineSourceRef[] = [
  'branch-head',
  'base',
  'legacy-fallback',
]

export function isPipelineSourceRef(value: unknown): value is PipelineSourceRef {
  return typeof value === 'string' && (PIPELINE_SOURCE_REFS as readonly string[]).includes(value)
}

/** Metadata recorded alongside every deposited effective-config artifact. */
export interface PipelineSourceMeta {
  ref: PipelineSourceRef
  /** Exact commit the pipeline sections were parsed from. Absent only for the
   * legacy fallback, where no build-branch/base read was possible. */
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

function pipeline(commit: string, ref: PipelineSourceRef, content: string): PipelineSource {
  return { meta: { ref, commit }, config: parseConfig(content, `autobuild.toml@${commit}`) }
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
  const branch = buildBranch(record, slug)
  const path = 'autobuild.toml'

  if (input.mode === 'origin') {
    const forge = input.forge
    if (forge === undefined) return undefined
    const { remoteBranchSha, readFile: forgeRead } = forge
    if (remoteBranchSha !== undefined && forgeRead !== undefined) {
      try {
        const head = await remoteBranchSha.call(forge, branch)
        return pipeline(head, 'branch-head', await forgeRead.call(forge, path, head))
      } catch {
        // Branch not yet published (or forge read failed): fall through to the
        // recorded base commit, which is exactly what the workspace was cut from.
      }
    }
    const baseSha = recordedBaseSha(events)
    if (baseSha !== undefined && forgeRead !== undefined) {
      try {
        return pipeline(baseSha, 'base', await forgeRead.call(forge, path, baseSha))
      } catch {
        // Base file unreadable (legacy logs, deleted history): legacy fallback.
      }
    }
    return undefined
  }

  const { checkout, exec, workspacePath } = input
  if (checkout !== undefined && exec !== undefined) {
    // The build branch is a ref of the shared repository: it exists from
    // provision time (cut from base) and survives workspace release, so the
    // committed head is readable at every launch boundary — including the
    // relaunch after finalize. The recorded commit is the exact sha read.
    let head: string | undefined
    try {
      const resolved = await git(['rev-parse', '--verify', `refs/heads/${branch}`], checkout, exec)
      if (resolved.exitCode === 0) head = resolved.stdout.trim()
    } catch {
      // Fall through to the recorded base commit.
    }
    if (head !== undefined) {
      // Checkout mode's primary read is the open build worktree's file — it is
      // the branch head. The committed ref read is the released-workspace
      // fallback, and the recorded commit stays the resolved branch head.
      if (workspacePath !== undefined) {
        try {
          const content = await readFile(join(workspacePath, path), 'utf8')
          return pipeline(head, 'branch-head', content)
        } catch {
          // Workspace released or unreadable: read the committed branch head.
        }
      }
      try {
        return pipeline(head, 'branch-head', await readCheckoutFile(head, path, checkout, exec))
      } catch {
        // Branch file unreadable: fall through to base.
      }
    }
    const baseSha = recordedBaseSha(events)
    if (baseSha !== undefined) {
      try {
        return pipeline(baseSha, 'base', await readCheckoutFile(baseSha, path, checkout, exec))
      } catch {
        // Base file unreadable: legacy fallback.
      }
    }
  }
  return undefined
}
