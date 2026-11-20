/**
 * The optimization node's derived state (SPEC §15.5, RFC 0005 §11): a bounded
 * digest the dispatcher, status and `ab objective` read from BuildState, and
 * a ledger of settled attempts the proposer reads once per run.
 *
 * Both fold only the node's own log. `attempt.settled` carries the measured
 * delta, so neither ever reads an attempt's log.
 */
import type { AbEvent } from '../events/catalog'
import type {
  AttemptOutcome,
  EventPayload,
  OptimizationStopCause,
  UnmeasuredMergeReason,
  UnmeasuredSettlementPolicy,
} from '../events/payloads'
import {
  applyObjectiveRevisions,
  objectiveRulerChanged,
  REVISABLE_FIELDS,
  type Objective,
  type ObjectiveEpsilon,
  type RevisableField,
} from '../objective'
import type { TicketRef } from '../ontology'
import { defineReducer } from './incremental'
export { optimizationCompletionBlocker } from './integration-state'
import type { BuildState } from './reducer'
import { direction, HOUR_MS, optimizationAdmission } from './optimization-admission'

// The admission selectors live in a module with no reducer machinery, so the
// browser dashboards can import them through dispatch capacity.
export * from './optimization-admission'

/** One proposed attempt that has not settled. Admission caps these at the
 * objective's concurrency, so the list is bounded. */
export interface InFlightAttempt {
  proposal: string
  ticket: TicketRef
  /** The attempt merged without a valid landing measurement of its merged
   * head. It keeps its slot until an operator settles it `merged-unmeasured`. */
  unmeasuredMerge?: UnmeasuredMerge
}

/** An in-flight attempt's merge that no landing measurement covers. */
export interface UnmeasuredMerge {
  build: string
  /** The merged head; absent only when `reason` is `unresolvable`. */
  sha?: string
  reason: UnmeasuredMergeReason
  measuredCandidate?: string
  at: string
}

/** A settled, non-accepted attempt whose ticket the dispatcher has not yet
 * moved to the rejected role (SPEC §13). Settlement transfers an attempt from
 * `inFlight` to here, and admission counts both lists against concurrency, so
 * `inFlight.length + rejections.length` never exceeds `proposer.concurrency`
 * through new proposals. An entry exists only between settlement and the
 * move's `attempt.ticket-rejected`. */
export interface PendingRejection {
  proposal: string
  ticket: TicketRef
  /** The attempt's build, when it was ever claimed. */
  build?: string
  outcome: Exclude<AttemptOutcome, 'accepted' | 'merged-unmeasured'>
  /** The attempt's published build branch, still to be deleted from the
   * forge: the durable cleanup obligation of a declined or no-improvement
   * settlement. Cleared by `attempt.branch-deleted`. */
  branch?: string
  /** The latest failed deletion of `branch`, until it succeeds. */
  branchCleanupError?: string
}

export interface OptimizationValue {
  value: number
  spread: number
  head: string
}

/** The bounded per-node digest. Plain JSON; its size never grows with the
 * number of settled attempts. */
