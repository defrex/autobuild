/**
 * The shared read-wait loop (SPEC §7.6): when a read finds no newer chunk and
 * the stream is open, the adapter honors the wait bound — returning no later
 * than the bound, but as soon as a chunk is appended or the stream closes.
 * The memory, SQLite, and PostgreSQL adapters all delegate here so wait
 * semantics are adapter-uniform; the remote adapter instead delegates the
 * wait to its backing store over one held-open request.
 *
 * A small poll loop rather than a waiter registry: the uniformity across
 * synchronous (SQLite) and asynchronous (PostgreSQL) backends is worth more
 * than wake-on-write precision. The loop serves two cadences: held *stream*
 * reads are presentation content and poll at the ~25 ms `STREAM_WAIT_POLL_MS`;
 * held *event* reads (build, repository, session — AUT-334/381/383) take the
 * one-second `EVENT_WAIT_POLL_MS` budget when the adapter passes it per call
 * (see `EVENT_WAIT_POLL_MS` for which adapters do). Closed streams never wait.
 *
 * Both loops accept an optional `signal` (AUT-380): when it aborts, the hold
 * ends promptly — the inter-poll sleep resolves early, the loop stops, and the
 * read resolves with its current result instead of polling to the wait bound.
 * This is what lets a remote server cancel a disconnected peer's backing read
 * rather than let it poll an unobserved database. Resolving (never rejecting)
 * keeps every caller on one code path: callers treat the empty result exactly
 * as they treat the hold expiring.
 */
import { clampWaitSeconds, type StreamRead } from './types'

export const STREAM_WAIT_POLL_MS = 25

/**
 * The one-second held-event poll budget (the hosted per-query budget,
 * AUT-334/381/383): held event reads — build, repository, and session —
 * re-query at most once per second, so an append is observed at the next
 * poll, typically within about one second. Held *stream* reads are excluded:
 * they are presentation content and stay at the ~25 ms `STREAM_WAIT_POLL_MS`
 * cadence. This deliberately diverges from `STREAM_WAIT_POLL_MS`; adapters
 * pass it as `pollMs` on their event-family calls to `readEventsWithWait` —
 * the PostgreSQL and memory stores do on all three families (AUT-334/381/383).
 * The SQLite store has not adopted the budget (out of scope for AUT-383), so
 * its held event reads fall back to the stream default until it does.
 */
export const EVENT_WAIT_POLL_MS = 1000

/** Sleep `ms`, or return early when `signal` aborts. Resolves (never
 * rejects) on either path; the abort listener is removed on both so a
 * long-held read cannot leak listeners. No signal (or an already-aborted
 * one) never waits. */
function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return Bun.sleep(ms)
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    const onAbort = (): void => finish()
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Read once, then poll until newer chunks arrive, the stream closes, the
 * clamped wall-clock deadline passes, or `signal` aborts. `read` must
 * re-query the store on every call; a throw from it propagates immediately.
 * An abort ends the hold with the current result (a pre-aborted signal still
 * performs the initial read — reads are cheap and side-effect-free — but
 * never waits).
 */
export async function readStreamWithWait(opts: {
  read: () => Promise<StreamRead>
  waitSeconds?: number
  pollMs?: number
  signal?: AbortSignal
}): Promise<StreamRead> {
  const pollMs = opts.pollMs ?? STREAM_WAIT_POLL_MS
  const deadline = Date.now() + clampWaitSeconds(opts.waitSeconds ?? 0) * 1000
  let result = await opts.read()
  while (
    !opts.signal?.aborted &&
    result.status === 'open' &&
    result.chunks.length === 0 &&
    Date.now() < deadline
  ) {
    await sleepWithAbort(pollMs, opts.signal)
    if (opts.signal?.aborted) break
    result = await opts.read()
  }
  return result
}

/**
 * The event-read variant of the shared wait loop: read once, then poll until
 * newer events arrive, the clamped deadline passes, or `signal` aborts.
 * Session event reads (§7.1.1) honor the same clamp/early-return rules as
 * stream reads so the operator UI's poll loop cannot drift between the two;
 * there is no "closed" state to short-circuit on — an event log is always
 * open. An abort ends the hold with the current result (a pre-aborted signal
 * still performs the initial read but never waits).
 */
export async function readEventsWithWait<T>(opts: {
  read: () => Promise<T[]>
  waitSeconds?: number
  pollMs?: number
  signal?: AbortSignal
}): Promise<T[]> {
  const pollMs = opts.pollMs ?? STREAM_WAIT_POLL_MS
  const deadline = Date.now() + clampWaitSeconds(opts.waitSeconds ?? 0) * 1000
  let result = await opts.read()
  while (result.length === 0 && !opts.signal?.aborted && Date.now() < deadline) {
    await sleepWithAbort(pollMs, opts.signal)
    if (opts.signal?.aborted) break
    result = await opts.read()
  }
  return result
}
