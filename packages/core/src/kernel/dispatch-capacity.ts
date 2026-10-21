import type { TicketRef } from '../ontology'
import type { BuildRecord } from '../store/types'
import type { BuildState } from './reducer'
import { integrationNeedsRunner } from './integration-state'

/** Repository-scoped, reduced facts. Provisioning reserves a slot before a workspace exists. */
export interface CapacityBuild {
  record: BuildRecord
  state: BuildState
  workspace: boolean
  provisioning?: boolean
}

export interface DispatchCapacity {
  configured: number
  occupied: number
  effective: number
  borrowingNodes: string[]
}

export function occupiesCapacity(build: CapacityBuild, now: Date): boolean {
  const { state, record } = build
  if (state.status === 'done' || state.status === 'aborted') return false
  return (
    state.kind !== 'node' ||
    !!state.nodeRestack?.conflict ||
    (integrationNeedsRunner(state) &&
      (build.workspace ||
        !!build.provisioning ||
        (record.lease !== undefined && Date.parse(record.lease.expiresAt) > now.getTime())))
  )
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
      if (
        !build.workspace &&
        !build.provisioning &&
        !(build.record.lease && Date.parse(build.record.lease.expiresAt) > now.getTime())
      )
        return false
      const admission = nodeCapacity(unique, build.record.slug, now, identity)
      return (
        occupied > configured &&
        admission.excludedDescendants.length > 0 &&
        admission.occupied < configured
      )
    })
    .map((build) => build.record.slug)
    .sort()
  return {
    configured,
    occupied,
    effective: borrowingNodes.length ? Math.max(configured, occupied) : configured,
    borrowingNodes,
  }
}

/** Shared wording for the terminal and browser control lines. */
export function capacityExplanation(capacity?: DispatchCapacity): string {
  if (!capacity?.borrowingNodes.length) return ''
  return ` (${capacity.configured} configured; ${capacity.borrowingNodes.length} node${capacity.borrowingNodes.length === 1 ? '' : 's'} using descendant-held slots: ${capacity.borrowingNodes.join(', ')})`
}
