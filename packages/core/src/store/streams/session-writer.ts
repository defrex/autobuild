/**
 * The session-stream batching writer (SPEC §9): the store-side sink the
 * build-runner hands to a runtime registration's `openSessionStream`
 * capability. Buffers appended protocol parts and flushes them to the
 * store on a short cadence — well inside the one-second latency bound —
 * instead of one request per delta.
 *
 * Failure containment is the contract: `append` NEVER throws, an append
 * error retries on the next tick, and after three consecutive failed
 * flushes the writer stops streaming the session, best-effort closes the
 * stream as `aborted` (first close wins), and reports once through the
 * diagnostics hook. A failing stream path can therefore never fail a turn,
 * a deposit, or a phase. `close` is flush-then-close, idempotent, first
 * outcome wins.
 *
 * Per-part payloads above the documented `STREAM_PART_MAX_BYTES` are
 * truncated on a UTF-8 boundary and followed by a `data-ab-truncation`
 * part naming the omitted byte count, so no single delta can exceed the
 * store's batch ceiling.
 */
import type { SessionStreamSink } from '../../ports/types'
import { truncationPart } from '../../ports/runner/stream-parts'
import type { JsonRecord } from '../../ports/runner/json-record'
import {
  serializedBatchSize,
  STREAM_BATCH_MAX_BYTES,
  type StreamOutcome,
  type StreamPart,
  type StreamRecord,
  type StreamScope,
} from './types'

export interface SessionStreamSinkOptions {
  /** Any BuildStore handle scoped so `createStream(scope)` succeeds — the
   * build-runner passes its build-scoped handle. */
  store: {
    createStream(scope: StreamScope, label: string): Promise<StreamRecord>
    appendStreamParts(streamId: string, parts: StreamPart[]): Promise<unknown>
    closeStream(streamId: string, outcome: StreamOutcome): Promise<StreamRecord>
  }
  scope: StreamScope
  /** Called at most once per sink, when streaming gives up. */
  onDiagnostic?: (message: string) => void
  /** Flush cadence in milliseconds. Default 250. */
  flushMs?: number
  /** Injectable scheduler for tests. Default: an unref'ed interval. */
  schedule?: (flush: () => void, ms: number) => () => void
}

/** Consecutive failed flushes before the writer stops streaming a session. */
const MAX_FLUSH_FAILURES = 3

/**
 * Cut `text` to at most `maxBytes` UTF-8 bytes without splitting a
 * multi-byte sequence. Returns the prefix and the omitted byte count.
 */
function truncateUtf8(text: string, maxBytes: number): { text: string; omitted: number } {
  const bytes = new TextEncoder().encode(text)
  if (bytes.byteLength <= maxBytes) return { text, omitted: 0 }
  let cut = maxBytes
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut -= 1
  return {
    text: new TextDecoder().decode(bytes.slice(0, cut)),
    omitted: bytes.byteLength - cut,
  }
}

/**
 * Bound one part's payload against `STREAM_PART_MAX_BYTES`. Text and
 * reasoning deltas truncate their `delta`; tool inputs/outputs truncate
 * their JSON serialization; the prompt part truncates `data.text`. Anything
 * else passes through untouched. Returns the (possibly replaced) part plus
 * a `data-ab-truncation` part when bytes were omitted.
 */
function boundPart(part: StreamPart, maxBytes: number): StreamPart[] {
  const record = part as JsonRecord
  switch (part.type) {
    case 'text-delta':
    case 'reasoning-delta': {
      const delta = record.delta
      if (typeof delta !== 'string') return [part]
      const { text, omitted } = truncateUtf8(delta, maxBytes)
      return omitted === 0
        ? [part]
        : [{ ...record, type: part.type, delta: text }, truncationPart(omitted)]
    }
    case 'tool-input-available':
    case 'tool-output-available': {
      const key = part.type === 'tool-input-available' ? 'input' : 'output'
      const value = record[key]
      if (value === undefined) return [part]
      const serialized = JSON.stringify(value)
      if (typeof serialized !== 'string') return [part]
      const { text, omitted } = truncateUtf8(serialized, maxBytes)
      return omitted === 0
        ? [part]
        : [{ ...record, type: part.type, [key]: text }, truncationPart(omitted)]
    }
    default: {
      // data-ab-prompt carries the turn's prompt in data.text; other data
      // parts are small bracket metadata and pass through.
      if (part.type !== 'data-ab-prompt') return [part]
      const data = record.data
      if (typeof data !== 'object' || data === null) return [part]
      const text = (data as JsonRecord).text
      if (typeof text !== 'string') return [part]
      const { text: bounded, omitted } = truncateUtf8(text, maxBytes)
      if (omitted === 0) return [part]
      return [
        { ...record, type: part.type, data: { ...(data as JsonRecord), text: bounded } },
        truncationPart(omitted),
      ]
    }
  }
}

