import type { TicketStartPriority } from '../events/repository'
import type { TicketPriority } from '../ports/types'
import type { BuildRecord } from '../store/types'
import type { BuildState } from './reducer'
import { integrationAdmissible, integrationNeedsRunner } from './integration-state'
import { proposeAdmissible, proposeRunDue, proposeStarted } from './optimization-admission'
import { waitParked, waitResumeDue } from './ticket-wait'
import { escalationCarried, type EscalationCarryInput } from './verify-stage-state'
import { nodeMeasurementDue, pendingMeasurementRequest } from './measurement'
import {
  reopenRestart,
  reopenSpecPending,
  reopenUnsettled,
  reviseSpecPending,
} from './reopen-state'
import type { PolicyConfig } from '../config/schema'
import {
  backpressureExplanation,
  openPrBackpressure,
  openPrBackpressurePolicy,
  type OpenPrBackpressure,
} from './open-pr-backpressure'

/** Repository-scoped, reduced facts (SPEC §12 "What holds a slot").
 *
 * A leaf takes a slot only by admission: its `build.created` (a ticket claim
 * or start request) or the dispatcher's `slot.admitted`. It holds the slot
 * while Autobuild owes its next move, whether or not a runner works, and
 * releases it as soon as it waits on the outside world (`leafOutsideWait`): a
 * human (an open escalation, an acknowledged pause, a `revise-spec` answer
 * awaiting its revision, a merge decision or hold), another ticket, or the
 * forge. An open escalation that work Autobuild started still outruns (a
 * verify stage's other members, a recorded launch or its execution:
 * `escalationCarried`) does not release it, and its answer releases nothing.
 * Release follows state; acquisition never does, so a leaf whose outside
 * wait ended asks for a slot (`slotRequest`) and holds none until it is
 * admitted again. Runner liveness plays no part in a leaf's hold (only launch
 * records and execution facts do), and its workspace never counts. Nodes
 * hold a slot only while they need a runner;
 * their provisioning marker reserves one before a workspace exists. */
export interface CapacityBuild {
  record: BuildRecord
  state: BuildState
  workspace: boolean
  provisioning?: boolean
  /** The engine's awaiting-landing restack is due (`landingRestackDue`); omitted means false. */
  restackDue?: boolean
}

/** The slot a node or a leaf that holds none has durably requested. `resume`
 * is a leaf whose escalation was answered, whose pause was resumed, whose
 * ticket wait ended or whose target was rewritten; `reopen` is a leaf an
 * operator reopened; `propose` is an optimization node's open, still
 * eligible proposal request. */
export type SlotRequest = 'verification' | 'reconcile' | 'resume' | 'reopen' | 'propose'

/** One node or leaf waiting for a slot. `priority` is omitted for normal
 * builds, and by an older server. */
export interface SlotWaiter {
  slug: string
  request: SlotRequest
  priority?: 'urgent'
}

/** One build's slot state (SPEC §12 "What holds a slot"), by the rules
 * admission counts: `held` exactly when `occupiesCapacity`, otherwise
 * `requested` exactly when `slotRequest` names one (`priority` as the
 * build's `SlotWaiter` carries it), otherwise `none`. */
export type SlotState =
  | { state: 'held' }
  | { state: 'requested'; request: SlotRequest; priority?: 'urgent' }
  | { state: 'none' }

/** Slot admission order for free slots (SPEC §12, "Slot admission order"):
 * manual start requests, urgent parked work, urgent ticket claims (urgent
 * start requests first), normal parked work, normal ticket claims (normal
 * start requests first); each tier keeps its own order. */
