/**
 * Moving zod issues across a validation boundary without losing what zod
 * reported, and expanding what a renderer cannot present as-is.
 *
 * A nested `safeParse` whose issues are relayed by hand — the shape every
 * `z.transform` that validates a sub-value ends up in — is where detail goes to
 * die. Re-encoding each issue as `{ code: 'custom', message }` keeps the prose
 * and silently discards everything structured: `unrecognized_keys.keys`,
 * `invalid_type.expected`, and, decisively, `invalid_union.errors`, which is
 * where an untagged `z.union` keeps the entire reason it rejected the value.
 * Its own `message` is the bare "Invalid input", so re-encoding turns a precise
 * rejection into no information at all.
 *
 * The split is deliberate: `forwardIssues` relays, `expandIssues` presents.
 * Forwarding keeps validation honest without deciding prose; expanding is what
 * makes union branch detail reach a human, and belongs at operator-facing
 * renderer boundaries rather than inside a validator.
 */
import type { z } from 'zod'

/**
 * The slice of zod's `$RefinementCtx` a transform needs to report issues.
 *
 * Taken from zod rather than hand-written: its `addIssue` already accepts every
 * issue code — an issue this codebase raises (`{ code: 'custom', message }`,
 * path optional because zod anchors it) and one relayed from an inner parse
 * alike. Restating it as a `custom`-only shape is what made re-encoding look
 * like the only option at each of these boundaries.
 */
export type IssueSink = Pick<z.core.$RefinementCtx, 'addIssue'>

/**
 * Relay every issue from an inner parse to an outer context verbatim, with only
 * its path prefixed to anchor it where the inner value sits.
 *
 * Verbatim is the point. Each issue keeps its own code and its code-specific
 * payload, so a caller downstream — the config loader's `unrecognized_keys`
 * migration hints, `expandIssues`' union expansion — still sees what zod
 * actually decided rather than a `custom` issue carrying prose.
 */
export function forwardIssues(
  issues: readonly z.core.$ZodIssue[],
  ctx: IssueSink,
  prefix: PropertyKey[] = [],
): void {
  for (const issue of issues) {
    ctx.addIssue({ ...issue, path: [...prefix, ...issue.path] })
  }
}

/**
 * Replace each union issue that carries branch detail with one issue per branch
 * leaf, so a renderer that prints `path: message` prints why every alternative
 * was rejected instead of the bare "Invalid input".
 *
 * A leaf keeps its real path (the union's, then its own) and its real code, so
 * path-and-code-driven post-processing downstream still sees a real issue. Only
 * the message is synthesized, and only by prefixing `option N of M:`.
 *
 * Expansion happens ONLY when it yields at least one leaf; otherwise the issue
 * passes through untouched. That single rule is the whole tagged-choice
 * guarantee: a `z.discriminatedUnion` that matches no tag reports
 * `invalid_union` with `errors: []` and a message that already names the
 * expected tags, so it has nothing to expand and renders exactly as it did
 * before. Nesting recurses — a union inside a union yields leaves carrying both
 * markers.
 *
 * `invalid_key` and `invalid_element` nest issues the same way. Neither reaches
 * the currently covered config, plugin-manifest, findings, or ticket-update
 * renderers, so they are left alone rather than handled speculatively.
 */
export function expandIssues(issues: readonly z.core.$ZodIssue[]): z.core.$ZodIssue[] {
  const expanded: z.core.$ZodIssue[] = []
  for (const issue of issues) {
    const leaves = issue.code === 'invalid_union' ? unionLeaves(issue) : []
    if (leaves.length > 0) expanded.push(...leaves)
    else expanded.push(issue)
  }
  return expanded
}

function unionLeaves(issue: z.core.$ZodIssueInvalidUnion): z.core.$ZodIssue[] {
  const branches = issue.errors
  return branches.flatMap((branch, index) =>
    expandIssues(branch).map((leaf) => ({
      ...leaf,
      path: [...issue.path, ...leaf.path],
      message: `option ${index + 1} of ${branches.length}: ${leaf.message}`,
    })),
  )
}
