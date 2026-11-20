import { candidateHeadPaths } from '../../kernel/head-paths-state'
import { evaluateLandingPolicy, type LandingPaths } from '../../kernel/landing-policy'
import type { BuildState } from '../../kernel/reducer'

/** The candidate's already-reduced changed paths; never an artifact read. */
function candidatePaths(state: BuildState): LandingPaths {
  const answer = candidateHeadPaths(state)
  return answer.recorded
    ? {
        recorded: true,
        complete: answer.record.total === answer.record.preview.length,
        paths: answer.record.preview,
      }
    : { recorded: false }
}

/** Why the operator held, while a hold that gave a reason stands. */
export function holdReason(landing: BuildState['landing']): string | undefined {
  return landing?.command?.kind === 'hold' ? landing.command.reason : undefined
}

export function landingPolicyDisplay(landing: BuildState['landing']): string {
  if (landing?.command?.kind === 'hold') return mergeVocabulary.held(holdReason(landing))
  return landing?.decision?.mode ?? 'policy pending'
}

/** Prospective display only: absent labels are unknown, never an empty set.
 * Follow reachable first matches; an unlabeled rule ends exploration only when
 * it matches or its changed paths are not yet decidable; repeated excluded
 * labels are unreachable. */
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
  const paths = candidatePaths(state)
  const mode = (labels: string[]) => {
    const result = evaluateLandingPolicy(rules, { ...input, labels }, paths)
    return 'deferred' in result ? 'policy pending' : result.mode
  }
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
      modes.add(mode([rule.label]))
      excluded.add(rule.label)
    } else {
      // A default answer means the rule's path predicates fail on the complete
      // recorded paths, so it is unreachable for every label set.
      const own = evaluateLandingPolicy([rule], input, paths)
      if ('default' in own.rule) continue
      modes.add(mode([]))
      return modes.size === 1
        ? ([...modes][0] as 'auto' | 'consent' | 'policy pending')
        : 'policy pending'
    }
  }
  modes.add(mode([]))
  return modes.size === 1
    ? ([...modes][0] as 'auto' | 'consent' | 'policy pending')
    : 'policy pending'
}

/** Explain the durable rule when available; unknown labels must not invent a match. */
export function nodeLandingRuleDisplay(
  state: BuildState,
  rules: readonly import('../../config/schema').LandingRule[],
): string {
  const recorded = state.landing?.decision?.rule
  if (recorded) {
    if ('default' in recorded) return 'default rule for integration builds: consent'
    return `rule ${recorded.index + 1}: ${JSON.stringify(recorded.snapshot)}`
  }
  const into = state.target
    ? { kind: 'node' as const, ticket: state.target.ticket.id }
    : { kind: 'root' as const }
  const paths = candidatePaths(state)
  const candidates = [
    evaluateLandingPolicy(rules, { from: 'node', into, labels: [] }, paths),
    ...rules
      .filter((r) => r.label)
      .map((r) => evaluateLandingPolicy(rules, { from: 'node', into, labels: [r.label!] }, paths)),
  ]
  if (candidates.some((c) => 'deferred' in c)) return 'rule pending changed paths'
  const unique = new Map(candidates.map((c) => [JSON.stringify(c.rule), c.rule]))
  if (unique.size !== 1) return 'rule pending ticket labels'
  const rule = [...unique.values()][0]!
  return 'default' in rule
    ? 'default rule for integration builds: consent'
    : `rule ${rule.index + 1}: ${JSON.stringify(rule.snapshot)}`
}

/** Public merge vocabulary shared by terminal and web renderers. */
export const mergeVocabulary = {
  title: 'Merge',
  label: 'merge',
  merged: 'merged',
  consent: 'Merge awaits consent. Merge releases this build; Hold keeps it waiting.',
  /** Landing by polling because the forge cannot arm native auto-merge. */
  polling: 'polling',
  /** Settled: a human merges the PR on the forge. */
  humanMerge: 'awaits a human merge',
  /** A standing hold, with the operator's reason when it gave one. */
  held: (reason?: string) => (reason === undefined ? 'held' : `held — ${reason}`),
} as const

export function mergeSummary(build: {
  landing?: BuildState['landing']
  autoMerge: string
}): string {
  const landing = build.landing
  const status =
    landing?.command?.kind === 'hold'
      ? 'held'
      : landing?.decision?.mode === 'consent' && landing.command?.kind !== 'land'
        ? 'awaiting consent'
        : build.autoMerge === 'polling'
          ? mergeVocabulary.polling
          : build.autoMerge === 'human-merge'
            ? mergeVocabulary.humanMerge
            : build.autoMerge
  return `${mergeVocabulary.label} ${status}`
}
export function mergedChildren(merged: number, total: number): string {
  return `${merged}/${total} ${mergeVocabulary.merged}`
}
