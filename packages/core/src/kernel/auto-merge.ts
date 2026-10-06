import type { AbEvent, EventEnvelope, EventWrite } from '../events/catalog'
import { KERNEL } from '../events/envelope'
import { autoMergeDeferralClasses, type AutoMergeDeferralReason } from '../ports/types'
import type { BuildStore } from '../store/types'
import { defineReducer } from './incremental'
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

/** Stable correlation key for the one follow-up allowed per PR/consent command. */
export function autoMergeDeferralRef(prNumber: number, commandSeq: number): string {
  return `auto-merge-gate:pr:${prNumber}:command:${commandSeq}`
}

/**
 * The one live deferral observation for a PR/consent command, or undefined.
 * An observation is current only while the PR is open — any `pr.merged` or
 * `pr.closed` fact in the log ends it — and until later evidence proves the
 * PR head changed, superseding the recorded condition until the gate
 * re-examines consent and records a fresh observation. Head-changing evidence
 * is a `reconcile.completed` (the resolution is a merge commit on the branch)
 * or a `finalize.completed` whose head differs from the head the observation
 * was recorded under. The dedupe and the projection share this predicate, so
 * a stale observation stops suppressing and re-recording after reconcile
 * works.
 *
 * The head at observation time is the newest `finalize.completed` before it:
 * the record seam always runs right after that event is appended. An
 * observation with no preceding `finalize.completed` (janitor-recorded seeds,
 * synthetic logs) takes its head from the FIRST following `finalize.completed`
 * instead of being superseded by it — the §8.7 retry that adopts the same PR
 * at the same head must not invalidate the marker it honors. A
 * `finalize.completed` naming a different head is a rebuilt pipeline
 * re-finalizing after new commits, and it does make the observation stale.
 *
 * Ending currency on any terminal PR fact in the log is safe only because a
 * build finalizes one PR; if a future feature ever re-finalizes onto a second
 * PR, revisit.
 */
export function currentDeferralObservation(
  events: AbEvent[],
  prNumber: number,
  commandSeq: number,
): DeferralObservation | undefined {
  return deferralObservationFrom(
    currentDeferralObservationReducer.reduce(events),
    prNumber,
    commandSeq,
  )
}

type DeferralObservation = Extract<AbEvent, { type: 'observation.recorded' }>

const DEFERRAL_REF_PREFIX = 'auto-merge-gate:pr:'

/** One array-order ledger entry. Only the facts the currency predicate reads
 * are kept, with every maximal run of other events collapsed to a barrier
 * carrying the run's max seq: the head scan stops at the first event (of ANY
 * type) with `seq >= observation.seq`, so an unrelated event must still be able
 * to end it. */
type DeferralLedgerEntry =
  | { t: 'barrier'; seq: number }
  | { t: 'observation'; event: DeferralObservation }
  | { t: 'finalized'; seq: number; headSha: string }
  | { t: 'terminal'; seq: number }
  | { t: 'reconciled'; seq: number }

export const CURRENT_DEFERRAL_OBSERVATION_REDUCER_VERSION = 1

export interface DeferralLedger {
  entries: DeferralLedgerEntry[]
}

export const currentDeferralObservationReducer = defineReducer<
  DeferralLedger,
  AbEvent,
  DeferralLedger
>({
  version: CURRENT_DEFERRAL_OBSERVATION_REDUCER_VERSION,
  initial: () => ({ entries: [] }),
  fold(acc, events) {
    for (const event of events) {
      let entry: DeferralLedgerEntry | undefined
      if (
        event.type === 'observation.recorded' &&
        event.payload.refs?.some((ref) => ref.startsWith(DEFERRAL_REF_PREFIX)) === true
      ) {
        entry = { t: 'observation', event }
      } else if (event.type === 'finalize.completed') {
        entry = { t: 'finalized', seq: event.seq, headSha: event.payload.pr.headSha }
      } else if (event.type === 'pr.merged' || event.type === 'pr.closed') {
        entry = { t: 'terminal', seq: event.seq }
      } else if (event.type === 'reconcile.completed') {
        entry = { t: 'reconciled', seq: event.seq }
      }
      if (entry !== undefined) {
        acc.entries.push(entry)
        continue
      }
      const last = acc.entries.at(-1)
      if (last?.t === 'barrier') last.seq = Math.max(last.seq, event.seq)
      else acc.entries.push({ t: 'barrier', seq: event.seq })
    }
  },
  finish: (acc) => ({ entries: acc.entries.slice() }),
})

function deferralEntrySeq(entry: DeferralLedgerEntry): number {
  return entry.t === 'observation' ? entry.event.seq : entry.seq
}

