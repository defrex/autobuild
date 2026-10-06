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
export function reduceBuildDigest(events: DigestEventRow[]): Omit<BuildDigest, 'slug'> {
  let terminal: BuildDigest['terminal']
  let merged: string | undefined
  // `pendingPrAttachmentReclaims`: a hosted seq is reclaimed iff a reclaimed
  // event naming it has a later seq.
  const hosted = new Set<number>()
  const reclaimed = new Set<number>()
  // `openExecution`: the latest start, cleared only by an instance-matched end.
  let openInstance: string | null = null
  const observations: { seq: number; ts: string }[] = []
  for (const event of events) {
    if (event.type === 'build.completed') terminal = 'done'
    else if (event.type === 'build.aborted') terminal = 'aborted'
    else if (event.type === 'pr.merged') merged = event.ts
    else if (event.type === 'observation.recorded')
      observations.push({ seq: event.seq, ts: event.ts })
    else if (event.type === 'pr-attachment.hosted') hosted.add(event.seq)
    else if (event.type === 'pr-attachment.reclaimed') {
      if (event.hostedSeq !== undefined && event.seq > event.hostedSeq)
        reclaimed.add(event.hostedSeq)
    } else if (event.type === 'execution.started') openInstance = event.instance ?? null
    else if (event.type === 'execution.ended') {
      if (openInstance !== null && event.instance === openInstance) openInstance = null
    }
  }
  const reclaimPending = [...hosted].some((seq) => !reclaimed.has(seq))
  return {
    observations,
    ...(merged !== undefined ? { merged } : {}),
    ...(terminal !== undefined ? { terminal } : {}),
    ...(reclaimPending ? { reclaimPending: true as const } : {}),
    ...(openInstance !== null ? { executionOpen: true as const } : {}),
  }
}
