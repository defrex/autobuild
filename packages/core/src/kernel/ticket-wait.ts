import type { WaitEndCause } from '../events/payloads'
import type { AnsweredEscalation, BuildState } from './reducer'

/**
 * Ticket waits (SPEC §11 "Ticket waits"): a phase agent declares with
 * `ab wait-on` that its build cannot proceed until other tickets complete.
 * The declaration (`wait.requested`) is the session's terminal; the
 * dispatcher validates it against the ticket source and answers with
 * `wait.entered` or `wait.refused`. An entered wait opens an escalation that
 * an operator answer, or `wait.ended`, closes. A leaf waiting on tickets
 * holds no capacity slot and keeps its workspace, branch and phase work.
 *
 * Every helper here reads reduced state only, so per-tick callers cost the
 * same at any log length.
 */

function terminal(state: Pick<BuildState, 'status'>): boolean {
  return state.status === 'done' || state.status === 'aborted'
}

/** A nonterminal build's ticket-wait request the dispatcher has not yet
 * accepted or refused. The build holds its slot during this window. */
export function pendingWaitRequest(
  state: Pick<BuildState, 'status' | 'waitRequest'>,
): BuildState['waitRequest'] {
  const request = state.waitRequest
  return request !== undefined && request.outcome === undefined && !terminal(state)
    ? request
    : undefined
}

/** The entered wait while its escalation is still open. */
export function openTicketWait(
  state: Pick<BuildState, 'status' | 'wait' | 'openEscalations'>,
): BuildState['wait'] {
  const wait = state.wait
  return wait !== undefined &&
    wait.ended === undefined &&
    !terminal(state) &&
    state.openEscalations.some((escalation) => escalation.id === wait.escalation)
    ? wait
    : undefined
}

/** A nonterminal leaf parked by a ticket wait: the wait is open, or ended and
 * not yet resumed, and no other escalation is open. Parked leaves hold no
 * capacity slot; an ended wait requests one to resume. */
export function waitParked(state: BuildState): boolean {
  const wait = state.wait
  if (state.kind === 'node' || terminal(state) || wait === undefined) return false
  if (wait.resumedSeq !== undefined) return false
  if (wait.ended === undefined && openTicketWait(state) === undefined) return false
  return state.openEscalations.every((escalation) => escalation.id === wait.escalation)
}

/** The wait ended and the build may take a slot to resume its declaring
 * phase. A `revise-spec` answer keeps it parked until the revision lands. */
export function waitResumeDue(state: BuildState): boolean {
  const wait = state.wait
  if (!waitParked(state) || wait?.ended === undefined) return false
  return !state.answeredEscalations.some(
    (escalation) => escalation.id === wait.escalation && escalation.resolution === 'revise-spec',
  )
}

/** Refused wait requests, shaped as answered guidance so the engine routes
 * and delivers them exactly like an answered escalation: the id is the
 * request id, the answer is the refusal message, and `answeredSeq` is the
 * refusal's seq. Only the latest request can carry one. */
export function waitGuidance(state: Pick<BuildState, 'waitRequest'>): Array<
  Pick<AnsweredEscalation, 'id' | 'phase' | 'source' | 'answer' | 'answeredSeq'> & {
    wait: { id: string }
  }
> {
  const request = state.waitRequest
  if (request?.outcome?.kind !== 'refused') return []
  return [
    {
      id: request.id,
      phase: request.phase,
      source: 'agent',
      wait: { id: request.id },
      answer: request.outcome.message,
      answeredSeq: request.outcome.seq,
    },
  ]
}

/** What a resumed or re-run session is told about its wait, in
 * `guidance.json`'s `wait` block. Undefined unless the latest request was
 * refused, or the latest entered wait ended, for this phase and round. */
export interface WaitBlock {
  id: string
  tickets: string[]
  reason: string
  outcome: 'refused' | 'ended'
  cause?: string
  message: string
}

export function waitBlock(
  state: Pick<BuildState, 'waitRequest' | 'wait'>,
  phase: string,
  round: number,
): WaitBlock | undefined {
  const wait = state.wait
  const request = state.waitRequest
  if (
    request?.outcome?.kind === 'refused' &&
    request.phase === phase &&
    request.round === round &&
    (wait === undefined || request.seq > wait.enteredSeq)
  )
    return {
      id: request.id,
      tickets: request.tickets,
      reason: request.reason,
      outcome: 'refused',
      cause: request.outcome.cause,
      message: request.outcome.message,
    }
  if (wait?.ended !== undefined && wait.phase === phase && wait.round === round)
    return {
      id: wait.id,
      tickets: wait.tickets.map((ticket) => ticket.id),
      reason: wait.reason,
      outcome: 'ended',
      cause: wait.ended.cause,
      message: wait.ended.message,
    }
  return undefined
}

/** One-line summary for a session whose wait ended or was refused without
 * guidance text of its own (a bare retry answer). */
export function waitSummary(block: WaitBlock): string {
  const tickets = block.tickets.join(', ')
  return block.outcome === 'refused'
    ? `Your wait on ${tickets} was refused: ${block.message}`
    : `Your wait on ${tickets} ended (${block.cause ?? 'operator'}): ${block.message}`
}

/** A ticket wait as status surfaces show it: a request awaiting the
 * dispatcher's check, an open wait, or an ended wait not yet resumed. */
export type TicketWaitStatus =
  | { state: 'requested'; id: string; tickets: string[]; reason: string }
  | {
      state: 'waiting'
      id: string
      escalation: string
      tickets: string[]
      reason: string
      since: string
    }
  | {
      state: 'ended'
      id: string
      escalation: string
      tickets: string[]
      reason: string
      cause: WaitEndCause
    }

export function ticketWaitStatus(state: BuildState): TicketWaitStatus | undefined {
  const request = pendingWaitRequest(state)
  if (request !== undefined)
    return { state: 'requested', id: request.id, tickets: request.tickets, reason: request.reason }
  const wait = state.wait
  if (wait === undefined) return undefined
  const base = {
    id: wait.id,
    escalation: wait.escalation,
    tickets: wait.tickets.map((ticket) => ticket.id),
    reason: wait.reason,
  }
  if (openTicketWait(state) !== undefined)
    return { state: 'waiting', ...base, since: wait.enteredAt }
  if (wait.ended !== undefined && waitParked(state))
    return { state: 'ended', ...base, cause: wait.ended.cause }
  return undefined
}

/** One status line for a ticket wait, without the label. */
export function ticketWaitText(wait: TicketWaitStatus): string {
  const tickets = wait.tickets.join(', ')
  switch (wait.state) {
    case 'requested':
      return `wait requested on ${tickets}: awaiting dispatcher check`
    case 'waiting':
      return `${tickets} — ${wait.reason} (since ${wait.since}; end early with ab answer ${wait.escalation})`
    case 'ended':
      return `wait on ${tickets} ended (${wait.cause}); resume waiting for a slot`
  }
}