export interface DispatchCapacity {
  configured: number
  /** Builds holding a slot; never above `configured` once admitted by the
   * slot arithmetic. */
  occupied: number
  /** @deprecated Always `configured`. Kept for clients in the version window,
   * which read it as the effective capacity. */
  effective: number
  /** @deprecated Always empty. Kept for clients in the version window, which
   * read it as the nodes borrowing descendant-held slots. */
  borrowingNodes: string[]
  /** Nodes waiting for a slot; omitted when none wait, and by an older server. */
  waitingNodes?: SlotWaiter[]
  /** Leaves waiting for a slot; omitted when none wait, and by an older server. */
  waitingBuilds?: SlotWaiter[]
  /** Urgent ticket claims the latest admission scan found waiting for a slot
   * (`urgentClaimDemand`); they go ahead of normal parked work. Omitted when
   * none, and when the caller has no repository facts. */
  urgentClaims?: number
  /** Open-PR backpressure on normal-priority claims; absent when disabled. */
  backpressure?: OpenPrBackpressure
  /** Pending operator start requests by tier (`startClaimDemand`); each
   * reserves a slot ahead of the lower tiers. Omitted when none, by an older
   * server, and when the caller has no repository facts. */
  startRequests?: Partial<Record<TicketStartPriority, number>>
  /** Each projected build's `slotState` by slug; empty when no build's is
   * known. Omitted by an older server. A missing entry, or a missing map,
   * is unknown, never `none`. */
  slots?: Record<string, SlotState>
}

/** A build's slot-admission priority; absent (historical builds, sources
 * without priority) reads as normal. */
export function buildPriority(state: Pick<BuildState, 'priority'>): TicketPriority {
  return state.priority === 'urgent' ? 'urgent' : 'normal'
}

/** Urgent ticket claims still waiting for a slot, from the latest scan fact.
 * Only an admission scan with intake on and the repository unpaused speaks
 * for claims that can run. */
export function urgentClaimDemand(facts: {
  scan?: { mode: 'admission' | 'observation'; urgentWaiting?: number }
  settings: { intake: boolean; paused: boolean }
}): number {
  if (!facts.settings.intake || facts.settings.paused || facts.scan?.mode !== 'admission') return 0
  return facts.scan.urgentWaiting ?? 0
}

/** What a capacity projection needs to report open-PR backpressure: the
 * effective `[policy]` and whether the durable engagement fact is set. */
export interface OpenPrBackpressureInput {
  policy:
    | Partial<Pick<PolicyConfig, 'maxOpenPrs' | 'resumeOpenPrs' | 'excludeHeldOpenPrs'>>
    | undefined
  engaged: boolean
}

/** Pending operator start requests by tier, counted whatever intake says:
 * a start request bypasses intake. Nothing while the repository is paused. */
export function startClaimDemand(facts: {
  ticketStarts: { pending: Record<string, { priority: TicketStartPriority }> }
  settings: { paused: boolean }
}): Partial<Record<TicketStartPriority, number>> {
  const demand: Partial<Record<TicketStartPriority, number>> = {}
  if (facts.settings.paused) return demand
  for (const { priority } of Object.values(facts.ticketStarts.pending))
    demand[priority] = (demand[priority] ?? 0) + 1
  return demand
}

/** Pending start requests of the named tiers. */
function startsOf(capacity: DispatchCapacity, tiers: readonly TicketStartPriority[]): number {
  return tiers.reduce((sum, tier) => sum + (capacity.startRequests?.[tier] ?? 0), 0)
}

/** A node's provisioning marker or continuation, or a live lease: a runner is working. */
function runnerAllocated(build: CapacityBuild, now: Date): boolean {
  return (
    !!build.provisioning ||
    (build.record.lease !== undefined && Date.parse(build.record.lease.expiresAt) > now.getTime())
  )
}

/** A workspace, a provisioning marker or a live lease holds runner capacity. */
function allocated(build: CapacityBuild, now: Date): boolean {
  return build.workspace || runnerAllocated(build, now)
}

/** The position the dispatcher records as settled: the later of the current
 * verify cycle's start and the latest finalize completion. A reconcile,
 * restack or config supersession opens a new cycle and so a new key. */
export function settlementKey(state: BuildState): number {
  return Math.max(state.verify.cycleSince, state.finalizeCompletedSeq)
}

function terminal(state: BuildState): boolean {
  return state.status === 'done' || state.status === 'aborted'
}

