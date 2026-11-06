import { KERNEL } from '../events/envelope'
import type { ForgeRejection } from '../ports/forge-failure'
import { ForgeRequestDeferred } from '../ports/forge-request-context'
import { readBuildFacts, type CurrentBuildFacts } from '../store/reduced-reads'
import type { BuildStore } from '../store/types'

/**
 * A forge that refuses a dispatcher-side finalize PR create for a reason a
 * retry cannot fix (a 4xx validation answer such as GitHub's "No commits
 * between") is a question for the operator, not a provider failure. One
 * escalation is raised per rejection; while it is open the request is parked
 * without calling the forge, and each answer authorizes exactly one more
 * attempt. Escalation ids are keyed by the publication request and the seq
 * of the answer that authorized the attempt (0 for the first), so a crash
 * between the rejection and its fact, or repeated ticks, never raise twice.
 */
type FinalizeRequest = {
  seq: number
  payload: { branch: string; sha: string }
}

export function finalizePrEscalationPrefix(requestSeq: number) {
  return `publication:finalize:${requestSeq}:`
}

export function finalizePrEscalationId(requestSeq: number, anchor: number) {
  return `${finalizePrEscalationPrefix(requestSeq)}${anchor}`
}

/** Returns the anchor for the next PR-create attempt, or throws: deferred
 * while a rejection awaits its answer, plainly once the build is ending. */
export function finalizePrRejectionGate(facts: CurrentBuildFacts, request: FinalizeRequest) {
  const prefix = finalizePrEscalationPrefix(request.seq)
  const open = facts.state.openEscalations.find((e) => e.id.startsWith(prefix))
  const answered = facts.state.answeredEscalations.filter((e) => e.id.startsWith(prefix))
  const latest = answered.at(-1)
  const ending =
    facts.state.status === 'aborted' ||
    facts.state.status === 'done' ||
    facts.state.discardRequest !== undefined ||
    facts.state.pendingCommands.some((command) => command.command === 'abort') ||
    latest?.resolution === 'abort'
  if ((open !== undefined || latest !== undefined) && ending)
    throw new Error(
      `finalize PR create was rejected by the forge and the build is ending; not retrying (${(open ?? latest)!.id})`,
    )
  if (open !== undefined)
    throw new ForgeRequestDeferred(
      `finalize PR create rejected by the forge; awaiting an answer to ${open.id}`,
    )
  return latest?.answeredSeq ?? 0
}

export interface FinalizePrRejectionDeps {
  store: BuildStore
}

/** Record the rejection once, then park the request. Always throws. */
export async function raiseFinalizePrRejection(
  deps: FinalizePrRejectionDeps,
  slug: string,
  request: FinalizeRequest,
  baseBranch: string,
  anchor: number,
  rejection: ForgeRejection,
): Promise<never> {
  const id = finalizePrEscalationId(request.seq, anchor)
  for (;;) {
    const facts = (await readBuildFacts(deps.store, slug)).value
    if (
      facts.state.openEscalations.some((e) => e.id === id) ||
      facts.state.answeredEscalations.some((e) => e.id === id)
    )
      break
    const raised = await deps.store.appendIfCurrent(slug, facts.state.lastSeq, {
      actor: KERNEL,
      type: 'escalation.raised',
      payload: {
        id,
        phase: 'finalize',
        round: 1,
        source: 'policy',
        policyCause: 'non-retryable-phase-failure',
        question:
          `finalize could not open the pull request: ${rejection.forge} rejected the PR create ` +
          `with HTTP ${rejection.status}: ${rejection.forgeMessage}. Branch ${request.payload.branch} ` +
          `at ${request.payload.sha} → ${baseBranch}. No sandbox or provider recovery is needed. ` +
          `Answer retry to re-attempt the PR create once (for example after pushing commits or ` +
          `fixing the base), give guidance, or abort.`,
      },
    })
    if (raised) break
  }
  throw new ForgeRequestDeferred(`finalize PR create rejected; escalated ${id}`)
}