/**
 * Create the bracket-scoped sink. `open` creates the store stream and
 * returns its id; appends buffer until then and flush on the cadence.
 */
export function createSessionStreamSink(options: SessionStreamSinkOptions): SessionStreamSink {
  const { store, scope } = options
  const flushMs = options.flushMs ?? 250
  const maxPartBytes = 65_536

  let streamId: string | undefined
  let openError: unknown
  const buffer: StreamPart[] = []
  let flushFailures = 0
  let defunct = false
  let diagnosticSent = false
  let closed = false
  let firstOutcome: StreamOutcome | undefined
  let cancelSchedule: (() => void) | undefined

  const schedule =
    options.schedule ??
    ((flush, ms) => {
      const timer = setInterval(flush, ms)
      timer.unref?.()
      return () => clearInterval(timer)
    })

  function onDiagnosticOnce(message: string): void {
    if (diagnosticSent) return
    diagnosticSent = true
    options.onDiagnostic?.(message)
  }

  function ensureTimer(): void {
    if (cancelSchedule !== undefined || defunct || closed) return
    cancelSchedule = schedule(() => void flush(), flushMs)
  }

  async function flush(): Promise<void> {
    if (streamId === undefined || defunct || closed) return
    if (buffer.length === 0) return
    // Split the buffer into store-sized batches (parts were already
    // per-part bounded at append time, so every batch eventually lands).
    while (buffer.length > 0) {
      const batch: StreamPart[] = [buffer[0]!]
      buffer.shift()
      while (
        buffer.length > 0 &&
        serializedBatchSize([...batch, buffer[0]!]) <= STREAM_BATCH_MAX_BYTES
      ) {
        batch.push(buffer.shift()!)
      }
      try {
        await store.appendStreamParts(streamId, batch)
        flushFailures = 0
      } catch (error) {
        // Put the parts back in order and retry on the next tick.
        buffer.unshift(...batch)
        flushFailures += 1
        if (flushFailures >= MAX_FLUSH_FAILURES) {
          defunct = true
          cancelSchedule?.()
          cancelSchedule = undefined
          onDiagnosticOnce(
            `session stream "${streamId}" stopped after ${MAX_FLUSH_FAILURES} failed appends: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          )
          await closeSink('aborted')
        }
        return
      }
    }
  }

  /** First-outcome-wins, flush-then-close, best-effort. */
  async function closeSink(outcome: StreamOutcome): Promise<void> {
    if (closed || firstOutcome !== undefined) return
    firstOutcome = outcome
    cancelSchedule?.()
    cancelSchedule = undefined
    if (streamId !== undefined) {
      try {
        await flush()
      } catch {
        // flush is defensive; appends already handle their own failures.
      }
      try {
        await store.closeStream(streamId, outcome)
      } catch (error) {
        onDiagnosticOnce(
          `session stream "${streamId}" failed to close: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    closed = true
  }

  return {
    async open(label) {
      try {
        const record = await store.createStream(scope, label)
        streamId = record.id
        ensureTimer()
        // Parts appended while opening flush immediately after the id lands.
        await flush()
        return record.id
      } catch (error) {
        openError = error
        throw error
      }
    },

    append(parts) {
      // Never throws: after defunct/close or before a successful open,
      // parts are dropped or buffered without surfacing an error.
      if (defunct || closed) return
      if (openError !== undefined && streamId === undefined) return
      for (const part of parts) {
        buffer.push(...boundPart(part, maxPartBytes))
      }
      if (streamId !== undefined) ensureTimer()
    },

    async close(outcome) {
      await closeSink(outcome)
    },
  }
}