export interface OptimizationState {
  /** The latest `optimization.objective-accepted`. */
  accepted: EventPayload<'optimization.objective-accepted'> & { acceptedAt: string }
  /** When the objective was first accepted: the start of the hours budget. */
  openedAt: string
  /** The accepted objective with every later quick revision applied. */
  objective: Objective
  /** The latest objective revision, across acceptances and quick revisions. */
  revision: number
  /** Fields quick-revised since the latest acceptance. */
  revisedFields: RevisableField[]
  /** The acceptance that started the current ruler. Measurements under an
   * older revision are history and feed no value below. */
  rulerRevision: number
  /** The head measured against itself under the current ruler. A panel's
   * starting value is 0.5 by definition. */
  starting?: OptimizationValue
  /** The node head's value: a command's latest accepted candidate median, a
   * panel's latest head-against-start win rate. Falls back to the starting
   * value. */
  current?: number
  /** The best value in the objective's direction under the current ruler. */
  best?: number
  /** A panel node's landed heads (`attempt.settled.head` of `accepted`
   * settlements under the current ruler) that have no `progress-measured`
   * yet, oldest first; absent when empty. Bounded: the landing gate holds the
   * next attempt while it is non-empty, so it holds at most one head under
   * kernel control. */
  progressQueue?: string[]
  attempts: {
    /** Tickets proposed, which the attempts budget counts. */
    filed: number
    accepted: number
    /** Settled as no-improvement, declined, stopped or aborted. */
    rejected: number
    /** Merged without a landing measurement and released by an operator:
     * neither accepted nor rejected. */
    unmeasured: number
  }
  /** Proposed attempts that have not settled; `inFlight.length` are running. */
  inFlight: InFlightAttempt[]
  /** Settled, non-accepted attempts whose ticket move is still pending. */
  rejections: PendingRejection[]
  /** Consecutive `no-improvement` or `declined` settlements since the last
   * `accepted`. `stopped` and `aborted` leave it unchanged. */
  plateau: number
  /** Consecutive proposals that returned no attempts. */
  emptyProposals: number
  /** Proposal requests recorded; the propose phase's round counter. */
  requests: number
  /** The open proposal request: recorded by the dispatcher, deposited by the
   * proposer, closed by the filing's `attempts-proposed` or, before any
   * deposit, a withdrawal. At most one; `ids` are at most `room`. */
  proposal?: OpenProposal
  stopped?: { cause: OptimizationStopCause; mode: 'abort' | 'drain'; at: string }
  /** Tickets of attempts settled `stopped`, which the claim gate refuses.
   * Bounded: only attempts in flight at the stop settle `stopped`, and
   * admission caps those at the objective's concurrency. */
  stoppedTickets?: TicketRef[]
}

export interface OpenProposal {
  id: string
  head: string
  /** The attempts this request may deposit, fixed when it was recorded. */
  room: number
  requestedAt: string
  round: number
  deposited?: { artifact: { kind: string; rev: number }; ids: string[]; at: string }
}

/** The digest accumulator, embedded in BuildAcc. Undefined until the first
 * acceptance. */
export type OptimizationAcc = OptimizationState | undefined

function better(objective: Objective, a: number | undefined, b: number): number {
  if (a === undefined) return b
  return direction(objective) === 'minimize' ? Math.min(a, b) : Math.max(a, b)
}

/** Whether `event` is a node-log fact the digest folds. */
export function isOptimizationEvent(event: { type: string }): boolean {
  return (
    event.type.startsWith('optimization.') ||
    event.type === 'attempt.settled' ||
    event.type === 'propose.completed' ||
    event.type === 'attempt.ticket-rejected' ||
    event.type === 'attempt.merged-unmeasured' ||
    event.type === 'attempt.branch-deleted' ||
    event.type === 'attempt.branch-cleanup-failed'
  )
}

function startRuler(state: OptimizationState, revision: number) {
  state.rulerRevision = revision
  delete state.starting
  delete state.current
  delete state.best
  delete state.progressQueue
  if (state.objective.metric.kind === 'panel') {
    state.current = 0.5
    state.best = 0.5
  }
}

/** Fold node-log events into the digest. Returns the advanced value; the
 * previous one is mutated in place when it exists. */
