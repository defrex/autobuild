import type { TicketRef } from '../ontology'
import type { BuildRecord } from '../store/types'
import type { BuildState } from './reducer'
import { integrationAdmissible, integrationNeedsRunner } from './integration-state'

/** Repository-scoped, reduced facts. Provisioning reserves a slot before a workspace exists.
 *
 * `capacity` counts builds running work. A leaf that has finished its pipeline
 * (settled, see `epilogueLeaf`) and holds no runner is parked: it waits for a
 * merge decision, merge gates or the forge and holds no slot, though it keeps
 * its workspace. Every other unfinished leaf holds a slot, paused or blocked
 * included. Nodes hold a slot only while they need a runner. */
export interface CapacityBuild {
  record: BuildRecord
  state: BuildState
  workspace: boolean
  provisioning?: boolean
  /** The engine's awaiting-landing restack is due (`landingRestackDue`); omitted means false. */
  restackDue?: boolean
}

/** The runner a node or parked leaf has durably requested and does not yet hold. */
export type SlotRequest = 'verification' | 'reconcile'

export interface DispatchCapacity {
  configured: number
  occupied: number
  effective: number
  borrowingNodes: string[]
  /** Nodes admitted ahead of new ticket claims; omitted when none wait, and by an older server. */
  waitingNodes?: { slug: string; request: SlotRequest }[]
  /** Parked leaves admitted ahead of new ticket claims; omitted when none wait, and by an older server. */
  waitingBuilds?: { slug: string; request: SlotRequest }[]
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

/** A finished leaf with no runner working. It holds no slot; its workspace does not count. */
export function parkedLeaf(build: CapacityBuild, now: Date): boolean {
  return epilogueLeaf(build.state) && !runnerAllocated(build, now)
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
  return !!state.nodeRestack?.conflict || (integrationNeedsRunner(state) && allocated(build, now))
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
  if (state.prState === 'conflicted') return 'reconcile'
  if (build.restackDue || epilogueUnsettled(state)) return 'verification'
  return undefined
}

/** A node's or parked leaf's durable request for a runner it does not hold
 * yet. Admission outranks new ticket claims, so this never depends on when a
 * tick saw it. */
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
        return request ? [{ slug: build.record.slug, request }] : []
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
  }
}

/** Slots left for new ticket claims. A node verification request reserves one
 * slot until the node holds it; a node reconcile request already occupies one.
 * A parked build's request occupies nothing, so every one reserves a slot.
 * Never more than the configured budget minus occupied builds.
 *
 * The dispatcher refines the projection with its own decisions this tick:
 * `settled` drops waiters it found waiting for their PR, `denied` adds
 * builds its admission gate turned away. Status surfaces omit `adjust`. */
export function intakeCapacity(
  capacity: DispatchCapacity,
  adjust: { settled?: ReadonlySet<string>; denied?: ReadonlySet<string> } = {},
): number {
  const nodes = (capacity.waitingNodes ?? []).filter(
    (node) => node.request === 'verification',
  ).length
  const builds = new Set(
    (capacity.waitingBuilds ?? [])
      .map((build) => build.slug)
      .filter((slug) => !adjust.settled?.has(slug)),
  )
  for (const slug of adjust.denied ?? []) builds.add(slug)
  return capacity.configured - capacity.occupied - nodes - builds.size
}

/** Shared wording for one node or parked build waiting on a runner slot. */
export function slotWaitText(request: SlotRequest): string {
  return `${request} waiting for a slot ahead of new ticket claims`
}

/** Shared wording for every node and parked build waiting on a runner slot, or `''`. */
export function waitingExplanation(
  capacity?: DispatchCapacity,
  opts: { requests?: boolean } = {},
): string {
  const clause = (noun: string, waiting: { slug: string; request: SlotRequest }[]) =>
    waiting.length
      ? [
          `${waiting.length} ${noun}${waiting.length === 1 ? '' : 's'} waiting for a slot ahead of new ticket claims: ${waiting.map((entry) => (opts.requests ? `${entry.slug} (${entry.request})` : entry.slug)).join(', ')}`,
        ]
      : []
  return [
    ...clause('node', capacity?.waitingNodes ?? []),
    ...clause('parked build', capacity?.waitingBuilds ?? []),
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