/** A nonterminal leaf that finished its pipeline (every verify step and
 * finalize post-step) for the current spec at least once, as recorded by
 * `pipeline.settled`. A spec revision after settlement makes it unfinished,
 * unless that revision published a reopen's spec: a reopened leaf re-runs
 * through the parked-work slot queue. */
export function epilogueLeaf(state: BuildState): boolean {
  return (
    state.kind !== 'node' &&
    !terminal(state) &&
    ((state.pipelineSettled ?? 0) > state.restartSince || reopenRestart(state))
  )
}

/** A provider-observable execution (one with a command id) stays open until
 * supervision records its end on provider proof, so it holds its runner past
 * an expired lease, unknown liveness included. A local execution's liveness
 * is its lease. */
function executionOpen(state: BuildState): boolean {
  return state.openExecution?.commandId !== undefined
}

/** What a leaf's slot depends on: its reduced state and whether the engine's
 * awaiting-landing restack is due. */
export type LeafSlotFacts = Pick<CapacityBuild, 'state' | 'restackDue'>

/** The build was admitted since its last release (SPEC §12 "What holds a
 * slot"). A value from an older server carries neither seq and reads as
 * admitted. */
export function slotAdmitted(
  state: Pick<BuildState, 'slotAdmittedSeq' | 'slotReleasedSeq'>,
): boolean {
  return state.slotAdmittedSeq === undefined || state.slotAdmittedSeq > (state.slotReleasedSeq ?? 0)
}

/** A finished leaf still owes work before it waits for its merge decision:
 * a rewritten target, a conflicted PR, a reopen (its spec publication
 * included), a restack, an unsettled verify cycle or finalize, a pending
 * measurement request, or an open session to recover or close. */
function epilogueWorkDue(build: LeafSlotFacts): boolean {
  const { state } = build
  return (
    state.sessions.open.length > 0 ||
    state.targetRewrite !== undefined ||
    state.prState === 'conflicted' ||
    reopenSpecPending(state) ||
    reopenUnsettled(state) ||
    !!build.restackDue ||
    epilogueUnsettled(state) ||
    pendingMeasurementRequest(state) !== undefined
  )
}

/** A leaf waiting on the outside world, which holds no slot: an open
 * escalation (an entered ticket wait's included), an acknowledged pause no
 * resume was requested for, a `revise-spec` answer awaiting its revision, or
 * a finished pipeline with no epilogue work due (a merge decision or hold,
 * merge gates or the forge). */
export function leafOutsideWait(build: LeafSlotFacts): boolean {
  const { state } = build
  if (state.status === 'blocked') return true
  if (
    state.status === 'paused' &&
    (state.openEscalations.length > 0 ||
      !state.pendingCommands.some((command) => command.command === 'resume'))
  )
    return true
  if (reviseSpecPending(state)) return true
  return epilogueLeaf(state) && !epilogueWorkDue(build)
}

/** The carry input of a leaf's reduced state (`escalationCarried`). */
export function escalationCarryInput(state: BuildState): EscalationCarryInput {
  return {
    openEscalations: state.openEscalations,
    verifyStage: state.verifyStage,
    verifyCycle: state.verify.cycleSince,
    maxAttemptSeen: state.verify.maxAttemptSeen,
    executions: state.executions,
    liveExecution: state.openExecution,
    slotAdmittedSeq: state.slotAdmittedSeq,
    failures: [state.dispatchFailures, state.infrastructureFailures, state.setupFailures],
  }
}

/** A leaf whose only outside wait is its open escalations: blocked, with no
 * `revise-spec` answer awaiting its revision and no finished pipeline
 * waiting for its merge decision. */
function blockedOnlyByEscalations(build: LeafSlotFacts): boolean {
  const { state } = build
  return (
    state.status === 'blocked' &&
    state.openEscalations.length > 0 &&
    !reviseSpecPending(state) &&
    !(epilogueLeaf(state) && !epilogueWorkDue(build))
  )
}

