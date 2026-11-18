import type { AbEvent } from '../events/catalog'
import type { Phase } from '../ontology'
import { isVerifyPhase, verifyStep } from '../ontology'
import { isPhaseTerminalEvent, phaseSpecFor } from './phases'
import { defineReducer } from './incremental'
type CliEnv = { phase: Phase; round: number; session: string }
interface TerminalGuardAcc {
  reconcileAttempt: number
  sessionStartedSeq?: number
  permanent?: { seq: number; diagnostic: string }
  completion?: { seq: number; diagnostic: string }
  /** The build's undecided or open ticket wait, from any session. Waits are
   * build-wide, so a concurrent verifier may not declare a second one. */
  wait?: { id: string; session: string; tickets: string[]; escalation?: string }
}
export function terminalGuardReducer(env: CliEnv) {
  const spec = phaseSpecFor(env.phase)
  return defineReducer<TerminalGuardAcc, AbEvent, { diagnostic?: string; waitHeld?: string }>({
    version: 5,
    initial: () => ({ reconcileAttempt: 0 }),
    fold(acc, events) {
      for (const event of events) {
        if (event.type === 'spec.revised' && (isVerifyPhase(env.phase) || env.phase === 'finalize'))
          delete acc.completion
        if (event.type === 'reconcile.started') acc.reconcileAttempt = event.payload.attempt
        if (event.type === 'session.started' && event.payload.session === env.session)
          acc.sessionStartedSeq = event.seq
        foldWait(acc, event)
        try {
          checkEvent(event, env, acc.reconcileAttempt, acc.sessionStartedSeq)
        } catch (error) {
          const key = isPhaseTerminalEvent(spec, event) ? 'completion' : 'permanent'
          acc[key] ??= { seq: event.seq, diagnostic: (error as Error).message }
        }
      }
    },
    finish(acc) {
      const first = [acc.permanent, acc.completion]
        .filter((item) => item !== undefined)
        .sort((a, b) => a.seq - b.seq)[0]
      return {
        ...(first ? { diagnostic: first.diagnostic } : {}),
        ...(acc.wait ? { waitHeld: waitHeldDiagnostic(acc.wait) } : {}),
      }
    },
  })
}
function foldWait(acc: TerminalGuardAcc, event: AbEvent): void {
  if (event.type === 'wait.requested' && event.actor.kind === 'agent')
    acc.wait = {
      id: event.payload.id,
      session: event.actor.session,
      tickets: [...event.payload.tickets],
    }
  else if (event.type === 'wait.entered' && acc.wait?.id === event.payload.id)
    acc.wait.escalation = event.payload.escalation
  else if (
    (event.type === 'wait.refused' || event.type === 'wait.ended') &&
    acc.wait?.id === event.payload.id
  )
    delete acc.wait
  else if (
    event.type === 'escalation.answered' &&
    acc.wait?.escalation !== undefined &&
    acc.wait.escalation === event.payload.id
  )
    delete acc.wait
}
/** One wait per build at a time: a second declaration while another session's
 * wait is undecided or open would replace it, losing its tickets. */
