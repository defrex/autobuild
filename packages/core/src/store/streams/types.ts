/**
 * The stream primitive (SPEC §7.6): the BuildStore's third kind of durable
 * content, alongside the append-only event log of typed facts and the
 * content-addressed artifacts of bulk bytes. A stream is an append-only,
 * per-stream sequenced log of chunks — a chunk being a batch of protocol
 * parts — with an open-then-closed lifecycle that finalizes into an artifact.
 *
 * The chunk vocabulary is the Vercel AI SDK UI Message Stream protocol,
 * version 1 of the current major (AI SDK 7). Storing the protocol's parts
 * rather than a private shape means a read route can later re-emit them as
 * Server-Sent Events that the AI SDK's own client hooks consume unchanged,
 * and a closed stream finalizes into the protocol's `UIMessage[]` document.
 *
 * Streams are presentation, never routing: no kernel, engine, reducer, or
 * dispatcher decision reads stream content; outcomes travel only the typed
 * CLI. This module — like everything under `store/` — encodes nothing about
 * this repository's specifics.
 */

/** The literal format identifier carried on every stream record. */
export const STREAM_FORMAT = 'ai-ui-message-stream/v1'

/** The serialized-batch ceiling: the same byte bound artifacts enforce. */
export const STREAM_BATCH_MAX_BYTES = 1_048_576

/** Upper bound for a read's wait, in whole seconds. Larger requests clamp. */
export const MAX_STREAM_WAIT_SECONDS = 30

/** One protocol part: a JSON object with a nonempty-string `type`. The store
 * performs no further protocol validation on append — assembly at close does
 * that, following the protocol for its defined part types and dropping and
 * counting parts of undefined types. */
export type StreamPart = { type: string } & Record<string, unknown>

/** A store-assigned, per-stream sequenced batch of parts. */
export interface StreamChunk {
  stream: string
  /** Per-stream sequence assigned by the store, starting at 1. Producers
   * cannot fake ordering. */
  seq: number
  ts: string
  parts: StreamPart[]
}

/** Where a stream lives. The vocabulary is closed; a later operator-session
 * kind is the anticipated extension. */
export type StreamScope = { kind: 'build'; build: string } | { kind: 'repo'; repo: string }

export type StreamStatus = 'open' | 'closed'
export type StreamOutcome = 'completed' | 'aborted'

/** Reference to the artifact the close deposited on the owning scope. */
export interface StreamArtifactRef {
  kind: string
  revision: number
  blobRef: string
}

export interface StreamRecord {
  id: string
  scope: StreamScope
  /** Caller-supplied label; presentation metadata only. */
  label: string
  format: typeof STREAM_FORMAT
  status: StreamStatus
  createdAt: string
  closedAt?: string
  outcome?: StreamOutcome
  /** Present once closed: the finalized `UIMessage[]` document's artifact. */
  artifact?: StreamArtifactRef
}

export interface StreamRead {
  chunks: StreamChunk[]
  status: StreamStatus
  outcome?: StreamOutcome
  artifact?: StreamArtifactRef
}

/** Appending a batch whose serialized size exceeds the ceiling. Typed so the
 * remote server maps it to `413 {kind:'validation'}` like the artifact
 * ceiling and the remote client rehydrates it; the message names the bound. */
export class StreamBatchTooLargeError extends Error {
  constructor(
    readonly bytes: number | undefined,
    readonly maxBytes: number = STREAM_BATCH_MAX_BYTES,
    message?: string,
  ) {
    super(message ?? `stream batch of ${bytes} bytes exceeds the ${maxBytes}-byte ceiling`)
    this.name = 'StreamBatchTooLargeError'
  }
}

/** Appending to a closed stream. Typed so the remote server maps it to
 * `409 {kind:'conflict'}` and the remote client rehydrates it. The argument
 * is the stream id locally, or the server's message over the wire. */
export class StreamClosedError extends Error {
  constructor(streamOrMessage: string) {
    super(
      streamOrMessage.startsWith('stream "')
        ? streamOrMessage
        : `stream "${streamOrMessage}" is closed`,
    )
    this.name = 'StreamClosedError'
  }
}

/** Append validation: a nonempty array of parts, each a JSON object whose
 * `type` is a nonempty string. Throws a plain `Error` otherwise. */
export function validateStreamParts(parts: StreamPart[]): void {
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error('stream parts must be a nonempty array')
  }
  for (const part of parts) {
    if (typeof part !== 'object' || part === null || Array.isArray(part)) {
      throw new Error('every stream part must be a JSON object')
    }
    if (typeof part.type !== 'string' || part.type.length === 0) {
      throw new Error('every stream part must carry a nonempty string "type"')
    }
  }
}

/** Serialized JSON size of a batch, in bytes — the value compared against
 * `STREAM_BATCH_MAX_BYTES`. */
export function serializedBatchSize(parts: StreamPart[]): number {
  return new TextEncoder().encode(JSON.stringify(parts)).byteLength
}

/** The read-wait bound: whole seconds, clamped above 30 and below 0. */
export function clampWaitSeconds(waitSeconds: number): number {
  return Math.max(0, Math.min(MAX_STREAM_WAIT_SECONDS, Math.floor(waitSeconds)))
}

/**
 * The close-time artifact input every adapter deposits: the assembled
 * `UIMessage[]` document as JSON bytes, kind `stream:<streamId>`, with
 * metadata naming the stream id, label, scope, outcome, chunk count, and
 * dropped-part count. Shared so every adapter's finalized artifact is
 * byte-identical for the same stream.
 */
export function streamArtifactInput(
  stream: string,
  scope: StreamScope,
  label: string,
  outcome: StreamOutcome,
  document: unknown,
  chunkCount: number,
  droppedPartCount: number,
): {
  kind: string
  content: string
  metadata: Record<string, unknown>
} {
  return {
    kind: `stream:${stream}`,
    content: JSON.stringify(document),
    metadata: {
      stream,
      label,
      scope: { ...scope },
      outcome,
      chunkCount,
      droppedPartCount,
    },
  }
}
