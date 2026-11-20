/**
 * Reopening a settled, unmerged leaf (SPEC §15.7): the pure predicates the
 * control, engine, capacity, landing readiness, `ab context` and status
 * surfaces share. Every input is already-reduced `BuildState`; nothing here
 * reads the store.
 *
 * A feedback-only reopen opens a new code loop: its seq is the log index's
 * `codeRestartSeq`, so implement, code review, verify and finalize run again
 * on the existing branch while the plan stays approved. A reopen with a spec
 * restarts from plan once the kernel publishes that spec as the next
 * `spec.revised`; until then the engine parks on `awaiting-spec`.
 */
import { discardInFlight, type BuildState } from './reducer'
import { epilogueLeaf, epilogueUnsettled } from './dispatch-capacity'
import { pendingMeasurementRequest } from './measurement'

export interface ReopenRefusal {
  /** A `BuildControlErrorCode`. */
  code: 'inactive' | 'abort-pending' | 'discard-pending' | 'not-reopenable'
  message: string
}

/** A recorded reopen whose spec the kernel has not published yet. */
export function reopenSpecPending(state: Pick<BuildState, 'reopen'>): boolean {
  return state.reopen?.spec !== undefined && state.reopen.specPublishedSeq === undefined
}

/** The restart the latest reopen opened by publishing its spec is the
 * current restart: no later spec revision superseded it. */
export function reopenRestart(state: Pick<BuildState, 'reopen' | 'restartSince'>): boolean {
  return (
    state.reopen?.specPublishedSeq !== undefined &&
    state.reopen.specPublishedSeq === state.restartSince
  )
}

/** Whether the latest reopen still governs the current spec: a feedback-only
 * reopen after the latest spec revision, or the reopen whose spec is the
 * current revision. A later escalation spec revision supersedes it. */
export function reopenCurrent(state: Pick<BuildState, 'reopen' | 'restartSince'>): boolean {
  const reopen = state.reopen
  if (reopen === undefined) return false
  return reopen.spec !== undefined ? reopenRestart(state) : reopen.seq > state.restartSince
}

/** A nonterminal leaf reopened since it last settled: it is re-running its
 * pipeline and is not awaiting merge. */
export function reopenUnsettled(
  state: Pick<BuildState, 'kind' | 'status' | 'reopen' | 'pipelineSettled'>,
): boolean {
  return (
    state.kind !== 'node' &&
    state.status !== 'done' &&
    state.status !== 'aborted' &&
    state.reopen !== undefined &&
    state.reopen.seq > (state.pipelineSettled ?? 0)
  )
}

/** Where a reopen sends the leaf. */
export function reopenRoute(reopen: NonNullable<BuildState['reopen']>): 'implement' | 'plan' {
  return reopen.spec !== undefined ? 'plan' : 'implement'
}

const NEW_TICKET = 'a fixup for a merged or closed pull request is a new ticket (SPEC §15.7)'

function hasPendingAbort(state: BuildState): boolean {
  return state.pendingCommands.some((command) => command.command === 'abort')
}

/** The refusals both reopen guards share, in order: status, pending abort or
 * discard, and an ended pull request. */
function terminalRefusal(slug: string, state: BuildState): ReopenRefusal | undefined {
  if (state.status === 'done' || state.status === 'aborted')
    return {
      code: 'inactive',
      message:
        `build "${slug}" is ${state.status}${state.outcome !== undefined ? ` (${state.outcome})` : ''}; ` +
        `a finished build cannot be reopened: ${NEW_TICKET}`,
    }
  if (state.status === 'queued')
    return {
      code: 'inactive',
      message: `build "${slug}" has not started (status: queued); only a settled leaf can be reopened`,
    }
  if (hasPendingAbort(state))
    return {
      code: 'abort-pending',
      message: `build "${slug}" is aborting; abort is not revocable, so it cannot be reopened`,
    }
  if (discardInFlight(state))
    return {
      code: 'discard-pending',
      message: `build "${slug}" has an outstanding discard request, so it cannot be reopened`,
    }
  if (state.prState === 'merged' || state.prState === 'closed')
    return {
      code: 'not-reopenable',
      message: `build "${slug}"'s pull request is ${state.prState}; ${NEW_TICKET}`,
    }
  return undefined
}

/** Why `ab reopen` refuses this build, or undefined when it is a settled,
 * unmerged leaf. `attempt` says the build is an optimization attempt, whose
 * node's landing gate owns its lifecycle. A paused settled leaf is accepted:
 * the engine parks the reopen until resume. */
export function reopenRefusal(
  slug: string,
  state: BuildState,
  opts: { attempt?: boolean; restackActive?: boolean } = {},
): ReopenRefusal | undefined {
  if (state.status !== 'done' && state.status !== 'aborted' && state.status !== 'queued') {
    if (state.kind === 'node')
      return {
        code: 'not-reopenable',
        message:
          `build "${slug}" is an integration node and cannot be reopened; add a child ticket, ` +
          `push a commit to its branch, or revise its spec with ab answer ${slug} --revise-spec`,
      }
    if (opts.attempt)
      return {
        code: 'not-reopenable',
        message:
          `build "${slug}" is an optimization attempt; its node's landing gate decides it, ` +
          'so it cannot be reopened',
      }
  }
  const ended = terminalRefusal(slug, state)
  if (ended) return ended
  if (state.prState !== 'open')
    return {
      code: 'not-reopenable',
      message:
        `build "${slug}" has not settled awaiting merge (pull request: ${state.prState ?? 'not opened'}); ` +
        'only a leaf that finished its pipeline can be reopened',
    }
  if (state.openEscalations.length > 0 || state.status === 'blocked')
    return {
      code: 'not-reopenable',
      message: `build "${slug}" is blocked on an open escalation; answer it with ab answer ${slug}`,
    }
  if (
    !epilogueLeaf(state) ||
    epilogueUnsettled(state) ||
    reopenUnsettled(state) ||
    state.sessions.open.length > 0 ||
    state.currentPhase !== undefined ||
    opts.restackActive ||
    pendingMeasurementRequest(state) !== undefined
  )
    return {
      code: 'not-reopenable',
      message:
        `build "${slug}" has not settled awaiting merge; it is still running its pipeline. ` +
        'Reopen it once it waits for its merge decision',
    }
  return undefined
}

/** Why the kernel must not publish a recorded reopen's spec now, or
 * undefined. Unlike `reopenRefusal` it does not require settlement: after
 * `build.reopened` the leaf is deliberately unsettled, and the engine parks on
 * `awaiting-spec`, so no session or escalation can arise before publication.
 * The caller checks `reopenSpecPending` for whether publication is due. */
export function reopenPublicationRefusal(
  slug: string,
  state: BuildState,
): ReopenRefusal | undefined {
  const refusal = terminalRefusal(slug, state)
  if (refusal === undefined) return undefined
  return {
    code: refusal.code,
    message: `the reopen of build "${slug}" was recorded but its spec was not published: ${refusal.message}; nothing further was written`,
  }
}
