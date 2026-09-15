/**
 * The shared read-wait loop (SPEC §7.6): when a read finds no newer chunk and
 * the stream is open, the adapter honors the wait bound — returning no later
 * than the bound, but as soon as a chunk is appended or the stream closes.
 * The memory, SQLite, and PostgreSQL adapters all delegate here so wait
 * semantics are adapter-uniform; the remote adapter instead delegates the
 * wait to its backing store over one held-open request.
 *
 * A small poll loop rather than a waiter registry: streams are presentation
 * content, poll frequency is ~25 ms, and the uniformity across synchronous
 * (SQLite) and asynchronous (PostgreSQL) backends is worth more than
 * wake-on-write precision. Closed streams never wait.
 */
import { clampWaitSeconds, type StreamRead } from './types'

export const STREAM_WAIT_POLL_MS = 25

/**
 * Read once, then poll until newer chunks arrive, the stream closes, or the
 * clamped wall-clock deadline passes. `read` must re-query the store on every
 * call; a throw from it propagates immediately.
 */
export async function readStreamWithWait(opts: {
  read: () => Promise<StreamRead>
  waitSeconds?: number
  pollMs?: number
}): Promise<StreamRead> {
  const pollMs = opts.pollMs ?? STREAM_WAIT_POLL_MS
  const deadline = Date.now() + clampWaitSeconds(opts.waitSeconds ?? 0) * 1000
  let result = await opts.read()
  while (result.status === 'open' && result.chunks.length === 0 && Date.now() < deadline) {
    await Bun.sleep(pollMs)
    result = await opts.read()
  }
  return result
}

/**
 * The event-read variant of the shared wait loop: read once, then poll until
 * newer events arrive or the clamped deadline passes. Session event reads
 * (§7.1.1) honor the same clamp/early-return rules as stream reads so the
 * operator UI's poll loop cannot drift between the two; there is no
 * "closed" state to short-circuit on — an event log is always open.
 */
export async function readEventsWithWait<T>(opts: {
  read: () => Promise<T[]>
  waitSeconds?: number
  pollMs?: number
}): Promise<T[]> {
  const pollMs = opts.pollMs ?? STREAM_WAIT_POLL_MS
  const deadline = Date.now() + clampWaitSeconds(opts.waitSeconds ?? 0) * 1000
  let result = await opts.read()
  while (result.length === 0 && Date.now() < deadline) {
    await Bun.sleep(pollMs)
    result = await opts.read()
  }
  return result
}
