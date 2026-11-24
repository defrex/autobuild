/**
 * The phase.failed tally that guards phase retries. Pure so the reducer
 * registry can register it without importing process code.
 */
import type { AbEvent } from '../events/catalog'
import type { EventPayload } from '../events/payloads'
import type { Phase } from '../ontology'
import {
  resetsPhaseFailureBudget,
  type PhaseFailureResetEscalation,
} from '../processes/phase-failure-budget'
import { defineReducer } from './incremental'
import { verifyMemberKey } from './verify-stage-state'

type ProviderAttempt = NonNullable<EventPayload<'phase.failed'>['providerAttempts']>[number]

export interface PhaseFailureTally {
  count: number
  lastError?: string
  lastWillRetry?: boolean
  lastProviderAttempts?: readonly ProviderAttempt[]
}

/**
 * phase.failed tally for one phase+round — D5's retry-guard input. A factory
 * because phase and round are parameters of the projection.
 *
 * An answered escalation re-arms this budget only when its semantic class
 * acknowledges phase-runner failures (§15.6-B). Runner-failure causes reset
 * their matching round, the phase-level verify cause resets all rounds, and
 * unrelated policy causes reset nothing. Cause-less historical and
 * non-policy raises retain the legacy round-shaped behavior. Failures after
 * an applicable answer count again, so a still-failing phase re-escalates on
 * new evidence instead of deadlocking before its recovery session starts.
 */
export function phaseFailuresReducer(phase: Phase, round: number) {
  return defineReducer<
    {
      /** id → the raise's reset semantics — answers are matched by id (§15.3). */
      raised: Record<string, PhaseFailureResetEscalation & { session?: string }>
      owners: Record<string, string>
      cancelled: Record<string, boolean>
      count: number
      lastError?: string
      lastWillRetry?: boolean
      lastProviderAttempts?: readonly ProviderAttempt[]
    },
    AbEvent,
    PhaseFailureTally
  >({
    identity: 'phaseFailures',
    initial: () => ({ raised: {}, owners: {}, cancelled: {}, count: 0 }),
    fold(acc, events) {
      for (const event of events) {
        switch (event.type) {
          case 'session.started':
            if (event.payload.phase?.startsWith('verify:') && event.payload.round !== undefined)
              acc.owners[event.payload.session] = verifyMemberKey(
                event.payload.phase.slice(7),
                event.payload.round,
              )
            break
          case 'verify.cancelled':
            acc.cancelled[verifyMemberKey(event.payload.step, event.payload.attempt)] = true
            break
          case 'phase.deferral-escalated':
            acc.raised[event.payload.id] = {
              phase: event.payload.phase,
              round: event.payload.round,
              source: 'policy',
              deferral: 'own-build-read',
            }
            break
          // A ticket wait's escalation (`wait.entered`) is deliberately not
          // registered: ending a wait is not a failure retry, so its answer
          // re-arms no budget.
          case 'escalation.raised':
            acc.raised[event.payload.id] = {
              phase: event.payload.phase,
              source: event.payload.source,
              ...(event.actor.kind === 'agent' ? { session: event.actor.session } : {}),
              ...(event.payload.policyCause !== undefined
                ? { policyCause: event.payload.policyCause }
                : {}),
              ...(event.payload.round !== undefined ? { round: event.payload.round } : {}),
            }
            break
          case 'escalation.answered': {
            const raise = acc.raised[event.payload.id]
            if (raise?.session && acc.cancelled[acc.owners[raise.session] ?? '']) break
            if (raise !== undefined && resetsPhaseFailureBudget(raise, phase, round)) {
              acc.count = 0
              delete acc.lastError
              delete acc.lastWillRetry
              delete acc.lastProviderAttempts
            }
            break
          }
          case 'phase.failed':
            if (event.payload.phase === phase && event.payload.round === round) {
              acc.count += 1
              acc.lastError = event.payload.error
              acc.lastWillRetry = event.payload.willRetry
              acc.lastProviderAttempts = event.payload.providerAttempts
            }
            break
          default:
            break
        }
      }
    },
    finish: (acc) => ({
      count: acc.count,
      ...(acc.lastError !== undefined ? { lastError: acc.lastError } : {}),
      ...(acc.lastWillRetry !== undefined ? { lastWillRetry: acc.lastWillRetry } : {}),
      ...(acc.lastProviderAttempts !== undefined
        ? { lastProviderAttempts: acc.lastProviderAttempts }
        : {}),
    }),
  })
}
