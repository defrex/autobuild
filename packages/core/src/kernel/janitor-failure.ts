import type { BuildState } from './reducer'
import type { BuildStatus } from '../ontology'
import type { BuildStore } from '../store/types'
import { DISPATCHER } from '../events/envelope'
import { isForgeFailure } from '../ports/forge-failure'
import { ForgeRequestDeferred } from '../ports/forge-request-context'

/** Repository-level scheduling signals: not a janitor failure, never aged as one. */
export function janitorDeferral(error: unknown): boolean {
  return (
    error instanceof ForgeRequestDeferred ||
    (isForgeFailure(error) && error.details.kind === 'rate-limited')
  )
}

/** The janitor stage an attempt was in when it failed, named in the escalation. */
export type JanitorOperation =
  | 'build state read'
  | 'native auto-merge cancellation'
  | 'integration landing audit'
  | 'PR attachment reclaim'
  | 'control command'
  | 'node integration'
  | 'node cascade'
  | 'empty node poll'
  | 'abort cleanup'
  | 'discard cleanup'
  | 'target observation'
  | 'PR check'

/** A build's janitor attempt is due: no episode, an answered escalation asked
 * for a retry, or the backoff has elapsed. */
export function janitorDue(janitor: BuildState['janitor'], now: Date): boolean {
  return (
    !janitor ||
    janitor.retryRequested === true ||
    Date.parse(janitor.nextAttemptAt) <= now.getTime()
  )
}

/** One escalation per episode, identified by the episode's first failure. */
export function janitorEscalationId(firstFailureAt: string): string {
  return `janitor:${firstFailureAt}`
}

type StatusState = Pick<BuildState, 'status' | 'statusWithoutJanitorEscalation'>

/** The status the janitor acts on: its own escalation never gates the work
 * that would recover it, so a build blocked only by that escalation reads as
 * it would without it. Every other case is the build's status. */
export function janitorStatus(state: StatusState): BuildStatus {
  return state.statusWithoutJanitorEscalation ?? state.status
}

export function janitorBlocked(state: StatusState): boolean {
  return janitorStatus(state) === 'blocked'
}

export function escalationsBeyondJanitor(state: Pick<BuildState, 'openEscalations'>) {
  return state.openEscalations.filter((e) => !e.janitor)
}

/** The build as the janitor's landing decisions see it: without its janitor
 * escalation, so a failing landing step is retried rather than skipped. */
export function withoutJanitorEscalation(state: BuildState): BuildState {
  if (state.statusWithoutJanitorEscalation === undefined) return state
  const { statusWithoutJanitorEscalation: status, ...rest } = state
  return { ...rest, status, openEscalations: escalationsBeyondJanitor(state) }
}

export async function recordJanitorFailure(
  store: BuildStore,
  slug: string,
  previous: BuildState['janitor'],
  message: string,
  now: Date,
  policy: {
    janitorBackoffMaxSeconds: number
    janitorFailureAttentionSeconds: number
    janitorFailureEscalationSeconds: number
  },
  operation: JanitorOperation,
): Promise<void> {
  const attempt = (previous?.attempt ?? 0) + 1
  const firstFailureAt = previous?.firstFailureAt ?? now.toISOString()
  const age = now.getTime() - Date.parse(firstFailureAt)
  await store.append(slug, {
    actor: DISPATCHER,
    type: 'build.janitor-attempt-failed',
    payload: {
      firstFailureAt,
      attempt,
      message,
      nextAttemptAt: new Date(
        now.getTime() +
          Math.min(policy.janitorBackoffMaxSeconds, 30 * 2 ** Math.min(attempt - 1, 30)) * 1000,
      ).toISOString(),
    },
  })
  if (!previous?.attention && age >= policy.janitorFailureAttentionSeconds * 1000)
    await store.append(slug, {
      actor: DISPATCHER,
      type: 'build.janitor-failing',
      payload: { message },
    })
  // Wall-clock from the episode's first failure, checked only on a failed
  // attempt; a deferral never reaches here. A crash after the appends above
  // leaves `escalation` unset, so the next failure raises it.
  if (previous && !previous.escalation && age >= policy.janitorFailureEscalationSeconds * 1000) {
    const line = message.replace(/\s+/g, ' ').trim()
    await store.append(slug, {
      actor: DISPATCHER,
      type: 'build.janitor-escalated',
      payload: {
        id: janitorEscalationId(firstFailureAt),
        operation,
        message,
        attempt,
        firstFailureAt,
        question:
          `Janitor ${operation} has failed ${attempt} consecutive attempts since ${firstFailureAt}. ` +
          `Last error: ${line}. The janitor keeps retrying and closes this escalation when an ` +
          'attempt succeeds. Fix the cause, then answer with a bare retry to attempt now.',
      },
    })
  }
}