/** A nonterminal leaf holds a slot when it was admitted since its last
 * release and either does not wait on the outside world or waits only on
 * escalations that work Autobuild started still outruns (`escalationCarried`).
 * No lease or provisioning marker enters: a runner left over from before a
 * release never takes the slot back. */
export function leafHoldsSlot(build: LeafSlotFacts): boolean {
  return (
    !terminal(build.state) &&
    slotAdmitted(build.state) &&
    (!leafOutsideWait(build) ||
      (blockedOnlyByEscalations(build) && escalationCarried(escalationCarryInput(build.state))))
  )
}

/** An optimization node's workspace that no work owns: no runner, no open
 * execution, no starting or progress measurement, proposal, restack or integration cycle or intent, and no pause, block
 * or command holding it. Filing releases the proposer's workspace after its
 * record clears the proposal; this is the durable condition that recovers a
 * release the record outlived (a crash, a failed release, a live lease at
 * filing time). An existing integration cycle retains ownership too; ordinary future
 * verification admission provisions afresh. */
export function strandedNodeWorkspace(build: CapacityBuild, now: Date): boolean {
  const { state } = build
  return (
    state.kind === 'node' &&
    !terminal(state) &&
    state.optimization !== undefined &&
    state.optimization.proposal === undefined &&
    !nodeMeasurementDue(state) &&
    state.integration?.cycle === undefined &&
    state.sessions.open.length === 0 &&
    build.workspace &&
    !runnerAllocated(build, now) &&
    !executionOpen(state) &&
    state.status !== 'paused' &&
    state.status !== 'blocked' &&
    state.pendingCommands.length === 0 &&
    (state.compatibility?.decisiveFacts ?? 0) === 0 &&
    !state.nodeRestack?.active &&
    !state.nodeRestack?.conflict &&
    state.integration?.intent === undefined
  )
}

/** A finished leaf whose latest verify cycle or finalize has not been settled
 * since: it must re-verify before it waits for its merge decision again. */
export function epilogueUnsettled(state: BuildState): boolean {
  return epilogueLeaf(state) && (state.pipelineSettled ?? 0) < settlementKey(state)
}

/** The dispatcher should record a `pipeline.settled` fact when the engine's
 * decision for this leaf is `wait awaiting-pr`. */
export function settlementDue(state: BuildState): boolean {
  return (
    state.kind !== 'node' &&
    !terminal(state) &&
    state.finalizeCompletedSeq > state.restartSince &&
    (state.pipelineSettled ?? 0) < settlementKey(state)
  )
}

export function occupiesCapacity(build: CapacityBuild, now: Date): boolean {
  const { state } = build
  if (terminal(state)) return false
  if (state.kind !== 'node') return leafHoldsSlot(build)
  return (
    !!state.nodeRestack?.conflict ||
    ((integrationNeedsRunner(state) || nodeMeasurementDue(state)) && allocated(build, now)) ||
    (proposeRunDue(state.optimization) && allocated(build, now))
  )
}

/** The durable slot request of a leaf that holds none and no longer waits on
 * the outside world, or undefined. */
export function leafSlotRequest(build: LeafSlotFacts): SlotRequest | undefined {
  const { state } = build
  if (
    terminal(state) ||
    leafHoldsSlot(build) ||
    leafOutsideWait(build) ||
    // Mixed-version deferral withholds every decision, admission included.
    (state.compatibility?.decisiveFacts ?? 0) > 0
  )
    return undefined
  // A leaf on a rewritten target needs a runner to leave the wait: it
  // reprovisions itself or raises its one escalation (SPEC §7.4).
  if (state.targetRewrite !== undefined) return 'resume'
  // A ticket wait parks a leaf mid-pipeline: it asks for a slot only once the
  // wait has ended, to resume the phase that declared it.
  if (waitParked(state)) return waitResumeDue(state) ? 'resume' : undefined
  // Every other unfinished leaf an outside wait released resumes where it
  // stopped: an answered escalation, a resumed pause, a landed spec revision.
  if (!epilogueLeaf(state)) return 'resume'
  if (state.prState === 'conflicted') return 'reconcile'
  // A reopen asks for a slot once any replacement spec is published.
  if (reopenSpecPending(state)) return undefined
  if (reopenUnsettled(state)) return 'reopen'
  // A requested optimization measurement is admitted as a re-verify is. A
  // superseded request asks for no slot: the gate requests a current one.
  if (
    build.restackDue ||
    epilogueUnsettled(state) ||
    pendingMeasurementRequest(state) !== undefined
  )
    return 'verification'
  return undefined
}

