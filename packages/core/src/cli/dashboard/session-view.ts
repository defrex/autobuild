/**
 * The shared session-view projection: protocol parts → display lines.
 *
 * This module is the one place the session view's VOCABULARY is decided. The
 * terminal renderer consumes its output and so will the web app later; nothing
 * outside this file decides what a part says. Two adapters feed one rendering
 * core:
 *
 *   - `projectSessionParts` renders the live/chunk path — raw `StreamPart[]`
 *     in store-sequence order, including parts that have not assembled (a tool
 *     call with input but no output yet).
 *   - `projectSessionDocument` renders the finalized `UIMessage[]` artifact
 *     that `closeStream` deposits. Note the SDK's document assembly drops
 *     `error` and `abort` chunks (they never become message parts), so those
 *     elements are only visible on the parts path.
 *
 * Both are pure functions of (input, width): stored parts are never altered,
 * and no line depends on color. Reasoning is marked by a literal `~ ` prefix so
 * it stays distinct from answer text even with the escapes stripped.
 */
import type { UIMessage } from 'ai'
import type { StreamPart } from '../../store/streams/types'
import { cellWidth, displayText, graphemes } from './cells'
import { wrapDisplay } from './composer'

/** Documented cap on the wrapped rows rendered for one tool output. */
export const SESSION_OUTPUT_MAX_ROWS = 8

/** One `data-ab-session` part's bracket identity, the header's source. */
export interface SessionHeaderInfo {
  session: string
  role: string
  runner: string
  model?: string
  phase: string
  round?: number
}

