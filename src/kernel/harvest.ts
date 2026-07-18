/**
 * Pure reduction of the repository-scoped harvest journal. As with builds,
 * snapshots are never authoritative: dashboard state, resumption boundaries,
 * claims, and the dedup ledger are all re-derived from append-only facts.
 */
import type { HarvestEvent } from '../events/harvest'
import type { ArtifactRef, Finding, TicketRef } from '../ontology'
import {
  occurrenceKey,
  type HarvestDisposition,
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
  terminalSeq?: number
  terminalAt?: string
}

export interface HarvestLedgerEntry extends HarvestDisposition {
  run: string
  seq: number
}

export interface HarvestState {
  lastSeq: number
  runs: HarvestRunState[]
  latest?: HarvestRunState
  /** Every occurrence claimed by a harvest.started fact, terminal or not. */
  claimed: OccurrenceKey[]
  /** Successful terminal disposition facts. */
  ledger: HarvestLedgerEntry[]
}

function cloneRef(ref: ArtifactRef): ArtifactRef {
  return { kind: ref.kind, rev: ref.rev }
}

function requireRun(
  runs: Map<string, HarvestRunState>,
  run: string,
  event: HarvestEvent,
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
export function reduceHarvest(events: HarvestEvent[]): HarvestState {
  const runs = new Map<string, HarvestRunState>()
  const order: HarvestRunState[] = []
  const claimed = new Map<string, OccurrenceKey>()
  const ledger: HarvestLedgerEntry[] = []
  let lastSeq = 0

  for (const event of events) {
    lastSeq = Math.max(lastSeq, event.seq)
    switch (event.type) {
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
        }
        runs.set(run.run, run)
        order.push(run)
        for (const key of run.observations) {
          claimed.set(occurrenceKey(key), { ...key })
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
          run.status = 'failed'
          run.terminalSeq = event.seq
          run.terminalAt = event.ts
        }
        break
      }
      case 'harvest.session.started':
      case 'harvest.session.ended':
        // Session facts remain individually queryable but add no transition.
        break
    }
  }

  const state: HarvestState = {
    lastSeq,
    runs: order,
    claimed: [...claimed.values()],
    ledger,
  }
  const latest = order.at(-1)
  if (latest !== undefined) state.latest = latest
  return state
}

export function claimedOccurrenceKeys(state: HarvestState): Set<string> {
  return new Set(state.claimed.map(occurrenceKey))
}

export function openHarvestRun(state: HarvestState): HarvestRunState | undefined {
  return [...state.runs].reverse().find((run) => run.status === 'running')
}

export function proposalArtifactForRound(
  run: HarvestRunState,
  round: number,
): ArtifactRef | undefined {
  return [...run.proposals]
    .reverse()
    .find((proposal) => proposal.round === round)?.artifact
}