export function advanceOptimization(acc: OptimizationAcc, events: readonly AbEvent[]) {
  let state = acc
  for (const event of events) {
    if (event.type === 'optimization.objective-accepted') {
      const accepted = { ...structuredClone(event.payload), acceptedAt: event.ts }
      if (state === undefined) {
        state = {
          accepted,
          openedAt: event.ts,
          objective: structuredClone(event.payload.objective),
          revision: event.payload.revision,
          revisedFields: [],
          rulerRevision: event.payload.revision,
          attempts: { filed: 0, accepted: 0, rejected: 0, unmeasured: 0 },
          inFlight: [],
          rejections: [],
          plateau: 0,
          emptyProposals: 0,
          requests: 0,
        }
        startRuler(state, event.payload.revision)
        continue
      }
      const changed = objectiveRulerChanged(state.accepted.objective, event.payload.objective)
      state.accepted = accepted
      state.objective = structuredClone(event.payload.objective)
      state.revision = event.payload.revision
      state.revisedFields = []
      if (changed) startRuler(state, event.payload.revision)
      continue
    }
    if (state === undefined) continue
    switch (event.type) {
      case 'optimization.objective-revised': {
        state.objective = applyObjectiveRevisions(state.objective, [event.payload.changes])
        state.revision = event.payload.revision
        const revised = new Set([...state.revisedFields, ...Object.keys(event.payload.changes)])
        state.revisedFields = REVISABLE_FIELDS.filter((field) => revised.has(field))
        break
      }
      case 'optimization.baseline-measured': {
        if (event.payload.revision < state.rulerRevision) break
        const panel = state.objective.metric.kind === 'panel'
        const value = panel ? 0.5 : event.payload.median
        state.starting = { value, spread: event.payload.spread, head: event.payload.head }
        if (!panel) {
          state.current ??= value
          state.best = better(state.objective, state.best, value)
        }
        break
      }
      case 'optimization.noise-exceeded':
        // Advisory attention only: the starting value arrives with the
        // `baseline-measured` fact written after it.
        break
      case 'optimization.progress-measured': {
        if (event.payload.revision < state.rulerRevision) break
        if (event.payload.start !== state.starting?.head) break
        state.current = event.payload.winRate
        state.best = better(state.objective, state.best, event.payload.winRate)
        const queue = state.progressQueue?.filter((head) => head !== event.payload.head) ?? []
        if (queue.length > 0) state.progressQueue = queue
        else delete state.progressQueue
        break
      }
      case 'optimization.proposal-requested':
        state.requests += 1
        state.proposal = {
          id: event.payload.id,
          head: event.payload.head,
          room: event.payload.room,
          requestedAt: event.ts,
          round: state.requests,
        }
        break
      case 'propose.completed':
        if (state.proposal?.id === event.payload.request && !state.proposal.deposited)
          state.proposal.deposited = {
            artifact: { ...event.payload.artifact },
            ids: [...event.payload.proposals],
            at: event.ts,
          }
        break
      case 'optimization.proposal-withdrawn':
        // A deposit is a commitment: only an undeposited request withdraws.
        if (state.proposal?.id === event.payload.request && !state.proposal.deposited)
          delete state.proposal
        break
      case 'optimization.attempts-proposed':
        if (state.proposal?.id === event.payload.request) delete state.proposal
        state.attempts.filed += event.payload.proposals.length
        state.emptyProposals = event.payload.proposals.length === 0 ? state.emptyProposals + 1 : 0
        for (const proposal of event.payload.proposals)
          if (!state.inFlight.some((attempt) => attempt.proposal === proposal.id))
            state.inFlight.push({ proposal: proposal.id, ticket: proposal.ticket })
        break
      case 'attempt.settled': {
        const { attempt, outcome, measurement } = event.payload
        const wasInFlight = state.inFlight.some((entry) => entry.proposal === attempt.proposal)
        state.inFlight = state.inFlight.filter((entry) => entry.proposal !== attempt.proposal)
        if (outcome === 'merged-unmeasured') {
          // The code merged and its ticket is done: release the slot and
          // count it, but record no value, no plateau step, no rejection.
          if (wasInFlight) state.attempts.unmeasured += 1
          break
        }
        // Only a transfer out of `inFlight` adds a pending rejection, so
        // settlement never grows the two lists' combined length.
        if (
          outcome !== 'accepted' &&
          wasInFlight &&
          !state.rejections.some((entry) => entry.proposal === attempt.proposal)
        )
          state.rejections.push({
            proposal: attempt.proposal,
            ticket: structuredClone(attempt.ticket),
            ...(attempt.build !== undefined ? { build: attempt.build } : {}),
            outcome,
            ...(attempt.branch !== undefined ? { branch: attempt.branch } : {}),
          })
        if (outcome === 'accepted') {
          state.attempts.accepted += 1
          state.plateau = 0
          if (
            state.objective.metric.kind === 'command' &&
            measurement !== undefined &&
            measurement.revision >= state.rulerRevision
          ) {
            state.current = measurement.candidate
            state.best = better(state.objective, state.best, measurement.candidate)
          }
          // A panel's settlement win rate is against the previous head, not
          // the start: its progress comes from a panel of the landed head.
          const head = event.payload.head
          if (state.objective.metric.kind === 'panel' && head !== undefined) {
            state.progressQueue ??= []
            if (!state.progressQueue.includes(head)) state.progressQueue.push(head)
          }
          break
        }
        state.attempts.rejected += 1
        if (outcome === 'no-improvement' || outcome === 'declined') state.plateau += 1
        if (outcome === 'stopped') {
          state.stoppedTickets ??= []
          if (
            !state.stoppedTickets.some((ticket) => ticketKey(ticket) === ticketKey(attempt.ticket))
          )
            state.stoppedTickets.push(attempt.ticket)
        }
        break
      }
      case 'optimization.stopped':
        state.stopped ??= { ...event.payload, at: event.ts }
        break
      case 'attempt.ticket-rejected':
        state.rejections = state.rejections.filter(
          (entry) => entry.proposal !== event.payload.proposal,
        )
        break
      case 'attempt.merged-unmeasured': {
        const entry = state.inFlight.find((attempt) => attempt.proposal === event.payload.proposal)
        if (entry === undefined || entry.unmeasuredMerge !== undefined) break
        const { build, sha, reason, measuredCandidate } = event.payload
        entry.unmeasuredMerge = {
          build,
          ...(sha !== undefined ? { sha } : {}),
          reason,
          ...(measuredCandidate !== undefined ? { measuredCandidate } : {}),
          at: event.ts,
        }
        break
      }
      case 'attempt.branch-deleted':
      case 'attempt.branch-cleanup-failed': {
        const entry = state.rejections.find(
          (rejection) =>
            rejection.proposal === event.payload.proposal &&
            rejection.branch === event.payload.branch,
        )
        if (entry === undefined) break
        if (event.type === 'attempt.branch-deleted') {
          delete entry.branch
          delete entry.branchCleanupError
        } else entry.branchCleanupError = event.payload.error
        break
      }
    }
  }
  return state
}

