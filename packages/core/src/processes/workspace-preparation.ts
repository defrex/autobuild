/**
 * Workspace preparation freshness (§15.6-C).
 *
 * `[commands].setup` prepares the workspace for the base the build sits on:
 * dependencies, generated toolchains, anything the repository's setup command
 * produces. A runner records the base it prepared for once setup succeeds.
 * When a kernel operation moves the build onto a new base — a restack, a
 * wait-resume advance, a completed reconcile, a node's next integration cycle —
 * that preparation is stale, and setup must run again before the next decision
 * that uses the workspace tree. Autobuild cannot see which files setup reads,
 * so every base move counts as a possible dependency change.
 *
 * Commits the build's own agents author (implement rounds, a resolver's edits)
 * do not move the base and never make the preparation stale: those agents
 * prepare their own tree.
 *
 * Pure and in-memory: the runner compares against facts it already read.
 */
import type { Decision } from '../kernel/engine'

/** The base the current process last prepared the workspace for. */
export type WorkspacePreparation = { readonly base: string | undefined }

/**
 * Whether executing `decision` relies on a prepared workspace tree. Reconcile
 * is excluded: its resolver works on a replay that may be mid-cherry-pick,
 * with conflict markers in manifests or lockfiles. The base move a completed
 * reconcile promotes is caught before the following verify instead.
 * `evaluate-verify` counts: path gating may resolve straight into a check.
 */
export function decisionUsesWorkspace(decision: Decision): boolean {
  switch (decision.kind) {
    case 'run-phase':
      return decision.phase !== 'reconcile'
    case 'run-check':
    case 'run-agent-verify':
    case 'evaluate-verify':
    case 'run-verify-stage':
    case 'run-finalize-step':
    case 'run-measurement':
    case 'measure-baseline':
    case 'measure-progress':
      return true
    case 'record-verify-selection-drift':
    case 'restart-execution':
    case 'cancel-verify-stage':
    case 'record-verify-stage-failure':
    case 'raise-read-deferral':
    case 'restack':
    case 'capture-reconcile-policy':
    case 'wait':
    case 'acknowledge':
    case 'skip-verify':
    case 'check-reconcile-progress':
    case 'raise-escalation':
      return false
    default: {
      const unclassified: never = decision
      throw new Error(`unclassified decision ${JSON.stringify(unclassified)}`)
    }
  }
}

/**
 * True only when this process prepared the workspace, the decision uses it,
 * and the build's base has moved since that preparation.
 */
export function preparationStale(
  prepared: WorkspacePreparation | undefined,
  base: string | undefined,
  decision: Decision,
): boolean {
  return prepared !== undefined && decisionUsesWorkspace(decision) && prepared.base !== base
}