type DisplayEvent =
  | { kind: 'header'; info: SessionHeaderInfo }
  | { kind: 'prompt'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | {
      kind: 'tool'
      toolName: string
      input?: unknown
      output?: unknown
      awaiting: boolean
      errorText?: string
    }
  | { kind: 'step' }
  | { kind: 'error'; text: string }
  | { kind: 'abort'; text: string }
  | { kind: 'truncation'; bytes: number }
  | { kind: 'data'; name: string }

/**
 * The dashboard's prose wrap. Duplicated from `render.ts`'s file-local
 * `wrappedText` rather than exported from there: that file already imports
 * this module's output vocabulary, so sharing the helper would create an
 * import cycle for one narrow function. This copy keeps the same byte-stable
 * behavior — paragraph structure preserved, a token wider than the line
 * truncated with a `~`.
 */
function wrapProse(value: string, width: number, indent = ''): string[] {
  if (width <= 0) return []
  const lines: string[] = []
  for (const paragraph of value.split(/\r?\n/)) {
    const safe = displayText(paragraph)
    if (safe.length === 0) {
      lines.push(indent)
      continue
    }
    const wrapped = wrapDisplay(safe, width, indent)
    lines.push(...(wrapped.length > 0 ? wrapped : [indent]))
  }
  return lines
}

/** Cell-honest one-line cut with a `…` continuation marker. */
function truncateOneLine(value: string, width: number): string {
  const safe = displayText(value)
  if (width <= 0) return ''
  if (cellWidth(safe) <= width) return safe
  let out = ''
  let used = 0
  const budget = Math.max(0, width - 1)
  for (const cluster of graphemes(safe)) {
    if (used + cluster.width > budget) break
    out += cluster.text
    used += cluster.width
  }
  return `${out}…`
}

function headerLine(info: SessionHeaderInfo | undefined): string {
  if (info === undefined) return 'unknown session'
  const tokens = [
    info.role,
    info.runner,
    ...(info.model !== undefined ? [info.model] : []),
    `phase ${info.phase}`,
  ]
  const round = info.round !== undefined ? ` (round ${info.round})` : ''
  return `${tokens.join(' · ')}${round}`
}

function outputLines(output: unknown, width: number): string[] {
  const text = typeof output === 'string' ? output : JSON.stringify(output)
  if (typeof text !== 'string' || text.length === 0) return []
  return wrapProse(text, width)
}

/** Cap one block at `SESSION_OUTPUT_MAX_ROWS` rows, naming what is withheld. */
function capRows(rows: string[]): string[] {
  if (rows.length <= SESSION_OUTPUT_MAX_ROWS) return rows
  const withheld = rows.length - SESSION_OUTPUT_MAX_ROWS
  return [...rows.slice(0, SESSION_OUTPUT_MAX_ROWS), `… ${withheld} more rows withheld`]
}

function inputSummary(input: unknown): string {
  return typeof input === 'undefined' ? '' : JSON.stringify(input)
}

function renderEvents(events: readonly DisplayEvent[], width: number): string[] {
  const lines: string[] = []
  let sawContent = false
  let lastWasStep = false
  const push = (...added: string[]): void => {
    lines.push(...added)
    if (added.length > 0) {
      sawContent = true
      lastWasStep = false
    }
  }
  const pushProse = (text: string, width_: number): void => {
    if (text.length === 0) return
    const wrapped = wrapProse(text, width_)
    if (wrapped.length === 0) return
    push(...wrapped)
  }
  const pushStep = (): void => {
    // The leading boundary would only double-separate the header, and two
    // adjacent boundaries (finish then start) render one separator.
    if (!sawContent || lastWasStep) return
    lines.push('── step ──')
    sawContent = true
    lastWasStep = true
  }
  const pushMarked = (text: string, width_: number, mark: string): void => {
    if (text.length === 0) return
    for (const line of wrapProse(text, Math.max(1, width_ - mark.length))) {
      push(`${mark}${line}`)
    }
  }

  for (const event of events) {
    switch (event.kind) {
      case 'header': {
        push(headerLine(event.info))
        break
      }
      case 'prompt':
        if (event.text.length > 0) push(...wrapProse(`Prompt: ${event.text}`, width))
        break
      case 'text':
        pushProse(event.text, width)
        break
      case 'reasoning':
        // Distinct from answer text WITHOUT color: a literal prefix that
        // survives `--plain` and every pipe.
        pushMarked(event.text, width, '~ ')
        break
      case 'tool': {
        push(truncateOneLine(`${event.toolName}(${inputSummary(event.input)})`, width))
        if (event.awaiting) push('waiting for output')
        if (event.errorText !== undefined) push(`ERROR: ${event.errorText}`)
        else if (event.output !== undefined) push(...capRows(outputLines(event.output, width)))
        break
      }
      case 'step':
        pushStep()
        break
      case 'error':
        push(`ERROR: ${event.text}`)
        break
      case 'abort':
        push(`ABORTED: ${event.text}`)
        break
      case 'truncation':
        push(`… ${event.bytes} bytes truncated`)
        break
      case 'data':
        push(`data ${event.name}`)
        break
    }
  }
  return lines
}

// ── Parts adapter (the live/chunk path) ──────────────────────────────────────

interface OpenRun {
  id: string
  buffer: string
}

function collectPartEvents(parts: readonly StreamPart[]): DisplayEvent[] {
  // Tool outputs arrive in later chunks than their inputs; resolve them in a
  // first pass so the tool call renders complete wherever its input landed.
  const outputs = new Map<string, { output?: unknown; errorText?: string }>()
  for (const part of parts) {
    if (part.type === 'tool-output-available' && typeof part.toolCallId === 'string') {
      outputs.set(part.toolCallId, { output: part.output })
    }
    if (part.type === 'tool-output-error' && typeof part.toolCallId === 'string') {
      outputs.set(part.toolCallId, {
        ...(typeof part.errorText === 'string' ? { errorText: part.errorText } : {}),
        ...(part.output !== undefined ? { output: part.output } : {}),
      })
    }
  }

  const events: DisplayEvent[] = []
  let headerSeen = false
  let openText: OpenRun | undefined
  let openReasoning: OpenRun | undefined
  const flush = (run: OpenRun | undefined, kind: 'text' | 'reasoning'): void => {
    if (run === undefined || run.buffer.length === 0) return
    events.push(
      kind === 'text'
        ? { kind: 'text', text: run.buffer }
        : { kind: 'reasoning', text: run.buffer },
    )
  }
  const open = (
    current: OpenRun | undefined,
    id: unknown,
    kind: 'text' | 'reasoning',
  ): OpenRun | undefined => {
    if (typeof id !== 'string') return current
    if (current?.id === id) return current
    flush(current, kind)
    return { id, buffer: '' }
  }

  for (const part of parts) {
    switch (part.type) {
      case 'data-ab-session': {
        const data = part.data
        if (typeof data !== 'object' || data === null) {
          if (!headerSeen) headerSeen = true
          events.push({ kind: 'data', name: part.type })
          break
        }
        const record = data as Record<string, unknown>
        if (!headerSeen && typeof record.role === 'string' && typeof record.runner === 'string') {
          headerSeen = true
          events.push({
            kind: 'header',
            info: {
              ...(typeof record.session === 'string'
                ? { session: record.session }
                : { session: '' }),
              role: record.role,
              runner: record.runner,
              ...(typeof record.model === 'string' ? { model: record.model } : {}),
              ...(typeof record.phase === 'string' ? { phase: record.phase } : { phase: '' }),
              ...(typeof record.round === 'number' ? { round: record.round } : {}),
            },
          })
        } else {
          events.push({ kind: 'data', name: part.type })
        }
        break
      }
      case 'data-ab-prompt': {
        const data = part.data
        const text =
          typeof data === 'object' && data !== null
            ? (data as Record<string, unknown>).text
            : undefined
        events.push({ kind: 'prompt', text: typeof text === 'string' ? text : '' })
        break
      }
      case 'data-ab-truncation': {
        const data = part.data
        const bytes =
          typeof data === 'object' && data !== null
            ? (data as Record<string, unknown>).omittedBytes
            : undefined
        events.push({ kind: 'truncation', bytes: typeof bytes === 'number' ? bytes : 0 })
        break
      }
      case 'text-start':
        openText = open(openText, part.id, 'text')
        break
      case 'text-delta': {
        openText = open(openText, part.id, 'text')
        if (openText !== undefined && typeof part.delta === 'string') openText.buffer += part.delta
        break
      }
      case 'text-end':
        flush(openText, 'text')
        openText = undefined
        break
      case 'reasoning-start':
        openReasoning = open(openReasoning, part.id, 'reasoning')
        break
      case 'reasoning-delta': {
        openReasoning = open(openReasoning, part.id, 'reasoning')
        if (openReasoning !== undefined && typeof part.delta === 'string') {
          openReasoning.buffer += part.delta
        }
        break
      }
      case 'reasoning-end':
        flush(openReasoning, 'reasoning')
        openReasoning = undefined
        break
      case 'tool-input-available': {
        const callId = typeof part.toolCallId === 'string' ? part.toolCallId : ''
        const resolved = outputs.get(callId) ?? {}
        events.push({
          kind: 'tool',
          toolName: typeof part.toolName === 'string' ? part.toolName : 'unknown tool',
          ...(part.input !== undefined ? { input: part.input } : {}),
          ...('output' in resolved && resolved.output !== undefined
            ? { output: resolved.output }
            : {}),
          awaiting: resolved.output === undefined && resolved.errorText === undefined,
          ...('errorText' in resolved && resolved.errorText !== undefined
            ? { errorText: resolved.errorText }
            : {}),
        })
        break
      }
      case 'start-step':
      case 'finish-step':
        events.push({ kind: 'step' })
        break
      case 'error':
        events.push({
          kind: 'error',
          text: typeof part.errorText === 'string' ? part.errorText : String(part.errorText ?? ''),
        })
        break
      case 'abort':
        events.push({
          kind: 'abort',
          text: typeof part.reason === 'string' ? part.reason : String(part.reason ?? ''),
        })
        break
      default: {
        // Any other `data-*` extension renders legibly; non-data parts of
        // unknown protocol types are ignored.
        if (part.type.startsWith('data-')) events.push({ kind: 'data', name: part.type })
        break
      }
    }
  }
  flush(openText, 'text')
  flush(openReasoning, 'reasoning')
  return events
}

/** Project a live/chunk part sequence (store order) to display lines. */
export function projectSessionParts(parts: readonly StreamPart[], width: number): string[] {
  return renderEvents(collectPartEvents(parts), width)
}

// ── Document adapter (the finalized artifact path) ──────────────────────────

function collectDocumentEvents(messages: readonly UIMessage[]): DisplayEvent[] {
  const events: DisplayEvent[] = []
  let headerSeen = false
  for (const message of messages) {
    for (const part of message.parts) {
      const type = part.type
      if (type === 'text') {
        if (typeof (part as { text?: unknown }).text === 'string') {
          events.push({ kind: 'text', text: (part as { text: string }).text })
        }
        continue
      }
      if (type === 'reasoning') {
        if (typeof (part as { text?: unknown }).text === 'string') {
          events.push({ kind: 'reasoning', text: (part as { text: string }).text })
        }
        continue
      }
      if (type === 'step-start') {
        events.push({ kind: 'step' })
        continue
      }
      if (type === 'dynamic-tool') {
        const tool = part as {
          toolName?: unknown
          state?: unknown
          input?: unknown
          output?: unknown
          errorText?: unknown
        }
        events.push({
          kind: 'tool',
          toolName: typeof tool.toolName === 'string' ? tool.toolName : 'unknown tool',
          ...(tool.input !== undefined ? { input: tool.input } : {}),
          ...(tool.output !== undefined ? { output: tool.output } : {}),
          awaiting: tool.state === 'input-streaming' || tool.state === 'input-available',
          ...(typeof tool.errorText === 'string' ? { errorText: tool.errorText } : {}),
        })
        continue
      }
      if (type.startsWith('tool-')) {
        const tool = part as {
          state?: unknown
          input?: unknown
          output?: unknown
          errorText?: unknown
        }
        events.push({
          kind: 'tool',
          toolName: type.slice('tool-'.length),
          ...(tool.input !== undefined ? { input: tool.input } : {}),
          ...(tool.output !== undefined ? { output: tool.output } : {}),
          awaiting: tool.state === 'input-streaming' || tool.state === 'input-available',
          ...(typeof tool.errorText === 'string' ? { errorText: tool.errorText } : {}),
        })
        continue
      }
      if (type.startsWith('data-')) {
        const data = (part as { data?: unknown }).data
        if (type === 'data-ab-prompt') {
          const text =
            typeof data === 'object' && data !== null
              ? (data as Record<string, unknown>).text
              : undefined
          events.push({ kind: 'prompt', text: typeof text === 'string' ? text : '' })
        } else if (type === 'data-ab-session') {
          const record =
            typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
          if (!headerSeen && typeof record.role === 'string' && typeof record.runner === 'string') {
            headerSeen = true
            events.push({
              kind: 'header',
              info: {
                ...(typeof record.session === 'string'
                  ? { session: record.session }
                  : { session: '' }),
                role: record.role,
                runner: record.runner,
                ...(typeof record.model === 'string' ? { model: record.model } : {}),
                ...(typeof record.phase === 'string' ? { phase: record.phase } : { phase: '' }),
                ...(typeof record.round === 'number' ? { round: record.round } : {}),
              },
            })
          } else {
            events.push({ kind: 'data', name: type })
          }
        } else if (type === 'data-ab-truncation') {
          const bytes =
            typeof data === 'object' && data !== null
              ? (data as Record<string, unknown>).omittedBytes
              : undefined
          events.push({ kind: 'truncation', bytes: typeof bytes === 'number' ? bytes : 0 })
        } else {
          events.push({ kind: 'data', name: type })
        }
      }
      // `file`, `source-url`, `custom`, … have no session-view rendering yet.
      // (`error`/`abort`/`finish-step` chunks never become message parts at
      // all — the SDK's assembly drops them — so those elements are only
      // visible on the parts path above.)
    }
  }
  return events
}

/** Project a finalized `UIMessage[]` document (the closed stream's artifact)
 * to the same display lines. */
export function projectSessionDocument(document: readonly UIMessage[], width: number): string[] {
  return renderEvents(collectDocumentEvents(document), width)
}