/** The digest as a registered build-scoped value. BuildState embeds the same
 * fold; this registration lets the shape contract and incremental tests hold
 * it independently. */
export const optimizationReducer = defineReducer<
  { state?: OptimizationState },
  AbEvent,
  OptimizationState | null
>({
  identity: 'optimization',
  initial: () => ({}),
  fold(acc, events) {
    const state = advanceOptimization(acc.state, events)
    if (state !== undefined) acc.state = state
  },
  finish: (acc) => (acc.state === undefined ? null : structuredClone(acc.state)),
})

/** What the stop enforcer knows about one in-flight attempt's newest build. */
export interface OptimizationAttemptBuild {
  slug: string
  terminal?: 'done' | 'aborted'
  merged?: boolean
  /** The build's reduced state; read only for an unmerged build that is not
   * mid-abort, since abort cleanup ends in `build.completed {abandoned}`. */
  state?: Pick<
    BuildState,
    'status' | 'outcome' | 'currentPhase' | 'lastCompletedPhase' | 'pendingCommands'
  >
}

export interface OptimizationStopActions {
  /** Attempts to settle `stopped`, with the build that ran, if any. */
  settle: { attempt: InFlightAttempt; build?: string }[]
  /** Attempt builds to request an abort of. */
  abort: { slug: string; reason: string }[]
}

/**
 * What a stopped node does to its in-flight attempts (RFC 0005 §9.2). Both
 * modes cancel an attempt that never got a build or never started work; an
 * aborted build is left to abort cleanup for settlement. Abort mode aborts every running attempt;
 * drain mode lets a running one finish and face the landing gate. A done or
 * merged attempt is the landing gate's to settle.
 */
