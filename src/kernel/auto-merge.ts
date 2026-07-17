import type { BuildState } from './reducer'

/** A human auto-merge command whose desired forge state has not yet been
 * acknowledged by a matching application fact. */
export interface PendingAutoMerge {
  enabled: boolean
  commandSeq: number
}

/**
 * Compare durable desired state with the correlated forge application fact.
 * A value mismatch OR a command-seq mismatch is pending. This is the recovery
 * predicate at both plumbing seams: retries are safe because Forge.setAutoMerge
 * is idempotent.
 */
export function pendingAutoMerge(
  state: Pick<BuildState, 'autoMerge'>,
): PendingAutoMerge | undefined {
  const { requested, commandSeq, applied } = state.autoMerge
  if (commandSeq === undefined) return undefined
  if (applied?.commandSeq === commandSeq && applied.enabled === requested) {
    return undefined
  }
  return { enabled: requested, commandSeq }
}

export function autoMergeApplicationType(
  enabled: boolean,
): 'pr.auto-merge-enabled' | 'pr.auto-merge-disabled' {
  return enabled ? 'pr.auto-merge-enabled' : 'pr.auto-merge-disabled'
}
