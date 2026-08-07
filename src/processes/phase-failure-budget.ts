import type { EscalationSource, EscalationTarget, Phase, PolicyEscalationCause } from '../ontology'

export type PhaseFailureBudgetResetScope = 'none' | 'matching-round' | 'all-phase-rounds'

/**
 * Closed policy semantics for answering a phase-failure budget escalation.
 * Adding a policy cause must choose its effect here rather than inheriting one
 * from the incidental presence or absence of `round`.
 */
export const POLICY_PHASE_FAILURE_RESET_SCOPES = {
  'review-round-limit': 'matching-round',
  'verify-failure-limit': 'all-phase-rounds',
  'reconcile-no-progress': 'none',
  'setup-failure-limit': 'none',
  'phase-attempt-limit': 'matching-round',
  'non-retryable-phase-failure': 'matching-round',
} as const satisfies Record<PolicyEscalationCause, PhaseFailureBudgetResetScope>

export interface PhaseFailureResetEscalation {
  phase: EscalationTarget
  round?: number
  source: EscalationSource
  policyCause?: PolicyEscalationCause
}

/**
 * Whether answering one raise re-arms the queried phase+round failure budget.
 * Cause-less historical policy raises and non-policy raises retain the legacy
 * shape rule so old logs replay without migration.
 */
export function resetsPhaseFailureBudget(
  raise: PhaseFailureResetEscalation,
  phase: Phase,
  round: number,
): boolean {
  if (raise.phase !== phase) return false

  if (raise.source !== 'policy' || raise.policyCause === undefined) {
    return raise.round === undefined || raise.round === round
  }

  const scope = POLICY_PHASE_FAILURE_RESET_SCOPES[raise.policyCause]
  switch (scope) {
    case 'none':
      return false
    case 'matching-round':
      return raise.round === round
    case 'all-phase-rounds':
      return true
  }
}
