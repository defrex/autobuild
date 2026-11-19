import {
  advanceCompatibility,
  initialCompatibility,
  type CompatibilityState,
  type StoredEvent,
} from '../events/compatibility'
/**
 * The shared build-digest derivation (AUT-487): every BuildStore adapter
 * answers `getRepoBuildDigests` by fetching only the digest-relevant event
 * types from its existing event table and running this one pure function per
 * build — identical results by construction, and the digest's `terminal` can
 * never drift from `reduceBuild`'s terminal rule because this is the same
 * in-order-overwrite of the latest terminal fact (§15.5). AUT-521 widens the
 * projection with the observation timestamps and merge facts the harvest
 * pressure gate needs, keeping that gate's cost flat in accumulated build
 * history.
 */
import type { AbEvent } from '../events/catalog'
import { defineReducer, type IncrementalReducer } from '../kernel/incremental'
import type { AttemptOutcome } from '../events/payloads'
import {
  advanceOptimization,
  isOptimizationEvent,
  isProposerWakeEvent,
  optimizationSignal,
  PROPOSER_WAKE_EVENT_TYPES,
  type OptimizationSignal,
  type OptimizationState,
} from '../kernel/optimization'
import type { PolicyEscalationCause, TicketRef } from '../ontology'
import type { BuildDigest, BuildDigestTicketWait } from './types'

/** The event types a digest is derived from. Adapters filter their event
 * rows to exactly these, so a per-build type-filtered index keeps the scan's
 * cost growing with the actual signal, not with total history. */
export const DIGEST_EVENT_TYPES = [
  'build.created',
  'node.parent-requested',
  'node.parent-accepted',
  'integration.landed',
  'integration.audited',
  'node.opened',
  'node.contribution-recorded',
  'pr.closed',
  'build.completed',
  'build.aborted',
  'observation.recorded',
  'pr.merged',
  'pr-attachment.hosted',
  'pr-attachment.reclaimed',
  'execution.started',
  'execution.ended',
  'wait.requested',
  'wait.refused',
  'wait.entered',
  'wait.ended',
  'escalation.raised',
  'escalation.answered',
  'attempt.settled',
  'attempt.ticket-rejected',
  // The optimization signal: the node's optimization facts, its proposer
  // deferrals, and every fact that can clear a deferral.
  'optimization.proposal-deferred',
  ...PROPOSER_WAKE_EVENT_TYPES,
] as const

/** The digest-relevant slice of one event row. Adapters ship `hostedSeq` for
 * `pr-attachment.reclaimed` rows and `instance` for `execution.started` /
 * `execution.ended` rows instead of whole payloads. */
export type DigestEventRow = Pick<AbEvent, 'type' | 'seq' | 'ts'> & {
  rawUnknown?: StoredEvent
  auditRequested?: boolean
  mergedSha?: string
  nodeContribution?: BuildDigest['nodeContribution']
  kind?: 'work' | 'node'
  /** Node build slugs this event's target or parent move names. */
  nodeTargets?: string[]
  hostedSeq?: number
  instance?: string
  /** `wait.entered` / `wait.ended`: the wait id. */
  waitId?: string
  /** `wait.entered`: the wait's escalation; `escalation.answered`: the id answered. */
  escalation?: string
  /** `wait.entered`: the waited tickets. */
  waitTickets?: TicketRef[]
  /** `escalation.raised`: the policy cause, when one. */
  policyCause?: PolicyEscalationCause
  /** `attempt.settled` / `attempt.ticket-rejected`: the attempt's proposal. */
  attemptProposal?: string
  /** `attempt.settled`: the settlement outcome. */
  attemptOutcome?: AttemptOutcome
  /** An optimization fact the signal folds, decoded whole; every such
   * payload is bounded. */
  optimizationEvent?: AbEvent
}

/** The digest-relevant projection of one build's events, in log order.
 * `terminal` follows `reduceBuild` exactly: `build.completed` sets `done`,
 * `build.aborted` sets `aborted`, latest wins (in-order overwrite) — and
 * `merged` follows the same overwrite pattern for `pr.merged` timestamps.
 * The events carry no slug, so the result is slug-less; every adapter attaches
 * `slug` itself when grouping its per-build event rows. */
export type DigestEvent = DigestEventRow

