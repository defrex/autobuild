/**
 * Session-stream part builders (SPEC §9): the one place the `data-ab-*`
 * extension vocabulary is defined and the AI SDK UI Message Stream parts are
 * shaped. Pure functions returning fresh objects — the batching writer owns
 * buffering, truncation, and store delivery; the adapters own only when to
 * call these.
 *
 * Everything here is the protocol of `ai-ui-message-stream/v1` plus the
 * `data-ab-*` data parts Autobuild defines on top of it. Nothing encodes
 * this repository's specifics.
 */
import type { StreamPart } from '../../store/streams/types'
import type { SessionStreamInfo } from './runtime'

/**
 * Documented per-part size bound (SPEC §9): text, reasoning, tool inputs,
 * and tool outputs serialized above this many UTF-8 bytes are truncated by
 * the writer and followed by a `data-ab-truncation` part naming the omitted
 * byte count. The writer, not the adapter, enforces it.
 */
export const STREAM_PART_MAX_BYTES = 65_536

/** The stream's first part, always: the bracket it belongs to. */
export function sessionPart(info: SessionStreamInfo): StreamPart {
  return {
    type: 'data-ab-session',
    data: {
      session: info.session,
      role: info.role,
      runner: info.runner,
      ...(info.model !== undefined ? { model: info.model } : {}),
      phase: info.phase,
      ...(info.round !== undefined ? { round: info.round } : {}),
    },
  }
}

/** A turn's prompt: the skill invocation on turn 1, the continuation
 * message on later rounds — both sides of the exchange are visible. */
export function promptPart(text: string): StreamPart {
  return { type: 'data-ab-prompt', data: { text } }
}

/** Serialized bytes omitted by the writer's truncation, as its own part. */
export function truncationPart(omittedBytes: number): StreamPart {
  return { type: 'data-ab-truncation', data: { omittedBytes } }
}

export function startPart(messageId: string): StreamPart {
  return { type: 'start', messageId }
}

export function finishPart(): StreamPart {
  return { type: 'finish', finishReason: 'stop' }
}

export function errorPart(errorText: string): StreamPart {
  return { type: 'error', errorText }
}

export function abortPart(reason: string): StreamPart {
  return { type: 'abort', reason }
}

export function startStepPart(): StreamPart {
  return { type: 'start-step' }
}

export function finishStepPart(): StreamPart {
  return { type: 'finish-step' }
}

export function textStartPart(id: string): StreamPart {
  return { type: 'text-start', id }
}

export function textDeltaPart(id: string, delta: string): StreamPart {
  return { type: 'text-delta', id, delta }
}

export function textEndPart(id: string): StreamPart {
  return { type: 'text-end', id }
}

export function reasoningStartPart(id: string): StreamPart {
  return { type: 'reasoning-start', id }
}

export function reasoningDeltaPart(id: string, delta: string): StreamPart {
  return { type: 'reasoning-delta', id, delta }
}

export function reasoningEndPart(id: string): StreamPart {
  return { type: 'reasoning-end', id }
}

export function toolInputPart(toolCallId: string, toolName: string, input: unknown): StreamPart {
  return { type: 'tool-input-available', toolCallId, toolName, input }
}

export function toolOutputPart(toolCallId: string, output: unknown): StreamPart {
  return { type: 'tool-output-available', toolCallId, output }
}
