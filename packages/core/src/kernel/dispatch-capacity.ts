import type { TicketRef } from '../ontology'
import type { TicketPriority } from '../ports/types'
import type { BuildRecord } from '../store/types'
import type { BuildState } from './reducer'
import { integrationAdmissible, integrationNeedsRunner } from './integration-state'
import { proposeAdmissible, proposeRunDue, proposeStarted } from './optimization-admission'
import { waitParked, waitResumeDue } from './ticket-wait'
import { nodeMeasurementDue, pendingMeasurementRequest } from './measurement'

/** Repository-scoped, reduced facts. Provisioning reserves a slot before a workspace exists.
 *
 * `capacity` counts builds running work. A leaf that holds no runner is
 * parked when it has finished its pipeline (settled, see `epilogueLeaf`) and
 * waits for a merge decision, merge gates or the forge, or when it waits on
 * other tickets (`waitParked`). A parked leaf holds no slot, though it keeps
 * its workspace. Every other unfinished leaf holds a slot, paused or blocked
 * on a question included. Nodes hold a slot only while they need a runner. */
export interface CapacityBuild {
  record: BuildRecord
  state: BuildState
  workspace: boolean
  provisioning?: boolean
  /** The engine's awaiting-landing restack is due (`landingRestackDue`); omitted means false. */
  restackDue?: boolean
}

/** The runner a node or parked leaf has durably requested and does not yet
 * hold. `resume` is a leaf whose ticket wait ended; `propose` is an
 * optimization node's open, still eligible proposal request. */
export type SlotRequest = 'verification' | 'reconcile' | 'resume' | 'propose'

/** One node or parked leaf waiting for a slot. `priority` is omitted for
 * normal builds, and by an older server. */
export interface SlotWaiter {
  slug: string
  request: SlotRequest
  priority?: 'urgent'
}

/** Slot admission order for free slots (SPEC §12, "Slot admission order"):
 * urgent parked work, urgent ticket claims, normal parked work, normal ticket
 * claims; each tier keeps its own order. */
