/**
 * Pure reduction of the repository-scoped harvest journal. As with builds,
 * snapshots are never authoritative: dashboard state, resumption boundaries,
 * claims, and the dedup ledger are all re-derived from append-only facts.
 */
import type { RepositoryEvent } from '../events/repository'
import type { Actor } from '../events/envelope'
import type { ArtifactRef, Finding, TicketRef } from '../ontology'
import {
  occurrenceKey,
  type HarvestDisposition,
  type HarvestPendingProposal,
  type HarvestStep,
  type OccurrenceKey,
} from '../harvest/schema'

export interface HarvestStepOccurrence {
  step: HarvestStep
  round?: number
  startedSeq: number
  startedAt: string
  completedSeq?: number
  completedAt?: string
  outcome?: 'completed' | 'approve' | 'revise' | 'escalate' | 'failed'
  artifact?: ArtifactRef
  detail?: string
}

export interface HarvestReviewRound {
  round: number
  verdict: 'approve' | 'revise' | 'escalate'
  findings: Finding[]
  artifact: ArtifactRef
  reason?: string
  seq: number
}

export interface HarvestProposalReservation {
  proposalKey: string
  id: string
  seq: number
}

export interface HarvestRecoveryRequest {
  attempt: number
  limit: number
  seq: number
  requestedAt: string
  acknowledgedSeq?: number
  acknowledgedAt?: string
}

export interface HarvestRecoveryExhaustion {
  step: HarvestStep
  round?: number
  error: string
  attempts: number
  limit: number
  releasedObservations: OccurrenceKey[]
  committedDispositions: HarvestDisposition[]
  pendingProposals: HarvestPendingProposal[]
  seq: number
  at: string
  attentionAcknowledgedSeq?: number
  attentionAcknowledgedAt?: string
}

export interface HarvestRunState {
  run: string
  status: 'running' | 'completed' | 'escalated' | 'failed'
  startedSeq: number
  startedAt: string
  observations: OccurrenceKey[]
  scan: ArtifactRef
  steps: HarvestStepOccurrence[]
  proposals: Array<{ round: number; artifact: ArtifactRef; seq: number }>
  reviews: HarvestReviewRound[]
  reservations: HarvestProposalReservation[]
  filed: Array<{ proposalKey: string; ticket: TicketRef; seq: number }>
  dispositions: HarvestDisposition[]
  report?: ArtifactRef
  escalation?: {
    source: 'agent' | 'stall' | 'policy'
    reason: string
    round?: number
  }
  failure?: {
    step: HarvestStep
    round?: number
    attempt: number
    error: string
    willRetry: boolean
  }
  /** Durable outer recoveries, independent of within-step attempt facts. */
  recoveryRequests: HarvestRecoveryRequest[]
  /** Present after the automatic recovery budget is atomically exhausted. */
  recoveryExhaustion?: HarvestRecoveryExhaustion
  terminalSeq?: number
  terminalAt?: string
}

export interface HarvestLedgerEntry extends HarvestDisposition {
  run: string
  seq: number
}

/** An operator request not yet acknowledged by the harvest kernel. Requests
 * are ordered repository facts; pause and resume countermand older opposing
 * intent exactly as build commands do. */
export interface HarvestPendingCommand {
  command: 'pause' | 'resume'
  seq: number
  actor: Actor
}

export interface HarvestState {
  lastSeq: number
  runs: HarvestRunState[]
  latest?: HarvestRunState
  /** Repository-wide gate, independent of any one run. It changes only on the
   * kernel acknowledgement, never on the human request. */
  paused: boolean
  /** Boundary at which the current pause was acknowledged. Dashboard timing
   * freezes here; absent whenever the gate is open. */
  pausedSeq?: number
  pausedAt?: string
  /** Unacknowledged human commands in repository sequence order. */
  pendingCommands: HarvestPendingCommand[]
  /** Occurrences still owned by started runs; exhaustion may selectively
   * release pending members while retaining committed ones. */
  claimed: OccurrenceKey[]
  /** Completed and recovery-exhausted committed disposition facts. */
  ledger: HarvestLedgerEntry[]
}

export const DEFAULT_MAX_HARVEST_RECOVERY_ATTEMPTS = 2

