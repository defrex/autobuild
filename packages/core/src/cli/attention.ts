import type { AbEvent } from '../events/catalog'
import type { RepositoryEvent } from '../events/repository'
import {
  currentDeferralObservationReducer,
  mergeAttentionFromFacts,
  type DeferralLedger,
} from '../kernel/auto-merge'
import { reduceBuild, type BuildState } from '../kernel/reducer'

export interface MergeDecision {
  type: 'build.merge-decision'
  pr: { number: number; url: string; headSha: string }
  reason: string
  observedAt: string
}

/** Consent pending application is armed; only a current actionable deferral
 * or withdrawn consent needs a person. Currency is owned by the kernel. */
export function mergeDecision(
  events: AbEvent[],
  now: Date,
  state = reduceBuild(events),
): MergeDecision | null {
  return mergeDecisionFromFacts(state, currentDeferralObservationReducer.reduce(events), now)
}

export function mergeDecisionFromFacts(
  state: BuildState,
  ledger: DeferralLedger,
  now: Date,
): MergeDecision | null {
  const decision = mergeAttentionFromFacts(state, ledger)
  return decision
    ? { type: 'build.merge-decision', ...decision, observedAt: now.toISOString() }
    : null
}

export function buildNeedsAttention(events: AbEvent[], state: BuildState): boolean {
  return (
    (state.openEscalations?.length ?? 0) > 0 || mergeDecision(events, new Date(0), state) !== null
  )
}

export function mergeIdentity(slug: string, pr: number): string {
  return JSON.stringify([slug, pr])
}

export function repositoryNeedsAttention(event: RepositoryEvent): boolean {
  switch (event.type) {
    case 'harvest.escalated':
    case 'harvest.recovery-exhausted':
    case 'dispatcher.config-rejected':
      return true
    case 'dispatcher.config-reloaded':
      return event.payload.restartRequired.length > 0
    case 'dispatcher.run-stopped':
      return event.payload.outcome === 'abnormal'
    default:
      return false
  }
}

export { RepositoryAttention, type PersistenceObservation } from '../kernel/repository-attention'
