import { verifyPathGlobError } from '../config/schema'

/**
 * Pure verify-applicability rule. `always` is explicit rather than represented
 * by an empty selector list, so mandatory-gate precedence cannot depend on
 * truthiness or ordering.
 */
export type VerifyApplicabilityRule =
  | { kind: 'always' }
  | { kind: 'paths'; step: string; paths: readonly string[] }

export type VerifyApplicabilityResult = { applies: true } | { applies: false; reason: string }

/** Stable, queryable reason used by the kernel-authored skipped outcome. */
export function pathExclusionReason(step: string, paths: readonly string[]): string {
  return `excluded by [verify.${step}].paths: no changed path matched ${JSON.stringify(paths)}`
}

/**
 * Evaluate one rule against Git's repository-relative, `/`-separated changed
 * paths. Matching is case-sensitive and OR-shaped: one selector matching one
 * changed path is enough. No I/O and no event writes occur here.
 */
export function evaluateVerifyApplicability(
  rule: VerifyApplicabilityRule,
  changedPaths: readonly string[],
): VerifyApplicabilityResult {
  if (rule.kind === 'always') return { applies: true }

  // Parsed Config is the normal caller and has already validated these. Keep
  // this exported pure seam fail-closed for direct callers too: Bun.Glob is
  // never asked to interpret syntax outside the documented subset.
  for (const path of rule.paths) {
    const error = verifyPathGlobError(path)
    if (error !== undefined) {
      throw new Error(
        `invalid [verify.${rule.step}].paths selector ${JSON.stringify(path)}: ${error}`,
      )
    }
  }

  const globs = rule.paths.map((path) => new Bun.Glob(path))
  for (const changedPath of changedPaths) {
    for (const glob of globs) {
      if (glob.match(changedPath)) return { applies: true }
    }
  }
  return {
    applies: false,
    reason: pathExclusionReason(rule.step, rule.paths),
  }
}
