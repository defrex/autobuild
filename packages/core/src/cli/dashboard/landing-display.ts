import { evaluateLandingPolicy } from '../../kernel/landing-policy'
import type { BuildState } from '../../kernel/reducer'

export function landingPolicyDisplay(landing: BuildState['landing']): string {
  if (landing?.command?.kind === 'hold') return 'held'
  return landing?.decision?.mode ?? 'policy pending'
}

/** Prospective display only: absent labels are unknown, never an empty set.
 * Follow reachable first matches; repeated excluded labels are unreachable. */
export function nodeLandingPolicyDisplay(
  state: BuildState,
  rules: readonly import('../../config/schema').LandingRule[],
): 'held' | 'auto' | 'consent' | 'policy pending' {
  if (state.landing?.command?.kind === 'hold') return 'held'
  if (state.landing?.decision) return state.landing.decision.mode
  const into = state.target
    ? { kind: 'node' as const, ticket: state.target.ticket.id }
    : { kind: 'root' as const }
  const input = { from: 'node' as const, into, labels: [] as string[] }
  const excluded = new Set<string>()
  const modes = new Set<string>()
  for (const rule of rules) {
    if (rule.from && rule.from !== 'node') continue
    if (
      rule.into &&
      (rule.into === 'root'
        ? into.kind !== 'root'
        : into.kind !== 'node' || (rule.into !== 'node' && rule.into !== into.ticket))
    )
      continue
    if (rule.label) {
      if (excluded.has(rule.label)) continue
      modes.add(evaluateLandingPolicy(rules, { ...input, labels: [rule.label] }).mode)
      excluded.add(rule.label)
    } else {
      modes.add(evaluateLandingPolicy(rules, input).mode)
      return modes.size === 1 ? ([...modes][0] as 'auto' | 'consent') : 'policy pending'
    }
  }
  modes.add(evaluateLandingPolicy(rules, input).mode)
  return modes.size === 1 ? ([...modes][0] as 'auto' | 'consent') : 'policy pending'
}