/** The carried accumulator for `reduceBuildDigest`. */
export interface DigestAcc {
  compatibility: CompatibilityState
  integrationAuditPending?: true
  mergedSha?: string
  nodeContribution?: BuildDigest['nodeContribution']
  kind?: 'work' | 'node'
  nodeOpened?: true
  prClosed?: true
  readinessChangeSeq?: number
  terminal?: BuildDigest['terminal']
  merged?: string
  observations: { seq: number; ts: string }[]
  /** `pendingPrAttachmentReclaims`: seqs of hosted events. */
  hosted: number[]
  /** Hosted seqs named by a reclaimed event with a later seq. */
  reclaimed: number[]
  /** `openExecution`: the latest start's instance, cleared only by an instance-matched end. */
  openInstance: string | null
  /** Sorted unique node slugs any target or parent move has named. */
  nodeTargets: string[]
  /** The latest ticket-wait fact is a request without its outcome. */
  waitPending?: true
  /** The entered ticket wait that has not ended. */
  ticketWait?: BuildDigestTicketWait
  /** An optimization node's settled, non-accepted attempts whose ticket has
   * not yet moved to the rejected role: proposal ids. */
  pendingRejections?: string[]
  /** The node's optimization digest, folded by the same `advanceOptimization`
   * BuildState uses, so the signal cannot drift from it. */
  optimization?: OptimizationState
  /** seq of the latest proposer wake fact. */
  proposerWakeSeq?: number
  /** seq of the latest `optimization.proposal-deferred`. */
  proposerDeferredSeq?: number
}

/** Bump when `DigestAcc`'s shape or fold semantics change. */
export const BUILD_DIGEST_REDUCER_VERSION = 16

/** A peer's digest answer predates a field a caller needs. Callers fail with
 * this rather than reconstructing the field from per-build reads. */
export class BuildDigestCapabilityError extends Error {
  constructor(
    readonly slug: string,
    readonly capability: 'nodeTargets' | 'optimization' = 'nodeTargets',
  ) {
    super(
      capability === 'nodeTargets'
        ? `build digest for ${slug} has no nodeTargets: the store's digest answer predates node targets`
        : `build digest for node ${slug} has no optimization signal: the store's digest answer predates optimization proposing`,
    )
    this.name = 'BuildDigestCapabilityError'
  }
}

/** A node digest's optimization signal: `false` for a plain node, undefined
 * for a leaf. A node digest without the member is an older peer's answer. */
export function digestOptimization(
  digest: Pick<BuildDigest, 'slug' | 'kind' | 'optimization'>,
): OptimizationSignal | false | undefined {
  if (digest.kind !== 'node') return undefined
  if (digest.optimization === undefined)
    throw new BuildDigestCapabilityError(digest.slug, 'optimization')
  return digest.optimization
}

/** Every node build the digest's build has targeted or moved between. */
export function digestNodeTargets(
  digest: Pick<BuildDigest, 'slug' | 'nodeTargets'>,
): readonly string[] {
  if (digest.nodeTargets === undefined) throw new BuildDigestCapabilityError(digest.slug)
  return digest.nodeTargets
}

export const buildDigestReducer: IncrementalReducer<
  DigestAcc,
  DigestEvent,
  Omit<BuildDigest, 'slug'>