export type HarvestControlDecision =
  | { kind: 'acknowledge'; command: 'pause' | 'resume' }
  | { kind: 'request-recovery'; run: string; attempt: number; limit: number }
  | { kind: 'exhaust-recovery'; run: string; attempts: number; limit: number }
  | { kind: 'park' }
  | { kind: 'proceed' }

function cloneRef(ref: ArtifactRef): ArtifactRef {
  return { kind: ref.kind, rev: ref.rev }
}

function isOrdinaryParkedRun(run: HarvestRunState): boolean {
  return run.status === 'failed' && run.recoveryExhaustion === undefined
}

function hasUnresolvedExhaustion(run: HarvestRunState): boolean {
  return (
    run.status === 'failed' &&
    run.recoveryExhaustion !== undefined &&
    run.recoveryExhaustion.attentionAcknowledgedSeq === undefined
  )
}

function requireRun(
  runs: Map<string, HarvestRunState>,
  run: string,
  event: RepositoryEvent,
): HarvestRunState {
  const state = runs.get(run)
  if (!state) {
    throw new Error(
      `${event.type} at repo seq ${event.seq} references unknown harvest run "${run}"`,
    )
  }
  return state
}

/** Total for valid journals; malformed cross-event references throw loudly so
 * storage corruption cannot masquerade as an idle harvester. */
