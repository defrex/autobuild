import type { BuildState } from './reducer'

/** The complete GitHub `mergeStateStatus` enum. Keeping this list closed is a
 * safety property: a future forge state cannot silently become direct-merge
 * eligible. */
export const mergeStateStatuses = [
  'BEHIND',
  'BLOCKED',
  'CLEAN',
  'DIRTY',
  'DRAFT',
  'HAS_HOOKS',
  'UNKNOWN',
  'UNSTABLE',
] as const

export type MergeStateStatus = (typeof mergeStateStatuses)[number]
export type MergeGatePresence = 'present' | 'absent'

export type AutoMergeEnableDisposition =
  | { kind: 'native' }
  | { kind: 'direct' }
  | { kind: 'deferred' }
  | { kind: 'error'; reason: string }

const NATIVE = { kind: 'native' } as const
const DIRECT = { kind: 'direct' } as const
const DEFERRED = { kind: 'deferred' } as const

/**
 * Route from two independent facts: whether a real merge gate exists and the
 * PR's current GitHub merge state. In particular, CLEAN never proves that a
 * branch is ungated: a gated branch whose requirements passed is CLEAN too.
 */
const ENABLE_DISPOSITIONS = {
  BEHIND: { present: NATIVE, absent: DIRECT },
  BLOCKED: {
    present: NATIVE,
    absent: {
      kind: 'error',
      reason: 'GitHub reports the PR BLOCKED despite no discovered merge-blocking gate',
    },
  },
  CLEAN: { present: NATIVE, absent: DIRECT },
  DIRTY: { present: DEFERRED, absent: DEFERRED },
  DRAFT: {
    present: {
      kind: 'error',
      reason: 'GitHub reports the PR as DRAFT; Autobuild only finalizes ready PRs',
    },
    absent: {
      kind: 'error',
      reason: 'GitHub reports the PR as DRAFT; Autobuild only finalizes ready PRs',
    },
  },
  HAS_HOOKS: { present: NATIVE, absent: NATIVE },
  UNKNOWN: { present: NATIVE, absent: DEFERRED },
  UNSTABLE: { present: NATIVE, absent: DIRECT },
} as const satisfies Record<MergeStateStatus, Record<MergeGatePresence, AutoMergeEnableDisposition>>

export function classifyAutoMergeEnable(
  mergeState: MergeStateStatus,
  gate: MergeGatePresence,
): AutoMergeEnableDisposition {
  return ENABLE_DISPOSITIONS[mergeState][gate]
}

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
