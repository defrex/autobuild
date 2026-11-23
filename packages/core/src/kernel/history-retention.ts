import { KERNEL } from '../events/envelope'
import {
  classifyGitNetworkFailure,
  isArchiveConflict,
  isForgeFailure,
} from '../ports/forge-failure'
import { ForgeRequestDeferred } from '../ports/forge-request-context'
import type { ForgeRewrite } from '../ports/types'
import type { Exec } from '../ports/workspace/git-worktree'
import { readBuildFacts } from '../store/reduced-reads'
import type { BuildStore } from '../store/types'
import { MixedVersionDeferral } from './mixed-version'
import { restoreChangeCommit, restoreRetainedCopy, retainHistoryCopy } from './replay-retention'

/**
 * Best-effort retention of the history a leaf rewrite displaces. Writes try,
 * in order: the forge's immutable archive ref, a BuildStore copy of the
 * objects the published target does not hold, and otherwise nothing (the
 * rewrite proceeds after one build-scoped warning). Reads fall back in the
 * same order and end at the published branches; a commit retained nowhere
 * makes the caller redo its work from the published branch.
 */
export type RetentionOutcome =
  | { sha: string; in: 'forge'; ref: string }
  | { sha: string; in: 'store' | 'target' }
  | { sha: string; in: 'none'; reason: string }

export interface RetentionContext {
  store: BuildStore
  slug: string
  exec: Exec
  workspacePath: string
  archive: ForgeRewrite['archive']
  /** The published target head the rewrite is based on. A store copy holds
   * only objects it does not reach. */
  exclude: string
  /** Local-git: no remote to consult. */
  local: boolean
  /** Published build branch, fetched as a last resort when restoring. */
  branch?: string
  /** Published target branch, fetched as a last resort when restoring. */
  targetBranch?: string
}

/** Recovery needs a commit that is retained nowhere: redo the work from the
 * published branch instead. */
export class RetainedHistoryUnavailable extends Error {
  constructor(readonly sha: string) {
    super(`displaced history ${sha} is retained nowhere; redo from the published branch`)
    this.name = 'RetainedHistoryUnavailable'
  }
}

/** The build-scoped observation id that warns, once, that history went unretained. */
export const UNRETAINED_OBSERVATION = 'history-unretained'

export const archiveRef = (slug: string, sha: string) => `refs/autobuild/archive/${slug}/${sha}`

/** True when an archive failure is a refusal the fallback may absorb. Transient
 * transport failures, deferrals and immutable-ref conflicts stay errors. */
