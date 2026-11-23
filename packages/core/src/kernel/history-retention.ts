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
import type { EventWrite } from '../events/catalog'
import type { BuildStore } from '../store/types'
import { MixedVersionDeferral } from './mixed-version'
import {
  historyCopyBase,
  restoreChangeCommit,
  restoreRetainedCopy,
  retainHistoryCopy,
} from './replay-retention'

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
  const archive = async () => {
    try {
      await ctx.archive({ workspacePath: ctx.workspacePath, ref, sha })
      return undefined
    } catch (error) {
      if (!isArchiveRefusal(error)) throw error
      return error ?? new Error('archive refused')
    }
  }
  const missing = !(await present(ctx, sha))
  // The forge path is unchanged: a present object, or a remote-only one the
  // forge can archive itself, is archived first.
  let refusal = await archive()
  if (refusal === undefined) return { sha, in: 'forge', ref }
  // An object the forge could not see may be retained elsewhere (for example a
  // prepared change kept only as reconcile-change-<sha>). Restore it, and give
  // an accepting forge its archive ref before falling back to a store copy.
  if ((await restoreCommit(ctx, sha)) && missing) {
    refusal = await archive()
    if (refusal === undefined) return { sha, in: 'forge', ref }
  }
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

/** Depth bound for chains of store copies whose saved base is itself a copy. */
const CHAIN_DEPTH = 8

/** Restore `sha` like `restoreCommit`, and when its store copy was saved over
 * a base that is itself absent, restore that base first through its own
 * retention, following the chain to a bound. */
export async function restoreRetainedHead(
  ctx: RetentionContext,
  sha: string,
  depth = CHAIN_DEPTH,
  visited: Set<string> = new Set(),
): Promise<boolean> {
  if (visited.has(sha)) return false
  visited.add(sha)
  if (await restoreCommit(ctx, sha)) return true
  if (depth <= 0) return false
  const base = await historyCopyBase(ctx.store, ctx.slug, sha)
  if (base === null || (await present(ctx, base))) return false
  if (!(await restoreRetainedHead(ctx, base, depth - 1, visited))) return false
  return restoreCommit(ctx, sha)
}

/** Keep `sha` as a BuildStore copy for strict workspace preservation, and
 * make sure the copy's saved base is recoverable: a published ancestor of
 * `ctx.exclude`, or itself retained, to a bounded depth. Resolves to the
 * copy's actual exclusion base. Throws when the copy or its base cannot be
 * kept, so the caller refuses to release the work. */
export async function retainPreservedCopy(
  ctx: RetentionContext,
  sha: string,
  depth = CHAIN_DEPTH,
  visited: Set<string> = new Set(),
): Promise<string> {
  if (visited.has(sha)) throw new Error(`retained history chain repeats at ${sha}`)
  visited.add(sha)
  const base = await retainHistoryCopy(ctx, sha, ctx.exclude)
  if (base === ctx.exclude) return base
  // An earlier copy saved over another base: that base must come back too.
  if (!(await present(ctx, base)) && !(await restoreRetainedHead(ctx, base)))
    throw new Error(`the saved base ${base} of the store copy of ${sha} is unavailable`)
  if ((await git(ctx, ['merge-base', '--is-ancestor', base, ctx.exclude])).exitCode === 0)
    return base
  if (depth <= 0) throw new Error(`retained history chain for ${sha} exceeds ${CHAIN_DEPTH}`)
  await retainPreservedCopy(ctx, base, depth - 1, visited)
  return base
}

/** Make a reserved node input present again during recovery. An accepting
 * forge takes the same archive call as before (it may fetch a remote-only
 * object); after a refusal the input comes back from wherever it is retained.
 * False when it is retained nowhere: the caller redoes the write from the
 * published branches. */
export async function recoverReservedInput(
  ctx: RetentionContext,
  sha: string,
  ref = archiveRef(ctx.slug, sha),
): Promise<boolean> {
  try {
    await ctx.archive({ workspacePath: ctx.workspacePath, ref, sha })
    return true
  } catch (error) {
    if (!isArchiveRefusal(error)) throw error
    return restoreRetainedHead(ctx, sha)
  }
}

/** Strict retention of unpublished work that exists nowhere else: the forge
 * archive ref, then a store copy. Never `target` or `none`; throws naming
 * both failures when neither holds it. Non-refusal archive errors rethrow. */
export async function preserveRetained(
  ctx: RetentionContext,
  sha: string,
): Promise<{ remoteRef: string } | { storeBase: string }> {
  const ref = archiveRef(ctx.slug, sha)
  try {
    await ctx.archive({ workspacePath: ctx.workspacePath, ref, sha })
    return { remoteRef: ref }
  } catch (error) {
    if (!isArchiveRefusal(error)) throw error
    try {
      return { storeBase: await retainPreservedCopy(ctx, sha) }
    } catch (copy) {
      throw new Error(
        `unpublished commit ${sha} could not be preserved: archive refused (${message(error)}); BuildStore copy failed (${message(copy)})`,
        { cause: copy },
      )
    }
  }
}

export type RetentionScope =
  | { event?: 'history.retained'; operation: 'restack' | 'reconcile'; id: string; base: string }
  | {
      event: 'node.history-retained'
      operation: 'restack' | 'landing' | 'integration-landing' | 'verify'
      id: string
      base: string
    }

/** Writes the paper trail. The warning precedes the decisive fact, so a crash
 * never loses it; its fixed id makes it appear once per build. `append`
 * substitutes a caller's lease-renewing writer. */
export async function recordRetention(
  store: BuildStore,
  slug: string,
  scope: RetentionScope,
  outcomes: readonly RetentionOutcome[],
  append: (write: EventWrite) => Promise<unknown> = (write) => store.append(slug, write),
): Promise<void> {
  if (!outcomes.some((outcome) => outcome.in !== 'forge')) return
  const { event = 'history.retained', ...fields } = scope
  const facts = (await readBuildFacts(store, slug)).value
  const none = outcomes.filter((outcome) => outcome.in === 'none')
  if (none.length > 0 && !facts.observations.some((o) => o.id === UNRETAINED_OBSERVATION)) {
    const shas = [...new Set(none.map((outcome) => outcome.sha))]
    await append({
      actor: KERNEL,
      type: 'observation.recorded',
      payload: {
        id: UNRETAINED_OBSERVATION,
        kind: 'followup',
        summary: `Displaced history not retained for ${shas.join(', ')}: the forge refused archive refs and the BuildStore copy failed (${none[0]!.reason}); the write proceeded. Later unretained commits in this build are recorded in ${event} without another warning.`,
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
    ...fields,
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
  await append(
    event === 'history.retained'
      ? {
          actor: KERNEL,
          type: 'history.retained',
          payload: payload as EventWrite<'history.retained'>['payload'],
        }
      : {
          actor: KERNEL,
          type: 'node.history-retained',
          payload: payload as EventWrite<'node.history-retained'>['payload'],
        },
  )
}
