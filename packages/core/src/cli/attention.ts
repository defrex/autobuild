import { effectiveTreeTarget } from './dashboard/tree'
import type { BuildStreamSeed } from '../kernel/read-facts'
import { buildReducer } from '../kernel/reducer'
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

/** Gate deferrals and unsafe forge outcomes remain merge attention.
 * Consent and holds are represented exclusively by consent-ready. */
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
    state.janitor?.attention === true ||
    !!state.targetRewrite ||
    (state.compatibility?.decisiveFacts ?? 0) > 0 ||
    (state.openEscalations?.length ?? 0) > 0 ||
    mergeDecision(events, new Date(0), state) !== null
  )
}

export function mergeIdentity(slug: string, pr: number): string {
  return JSON.stringify([slug, pr])
}

export function repositoryNeedsAttention(event: RepositoryEvent): boolean {
  switch (event.type) {
    case 'account.credentials-unavailable':
    case 'harvest.escalated':
    case 'harvest.recovery-exhausted':
    case 'dispatcher.forge-readiness-failed':
    case 'dispatcher.config-rejected':
    case 'dispatcher.runtime-rolled-back':
    case 'dispatcher.upgrade-failed':
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

export function consentReady(seed: BuildStreamSeed, observedAt: Date) {
  const state = buildReducer.finish(seed.build)
  const episode = seed.consentEpisode
  if (!episode) return null
  return {
    type: 'build.consent-ready' as const,
    observedAt: observedAt.toISOString(),
    target: effectiveTreeTarget(state),
    candidate: state.landing!.decision!.candidate,
    reason: state.landing?.command?.kind === 'hold' ? 'held' : 'consent required',
    branch: seed.branch ?? state.nodeOpening?.branch,
    position: episode.seq,
  }
}
export type ConsentReady = NonNullable<ReturnType<typeof consentReady>>
export function consentIdentity(slug: string, seq: number): string {
  return JSON.stringify(['consent', slug, seq])
}