export function optimizationStopActions(
  node: { slug: string; stopped: NonNullable<OptimizationState['stopped']> },
  attempts: readonly { attempt: InFlightAttempt; build?: OptimizationAttemptBuild }[],
): OptimizationStopActions {
  const reason = `optimization node ${node.slug} stopped (${node.stopped.cause}, ${node.stopped.mode})`
  const actions: OptimizationStopActions = { settle: [], abort: [] }
  for (const { attempt, build } of attempts) {
    if (build === undefined) {
      actions.settle.push({ attempt })
      continue
    }
    // Abort cleanup alone settles builds, from the first request's origin.
    if (build.terminal === 'aborted' || build.state?.outcome === 'abandoned') continue
    if (build.terminal === 'done' || build.merged || build.state === undefined) continue
    const state = build.state
    if (state.status === 'done' || state.status === 'aborted') continue
    if (state.pendingCommands.some((command) => command.command === 'abort')) continue
    const started =
      state.status === 'running' ||
      state.currentPhase !== undefined ||
      state.lastCompletedPhase !== undefined
    if (node.stopped.mode === 'abort' || !started) actions.abort.push({ slug: build.slug, reason })
  }
  return actions
}

function ticketKey(ref: TicketRef): string {
  const source = ref.source === 'database' ? 'hosted' : ref.source
  return `${source}\u0000${ref.id}`
}

/**
 * The in-flight attempt `ticket` is, when it is one. A build is an attempt of
 * a node exactly when its ticket was created from a recorded proposal of that
 * node; children filed any other way are not attempts. Settled attempts are
 * in the ledger. `key` lets a caller apply its ticket-migration identity.
 */
export function optimizationAttempt(
  state: OptimizationState | undefined,
  ticket: TicketRef,
  key: (ref: TicketRef) => string = ticketKey,
): InFlightAttempt | undefined {
  if (state === undefined) return undefined
  const wanted = key(ticket)
  return state.inFlight.find((attempt) => key(attempt.ticket) === wanted)
}

/** The pending rejection for `ticket`: a settled attempt whose ticket has not
 * yet moved to the rejected role. */
export function optimizationRejection(
  state: OptimizationState | undefined,
  ticket: TicketRef,
  key: (ref: TicketRef) => string = ticketKey,
): PendingRejection | undefined {
  if (state === undefined) return undefined
  const wanted = key(ticket)
  return state.rejections.find((entry) => key(entry.ticket) === wanted)
}

/** An in-flight attempt merged without a landing measurement, as the status
 * surfaces list it. */
export interface UnmeasuredMergeView {
  proposal: string
  ticket: string
  build: string
  /** Absent only for an `unresolvable` merge. */
  sha?: string
  reason: UnmeasuredMergeReason
  measuredCandidate?: string
}

/** A settled attempt whose published build branch still awaits deletion. */
export interface PendingCleanupView {
  proposal: string
  build?: string
  branch: string
  /** The latest failed deletion, when one was recorded. */
  error?: string
}

/** The in-flight attempts holding a slot as unmeasured merges. */
export function optimizationUnmeasuredMerges(state: OptimizationState): UnmeasuredMergeView[] {
  return state.inFlight.flatMap(({ proposal, ticket, unmeasuredMerge: merge }) =>
    merge === undefined
      ? []
      : [
          {
            proposal,
            ticket: ticket.id,
            build: merge.build,
            ...(merge.sha !== undefined ? { sha: merge.sha } : {}),
            reason: merge.reason,
            ...(merge.measuredCandidate !== undefined
              ? { measuredCandidate: merge.measuredCandidate }
              : {}),
          },
        ],
  )
}

/** The pending rejections that still carry a branch cleanup obligation. */
export function optimizationPendingCleanups(state: OptimizationState): PendingCleanupView[] {
  return state.rejections.flatMap(({ proposal, build, branch, branchCleanupError }) =>
    branch === undefined
      ? []
      : [
          {
            proposal,
            ...(build !== undefined ? { build } : {}),
            branch,
            ...(branchCleanupError !== undefined ? { error: branchCleanupError } : {}),
          },
        ],
  )
}

export interface LedgerEntry {
  seq: number
  proposal: string
  ticket: TicketRef
  build?: string
  title: string
  strategy: string
  outcome: AttemptOutcome
  /** `merged-unmeasured`: the merged head, when recorded, and the policy that
   * released it. Such an entry carries no measurement. */
  mergedSha?: string
  policy?: UnmeasuredSettlementPolicy
  delta?: number
  baseline?: number
  candidate?: number
  note?: string
  /** Improved by less than ε: a strategy worth knowing about. */
  nearMiss?: true
}

