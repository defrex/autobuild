import type { OperatorAnswerRequest, OperatorApiClient } from 'autobuild/operator-api'

export type BuildControlReply = Awaited<ReturnType<OperatorApiClient['controlBuild']>>

export type ControlReplyClassification =
  | { kind: 'recorded' }
  | { kind: 'answer'; slug: string; escalationIds: string[] }
  | { kind: 'unexpected'; text: string }

export type AnswerReplyClassification = { kind: 'answered' } | { kind: 'unexpected'; text: string }

/** Compactly preserve an operator reply for the shell error line. */
export function controlReplyText(reply: unknown): string {
  if (typeof reply === 'string') return reply
  try {
    return JSON.stringify(reply) ?? String(reply)
  } catch {
    return String(reply)
  }
}

export function classifyControlReply(
  requestedSlug: string,
  reply: unknown,
): ControlReplyClassification {
  if (typeof reply !== 'object' || reply === null) {
    return { kind: 'unexpected', text: controlReplyText(reply) }
  }
  const value = reply as Record<string, unknown>
  if (
    value.kind === 'command' &&
    value.slug === requestedSlug &&
    typeof value.command === 'string' &&
    ['pause', 'resume', 'abort', 'discard', 'auto-merge-on', 'auto-merge-off'].includes(
      value.command,
    ) &&
    typeof value.event === 'object' &&
    value.event !== null
  ) {
    return { kind: 'recorded' }
  }
  if (
    value.kind === 'answer-required' &&
    value.slug === requestedSlug &&
    Array.isArray(value.escalationIds) &&
    value.escalationIds.every((id) => typeof id === 'string')
  ) {
    return {
      kind: 'answer',
      slug: requestedSlug,
      escalationIds: [...value.escalationIds] as string[],
    }
  }
  return { kind: 'unexpected', text: controlReplyText(reply) }
}

export function classifyAnswerReply(
  requestedSlug: string,
  reply: unknown,
): AnswerReplyClassification {
  if (typeof reply === 'object' && reply !== null) {
    const value = reply as Record<string, unknown>
    if (
      value.kind === 'answered' &&
      value.slug === requestedSlug &&
      typeof value.count === 'number' &&
      typeof value.resumed === 'boolean' &&
      typeof value.resolution === 'string' &&
      ['guidance', 'retry', 'dismiss-finding', 'revise-spec'].includes(value.resolution)
    ) {
      return { kind: 'answered' }
    }
  }
  return { kind: 'unexpected', text: controlReplyText(reply) }
}

export function answerRequest(input: string): OperatorAnswerRequest {
  const text = input.trim()
  return text ? { resolution: 'guidance', text } : { resolution: 'retry' }
}