export function isArchiveRefusal(error: unknown): boolean {
  return !(
    isForgeFailure(error) ||
    error instanceof ForgeRequestDeferred ||
    error instanceof MixedVersionDeferral ||
    isArchiveConflict(error)
  )
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function git(ctx: RetentionContext, args: string[]) {
  return ctx.exec(['git', ...args], { cwd: ctx.workspacePath })
}
async function present(ctx: RetentionContext, sha: string) {
  return (await git(ctx, ['cat-file', '-e', `${sha}^{commit}`])).exitCode === 0
}
/** A remote read that tolerates refusal and absence but rethrows transient
 * transport failures, so the operation retries instead of redoing work. */
async function remote(ctx: RetentionContext, args: string[]) {
  let result: Awaited<ReturnType<Exec>>
  try {
    result = await git(ctx, args)
  } catch (error) {
    const classified = classifyGitNetworkFailure(error)
    if (isForgeFailure(classified)) throw classified
    return null
  }
  if (result.exitCode !== 0) {
    const classified = classifyGitNetworkFailure(new Error(result.stderr || result.stdout))
    if (isForgeFailure(classified)) throw classified
    return null
  }
  return result
}

export async function retainCommit(ctx: RetentionContext, sha: string): Promise<RetentionOutcome> {
  const ref = archiveRef(ctx.slug, sha)
  let refusal: unknown
  try {
    await ctx.archive({ workspacePath: ctx.workspacePath, ref, sha })
    return { sha, in: 'forge', ref }
  } catch (error) {
    if (!isArchiveRefusal(error)) throw error
    refusal = error
  }
  // The forge path above is unchanged; only a refusal restores a missing
  // object from the other sources before classifying it.
  await restoreCommit(ctx, sha)
  if ((await git(ctx, ['merge-base', '--is-ancestor', sha, ctx.exclude])).exitCode === 0)
    return { sha, in: 'target' }
  try {
    await retainHistoryCopy(ctx, sha, ctx.exclude)
    return { sha, in: 'store' }
  } catch (error) {
    return {
      sha,
      in: 'none',
      reason: `${message(refusal)}; BuildStore copy failed: ${message(error)}`,
    }
  }
}

export async function restoreCommit(ctx: RetentionContext, sha: string): Promise<boolean> {
  if (await present(ctx, sha)) return true
  if (!ctx.local) {
    const ref = archiveRef(ctx.slug, sha)
    const listed = await remote(ctx, ['ls-remote', '--refs', 'origin', ref])
    if (listed !== null && listed.stdout.trim().split(/\s+/).join(' ') === `${sha} ${ref}`) {
      await remote(ctx, ['fetch', '--refmap=', '--no-tags', '--no-write-fetch-head', 'origin', ref])
      if (await present(ctx, sha)) return true
    }
  }
  if ((await restoreChangeCommit(ctx, sha)) || (await restoreRetainedCopy(ctx, sha))) return true
  if (ctx.local) return false
  // A thin copy completes only over its exclusion base, which the published
  // branches normally hold; they may also hold the commit itself.
  for (const branch of [ctx.branch, ctx.targetBranch])
    if (branch !== undefined)
      await remote(ctx, [
        'fetch',
        '--refmap=',
        '--no-tags',
        '--no-write-fetch-head',
        'origin',
        `refs/heads/${branch}`,
      ])
  if (await present(ctx, sha)) return true
  return restoreRetainedCopy(ctx, sha)
}

/** Writes the paper trail. The warning precedes the decisive fact, so a crash
 * never loses it; its fixed id makes it appear once per build. */
export async function recordRetention(
  store: BuildStore,
  slug: string,
  scope: { operation: 'restack' | 'reconcile'; id: string; base: string },
  outcomes: readonly RetentionOutcome[],
): Promise<void> {
  if (!outcomes.some((outcome) => outcome.in !== 'forge')) return
  const facts = (await readBuildFacts(store, slug)).value
  const none = outcomes.filter((outcome) => outcome.in === 'none')
  if (none.length > 0 && !facts.observations.some((o) => o.id === UNRETAINED_OBSERVATION)) {
    const shas = [...new Set(none.map((outcome) => outcome.sha))]
    await store.append(slug, {
      actor: KERNEL,
      type: 'observation.recorded',
      payload: {
        id: UNRETAINED_OBSERVATION,
        kind: 'followup',
        summary: `Displaced history not retained for ${shas.join(', ')}: the forge refused archive refs and the BuildStore copy failed (${none[0]!.reason}); the rewrite proceeded. Later unretained commits in this build are recorded in history.retained without another warning.`,
        refs: shas,
      },
    })
  }
  const known = facts.retainedHistory
  const pick = (where: 'store' | 'target') => [
    ...new Set(
      outcomes
        .filter((outcome) => outcome.in === where && !known[where].includes(outcome.sha))
        .map((outcome) => outcome.sha),
    ),
  ]
  const kept = new Set(
    outcomes.filter((o) => o.in === 'store' || o.in === 'target').map((o) => o.sha),
  )
  const payload = {
    ...scope,
    store: pick('store'),
    target: pick('target'),
    unretained: [
      ...new Set(
        none
          .map((outcome) => outcome.sha)
          .filter(
            (sha) =>
              !kept.has(sha) &&
              !known.unretained.includes(sha) &&
              !known.store.includes(sha) &&
              !known.target.includes(sha),
          ),
      ),
    ],
  }
  if (payload.store.length + payload.target.length + payload.unretained.length === 0) return
  await store.append(slug, { actor: KERNEL, type: 'history.retained', payload })
}
