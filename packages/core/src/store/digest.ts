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
] as const

/** The digest-relevant projection of one build's events, in log order.
 * `terminal` follows `reduceBuild` exactly: `build.completed` sets `done`,
 * `build.aborted` sets `aborted`, latest wins (in-order overwrite) — and
 * `merged` follows the same overwrite pattern for `pr.merged` timestamps.
 * The events carry no slug, so the result is slug-less; every adapter attaches
 * `slug` itself when grouping its per-build event rows. */
export function reduceBuildDigest(
  events: Pick<AbEvent, 'type' | 'seq' | 'ts'>[],
): Omit<BuildDigest, 'slug'> {
  let terminal: BuildDigest['terminal']
  let merged: string | undefined
  const observations: { seq: number; ts: string }[] = []
  for (const event of events) {
    if (event.type === 'build.completed') terminal = 'done'
    else if (event.type === 'build.aborted') terminal = 'aborted'
    else if (event.type === 'pr.merged') merged = event.ts
    else if (event.type === 'observation.recorded')
      observations.push({ seq: event.seq, ts: event.ts })
  }
  return {
    observations,
    ...(merged !== undefined ? { merged } : {}),
    ...(terminal !== undefined ? { terminal } : {}),
  }
}