export function reduceHarvest(events: RepositoryEvent[]): HarvestState {
  const runs = new Map<string, HarvestRunState>()
  const order: HarvestRunState[] = []
  const claimed = new Map<
    string,
    { occurrence: OccurrenceKey; run: string }
  >()
  const ledger: HarvestLedgerEntry[] = []
  const pending: Record<HarvestPendingCommand['command'], HarvestPendingCommand[]> = {
    pause: [],
    resume: [],
  }
  let paused = false
  let pausedSeq: number | undefined
  let pausedAt: string | undefined
  let lastSeq = 0

  for (const event of events) {
    lastSeq = Math.max(lastSeq, event.seq)
    switch (event.type) {
      case 'harvest.pause-requested':
        pending.resume = []
        pending.pause.push({
          command: 'pause',
          seq: event.seq,
          actor: event.actor,
        })
        break
      case 'harvest.resume-requested':
        pending.pause = []
        pending.resume.push({
          command: 'resume',
          seq: event.seq,
          actor: event.actor,
        })
        break
      case 'harvest.paused':
        paused = true
        pausedSeq = event.seq
        pausedAt = event.ts
        pending.pause = []
        break
      case 'harvest.resumed': {
        const hadHumanResume = pending.resume.length > 0
        paused = false
        pausedSeq = undefined
        pausedAt = undefined
        pending.resume = []
        for (const run of order) {
          const exhaustion = run.recoveryExhaustion
          if (exhaustion !== undefined) {
            // Give-up is terminal. A human acknowledgement removes every
            // outstanding repository attention barrier without resurrecting
            // a run or changing its selectively retained claims.
            if (
              hadHumanResume &&
              exhaustion.attentionAcknowledgedSeq === undefined
            ) {
              exhaustion.attentionAcknowledgedSeq = event.seq
              exhaustion.attentionAcknowledgedAt = event.ts
            }
            continue
          }
          if (!isOrdinaryParkedRun(run)) continue

          const automatic = [...run.recoveryRequests]
            .reverse()
            .find((request) => request.acknowledgedSeq === undefined)
          if (automatic !== undefined) {
            automatic.acknowledgedSeq = event.seq
            automatic.acknowledgedAt = event.ts
          }
          // One human acknowledgement is repository-wide and reopens every
          // ordinary parked run. Without human intent, the unscoped resumed
          // fact correlates only to runs with durable automatic requests.
          if (hadHumanResume || automatic !== undefined) {
            run.status = 'running'
            delete run.failure
            delete run.terminalSeq
            delete run.terminalAt
          }
        }
        break
      }
      case 'harvest.recovery-requested': {
        const run = requireRun(runs, event.payload.run, event)
        if (run.status !== 'failed' || run.recoveryExhaustion !== undefined) {
          throw new Error(
            `harvest.recovery-requested at repo seq ${event.seq} requires an ` +
              `ordinary failed run; "${run.run}" is ${run.status}`,
          )
        }
        if (
          run.recoveryRequests.some(
            (request) => request.acknowledgedSeq === undefined,
          )
        ) {
          throw new Error(
            `harvest run "${run.run}" already has an unacknowledged automatic recovery request`,
          )
        }
        const expectedAttempt = run.recoveryRequests.length + 1
        if (event.payload.attempt !== expectedAttempt) {
          throw new Error(
            `harvest run "${run.run}" recovery attempt must be ${expectedAttempt}; ` +
              `repo seq ${event.seq} recorded ${event.payload.attempt}`,
          )
        }
        const appliedLimit = run.recoveryRequests[0]?.limit
        if (
          appliedLimit !== undefined &&
          event.payload.limit !== appliedLimit
        ) {
          throw new Error(
            `harvest run "${run.run}" recovery limit was already applied as ` +
              `${appliedLimit}; repo seq ${event.seq} cannot change it to ${event.payload.limit}`,
          )
        }
        if (event.payload.attempt > event.payload.limit) {
          throw new Error(
            `harvest run "${run.run}" recovery attempt ${event.payload.attempt} ` +
              `exceeds its applied limit ${event.payload.limit}`,
          )
        }
        run.recoveryRequests.push({
          attempt: event.payload.attempt,
          limit: event.payload.limit,
          seq: event.seq,
          requestedAt: event.ts,
        })
        break
      }
      case 'harvest.recovery-exhausted': {
        const run = requireRun(runs, event.payload.run, event)
        if (run.recoveryExhaustion !== undefined) {
          throw new Error(
            `duplicate harvest.recovery-exhausted for run "${run.run}" at repo seq ${event.seq}`,
          )
        }
        if (run.status !== 'failed' || run.failure === undefined) {
          throw new Error(
            `harvest.recovery-exhausted at repo seq ${event.seq} requires a failed run`,
          )
        }
        if (
          run.failure.step !== event.payload.step ||
          run.failure.round !== event.payload.round ||
          run.failure.error !== event.payload.error
        ) {
          throw new Error(
            `harvest.recovery-exhausted at repo seq ${event.seq} does not match ` +
              `the stopped boundary for run "${run.run}"`,
          )
        }
        if (
          event.payload.attempts !== run.recoveryRequests.length ||
          event.payload.attempts !== event.payload.limit ||
          run.recoveryRequests.some(
            (request) => request.limit !== event.payload.limit,
          )
        ) {
          throw new Error(
            `harvest run "${run.run}" exhaustion must record its exact recovery ` +
              `count and limit; got ${event.payload.attempts}/${event.payload.limit} ` +
              `after ${run.recoveryRequests.length} requests`,
          )
        }
        if (
          run.recoveryRequests.some(
            (request) => request.acknowledgedSeq === undefined,
          )
        ) {
          throw new Error(
            `harvest run "${run.run}" cannot exhaust with an unacknowledged recovery request`,
          )
        }

        const expected = new Set(run.observations.map(occurrenceKey))
        const partition = new Set<string>()
        const released = new Set<string>()
        for (const disposition of event.payload.committedDispositions) {
          const key = occurrenceKey(disposition.occurrence)
          if (!expected.has(key) || partition.has(key)) {
            throw new Error(
              `harvest run "${run.run}" exhaustion has an invalid or duplicate committed occurrence ${key}`,
            )
          }
          partition.add(key)
        }
        for (const occurrence of event.payload.releasedObservations) {
          const key = occurrenceKey(occurrence)
          if (!expected.has(key) || partition.has(key)) {
            throw new Error(
              `harvest run "${run.run}" exhaustion has an invalid or duplicate released occurrence ${key}`,
            )
          }
          partition.add(key)
          released.add(key)
        }
        if (partition.size !== expected.size) {
          const missing = [...expected].filter((key) => !partition.has(key))
          throw new Error(
            `harvest run "${run.run}" exhaustion does not partition its snapshot; ` +
              `missing ${missing.join(', ')}`,
          )
        }
        const pendingKeys = new Set<string>()
        const pendingOccurrences = new Set<string>()
        for (const proposal of event.payload.pendingProposals) {
          if (pendingKeys.has(proposal.proposalKey)) {
            throw new Error(
              `harvest run "${run.run}" exhaustion repeats pending proposal key "${proposal.proposalKey}"`,
            )
          }
          pendingKeys.add(proposal.proposalKey)
          for (const occurrence of proposal.observations) {
            const key = occurrenceKey(occurrence)
            if (!released.has(key) || pendingOccurrences.has(key)) {
              throw new Error(
                `harvest run "${run.run}" pending proposal "${proposal.proposalKey}" ` +
                  `does not uniquely describe released occurrence ${key}`,
              )
            }
            pendingOccurrences.add(key)
          }
        }

        for (const key of released) {
          const owner = claimed.get(key)
          if (owner?.run !== run.run) {
            throw new Error(
              `harvest run "${run.run}" cannot release ${key}; its claim owner is ` +
                `${owner?.run ?? 'missing'}`,
            )
          }
          claimed.delete(key)
        }
        run.dispositions = structuredClone(
          event.payload.committedDispositions,
        )
        for (const disposition of event.payload.committedDispositions) {
          ledger.push({
            ...structuredClone(disposition),
            run: run.run,
            seq: event.seq,
          })
        }
        run.recoveryExhaustion = {
          step: event.payload.step,
          ...(event.payload.round !== undefined
            ? { round: event.payload.round }
            : {}),
          error: event.payload.error,
          attempts: event.payload.attempts,
          limit: event.payload.limit,
          releasedObservations: structuredClone(
            event.payload.releasedObservations,
          ),
          committedDispositions: structuredClone(
            event.payload.committedDispositions,
          ),
          pendingProposals: structuredClone(event.payload.pendingProposals),
          seq: event.seq,
          at: event.ts,
        }
        run.terminalSeq = event.seq
        run.terminalAt = event.ts
        break
      }
      case 'harvest.started': {
        if (runs.has(event.payload.run)) {
          throw new Error(
            `duplicate harvest.started for run "${event.payload.run}" at repo seq ${event.seq}`,
          )
        }
        const run: HarvestRunState = {
          run: event.payload.run,
          status: 'running',
          startedSeq: event.seq,
          startedAt: event.ts,
          observations: event.payload.observations.map((key) => ({ ...key })),
          scan: cloneRef(event.payload.scan),
          steps: [],
          proposals: [],
          reviews: [],
          reservations: [],
          filed: [],
          dispositions: [],
          recoveryRequests: [],
        }
        runs.set(run.run, run)
        order.push(run)
        for (const key of run.observations) {
          const id = occurrenceKey(key)
          const existing = claimed.get(id)
          if (existing !== undefined) {
            throw new Error(
              `harvest run "${run.run}" at repo seq ${event.seq} cannot claim ` +
                `${id}; it is already claimed by "${existing.run}"`,
            )
          }
          claimed.set(id, { occurrence: { ...key }, run: run.run })
        }
        break
      }
      case 'harvest.step.started': {
        const run = requireRun(runs, event.payload.run, event)
        run.steps.push({
          step: event.payload.step,
          ...(event.payload.round !== undefined
            ? { round: event.payload.round }
            : {}),
          startedSeq: event.seq,
          startedAt: event.ts,
        })
        break
      }
      case 'harvest.step.completed': {
        const run = requireRun(runs, event.payload.run, event)
        const occurrence = [...run.steps]
          .reverse()
          .find(
            (step) =>
              step.step === event.payload.step &&
              step.round === event.payload.round &&
              step.completedSeq === undefined,
          )
        const target =
          occurrence ??
          ({
            step: event.payload.step,
            ...(event.payload.round !== undefined
              ? { round: event.payload.round }
              : {}),
            startedSeq: event.seq,
            startedAt: event.ts,
          } satisfies HarvestStepOccurrence)
        if (occurrence === undefined) run.steps.push(target)
        target.completedSeq = event.seq
        target.completedAt = event.ts
        target.outcome = event.payload.outcome
        if (event.payload.artifact !== undefined) {
          target.artifact = cloneRef(event.payload.artifact)
        }
        if (event.payload.detail !== undefined) target.detail = event.payload.detail
        break
      }
      case 'harvest.proposals.submitted': {
        const run = requireRun(runs, event.payload.run, event)
        run.proposals.push({
          round: event.payload.round,
          artifact: cloneRef(event.payload.artifact),
          seq: event.seq,
        })
        break
      }
      case 'harvest.review.verdict': {
        const run = requireRun(runs, event.payload.run, event)
        run.reviews.push({
          round: event.payload.round,
          verdict: event.payload.verdict,
          findings: structuredClone(event.payload.findings),
          artifact: cloneRef(event.payload.artifact),
          ...(event.payload.reason !== undefined
            ? { reason: event.payload.reason }
            : {}),
          seq: event.seq,
        })
        break
      }
      case 'harvest.proposal.id-reserved': {
        const run = requireRun(runs, event.payload.run, event)
        const normalizedId = event.payload.id.toLowerCase()
        const existingKey = run.reservations.find(
          (entry) => entry.proposalKey === event.payload.proposalKey,
        )
        if (existingKey !== undefined) {
          if (existingKey.id.toLowerCase() !== normalizedId) {
            throw new Error(
              `harvest proposal key "${event.payload.proposalKey}" was already ` +
                `reserved as "${existingKey.id}" at repo seq ${existingKey.seq}; ` +
                `repo seq ${event.seq} cannot replace it with "${event.payload.id}"`,
            )
          }
          // Exact replay is one logical reservation.
          break
        }
        const existingId = run.reservations.find(
          (entry) => entry.id.toLowerCase() === normalizedId,
        )
        if (existingId !== undefined) {
          throw new Error(
            `harvest reserved id "${event.payload.id}" already belongs to proposal ` +
              `key "${existingId.proposalKey}" at repo seq ${existingId.seq}; ` +
              `repo seq ${event.seq} cannot reuse it for "${event.payload.proposalKey}"`,
          )
        }
        run.reservations.push({
          proposalKey: event.payload.proposalKey,
          id: event.payload.id,
          seq: event.seq,
        })
        break
      }
      case 'harvest.proposal.filed': {
        const run = requireRun(runs, event.payload.run, event)
        // Idempotent projection: a retry may adopt the external ticket and see
        // the already-journaled fact. Keep one entry per stable proposal key.
        const existing = run.filed.find(
          (entry) => entry.proposalKey === event.payload.proposalKey,
        )
        if (!existing) {
          run.filed.push({
            proposalKey: event.payload.proposalKey,
            ticket: structuredClone(event.payload.ticket),
            seq: event.seq,
          })
        }
        break
      }
      case 'harvest.completed': {
        const run = requireRun(runs, event.payload.run, event)
        if (run.status !== 'running') break
        run.status = 'completed'
        run.dispositions = structuredClone(event.payload.dispositions)
        run.report = cloneRef(event.payload.report)
        run.terminalSeq = event.seq
        run.terminalAt = event.ts
        for (const disposition of run.dispositions) {
          ledger.push({
            ...structuredClone(disposition),
            run: run.run,
            seq: event.seq,
          })
        }
        break
      }
      case 'harvest.escalated': {
        const run = requireRun(runs, event.payload.run, event)
        if (run.status !== 'running') break
        run.status = 'escalated'
        run.escalation = {
          source: event.payload.source,
          reason: event.payload.reason,
          ...(event.payload.round !== undefined
            ? { round: event.payload.round }
            : {}),
        }
        run.terminalSeq = event.seq
        run.terminalAt = event.ts
        break
      }
      case 'harvest.failed': {
        const run = requireRun(runs, event.payload.run, event)
        // Completion and deliberate escalation are irrevocable outcomes. A
        // late infrastructure fact remains in the journal but cannot replace
        // either with a recoverable error projection.
        if (run.status !== 'running') break
        run.failure = {
          step: event.payload.step,
          ...(event.payload.round !== undefined
            ? { round: event.payload.round }
            : {}),
          attempt: event.payload.attempt,
          error: event.payload.error,
          willRetry: event.payload.willRetry,
        }
        if (!event.payload.willRetry) {
          // Failed is a parked infrastructure stop, not a completed outcome.
          // The claim and every workflow artifact remain owned by this run
          // until an explicit harvest.resumed fact reopens it.
          run.status = 'failed'
        }
        break
      }
      case 'harvest.session.started':
      case 'harvest.session.ended':
        // Session facts remain individually queryable but add no transition.
        break
      case 'dispatcher.intake-set':
      case 'dispatcher.auto-merge-default-set':
        // Dispatcher controls share the repository journal but are projected
        // independently; they never alter harvest workflow state.
        break
    }
  }

  const state: HarvestState = {
    lastSeq,
    runs: order,
    paused,
    ...(pausedSeq !== undefined ? { pausedSeq } : {}),
    ...(pausedAt !== undefined ? { pausedAt } : {}),
    pendingCommands: [...pending.pause, ...pending.resume].sort(
      (left, right) => left.seq - right.seq,
    ),
    claimed: [...claimed.values()].map(({ occurrence }) => occurrence),
    ledger,
  }
  const latest = order.at(-1)
  if (latest !== undefined) state.latest = latest
  return state
}

