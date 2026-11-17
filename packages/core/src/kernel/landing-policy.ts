import type { LandingRule } from '../config/schema'
import { compilePathSelectors } from '../config/path-selectors'
import { LANDING_MATCHED_PATHS_PREVIEW } from '../events/head-paths-limits'

/** The frozen destination identity, never the source ticket's mutable parent. */
export type LandingTarget = { kind: 'root' } | { kind: 'node'; ticket: string }
export interface LandingPolicyInput {
  from: 'leaf' | 'node'
  into: LandingTarget
  labels: readonly string[]
}
/**
 * The candidate head's recorded changed paths. "Not recorded" is distinct from
 * a recorded empty change. `complete: false` means only a bounded preview is
 * known; the caller reads the complete set and evaluates again.
 */
export type LandingPaths =
  | { recorded: false }
  | { recorded: true; complete: boolean; paths: readonly string[] }
export interface LandingPolicyMatch {
  mode: 'auto' | 'consent'
  /** Zero-based position and complete rule as sampled at readiness. */
  rule: { index: number; snapshot: LandingRule } | { default: true }
  /** Present only when the matched rule has a path predicate: the changed
   * paths its selectors matched, sorted, bounded, with the exact total. */
  paths?: { total: number; preview: string[] }
}
/** Evaluation reached a path-predicate rule it cannot decide yet. */
export interface LandingPolicyDeferral {
  deferred: 'paths-unrecorded' | 'paths-incomplete'
  rule: { index: number; snapshot: LandingRule }
}

/**
 * First match wins. `from`, `label` and `into` are checked before any path
 * predicate, so a rule whose other predicates fail never defers. A rule with
 * `paths` (any changed path matches) or `within` (at least one changed path,
 * and every one matches) needs the candidate's complete recorded paths:
 * unrecorded paths defer the decision rather than read as an empty change.
 */
export function evaluateLandingPolicy(
  rules: readonly LandingRule[],
  input: LandingPolicyInput,
  changed: LandingPaths = { recorded: false },
): LandingPolicyMatch | LandingPolicyDeferral {
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
    const snapshot = { ...rule }
    if (rule.paths === undefined && rule.within === undefined)
      return { mode: rule.mode, rule: { index, snapshot } }
    if (!changed.recorded) return { deferred: 'paths-unrecorded', rule: { index, snapshot } }
    if (!changed.complete) return { deferred: 'paths-incomplete', rule: { index, snapshot } }
    const matched = matchPathPredicates(rule, changed.paths)
    if (matched === undefined) continue
    return {
      mode: rule.mode,
      rule: { index, snapshot },
      paths: {
        total: matched.length,
        preview: matched.slice(0, LANDING_MATCHED_PATHS_PREVIEW),
      },
    }
  }
  return {
    mode: input.from === 'leaf' ? 'auto' : 'consent',
    rule: { default: true },
  }
}

/** The sorted, unique changed paths any of the rule's selectors match, or
 * undefined when its path predicates do not hold. */
function matchPathPredicates(rule: LandingRule, changed: readonly string[]): string[] | undefined {
  const describe = (field: string) => (selector: string, error: string) =>
    `invalid [[merge]] ${field} selector ${JSON.stringify(selector)}: ${error}`
  const any = rule.paths && compilePathSelectors(rule.paths, describe('paths'))
  const all = rule.within && compilePathSelectors(rule.within, describe('within'))
  const unique = [...new Set(changed)].sort()
  if (any && !unique.some(any)) return undefined
  if (all && (unique.length === 0 || !unique.every(all))) return undefined
  return unique.filter((path) => any?.(path) || all?.(path))
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