function waitHeldDiagnostic(wait: NonNullable<TerminalGuardAcc['wait']>): string {
  return (
    `wait rejected: session "${wait.session}" already declared wait "${wait.id}" on ` +
    `${wait.tickets.join(', ')}, and a build holds one ticket wait at a time. ` +
    'End this session with its ordinary terminal; if it also depends on other ' +
    'tickets, name them with ab escalate instead.'
  )
}
function checkEvent(
  event: AbEvent,
  env: CliEnv,
  reconcileAttempt: number,
  sessionStartedSeq?: number,
): void {
  const spec = phaseSpecFor(env.phase)
  const restartSeq = 0
  if (event.type === 'session.started' && event.payload.continuation?.predecessor === env.session)
    throw new Error(
      `terminal rejected (D5): session "${env.session}" was superseded by continuation ${event.payload.session}`,
    )
  if (
    (event.type === 'session.ended' || event.type === 'session.suspended') &&
    event.payload.session === env.session
  ) {
    throw new Error(
      `terminal rejected (D5): session "${env.session}" already ${event.type === 'session.suspended' ? 'suspended' : 'ended'} ` +
        `(${event.type} at seq ${event.seq}) — a session that ended without ` +
        'a terminal was failed and retried; only the live retry may complete ' +
        'this phase round (§8.4).',
    )
  }
  if (
    sessionStartedSeq !== undefined &&
    event.type === 'phase.failed' &&
    event.payload.phase === env.phase &&
    event.payload.round === env.round &&
    event.seq > sessionStartedSeq
  ) {
    throw new Error(
      `terminal rejected (D5): ${env.phase}@${env.round} already failed after ` +
        `this session started (phase.failed at seq ${event.seq}) — the retry ` +
        'session owns this round now (§8.4).',
    )
  }
  if (
    event.type === 'escalation.raised' &&
    event.actor.kind === 'agent' &&
    event.actor.session === env.session
  ) {
    throw new Error(
      `second terminal call rejected (D5): this session already escalated — ` +
        `escalation.raised "${event.payload.id}" at seq ${event.seq}. ` +
        'Every phase ends with exactly one terminal command (§8.4).',
    )
  }
  if (
    event.type === 'wait.requested' &&
    event.actor.kind === 'agent' &&
    event.actor.session === env.session
  ) {
    throw new Error(
      `second terminal call rejected (D5): this session already declared a wait — ` +
        `wait.requested "${event.payload.id}" at seq ${event.seq}. ` +
        'Every phase ends with exactly one terminal command (§8.4).',
    )
  }
  if (
    event.type === 'publication.requested' &&
    event.actor.kind === 'agent' &&
    event.actor.session === env.session &&
    ((env.phase === 'implement' &&
      event.payload.operation === 'implement' &&
      event.payload.round === env.round) ||
      (env.phase === 'reconcile' && event.payload.operation === 'reconcile') ||
      (env.phase === 'finalize' && event.payload.operation === 'finalize'))
  ) {
    throw new Error(
      `second terminal call rejected (D5): ${event.type} for ` +
        `${env.phase}@${env.round} already recorded at seq ${event.seq}. ` +
        'Remote publication is pending; do not run ab done again (§8.4).',
    )
  }
  if (
    event.type === 'verify.cancelled' &&
    isVerifyPhase(env.phase) &&
    event.payload.step === verifyStep(env.phase) &&
    event.payload.attempt === env.round
  )
    throw new Error(
      `terminal rejected: ${env.phase}@${env.round} was cancelled by verify:${event.payload.cause.step}`,
    )
  if (!isPhaseTerminalEvent(spec, event)) return
  if (
    (event.type === 'verify.completed' || event.type === 'finalize.completed') &&
    event.seq <= restartSeq
  ) {
    return
  }
  if (!terminalMatchesRound(event, env, reconcileAttempt)) return
  throw new Error(
    `second terminal call rejected (D5): ${event.type} for ` +
      `${env.phase}@${env.round} already recorded at seq ${event.seq}. ` +
      'Every phase ends with exactly one terminal command (§8.4).',
  )
}
function terminalMatchesRound(event: AbEvent, env: CliEnv, reconcileAttempt: number): boolean {
  switch (event.type) {
    case 'plan.completed':
    case 'plan-review.verdict':
    case 'implement.completed':
    case 'implement.declined':
    case 'code-review.verdict':
      return event.payload.round === env.round
    case 'verify.completed':
      return (
        isVerifyPhase(env.phase) &&
        event.payload.step === verifyStep(env.phase) &&
        event.payload.attempt === env.round
      )
    case 'finalize.completed':
      // finalize runs once per build (§5) — any prior completion counts.
      return true
    case 'reconcile.completed':
      // No started event before it → conservative match (total over any log).
      return reconcileAttempt === env.round || reconcileAttempt === 0
    default:
      return false
  }
}