export function claimedOccurrenceKeys(state: HarvestState): Set<string> {
  return new Set(state.claimed.map(occurrenceKey))
}

/** Runs are always returned in durable start order. `latest` remains useful for
 * history, but recovery and execution must never use it as an authority. */
export function parkedHarvestRuns(state: HarvestState): HarvestRunState[] {
  return state.runs.filter(isOrdinaryParkedRun)
}

export function unresolvedHarvestAttentionRuns(
  state: HarvestState,
): HarvestRunState[] {
  return state.runs.filter(hasUnresolvedExhaustion)
}

export function openHarvestRuns(state: HarvestState): HarvestRunState[] {
  return state.runs.filter((run) => run.status === 'running')
}

/** The concrete run a control boundary should report if it parks. Exhaustion
 * barriers are repository-global, then ordinary parked work takes priority,
 * then the oldest open workflow is the run execution should continue. */
export function actionableHarvestRun(
  state: HarvestState,
): HarvestRunState | undefined {
  return (
    unresolvedHarvestAttentionRuns(state)[0] ??
    parkedHarvestRuns(state)[0] ??
    openHarvestRuns(state)[0]
  )
}

/** Pure repository-control routing shared by dispatcher and harvest runner.
 * Human commands settle first. Recorded exhaustion is a global barrier; then
 * every durable automatic request is acknowledged before the oldest ordinary
 * parked run receives its next run-local attempt. Only a journal with no
 * unresolved failure may proceed to open work or a new scan. */
