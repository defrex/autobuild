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
import type { BuildDigest } from './types'

/** The event types a digest is derived from. Adapters filter their event
 * rows to exactly these, so a per-build type-filtered index keeps the scan's
 * cost growing with the actual signal, not with total history. */
export const DIGEST_EVENT_TYPES = [
  'build.completed',
  'build.aborted',
  'observation.recorded',
  'pr.merged',
  'pr-attachment.hosted',
  'pr-attachment.reclaimed',
  'execution.started',
  'execution.ended',
] as const

/** The digest-relevant slice of one event row. Adapters ship `hostedSeq` for
 * `pr-attachment.reclaimed` rows and `instance` for `execution.started` /
 * `execution.ended` rows instead of whole payloads. */
export type DigestEventRow = Pick<AbEvent, 'type' | 'seq' | 'ts'> & {
  hostedSeq?: number
  instance?: string
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
  terminal?: BuildDigest['terminal']
  merged?: string
  observations: { seq: number; ts: string }[]
  /** `pendingPrAttachmentReclaims`: seqs of hosted events. */
  hosted: number[]
  /** Hosted seqs named by a reclaimed event with a later seq. */
  reclaimed: number[]
  /** `openExecution`: the latest start's instance, cleared only by an instance-matched end. */
  openInstance: string | null
}

/** Bump when `DigestAcc`'s shape or fold semantics change. */
export const BUILD_DIGEST_REDUCER_VERSION = 2

export const buildDigestReducer: IncrementalReducer<
  DigestAcc,
  DigestEvent,
  Omit<BuildDigest, 'slug'>
> = defineReducer({
  version: BUILD_DIGEST_REDUCER_VERSION,
  initial: (): DigestAcc => ({ observations: [], hosted: [], reclaimed: [], openInstance: null }),
  fold(acc, events) {
    for (const event of events) {
      if (event.type === 'build.completed') acc.terminal = 'done'
      else if (event.type === 'build.aborted') acc.terminal = 'aborted'
      else if (event.type === 'pr.merged') acc.merged = event.ts
      else if (event.type === 'observation.recorded')
        acc.observations.push({ seq: event.seq, ts: event.ts })
      else if (event.type === 'pr-attachment.hosted') acc.hosted.push(event.seq)
      else if (event.type === 'pr-attachment.reclaimed') {
        if (event.hostedSeq !== undefined && event.seq > event.hostedSeq)
          acc.reclaimed.push(event.hostedSeq)
      } else if (event.type === 'execution.started') acc.openInstance = event.instance ?? null
      else if (event.type === 'execution.ended') {
        if (acc.openInstance !== null && event.instance === acc.openInstance)
          acc.openInstance = null
      }
    }
  },
  finish: ({ terminal, merged, observations, hosted, reclaimed, openInstance }) => {
    const reclaimedSet = new Set(reclaimed)
    const reclaimPending = hosted.some((seq) => !reclaimedSet.has(seq))
    return {
      observations: [...observations],
      ...(merged !== undefined ? { merged } : {}),
      ...(terminal !== undefined ? { terminal } : {}),
      ...(reclaimPending ? { reclaimPending: true as const } : {}),
      ...(openInstance !== null ? { executionOpen: true as const } : {}),
    }
  },
})

export function reduceBuildDigest(events: DigestEvent[]): Omit<BuildDigest, 'slug'> {
  return buildDigestReducer.reduce(events)
}
