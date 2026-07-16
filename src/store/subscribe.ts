/**
 * The shared polling implementation of `subscribe` (SPEC §7.2): push is the
 * specced interface, polling `getEvents(since)` is the v2.0 implementation.
 * Adapters delegate here so delivery semantics (in-order, exactly once per
 * subscription, no overlapping polls) are identical everywhere.
 */
import type { AbEvent } from '../events/catalog'
import type { SubscribeOptions, Unsubscribe } from './types'

export const DEFAULT_POLL_MS = 250

export function pollingSubscribe(
  getEvents: (sinceSeq: number) => Promise<AbEvent[]>,
  opts: SubscribeOptions,
  onEvent: (event: AbEvent) => void,
): Unsubscribe {
  let lastSeq = opts.fromSeq ?? 0
  let stopped = false
  let inFlight = false

  const tick = async (): Promise<void> => {
    if (stopped || inFlight) return
    inFlight = true
    try {
      const events = await getEvents(lastSeq)
      for (const event of events) {
        if (stopped) break
        if (event.seq <= lastSeq) continue
        lastSeq = event.seq
        onEvent(event)
      }
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
