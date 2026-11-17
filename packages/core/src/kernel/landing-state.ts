import type { AbEvent } from '../events/catalog'
import type { LandingRule } from '../config/schema'
import type { EventPayload } from '../events/payloads'
import { landingCandidateId, type LandingCandidate } from './landing-policy'

export interface LandingState {
  applicationFailure?: EventPayload<'landing.application-failed'>
  nativeEnablePending?: number
  forgeMerge?: EventPayload<'landing.forge-merged'>
  decision?: EventPayload<'landing.decided'> & { seq: number }
  /** The newest candidate whose decision waits for its recorded changed paths. */
  deferral?: EventPayload<'landing.deferred'> & { seq: number }
  command?: {
    kind: 'hold' | 'land'
    seq: number
    decisionSeq?: number
    /** The candidate head of the decision this consent named; absent for legacy commands. */
    head?: string
    /** The path-predicate rule the named decision matched; only consent given
     * under such a rule is revocable by a reconcile's edits. */
    rule?: { index: number; snapshot: LandingRule }
    legacy?: true
  }
  acknowledgedSeq?: number
  native?: EventPayload<'landing.native-applied'> & { seq: number }
}

export function advanceLanding(state: LandingState, event: AbEvent): void {
  switch (event.type) {
    case 'node.parent-accepted':
      // Acceptance durably revokes consent to the former destination. Holds
      // remain in force; readiness must sample policy for the new parent.
      if (state.command?.kind === 'land') {
        delete state.command
        delete state.acknowledgedSeq
      }
      delete state.decision
      delete state.deferral
      delete state.native
      break
    case 'landing.decided':
      delete state.applicationFailure
      delete state.deferral
      state.decision = { ...event.payload, seq: event.seq }
      break
    case 'landing.deferred':
      state.deferral = { ...event.payload, seq: event.seq }
      break
    case 'build.hold-requested':
      delete state.applicationFailure
      state.command = { kind: 'hold', seq: event.seq }
      break
    case 'build.land-requested': {
      const decision =
        state.decision?.seq === event.payload.decisionSeq ? state.decision : undefined
      const rule = decision && 'index' in decision.rule ? decision.rule : undefined
      state.command = {
        kind: 'land',
        seq: event.seq,
        decisionSeq: event.payload.decisionSeq,
        ...(decision ? { head: decision.candidate.head } : {}),
        ...(rule && (rule.snapshot.paths !== undefined || rule.snapshot.within !== undefined)
          ? { rule: { index: rule.index, snapshot: { ...rule.snapshot } } }
          : {}),
      }
      break
    }
    case 'landing.consent-revoked':
      // Only the consent it names; a later hold or consent stands.
      if (state.command?.kind === 'land' && state.command.seq === event.payload.commandSeq) {
        delete state.command
        delete state.acknowledgedSeq
      }
      break
    case 'landing.command-acknowledged':
      if (event.payload.commandSeq === state.command?.seq)
        state.acknowledgedSeq = event.payload.commandSeq
      break
    case 'pr.auto-merge-enabled':
    case 'pr.auto-merge-disabled':
      // Historical provider acknowledgements remain applied-state evidence.
      state.native = {
        enabled: event.type === 'pr.auto-merge-enabled',
        seq: event.seq,
      }
      if (
        event.type === 'pr.auto-merge-disabled' &&
        event.payload.commandSeq === state.command?.seq
      )
        state.acknowledgedSeq = event.payload.commandSeq
      break
    case 'landing.native-enable-started':
      state.nativeEnablePending = event.seq
      break
    case 'landing.forge-merged':
      state.forgeMerge = event.payload
      break
    case 'landing.application-failed':
      state.applicationFailure = event.payload
      break
    case 'landing.native-applied':
      delete state.applicationFailure
      if (event.payload.enableSeq === state.nativeEnablePending) delete state.nativeEnablePending
      state.native = { ...event.payload, seq: event.seq }
      break
    case 'build.auto-merge-requested':
    case 'build.auto-merge-cancelled':
      // Historical defaults were operational policy, never explicit consent.
      // New commands supersede every legacy control, even one appended later.
      if (event.payload.defaultSeq !== undefined || (state.command && !state.command.legacy)) break
      state.command = {
        kind: event.type === 'build.auto-merge-requested' ? 'land' : 'hold',
        seq: event.seq,
        legacy: true,
      }
      if (event.type === 'build.auto-merge-requested') state.acknowledgedSeq = event.seq
      break
  }
}

export function landingAuthorized(landing: LandingState | undefined): boolean {
  if (landing?.command?.kind === 'hold') return false
  if (landing?.command?.legacy && landing.command.kind === 'land') return true
  if (!landing?.decision) return false
  return landing.command?.kind === 'land' || landing.decision.mode === 'auto'
}

export function sameLandingCandidate(
  left: LandingCandidate | undefined,
  right: LandingCandidate | undefined,
): boolean {
  return !!left && !!right && landingCandidateId(left) === landingCandidateId(right)
}

export function nativeLandingApplied(landing: LandingState | undefined): boolean {
  const native = landing?.native
  return (
    !!native?.enabled &&
    native.decisionSeq === landing?.decision?.seq &&
    native.commandSeq === landing?.command?.seq &&
    sameLandingCandidate(native.candidate, landing?.decision?.candidate)
  )
}