/** A node's or leaf's durable request for a slot it does not hold yet.
 * Admission outranks ticket claims of the same priority, so this never
 * depends on when a tick saw it. */
export function slotRequest(build: CapacityBuild, now: Date): SlotRequest | undefined {
  const { state } = build
  if (state.kind !== 'node') return leafSlotRequest(build)
  if (
    state.status === 'done' ||
    state.status === 'aborted' ||
    state.status === 'paused' ||
    state.status === 'blocked' ||
    // Mixed-version deferral withholds every decision, admission included.
    (state.compatibility?.decisiveFacts ?? 0) > 0 ||
    allocated(build, now)
  )
    return undefined
  if (state.nodeRestack?.conflict) return state.openEscalations.length ? undefined : 'reconcile'
  if (proposeStarted(state)) return 'propose'
  // A node measurement (starting or progress) is admitted as a re-verify is.
  if (nodeMeasurementDue(state)) return 'verification'
  // A stale request (stopped, spent or shrunk below its room) reserves
  // nothing; the dispatcher withdraws it. A started session was admitted
  // already and resumes whatever its eligibility.
  if (proposeAdmissible(state.optimization, now)) return 'propose'
  if (integrationAdmissible(state) && integrationNeedsRunner(state)) return 'verification'
  return undefined
}

/** A nonterminal build's slot state, or undefined when it is unknown: a
 * `done` build reports none, and a value from a server older than durable
 * admission (no `slotAdmittedSeq`, which every current reducer sets on
 * `build.created`) was decided by older rules. A held slot outranks a
 * request: a conflicted node both occupies a slot and is listed as a
 * `reconcile` waiter, and reports `held`. An aborted build in cleanup
 * reports `none`. */
export function slotState(build: CapacityBuild, now: Date): SlotState | undefined {
  const { state } = build
  if (state.status === 'done' || state.slotAdmittedSeq === undefined) return undefined
  if (occupiesCapacity(build, now)) return { state: 'held' }
  const request = slotRequest(build, now)
  if (!request) return { state: 'none' }
  return buildPriority(state) === 'urgent'
    ? { state: 'requested', request, priority: 'urgent' }
    : { state: 'requested', request }
}

export function dispatchCapacity(
  builds: readonly CapacityBuild[],
  configured: number,
  now: Date,
  options: {
    urgentClaims?: number
    openPrs?: OpenPrBackpressureInput
    startRequests?: Partial<Record<TicketStartPriority, number>>
  } = {},
): DispatchCapacity {
  const unique = [...new Map(builds.map((build) => [build.record.slug, build])).values()]
  const occupied = unique.filter((build) => occupiesCapacity(build, now)).length
  const waiting = (kind: 'node' | 'leaf') =>
    unique
      .flatMap((build) => {
        if ((build.state.kind === 'node') !== (kind === 'node')) return []
        const request = slotRequest(build, now)
        if (!request) return []
        const waiter: SlotWaiter = { slug: build.record.slug, request }
        if (buildPriority(build.state) === 'urgent') waiter.priority = 'urgent'
        return [waiter]
      })
      .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
  const waitingNodes = waiting('node')
  const waitingBuilds = waiting('leaf')
  const slots: Record<string, SlotState> = {}
  for (const build of unique) {
    const slot = slotState(build, now)
    if (slot) slots[build.record.slug] = slot
  }
  const backpressure = options.openPrs
    ? openPrBackpressure(
        unique,
        openPrBackpressurePolicy(options.openPrs.policy),
        options.openPrs.engaged,
      )
    : undefined
  return {
    configured,
    occupied,
    effective: configured,
    borrowingNodes: [],
    ...(waitingNodes.length ? { waitingNodes } : {}),
    ...(waitingBuilds.length ? { waitingBuilds } : {}),
    ...(options.urgentClaims ? { urgentClaims: options.urgentClaims } : {}),
    ...(backpressure ? { backpressure } : {}),
    ...startRequestsOf(options.startRequests),
    slots,
  }
}

