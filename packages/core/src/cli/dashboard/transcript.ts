export interface TranscriptUsage {
  inputTokens: number
  outputTokens: number
  turns?: number
}

export interface TranscriptTurn {
  prompt: string
  text: string
  usage?: TranscriptUsage
  failure?: string
}

export type TranscriptPresentation =
  | { kind: 'turns'; turns: TranscriptTurn[] }
  | { kind: 'producer-boundary'; notice: string; turns: TranscriptTurn[] }
  | { kind: 'raw'; text: string }

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function usage(value: unknown): TranscriptUsage | undefined {
  const item = record(value)
  if (item === undefined) return undefined
  if (typeof item.inputTokens !== 'number' || typeof item.outputTokens !== 'number')
    return undefined
  return {
    inputTokens: item.inputTokens,
    outputTokens: item.outputTokens,
    ...(typeof item.turns === 'number' ? { turns: item.turns } : {}),
  }
}

function failure(value: unknown): string | undefined {
  const item = record(value)
  return item !== undefined && typeof item.message === 'string' ? item.message : undefined
}

function parseTurn(value: unknown, index: number): TranscriptTurn | undefined {
  const item = record(value)
  if (item === undefined) return undefined
  const result = record(item.result)
  const text = typeof item.text === 'string' ? item.text : result?.text
  if (typeof text !== 'string') return undefined
  const prompt =
    typeof item.prompt === 'string'
      ? item.prompt
      : typeof item.message === 'string'
        ? item.message
        : index === 0
          ? '(initial skill invocation)'
          : `(turn ${index + 1})`
  return {
    prompt,
    text,
    ...(usage(item.usage ?? result?.usage) !== undefined
      ? { usage: usage(item.usage ?? result?.usage)! }
      : {}),
    ...(failure(item.failure ?? result?.failure) !== undefined
      ? { failure: failure(item.failure ?? result?.failure)! }
      : {}),
  }
}

/** Parse opaque transcript bytes as a presentation heuristic, never a schema. */
export function parseTranscript(content: string): TranscriptPresentation {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return { kind: 'raw', text: content }
  }

  const root = record(parsed)
  if (root !== undefined && Array.isArray(root.turns)) {
    const turns = root.turns.map(parseTurn)
    if (turns.every((turn): turn is TranscriptTurn => turn !== undefined)) {
      return { kind: 'turns', turns }
    }
  }

  if (
    root !== undefined &&
    typeof root.note === 'string' &&
    root.note.includes('producer session')
  ) {
    const boundary = record(root.turn)
    if (boundary !== undefined && typeof boundary.text === 'string') {
      return {
        kind: 'producer-boundary',
        notice:
          "Producer boundary record: this session was kept live for continuation; only this round's final turn was deposited.",
        turns: [
          {
            prompt: '(producer round invocation)',
            text: boundary.text,
            ...(usage(boundary.usage) !== undefined ? { usage: usage(boundary.usage)! } : {}),
          },
        ],
      }
    }
  }

  return { kind: 'raw', text: JSON.stringify(parsed, null, 2) }
}
