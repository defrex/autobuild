import { expect } from 'bun:test'
import {
  occupiesCapacity,
  slotState,
  type CapacityBuild,
  type DispatchCapacity,
} from '../kernel/dispatch-capacity'

/** The reported slot state agrees with what admission counts (#1341): every
 * build's `slots` entry is its `slotState`, `held` exactly when it occupies a
 * slot, a `requested` build is a waiter with the same request and priority,
 * every waiter is `requested` or `held`, and with every nonterminal build
 * known, `occupied` equals the `held` entries. Pure; no IO. */
export function expectSlotAgreement(
  builds: readonly CapacityBuild[],
  now: Date,
  capacity: DispatchCapacity,
): void {
  const unique = [...new Map(builds.map((build) => [build.record.slug, build])).values()]
  const slots = capacity.slots ?? {}
  const waiters = new Map(
    [...(capacity.waitingNodes ?? []), ...(capacity.waitingBuilds ?? [])].map((waiter) => [
      waiter.slug,
      waiter,
    ]),
  )
  for (const build of unique) {
    const slug = build.record.slug
    const expected = slotState(build, now)
    expect({ slug, slot: slots[slug] }).toEqual({ slug, slot: expected })
    if (expected)
      expect({ slug, held: expected.state === 'held' }).toEqual({
        slug,
        held: occupiesCapacity(build, now),
      })
    if (expected?.state === 'requested') {
      const { state: _state, ...request } = expected
      expect({ slug, ...waiters.get(slug) }).toEqual({ slug, ...request })
    }
  }
  // A waiter from an older server's value is unknown, which is never `none`.
  for (const slug of waiters.keys())
    if (slots[slug] !== undefined)
      expect({ slug, waits: slots[slug].state !== 'none' }).toEqual({ slug, waits: true })
  const known = unique.every(
    (build) => build.state.status === 'done' || slots[build.record.slug] !== undefined,
  )
  if (known)
    expect(Object.values(slots).filter((slot) => slot.state === 'held').length).toBe(
      capacity.occupied,
    )
}