function startRequestsOf(
  demand: Partial<Record<TicketStartPriority, number>> | undefined,
): Pick<DispatchCapacity, 'startRequests'> {
  const startRequests: Partial<Record<TicketStartPriority, number>> = {}
  for (const tier of ['manual', 'urgent', 'normal'] as const)
    if (demand?.[tier]) startRequests[tier] = demand[tier]
  return Object.keys(startRequests).length ? { startRequests } : {}
}

/** A node verification or propose request reserves a slot until the node
 * holds it; a node reconcile request already occupies one. */
function nodeReserves(node: SlotWaiter): boolean {
  return node.request === 'verification' || node.request === 'propose'
}

/** Slots reserved ahead of one parked waiter: manual start requests for
 * urgent work; for normal work, also every other urgent reservation, the
 * urgent start requests and the urgent ticket claims still waiting. A waiter
 * is admitted when `occupied + reservedAhead` is below the configured budget,
 * so the order waiters are visited in never matters across tiers. */
export function reservedAhead(
  capacity: DispatchCapacity,
  waiter: { slug: string; priority: TicketPriority },
): number {
  if (waiter.priority === 'urgent') return startsOf(capacity, ['manual'])
  const urgent = (entry: SlotWaiter) => entry.priority === 'urgent' && entry.slug !== waiter.slug
  return (
    (capacity.waitingNodes ?? []).filter((node) => nodeReserves(node) && urgent(node)).length +
    (capacity.waitingBuilds ?? []).filter(urgent).length +
    (capacity.urgentClaims ?? 0) +
    startsOf(capacity, ['manual', 'urgent'])
  )
}

type CapacityAdjust = {
  settled?: ReadonlySet<string>
  denied?: ReadonlyMap<string, TicketPriority>
}

/** Waiters reserving a slot ahead of claims of one priority: urgent waiters
 * only for urgent claims, every waiter for normal ones. */
function waitersAhead(
  capacity: DispatchCapacity,
  adjust: CapacityAdjust,
  priority: TicketPriority,
): number {
  const counts = (entry: { priority?: TicketPriority }) =>
    priority === 'normal' || entry.priority === 'urgent'
  const nodes = (capacity.waitingNodes ?? []).filter(
    (node) => nodeReserves(node) && counts(node),
  ).length
  const builds = new Set(
    (capacity.waitingBuilds ?? [])
      .filter((build) => counts(build) && !adjust.settled?.has(build.slug))
      .map((build) => build.slug),
  )
  for (const [slug, denied] of adjust.denied ?? [])
    if (counts({ priority: denied })) builds.add(slug)
  return nodes + builds.size
}

/** Slots left for ordinary ticket claims of one priority. Parked work of the
 * same or a higher priority reserves ahead of them: an urgent claim waits only
 * for urgent parked work, a normal claim for every waiter. Pending start
 * requests of the same or a higher tier reserve ahead too: manual and urgent
 * ones for an urgent claim, every one for a normal claim. A node verification or
 * propose request reserves one slot until the node holds it; a node reconcile
 * request already occupies one. A parked build's request occupies nothing, so
 * each one reserves a slot. Never more than the configured budget minus
 * occupied builds.
 *
 * The dispatcher refines the projection with its own decisions this tick:
 * `settled` drops waiters it found waiting for their PR, `denied` adds
 * builds its admission gate turned away, with their priority. Status surfaces
 * omit `adjust`. */