/** Improved, but by less than the ε then in effect. A relative ε is scaled by
 * the baseline's magnitude. */
export function isNearMiss(
  entry: Pick<LedgerEntry, 'outcome' | 'delta' | 'baseline'>,
  epsilon: ObjectiveEpsilon,
): boolean {
  if (entry.outcome !== 'no-improvement' || entry.delta === undefined || entry.delta <= 0)
    return false
  const threshold =
    epsilon.relative !== undefined
      ? epsilon.relative * Math.abs(entry.baseline ?? 0)
      : (epsilon.absolute ?? 0)
  return entry.delta < threshold
}

export interface OptimizationLedger {
  /** The ε in effect, for near-miss flags. */
  epsilon?: ObjectiveEpsilon
  /** Proposed attempts by proposal id, until they settle. */
  pending: Record<string, { title: string; strategy: string }>
  entries: LedgerEntry[]
}

/** The attempt ledger: one entry per `attempt.settled`, advanced from the
 * node's log alone. Its size grows with settled attempts, which `maxAttempts`
 * bounds; only an explicit history request (the proposer) reads it. */
export const optimizationLedgerReducer = defineReducer<
  OptimizationLedger,
  AbEvent,
  OptimizationLedger
>({
  identity: 'optimizationLedger',
  initial: () => ({ pending: {}, entries: [] }),
  fold(acc, events) {
    for (const event of events) {
      switch (event.type) {
        case 'optimization.objective-accepted':
          acc.epsilon = { ...event.payload.objective.target.epsilon }
          break
        case 'optimization.objective-revised':
          if (event.payload.changes.epsilon !== undefined)
            acc.epsilon = { ...event.payload.changes.epsilon }
          break
        case 'optimization.attempts-proposed':
          for (const proposal of event.payload.proposals)
            acc.pending[proposal.id] = { title: proposal.title, strategy: proposal.strategy }
          break
        case 'attempt.settled': {
          const { attempt, outcome, measurement, note, mergedSha, policy } = event.payload
          const pending = acc.pending[attempt.proposal]
          delete acc.pending[attempt.proposal]
          const entry: LedgerEntry = {
            seq: event.seq,
            proposal: attempt.proposal,
            ticket: attempt.ticket,
            ...(attempt.build !== undefined ? { build: attempt.build } : {}),
            title: pending?.title ?? attempt.ticket.title ?? attempt.ticket.id,
            strategy: pending?.strategy ?? '',
            outcome,
            ...(mergedSha !== undefined ? { mergedSha } : {}),
            ...(policy !== undefined ? { policy } : {}),
            ...(measurement !== undefined
              ? {
                  delta: measurement.delta,
                  baseline: measurement.baseline,
                  candidate: measurement.candidate,
                }
              : {}),
            ...(note !== undefined ? { note } : {}),
          }
          if (acc.epsilon !== undefined && isNearMiss(entry, acc.epsilon)) entry.nearMiss = true
          acc.entries.push(entry)
          break
        }
      }
    }
  },
  finish: (acc) => structuredClone(acc),
})

/**
 * Node-log facts that can clear a `ProposerBlocker`. A node whose proposer
 * was deferred is read again only once one of these lands after the
 * deferral. A superset is safe: an extra wake costs one read and one write
 * per real fact, never a recurring read.
 */
export const PROPOSER_WAKE_EVENT_TYPES = [
  // paused: a resume acknowledgement.
  'build.resumed',
  // command: the acknowledgements that drain pending operator commands.
  'build.paused',
  'build.aborted',
  // blocked: what closes an open escalation.
  'escalation.answered',
  'escalation.raised',
  'wait.ended',
  'build.janitor-recovered',
  'verify.cancelled',
  // restack: the replay receipts and settlement that clear a node writer.
  'node.item-replayed',
  'node.writer-settled',
  'reconcile.completed',
  // integration: a landing intent abandons or lands.
  'integration.abandoned',
  'integration.landed',
  // landing: a pull request opens again.
  'pr.opened',
  'pr.closed',
  'pr.merged',
  // Every optimization fact except the deferral itself: settlements and
  // revisions change room.
  'optimization.objective-accepted',
  'optimization.objective-revised',
  'optimization.baseline-measured',
  'optimization.progress-measured',
  'optimization.proposal-requested',
  'optimization.proposal-withdrawn',
  'optimization.attempts-proposed',
  'optimization.stopped',
  'propose.completed',
  'attempt.settled',
  'attempt.ticket-rejected',
] as const satisfies readonly AbEvent['type'][]

