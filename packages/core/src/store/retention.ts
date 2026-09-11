/**
 * Artifact retention policy for the dispatcher run/config artifact family.
 *
 * Every dispatcher run start and config reload deposits a
 * `dispatcher-effective-config` (and on reload a `dispatcher-config`)
 * repository artifact; each build launch deposits a
 * `build-runner-effective-config` build artifact. Without a bound these rows
 * grow without limit (~1440/day/repo for a per-minute hosted dispatcher cron).
 *
 * The store contract (`store/types.ts`) has no delete, and the remote-store
 * protocol deliberately exposes no deletion endpoint — the artifact-store
 * schema and transport are out of bounds for retention. The policy is
 * therefore enforced **inside each store adapter at the deposit path**: when a
 * new revision of a retention-managed kind is deposited, the adapter keeps the
 * latest `maxRevisions` revisions of that `(scope, kind)` and deletes the
 * older ones in the same transaction, under the same serialization as the
 * deposit itself.
 *
 * The rule is count-based, not age-based: revision sequences already order by
 * deposit recency, so recency is preserved without a clock in the decision,
 * the boundary is deterministic, and an age rule would still only ever fire on
 * a deposit (there is no sweeper). Events and journal entries are never
 * pruned — historical payloads may reference a revision that no longer
 * resolves; the current run's snapshot is always among the newest deposits.
 */

/**
 * Repository-scoped artifact kinds subject to retention. Values mirror the
 * kind constants in `cli/dispatch.ts` (DISPATCHER_EFFECTIVE_CONFIG_ARTIFACT)
 * and `config/live.ts` (DISPATCHER_CONFIG_ARTIFACT); they are restated as
 * literals here because the store adapters must not import from the CLI
 * (store → cli would be an import cycle).
 */
export const DISPATCHER_RETENTION_REPO_KINDS = [
  'dispatcher-effective-config',
  'dispatcher-config',
] as const

/**
 * Build-scoped artifact kinds subject to retention. Value mirrors
 * `BUILD_EFFECTIVE_CONFIG_ARTIFACT` in `processes/build-execution-state.ts`.
 */
export const DISPATCHER_RETENTION_BUILD_KINDS = ['build-runner-effective-config'] as const

/** Default bound: the newest 200 revisions of each retention-managed kind survive. */
export const DEFAULT_ARTIFACT_RETENTION_MAX_REVISIONS = 200

/** True when deposits of `kind` are retention-managed (pruned past the bound). */
export function isRetentionManagedKind(kind: string): boolean {
  return (
    (DISPATCHER_RETENTION_REPO_KINDS as readonly string[]).includes(kind) ||
    (DISPATCHER_RETENTION_BUILD_KINDS as readonly string[]).includes(kind)
  )
}

/**
 * The pure pruning decision every adapter (and every test) shares: given the
 * revision numbers that currently exist for one `(scope, kind)`, return the
 * ones beyond the newest `maxRevisions` — exactly the revisions to delete.
 * Pure and side-effect-free; returns [] when nothing is past the bound.
 */
export function revisionsToPrune(revisions: readonly number[], maxRevisions: number): number[] {
  if (!Number.isInteger(maxRevisions) || maxRevisions < 1) {
    throw new Error(`maxRevisions must be a positive integer, got ${maxRevisions}`)
  }
  for (const revision of revisions) {
    if (!Number.isInteger(revision) || revision < 0) {
      throw new Error(`revisions must be nonnegative integers, got ${revision}`)
    }
  }
  const newestFirst = [...revisions].sort((a, b) => b - a)
  return newestFirst.slice(maxRevisions).sort((a, b) => a - b)
}
