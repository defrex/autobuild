import type { TicketRef } from '../ontology'
import type { BuildRecord } from '../store/types'
import type { BuildState } from './reducer'
import { integrationAdmissible, integrationNeedsRunner } from './integration-state'

/** Repository-scoped, reduced facts. Provisioning reserves a slot before a workspace exists. */
export interface CapacityBuild {
  record: BuildRecord
  state: BuildState
  workspace: boolean
  provisioning?: boolean
}

/** The runner a node has durably requested and does not yet hold. */
export type SlotRequest = 'verification' | 'reconcile'

export interface DispatchCapacity {
  configured: number
  occupied: number
  effective: number
  borrowingNodes: string[]
  /** Nodes admitted ahead of new ticket claims; omitted when none wait, and by an older server. */
  waitingNodes?: { slug: string; request: SlotRequest }[]
}

/** A workspace, a provisioning marker or a live lease holds runner capacity. */
function allocated(build: CapacityBuild, now: Date): boolean {
  return (
    build.workspace ||
    !!build.provisioning ||
    (build.record.lease !== undefined && Date.parse(build.record.lease.expiresAt) > now.getTime())
  )
}

export function occupiesCapacity(build: CapacityBuild, now: Date): boolean {
  const { state } = build
  if (state.status === 'done' || state.status === 'aborted') return false
  return (
    state.kind !== 'node' ||
    !!state.nodeRestack?.conflict ||
    (integrationNeedsRunner(state) && allocated(build, now))
  )
}

/** A node's durable request for a runner it does not hold yet. Admission
 * outranks new ticket claims, so this never depends on when a tick saw it. */
export function slotRequest(build: CapacityBuild, now: Date): SlotRequest | undefined {
  const { state } = build
  if (
    state.kind !== 'node' ||
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
  const waitingNodes = unique
    .flatMap((build) => {
      const request = slotRequest(build, now)
      return request ? [{ slug: build.record.slug, request }] : []
    })
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
  return {
    configured,
    occupied,
    effective: borrowingNodes.length ? Math.max(configured, occupied) : configured,
    borrowingNodes,
    ...(waitingNodes.length ? { waitingNodes } : {}),
  }
}

/** Slots left for new ticket claims. A verification request reserves one slot
 * until the node holds it; a reconcile request already occupies one. Never
 * more than the configured budget minus occupied builds. */
export function intakeCapacity(capacity: DispatchCapacity): number {
  const reserved = (capacity.waitingNodes ?? []).filter(
    (node) => node.request === 'verification',
  ).length
  return capacity.configured - capacity.occupied - reserved
}

/** Shared wording for one node waiting on a runner slot. */
export function slotWaitText(request: SlotRequest): string {
  return `${request} waiting for a slot ahead of new ticket claims`
}

/** Shared wording for every node waiting on a runner slot, or `''`. */
export function waitingExplanation(capacity?: DispatchCapacity): string {
  const waiting = capacity?.waitingNodes ?? []
  if (!waiting.length) return ''
  return `${waiting.length} node${waiting.length === 1 ? '' : 's'} waiting for a slot ahead of new ticket claims: ${waiting.map((node) => node.slug).join(', ')}`
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