/** The current deferral observation for a PR/command over a reduced ledger. */
export function deferralObservationFrom(
  ledger: DeferralLedger,
  prNumber: number,
  commandSeq: number,
): DeferralObservation | undefined {
  const marker = autoMergeDeferralRef(prNumber, commandSeq)
  const { entries } = ledger
  let observation: DeferralObservation | undefined
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry?.t === 'observation' && entry.event.payload.refs?.includes(marker) === true) {
      observation = entry.event
      break
    }
  }
  if (observation === undefined) return undefined

  let headAtObservation: string | undefined
  for (const entry of entries) {
    if (deferralEntrySeq(entry) >= observation.seq) break
    if (entry.t === 'finalized') headAtObservation = entry.headSha
  }

  for (const entry of entries) {
    if (entry.t === 'observation' || entry.t === 'barrier') continue
    if (entry.seq <= observation.seq) continue
    if (entry.t === 'terminal' || entry.t === 'reconciled') return undefined
    if (headAtObservation === undefined) headAtObservation = entry.headSha
    else if (entry.headSha !== headAtObservation) return undefined
  }
  return observation
}

export function hasAutoMergeDeferralObservation(
  events: AbEvent[],
  prNumber: number,
  commandSeq: number,
): boolean {
  return currentDeferralObservation(events, prNumber, commandSeq) !== undefined
}

/**
 * The exact provider-bearing summary for the current, unapplied enable
 * command. Deferral observations are durable history, so correlation to both
 * the current PR and command is what prevents an old reason from looking live
 * after consent is applied, cancelled, or replaced — and the shared currency
 * predicate is what keeps a superseded or terminal-PR observation from
 * looking live at all.
 */
export function currentAutoMergeDeferral(
  events: AbEvent[],
  state: Pick<BuildState, 'autoMerge' | 'pr'>,
): string | undefined {
  const pending = pendingAutoMerge(state)
  if (pending?.enabled !== true || state.pr === undefined) return undefined
  return currentDeferralObservation(events, state.pr.number, pending.commandSeq)?.payload.summary
}

const DEFERRAL_SUMMARIES = {
  'github-plan-limitation':
    'GitHub rulesets are unavailable because of the repository account plan',
  'repository-auto-merge-disabled': 'repository-level auto-merge is disabled',
  'unproven-gate-state': 'merge-gate state or native auto-merge application could not be proven',
  'merge-conflicts': 'the PR has merge conflicts with its base branch',
  'mergeability-uncomputed':
    'GitHub has not finished computing mergeability (transient; expected to resolve on retry)',
  'local-base-checkout-dirty': 'local merge is blocked by uncommitted work in the base checkout',
  'local-git-identity-missing':
    'local squash requires a configured Git author and committer identity',
} as const satisfies Record<AutoMergeDeferralReason['code'], string>

/** Kernel-authored durable diagnostic for a human-actionable declined consent. */
export function autoMergeDeferralObservation(
  reason: AutoMergeDeferralReason,
  prNumber: number,
  commandSeq: number,
  id: string,
): EventWrite<'observation.recorded'> {
  return {
    actor: KERNEL,
    type: 'observation.recorded',
    payload: {
      id,
      kind: 'followup',
      summary:
        `Auto-merge gate could not apply consent for PR #${prNumber}: ` +
        `${DEFERRAL_SUMMARIES[reason.code]} — ${reason.detail}`,
      refs: [autoMergeDeferralRef(prNumber, commandSeq)],
    },
  }
}

/**
 * Record the one durable diagnostic allowed for a PR/auto-merge command —
 * only for a deferral a person must fix. Pipeline-owned and transient codes
 * (`merge-conflicts`, `mergeability-uncomputed`) resolve through reconcile or
 * a later poll, so they record nothing: consent stays pending and later ticks
 * re-examine it. Every comparison is against the authoritative stream tail. A
 * concurrent unrelated append merely causes a retry; a concurrent matching
 * append makes the next read return without writing a duplicate.
 */
export async function recordAutoMergeDeferralObservation(
  store: BuildStore,
  slug: string,
  reason: AutoMergeDeferralReason,
  prNumber: number,
  commandSeq: number,
  id: string,
): Promise<EventEnvelope<'observation.recorded'> | null> {
  if (autoMergeDeferralClasses[reason.code] === 'pipeline-resolved') return null
  while (true) {
    const events = await store.getEvents(slug)
    if (hasAutoMergeDeferralObservation(events, prNumber, commandSeq)) return null

    const expectedSeq = events.at(-1)?.seq ?? 0
    const appended = await store.appendIfCurrent(
      slug,
      expectedSeq,
      autoMergeDeferralObservation(reason, prNumber, commandSeq, id),
    )
    if (appended !== null) return appended
  }
}