const WAKE_TYPES = new Set<string>(PROPOSER_WAKE_EVENT_TYPES)

export function isProposerWakeEvent(event: { type: string }): boolean {
  return WAKE_TYPES.has(event.type)
}

/**
 * The bounded optimization signal a node's build digest carries: exactly
 * what the dispatcher's proposer stage and the creation hold need to decide,
 * without reading the build, whether a node has due work. Constant size in
 * history; `deposited.ids` is at most the request's room.
 */
export interface OptimizationSignal {
  stopped?: true
  /** A starting value exists under the current ruler. */
  measured?: true
  inFlight: number
  concurrency: number
  /** Attempts the budget still allows; absent without an attempts budget. */
  attemptRoom?: number
  emptyProposals: number
  openedAt: string
  maxHours?: number
  proposal?: { request: string; deposited?: { ids: string[]; at: string } }
  /** seq of the latest fact that can clear a proposer blocker. */
  wakeSeq?: number
  /** seq of the latest `optimization.proposal-deferred`. */
  deferredSeq?: number
}

export function optimizationSignal(
  state: OptimizationState,
  seqs: { wakeSeq?: number; deferredSeq?: number } = {},
): OptimizationSignal {
  const { attemptRoom, slots } = optimizationAdmission(state, new Date(0))
  const maxHours = state.objective.budget.maxHours
  const proposal = state.proposal
  return {
    ...(state.stopped !== undefined ? { stopped: true as const } : {}),
    ...(state.starting !== undefined ? { measured: true as const } : {}),
    inFlight: state.inFlight.length,
    concurrency: state.inFlight.length + slots,
    ...(attemptRoom !== null ? { attemptRoom } : {}),
    emptyProposals: state.emptyProposals,
    openedAt: state.openedAt,
    ...(maxHours !== undefined ? { maxHours } : {}),
    ...(proposal !== undefined
      ? {
          proposal: {
            request: proposal.id,
            ...(proposal.deposited !== undefined
              ? { deposited: { ids: [...proposal.deposited.ids], at: proposal.deposited.at } }
              : {}),
          },
        }
      : {}),
    ...(seqs.wakeSeq !== undefined ? { wakeSeq: seqs.wakeSeq } : {}),
    ...(seqs.deferredSeq !== undefined ? { deferredSeq: seqs.deferredSeq } : {}),
  }
}

/** Which due work a node's digest signal shows, at `now`. `request` is a
 * candidate only: the dispatcher reads the build to confirm admission. A
 * deferred node shows no request or filing until a wake fact follows its
 * deferral, so an unchanged refused node costs no read. */
export function signalDue(
  signal: OptimizationSignal,
  now: Date,
  compatibilityDeferred = false,
): 'exhausted' | 'filing' | 'request' | undefined {
  if (signal.emptyProposals >= 2 && !signal.stopped) return 'exhausted'
  const deferred =
    signal.deferredSeq !== undefined &&
    (signal.wakeSeq === undefined || signal.wakeSeq < signal.deferredSeq)
  if (signal.proposal?.deposited !== undefined) return deferred ? undefined : 'filing'
  if (
    !deferred &&
    signal.proposal === undefined &&
    !signal.stopped &&
    signal.measured &&
    signal.inFlight < signal.concurrency &&
    signal.attemptRoom !== 0 &&
    signal.emptyProposals < 2 &&
    (signal.maxHours === undefined ||
      (now.getTime() - Date.parse(signal.openedAt)) / HOUR_MS < signal.maxHours) &&
    !compatibilityDeferred
  )
    return 'request'
  return undefined
}
