/**
 * The shared build-digest derivation (AUT-487): every BuildStore adapter
 * answers `getRepoBuildDigests` by fetching only the three digest-relevant
 * event types from its existing event table and running this one pure
 * function per build — identical results by construction, and the digest's
 * `terminal` can never drift from `reduceBuild`'s terminal rule because this
 * is the same in-order-overwrite of the latest terminal fact (§15.5).
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
] as const

/** The digest-relevant projection of one build's events, in log order.
 * `terminal` follows `reduceBuild` exactly: `build.completed` sets `done`,
 * `build.aborted` sets `aborted`, latest wins (in-order overwrite). The
 * events carry no slug, so the result is slug-less; every adapter attaches
 * `slug` itself when grouping its per-build event rows. */
export function reduceBuildDigest(
  events: Pick<AbEvent, 'type' | 'seq'>[],
): Omit<BuildDigest, 'slug'> {
  let terminal: BuildDigest['terminal']
  const observations: number[] = []
  for (const event of events) {
    if (event.type === 'build.completed') terminal = 'done'
    else if (event.type === 'build.aborted') terminal = 'aborted'
    else if (event.type === 'observation.recorded') observations.push(event.seq)
  }
  return { observations, ...(terminal !== undefined ? { terminal } : {}) }
}
