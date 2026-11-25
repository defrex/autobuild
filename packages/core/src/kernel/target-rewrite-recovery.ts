/**
 * Pure decisions for a leaf leaving the `target-rewritten` wait (SPEC §7.4).
 * The runner reads Git and the store; these helpers decide from what it read,
 * so the protocol is unit-testable without a workspace.
 */
import type { EventPayload } from '../events/payloads'
import type { LogIndex } from './log-index'
import type { BuildState } from './reducer'

export type PendingLocal = NonNullable<EventPayload<'target.rewrite-recovered'>['pendingLocal']>
export type PublishingOwner = PendingLocal['owner']

/**
 * How a resuming runner completes an open no-work reset. It never
 * re-classifies: `complete` when the branch already sits at the prepared
 * target, `redo` when it still sits at the proven head with a clean tracked
 * tree, else `unknown`, which escalates rather than resetting over commits
 * nobody proved disposable.
 */
export function reprovisionResume(
  prepared: Pick<EventPayload<'target.rewrite-reprovision-prepared'>, 'from' | 'sha'>,
  local: string | undefined,
  clean: boolean,
): 'complete' | 'redo' | 'unknown' {
  if (local === prepared.sha) return 'complete'
  if (local === prepared.from && clean) return 'redo'
  return 'unknown'
}

/**
 * The open occurrence whose own completion publishes local commits made
 * inside it: a started, uncompleted implement, finalize or reconcile phase,
 * else the finalize post-step started after finalize and not completed.
 */
export function openPublishingOwner(
  state: Pick<BuildState, 'currentPhase'>,
  log: Pick<LogIndex, 'openFinalizeStep'>,
): PublishingOwner | undefined {
  const phase = state.currentPhase?.phase
  if (phase === 'implement' || phase === 'finalize' || phase === 'reconcile')
    return { kind: 'phase', phase }
  const step = log.openFinalizeStep
  if (step !== undefined) return { kind: 'finalize-step', step: step.step, startedSeq: step.seq }
  return undefined
}

/**
 * Where an accept finds the build's local commits. `none`: everything local
 * is already published (or nothing exists beyond the base). `pending`: local
 * commits extend the published head (or the base) inside an open publishing
 * occurrence, whose completion publishes them before the restack replays
 * them. `refuse`: local commits no open occurrence owns, which the restack
 * could never replay; the accept is refused rather than discarding them.
 */
export function classifyAcceptedLocal(input: {
  local: string
  published: string | undefined
  base: string
  /** `local` is an ancestor of (or equal to) `published`. */
  localInPublished: boolean
  /** `published ?? base` is an ancestor of (or equal to) `local`. */
  localDescends: boolean
  owner: PublishingOwner | undefined
}):
  | { kind: 'none' }
  | { kind: 'pending'; pendingLocal: PendingLocal }
  | { kind: 'refuse'; from: string } {
  const { local, published, base, owner } = input
  if (published !== undefined ? input.localInPublished : local === base) return { kind: 'none' }
  if (input.localDescends && owner !== undefined)
    return { kind: 'pending', pendingLocal: { head: local, owner } }
  return { kind: 'refuse', from: published ?? base }
}

const LISTED_COMMITS = 20

/** The one operator question of a rewritten-target episode with work at
 * stake, or of a refused accept whose local commits no phase owns. */
export function targetRewriteQuestion(input: {
  slug: string
  branch: string
  previousSha: string
  sha: string
  /** `sha subject` lines, oldest first. */
  commits: { sha: string; subject: string }[]
  published?: string
  pr?: number
  unowned?: boolean
}): string {
  const short = (sha: string) => sha.slice(0, 7)
  const listed = input.commits
    .slice(0, LISTED_COMMITS)
    .map((commit) => `  ${short(commit.sha)} ${commit.subject}`)
  if (input.commits.length > LISTED_COMMITS)
    listed.push(`  and ${input.commits.length - LISTED_COMMITS} more`)
  const lines = [
    `target ${input.branch} was rewritten: its head ${short(input.sha)} does not descend from ` +
      `this build's base ${short(input.previousSha)}.`,
  ]
  if (input.unowned)
    lines.push(
      'The accept was refused: these local commits are unpublished and no open phase owns them, ' +
        'so a restack could not replay them. Remove or publish them, then answer ' +
        `\`ab answer ${input.slug} --accept-target\` again, or \`ab abort ${input.slug}\`.`,
    )
  else
    lines.push(
      `The build has its own work, so it was not reprovisioned. Answer \`ab answer ${input.slug} ` +
        `--accept-target\` to restack its own commits onto the current ${input.branch} head, ` +
        `or \`ab abort ${input.slug}\`.`,
    )
  if (input.published !== undefined) lines.push(`Published head: ${short(input.published)}.`)
  if (input.pr !== undefined) lines.push(`Pull request: #${input.pr}.`)
  if (listed.length > 0) lines.push('Own commits:', ...listed)
  return lines.join('\n')
}