> = defineReducer({
  version: BUILD_DIGEST_REDUCER_VERSION,
  initial: (): DigestAcc => ({
    compatibility: initialCompatibility(),
    observations: [],
    hosted: [],
    reclaimed: [],
    openInstance: null,
    nodeTargets: [],
  }),
  fold(acc, events) {
    for (const event of events) {
      if (event.rawUnknown) advanceCompatibility(acc.compatibility, [event.rawUnknown])
      if (event.optimizationEvent !== undefined && isOptimizationEvent(event.optimizationEvent))
        acc.optimization = advanceOptimization(acc.optimization, [event.optimizationEvent])
      if (event.type === 'optimization.proposal-deferred') acc.proposerDeferredSeq = event.seq
      else if (isProposerWakeEvent(event)) acc.proposerWakeSeq = event.seq
      if (event.nodeTargets?.some((target) => !acc.nodeTargets.includes(target)))
        acc.nodeTargets = [...new Set([...acc.nodeTargets, ...event.nodeTargets])].sort()
      if (
        [
          'node.writer-settled',
          'node.opened',
          'node.contribution-recorded',
          'pr.closed',
          'pr.merged',
          'build.completed',
          'build.aborted',
        ].includes(event.type)
      )
        acc.readinessChangeSeq = event.seq
      if (event.type === 'integration.landed')
        acc.integrationAuditPending = event.auditRequested ? true : undefined
      if (event.type === 'integration.audited') acc.integrationAuditPending = undefined
      if (event.type === 'build.created') acc.kind = event.kind
      if (event.type === 'node.contribution-recorded') acc.nodeContribution = event.nodeContribution
      if (event.type === 'node.opened') acc.nodeOpened = true
      if (event.type === 'pr.closed') acc.prClosed = true
      if (event.type === 'build.completed') acc.terminal = 'done'
      else if (event.type === 'build.aborted') acc.terminal = 'aborted'
      else if (event.type === 'pr.merged') {
        acc.merged = event.ts
        acc.mergedSha = event.mergedSha
      } else if (event.type === 'observation.recorded')
        acc.observations.push({ seq: event.seq, ts: event.ts })
      else if (event.type === 'pr-attachment.hosted') acc.hosted.push(event.seq)
      else if (event.type === 'pr-attachment.reclaimed') {
        if (event.hostedSeq !== undefined && event.seq > event.hostedSeq)
          acc.reclaimed.push(event.hostedSeq)
      } else if (event.type === 'wait.requested') acc.waitPending = true
      else if (event.type === 'wait.refused') acc.waitPending = undefined
      else if (event.type === 'wait.entered') {
        acc.waitPending = undefined
        if (event.waitId !== undefined && event.escalation !== undefined)
          acc.ticketWait = {
            id: event.waitId,
            escalation: event.escalation,
            tickets: (event.waitTickets ?? []).map((ticket) => ({ ...ticket })),
          }
      } else if (event.type === 'wait.ended') {
        if (event.waitId === acc.ticketWait?.id) acc.ticketWait = undefined
      } else if (event.type === 'escalation.answered') {
        if (event.escalation === acc.ticketWait?.escalation) acc.ticketWait = undefined
      } else if (event.type === 'escalation.raised') {
        if (event.policyCause === 'wait-unresolvable') acc.ticketWait = undefined
      } else if (event.type === 'attempt.settled') {
        const proposal = event.attemptProposal
        if (
          proposal !== undefined &&
          event.attemptOutcome !== undefined &&
          event.attemptOutcome !== 'accepted' &&
          event.attemptOutcome !== 'merged-unmeasured' &&
          !acc.pendingRejections?.includes(proposal)
        )
          acc.pendingRejections = [...(acc.pendingRejections ?? []), proposal]
      } else if (event.type === 'attempt.ticket-rejected') {
        if (acc.pendingRejections !== undefined) {
          const remaining = acc.pendingRejections.filter((p) => p !== event.attemptProposal)
          acc.pendingRejections = remaining.length > 0 ? remaining : undefined
        }
      } else if (event.type === 'execution.started') acc.openInstance = event.instance ?? null
      else if (event.type === 'execution.ended') {
        if (acc.openInstance !== null && event.instance === acc.openInstance)
          acc.openInstance = null
      }
    }
  },
  finish: ({
    compatibility,
    integrationAuditPending,
    mergedSha,
    nodeContribution,
    kind,
    nodeOpened,
    prClosed,
    readinessChangeSeq,
    terminal,
    merged,
    observations,
    hosted,
    reclaimed,
    openInstance,
    nodeTargets,
    waitPending,
    ticketWait,
    pendingRejections,
    optimization,
    proposerWakeSeq,
    proposerDeferredSeq,
  }) => {
    const reclaimedSet = new Set(reclaimed)
    const reclaimPending = hosted.some((seq) => !reclaimedSet.has(seq))
    return {
      ...(compatibility.unknownFacts ? { compatibility: structuredClone(compatibility) } : {}),
      ...(integrationAuditPending ? { integrationAuditPending } : {}),
      ...(mergedSha !== undefined ? { mergedSha } : {}),
      ...(nodeContribution !== undefined
        ? { nodeContribution: structuredClone(nodeContribution) }
        : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(nodeOpened ? { nodeOpened } : {}),
      ...(prClosed ? { prClosed } : {}),
      observations: [...observations],
      ...(readinessChangeSeq !== undefined ? { readinessChangeSeq } : {}),
      ...(merged !== undefined ? { merged } : {}),
      ...(terminal !== undefined ? { terminal } : {}),
      ...(reclaimPending ? { reclaimPending: true as const } : {}),
      ...(openInstance !== null ? { executionOpen: true as const } : {}),
      ...(waitPending ? { waitPending } : {}),
      ...(ticketWait !== undefined ? { ticketWait: structuredClone(ticketWait) } : {}),
      ...(pendingRejections?.length ? { rejectionsPending: true as const } : {}),
      nodeTargets: [...nodeTargets],
      ...(kind === 'node'
        ? {
            optimization:
              optimization === undefined
                ? (false as const)
                : optimizationSignal(optimization, {
                    ...(proposerWakeSeq !== undefined ? { wakeSeq: proposerWakeSeq } : {}),
                    ...(proposerDeferredSeq !== undefined
                      ? { deferredSeq: proposerDeferredSeq }
                      : {}),
                  }),
          }
        : {}),
    }
  },
})

export function reduceBuildDigest(events: DigestEvent[]): Omit<BuildDigest, 'slug'> {
  return buildDigestReducer.reduce(events)
}
