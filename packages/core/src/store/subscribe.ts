/**
 * The shared polling implementation of `subscribe` (SPEC §7.2): push is the
 * specced interface, polling `getEvents(since)` is the v2.0 implementation.
 * Adapters delegate here so delivery semantics (in-order, exactly once per
 * subscription, no overlapping polls) are identical everywhere.
 *
 * Two cadences (AUT-334). Without `waitSeconds` this is the unchanged
 * interval loop: one immediate read, then one read per `pollMs`. With
 * `waitSeconds` the loop long-polls: each cycle issues one held request and
 * then gap-fills so request *starts* stay at least `pollMs` apart (elapsed
 * request time counts toward the gap). Against a server that honors the
 * bound, a quiet stream costs one request per wait window and a new event is
 * delivered within about a server-side poll of its append; against a server
 * that answers immediately regardless of `wait`, the cadence degrades to
 * exactly today's request rate and delivery is unchanged.
 */
import type { AbEvent } from '../events/catalog'
import type { SubscribeOptions, Unsubscribe } from './types'

export const DEFAULT_POLL_MS = 250

export type SubscribeRead = (
  sinceSeq: number,
  opts?: { waitSeconds?: number },
) => Promise<AbEvent[]>

export function pollingSubscribe(
  getEvents: SubscribeRead,
  opts: SubscribeOptions,
  onEvent: (event: AbEvent) => void,
): Unsubscribe {
  let lastSeq = opts.fromSeq ?? 0
  let stopped = false
  let inFlight = false

  const deliver = (events: AbEvent[]): void => {
    for (const event of events) {
      if (stopped) break
      if (event.seq <= lastSeq) continue
      lastSeq = event.seq
      onEvent(event)
    }
  }

  if (opts.waitSeconds === undefined) {
    const tick = async (): Promise<void> => {
      if (stopped || inFlight) return
      inFlight = true
      try {
        deliver(await getEvents(lastSeq))
      } catch {
        // Store unreachable — keep polling; the next tick retries (§8.7).
      } finally {
        inFlight = false
      }
    }

    const timer = setInterval(() => void tick(), opts.pollMs ?? DEFAULT_POLL_MS)
    void tick()

    return () => {
      stopped = true
      clearInterval(timer)
    }
  }

  // Bounded-wait mode: one held request in flight at a time (the loop is
  // sequential, so polls never overlap); request starts spaced at least
  // `pollMs` apart. A throw from the read (store unreachable) ends the cycle
  // and is retried after the gap, like the interval loop.
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS
  void (async (): Promise<void> => {
    while (!stopped) {
      inFlight = true
      const started = Date.now()
      try {
        deliver(await getEvents(lastSeq, { waitSeconds: opts.waitSeconds }))
      } catch {
        // Store unreachable — retry after the gap (§8.7).
      } finally {
        inFlight = false
      }
      if (stopped) break
      const elapsed = Date.now() - started
      if (elapsed < pollMs) await Bun.sleep(pollMs - elapsed)
    }
  })()

  return () => {
    stopped = true
  }
}