export interface DispatchCapacity {
  configured: number
  occupied: number
  effective: number
  borrowingNodes: string[]
  /** Nodes waiting for a slot; omitted when none wait, and by an older server. */
  waitingNodes?: SlotWaiter[]
  /** Parked leaves waiting for a slot; omitted when none wait, and by an older server. */
  waitingBuilds?: SlotWaiter[]
  /** Urgent ticket claims the latest admission scan found waiting for a slot
   * (`urgentClaimDemand`); they go ahead of normal parked work. Omitted when
   * none, and when the caller has no repository facts. */
  urgentClaims?: number
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

/** A provisioning marker or continuation, or a live lease: a runner is working. */
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
 * `pipeline.settled`. A spec revision after settlement makes it unfinished. */
export function epilogueLeaf(state: BuildState): boolean {
  return (
    state.kind !== 'node' && !terminal(state) && (state.pipelineSettled ?? 0) > state.restartSince
  )
}

/** A provider-observable execution (one with a command id) stays open until
 * supervision records its end on provider proof, so it holds its runner past
 * an expired lease, unknown liveness included. A local execution's liveness
 * is its lease. */
function executionOpen(state: BuildState): boolean {
  return state.openExecution?.commandId !== undefined
}

/** A finished or ticket-waiting leaf with no runner working. It holds no
 * slot; its workspace does not count. */
export function parkedLeaf(build: CapacityBuild, now: Date): boolean {
  return (
    (epilogueLeaf(build.state) || waitParked(build.state)) &&
    !runnerAllocated(build, now) &&
    !executionOpen(build.state)
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
  if (state.kind !== 'node') return !parkedLeaf(build, now)
  return (
    !!state.nodeRestack?.conflict ||
    ((integrationNeedsRunner(state) || nodeMeasurementDue(state)) && allocated(build, now)) ||
    (proposeRunDue(state.optimization) && allocated(build, now))
  )
}

/** A parked leaf's durable request for a runner, or undefined. */
function leafSlotRequest(build: CapacityBuild, now: Date): SlotRequest | undefined {
  const { state } = build
  if (
    !parkedLeaf(build, now) ||
    state.status === 'paused' ||
    state.status === 'blocked' ||
    (state.compatibility?.decisiveFacts ?? 0) > 0 ||
    state.targetRewrite !== undefined
  )
    return undefined
  // A ticket wait parks a leaf mid-pipeline: it asks for a slot only once the
  // wait has ended, to resume the phase that declared it.
  if (waitParked(state)) return waitResumeDue(state) ? 'resume' : undefined
  if (state.prState === 'conflicted') return 'reconcile'
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

/** A node's or parked leaf's durable request for a runner it does not hold
 * yet. Admission outranks ticket claims of the same priority, so this never
 * depends on when a tick saw it. */
export function slotRequest(build: CapacityBuild, now: Date): SlotRequest | undefined {
  const { state } = build
  if (state.kind !== 'node') return leafSlotRequest(build, now)
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

type Identity = (ref: TicketRef, build?: string) => string
const exactIdentity: Identity = (ref) => JSON.stringify([ref.source, ref.id])

/** Follow accepted build identities, validating the source-qualified ticket at every edge. */
function descendsFrom(
  build: CapacityBuild,
  node: string,
  builds: Map<string, CapacityBuild>,
  identity: Identity,
): boolean {
  const seen = new Set<string>([build.record.slug])
  let target = build.state.target
  while (target) {
    if (seen.has(target.build)) return false
    seen.add(target.build)
    const parent = builds.get(target.build)
    if (
      parent?.state.kind !== 'node' ||
      parent.record.repo !== build.record.repo ||
      !parent.record.ticket ||
      identity(parent.record.ticket, parent.record.slug) !==
        identity(target.ticket, build.record.slug)
    )
      return false
    if (parent.record.slug === node) return true
    target = parent.state.target
  }
  return false
}

export function nodeCapacity(
  builds: readonly CapacityBuild[],
  node: string,
  now: Date,
  identity: Identity = exactIdentity,
): {
  occupied: number
  excludedDescendants: string[]
} {
  const identities = new Map(builds.map((build) => [build.record.slug, build]))
  const excludedDescendants: string[] = []
  let occupied = 0
  for (const build of identities.values()) {
    if (build.record.slug === node || !occupiesCapacity(build, now)) continue
    if (
      (build.state.status === 'blocked' || build.state.status === 'paused') &&
      descendsFrom(build, node, identities, identity)
    )
      excludedDescendants.push(build.record.slug)
    else occupied++
  }
  return { occupied, excludedDescendants: excludedDescendants.sort() }
}

export function dispatchCapacity(
  builds: readonly CapacityBuild[],
  configured: number,
  now: Date,
  identity: Identity = exactIdentity,
  opts: { urgentClaims?: number } = {},
): DispatchCapacity {
  const unique = [...new Map(builds.map((build) => [build.record.slug, build])).values()]
  const occupied = unique.filter((build) => occupiesCapacity(build, now)).length
  const borrowingNodes = unique
    .filter((build) => {
      if (build.state.kind !== 'node' || !occupiesCapacity(build, now)) return false
      // A waiting conflict owns capacity too, but only allocated runner work borrows.
      if (!allocated(build, now)) return false
      const admission = nodeCapacity(unique, build.record.slug, now, identity)
      return (
        occupied > configured &&
        admission.excludedDescendants.length > 0 &&
        admission.occupied < configured
      )
    })
    .map((build) => build.record.slug)
    .sort()
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
  return {
    configured,
    occupied,
    effective: borrowingNodes.length ? Math.max(configured, occupied) : configured,
    borrowingNodes,
    ...(waitingNodes.length ? { waitingNodes } : {}),
    ...(waitingBuilds.length ? { waitingBuilds } : {}),
    ...(opts.urgentClaims ? { urgentClaims: opts.urgentClaims } : {}),
  }
}

/** A node verification or propose request reserves a slot until the node
 * holds it; a node reconcile request already occupies one. */
function nodeReserves(node: SlotWaiter): boolean {
  return node.request === 'verification' || node.request === 'propose'
}

/** Slots reserved ahead of one parked waiter: nothing for urgent work; for
 * normal work, every other urgent reservation and the urgent ticket claims
 * still waiting. A waiter is admitted when `occupied + reservedAhead` is below
 * the configured budget, so the order waiters are visited in never matters
 * across tiers. */
export function reservedAhead(
  capacity: DispatchCapacity,
  waiter: { slug: string; priority: TicketPriority },
): number {
  if (waiter.priority === 'urgent') return 0
  const urgent = (entry: SlotWaiter) => entry.priority === 'urgent' && entry.slug !== waiter.slug
  return (
    (capacity.waitingNodes ?? []).filter((node) => nodeReserves(node) && urgent(node)).length +
    (capacity.waitingBuilds ?? []).filter(urgent).length +
    (capacity.urgentClaims ?? 0)
  )
}

/** Slots left for ticket claims of one priority. Parked work of the same or
 * a higher priority reserves ahead of them: an urgent claim waits only for
 * urgent parked work, a normal claim for every waiter. A node verification or
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
  adjust: { settled?: ReadonlySet<string>; denied?: ReadonlyMap<string, TicketPriority> } = {},
  priority: TicketPriority = 'normal',
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
  return capacity.configured - capacity.occupied - nodes - builds.size
}

/** Shared wording for one node or parked build waiting on a runner slot. */
export function slotWaitText(request: SlotRequest, priority: TicketPriority = 'normal'): string {
  return priority === 'urgent'
    ? `urgent ${request} waiting for a slot ahead of normal work`
    : `${request} waiting for a slot ahead of normal ticket claims`
}

/** Shared wording for every node and parked build waiting on a runner slot,
 * and for urgent ticket claims waiting ahead of normal parked work, or `''`. */
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
  return [
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
  if (capacity.borrowingNodes.length)
    clauses.push(
      `${capacity.borrowingNodes.length} node${capacity.borrowingNodes.length === 1 ? '' : 's'} using descendant-held slots: ${capacity.borrowingNodes.join(', ')}`,
    )
  const waiting = waitingExplanation(capacity)
  if (waiting) clauses.push(waiting)
  if (!clauses.length) return ''
  return ` (${capacity.configured} configured; ${clauses.join('; ')})`
}