export function decideHarvestControl(
  state: HarvestState,
  maxRecoveryAttempts = DEFAULT_MAX_HARVEST_RECOVERY_ATTEMPTS,
): HarvestControlDecision {
  if (!Number.isInteger(maxRecoveryAttempts) || maxRecoveryAttempts <= 0) {
    throw new Error('max harvest recovery attempts must be a positive integer')
  }
  const wantsResume = state.pendingCommands.some(
    (command) => command.command === 'resume',
  )
  if (state.paused) {
    if (wantsResume) return { kind: 'acknowledge', command: 'resume' }
    return { kind: 'park' }
  }
  if (state.pendingCommands.some((command) => command.command === 'pause')) {
    return { kind: 'acknowledge', command: 'pause' }
  }
  // A stale/racing human resume is still a command and must be consumed. It
  // reopens all ordinary failures and acknowledges all exhaustion barriers.
  if (wantsResume) return { kind: 'acknowledge', command: 'resume' }

  if (unresolvedHarvestAttentionRuns(state).length > 0) {
    return { kind: 'park' }
  }

  const parked = parkedHarvestRuns(state)
  if (
    parked.some((run) =>
      run.recoveryRequests.some(
        (request) => request.acknowledgedSeq === undefined,
      ),
    )
  ) {
    return { kind: 'acknowledge', command: 'resume' }
  }

  const run = parked[0]
  if (run === undefined) return { kind: 'proceed' }

  const attempts = run.recoveryRequests.length
  // Once the first request records the applied policy, replacements honor
  // that durable limit even if a later process ships a different default.
  const appliedLimit = run.recoveryRequests[0]?.limit ?? maxRecoveryAttempts
  if (attempts < appliedLimit) {
    return {
      kind: 'request-recovery',
      run: run.run,
      attempt: attempts + 1,
      limit: appliedLimit,
    }
  }
  return {
    kind: 'exhaust-recovery',
    run: run.run,
    attempts,
    limit: appliedLimit,
  }
}

export function openHarvestRun(state: HarvestState): HarvestRunState | undefined {
  return openHarvestRuns(state)[0]
}

export function proposalArtifactForRound(
  run: HarvestRunState,
  round: number,
): ArtifactRef | undefined {
  return [...run.proposals]
    .reverse()
    .find((proposal) => proposal.round === round)?.artifact
}