export function intakeCapacity(
  capacity: DispatchCapacity,
  adjust: CapacityAdjust = {},
  priority: TicketPriority = 'normal',
): number {
  return (
    capacity.configured -
    capacity.occupied -
    waitersAhead(capacity, adjust, priority) -
    startsOf(
      capacity,
      priority === 'urgent' ? ['manual', 'urgent'] : ['manual', 'urgent', 'normal'],
    )
  )
}

/** Slots left for operator start requests of one tier: a manual request
 * waits for nothing; an urgent one for urgent parked work and manual
 * requests; a normal one for every waiter, the manual and urgent requests and
 * the urgent ticket claims still waiting. `adjust` is `intakeCapacity`'s. */
export function startCapacity(
  capacity: DispatchCapacity,
  adjust: CapacityAdjust,
  tier: TicketStartPriority,
): number {
  const free = capacity.configured - capacity.occupied
  if (tier === 'manual') return free
  if (tier === 'urgent')
    return free - waitersAhead(capacity, adjust, 'urgent') - startsOf(capacity, ['manual'])
  return (
    free -
    waitersAhead(capacity, adjust, 'normal') -
    startsOf(capacity, ['manual', 'urgent']) -
    (capacity.urgentClaims ?? 0)
  )
}

/** Shared wording for one node or parked build waiting on a runner slot. */
export function slotWaitText(request: SlotRequest, priority: TicketPriority = 'normal'): string {
  return priority === 'urgent'
    ? `urgent ${request} waiting for a slot ahead of normal work`
    : `${request} waiting for a slot ahead of normal ticket claims`
}

/** Shared wording for pending operator start requests, every node and parked
 * build waiting on a runner slot, and urgent ticket claims waiting ahead of
 * normal parked work, in slot admission order, or `''`. */
export function waitingExplanation(
  capacity?: DispatchCapacity,
  opts: { requests?: boolean } = {},
): string {
  const label = (entry: SlotWaiter) => {
    const notes = [
      ...(opts.requests ? [entry.request] : []),
      ...(entry.priority === 'urgent' ? ['urgent'] : []),
    ]
    return notes.length ? `${entry.slug} (${notes.join(', ')})` : entry.slug
  }
  const clause = (noun: string, waiting: SlotWaiter[]) => {
    if (!waiting.length) return []
    const ordered = [
      ...waiting.filter((entry) => entry.priority === 'urgent'),
      ...waiting.filter((entry) => entry.priority !== 'urgent'),
    ]
    return [
      `${waiting.length} ${noun}${waiting.length === 1 ? '' : 's'} waiting for a slot ahead of normal ticket claims: ${ordered.map(label).join(', ')}`,
    ]
  }
  const urgentClaims = capacity?.urgentClaims ?? 0
  const starts = (tier: TicketStartPriority, waiting: string) => {
    const count = capacity?.startRequests?.[tier] ?? 0
    return count ? [`${count} ${tier} start request${count === 1 ? '' : 's'} ${waiting}`] : []
  }
  return [
    ...starts('manual', 'waiting ahead of all other work'),
    ...starts('urgent', 'waiting ahead of normal parked work'),
    ...starts('normal', 'waiting for a slot'),
    ...clause('node', capacity?.waitingNodes ?? []),
    ...clause('parked build', capacity?.waitingBuilds ?? []),
    ...(urgentClaims
      ? [
          `${urgentClaims} urgent ticket claim${urgentClaims === 1 ? '' : 's'} waiting ahead of normal parked work`,
        ]
      : []),
  ].join('; ')
}

/** Shared wording for the terminal and browser control lines. */
export function capacityExplanation(capacity?: DispatchCapacity): string {
  if (!capacity) return ''
  const clauses: string[] = []
  const waiting = waitingExplanation(capacity)
  if (waiting) clauses.push(waiting)
  const backpressure = backpressureExplanation(capacity.backpressure)
  if (backpressure) clauses.push(backpressure)
  if (!clauses.length) return ''
  return ` (${capacity.configured} configured; ${clauses.join('; ')})`
}
