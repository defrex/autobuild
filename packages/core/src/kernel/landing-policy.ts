import type { LandingRule } from '../config/schema'

/** The frozen destination identity, never the source ticket's mutable parent. */
export type LandingTarget = { kind: 'root' } | { kind: 'node'; ticket: string }
export interface LandingPolicyInput {
  from: 'leaf' | 'node'
  into: LandingTarget
  labels: readonly string[]
}
export interface LandingPolicyMatch {
  mode: 'auto' | 'consent'
  /** Zero-based position and complete rule as sampled at readiness. */
  rule: { index: number; snapshot: LandingRule } | { default: true }
}

export function evaluateLandingPolicy(
  rules: readonly LandingRule[],
  input: LandingPolicyInput,
): LandingPolicyMatch {
  for (const [index, rule] of rules.entries()) {
    if (rule.from !== undefined && rule.from !== input.from) continue
    if (rule.label !== undefined && !input.labels.includes(rule.label)) continue
    if (rule.into !== undefined) {
      if (rule.into === 'root') {
        if (input.into.kind !== 'root') continue
      } else if (rule.into === 'node') {
        if (input.into.kind !== 'node') continue
      } else if (input.into.kind !== 'node' || rule.into !== input.into.ticket) continue
    }
    return { mode: rule.mode, rule: { index, snapshot: { ...rule } } }
  }
  return {
    mode: input.from === 'leaf' ? 'auto' : 'consent',
    rule: { default: true },
  }
}

/** Policy decisions and native application receipts bind to this exact
 * readiness candidate. Operator consent instead binds to the landing. */
export interface LandingCandidate {
  head: string
  parent: string
  cycle: string
}
export function landingCandidateId(candidate: LandingCandidate): string {
  return JSON.stringify([candidate.head, candidate.parent, candidate.cycle])
}
