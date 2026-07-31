import { emitKeypressEvents } from 'node:readline'
import {
  decodeCsi,
  endsCsi,
  INTERRUPT_WATCH_MAX,
  isCsiParameterByte,
  isInterruptSequence,
  MAX_CSI_PARAM_DIGITS,
  type CsiReport,
} from './keyboard'

/**
 * The output seam for interactive rendering (SPEC §14).
 *
 * `ab dispatch` writes lines through a `stdout: (line) => void` dep. That is
 * the right shape for append-only output and the wrong one for a redrawn
 * region, which needs raw writes (no implicit newline), the terminal width,
 * and — above all — an honest answer to "is anyone watching?".
 *
 * The seam is deliberately tiny and injectable: `DispatchOpts.terminal` is
 * OPTIONAL, and absent ⇒ non-interactive ⇒ plain output. That default is what
 * keeps every existing dispatch test (and every piped invocation) on exactly
 * today's behavior, and it means the dashboard can never be the reason a
 * scripted `ab dispatch` starts emitting escape sequences.
 */

export type TerminalInputEvent =
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'left' }
  | { type: 'right' }
  | { type: 'home' }
  | { type: 'end' }
  | { type: 'enter' }
  | { type: 'newline' }
  | { type: 'backspace' }
  | { type: 'escape' }
  | { type: 'interrupt' }
  | { type: 'text'; text: string }
  /** One bracketed paste, delivered whole. Never split, never capped: the
   * buffer has to hold what the operator actually pasted. */
  | { type: 'paste'; text: string }

export interface TerminalInputHooks {
  onListening?(): void
  onKeyboardFlags?(flags: number): void
  onDeviceAttributes?(): void
}

/** Injectable keyboard seam. Starting returns an idempotent cleanup. */
export interface TerminalInput {
  start(onInput: (input: TerminalInputEvent) => void, hooks?: TerminalInputHooks): () => void
}

export interface TerminalOut {
  /** Raw write — no newline appended (unlike the line-oriented stdout dep). */
  write(chunk: string): void
  /** Terminal width in columns; a sane fallback when unknown. */
  columns: number
  /** Terminal height in rows; a sane fallback when unknown. The live region
   * snapshots this on every update so a resize invalidates its top-anchored
   * alternate-screen paint. The frame still has to leave one spare row for its
   * trailing newline. */
  rows: number
  /** True only for a real TTY — false for pipes and redirects. */
  interactive: boolean
}

/** Dimensions to assume when the stream reports none — the conventional 80x24. */
const FALLBACK_COLUMNS = 80
const FALLBACK_ROWS = 24

/**
 * A terminal dimension, or the fallback.
 *
 * The guard is `> 0`, not `?? `: a TTY may report **0** — `script(1)`, many pty
 * wrappers, and some CI runners all do — and `0 ?? 80` is `0`. Zero is not a
 * dimension; it means "this terminal will not say". (A zero width truncated
 * every line to nothing and collapsed the dashboard into a column of
 * ellipses; a zero height would clamp the whole build list away.)
 */
function dimension(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && value > 0 ? value : fallback
}

/**
 * The real terminal over a Node/Bun write stream.
 *
 * `isTTY` is `undefined` when stdout is a pipe or a file, so
 * `stream.isTTY === true` delivers "non-interactive output, including
 * redirected or piped output, automatically uses plain mode" for free — there
 * is no separate detection path to keep in sync.
 *
 * `columns` and `rows` are getters, not snapshots: a resized window is picked
 * up on the next frame without anyone subscribing to SIGWINCH.
 */
export function processTerminal(stream: NodeJS.WriteStream = process.stdout): TerminalOut {
  return {
    write: (chunk: string) => {
      stream.write(chunk)
    },
    get columns(): number {
      return dimension(stream.columns, FALLBACK_COLUMNS)
    },
    get rows(): number {
      return dimension(stream.rows, FALLBACK_ROWS)
    },
    interactive: stream.isTTY === true,
  }
}

interface Keypress {
  name?: string
  ctrl?: boolean
  meta?: boolean
  sequence?: string
}

/** A keyboard decoder holding the small amount of state a composer needs:
 * bracketed-paste accumulation and CSI reassembly. One per `start()`. */
export interface TerminalInputDecoder {
  press(text: string | undefined, key: Keypress): TerminalInputEvent | undefined
  /** Drop any partial paste, CSI run, or interrupt watch when the region tears down. */
  cleanup(): void
}

/**
 * Normalize readline's platform-dependent keypress shape without deciding what
 * printable characters mean. In particular, `m`, `p`, and `d` remain text
 * here: the dispatch controller maps them to commands only while no text input
 * is active, so they can be typed into blocked-build feedback.
 *
 * **CR submits, LF inserts a newline.** They arrive distinctly (`'return'`
 * versus `'enter'`), and Ctrl-J is literally LF - a newline binding that needs
 * no protocol negotiation and works in every terminal that runs the dashboard
 * today. Outside the resume prompt the controller treats `newline` exactly
 * like `enter`, so only the composer can tell the two apart.
 *
 * Two facts about Node/Bun's `emitKeypressEvents`, both probed rather than
 * recalled, shape the state this holds:
 *
 * - `key.name` for an unrecognized CSI is the literal STRING `'undefined'`.
 * - The parser gives up at the first `:` in a parameter list and during longer
 *   numeric parameters, emitting the partial sequence plus the remaining bytes
 *   as ordinary printable text. Lock-bearing arrows, associated text, and
 *   alternate-layout chords therefore all require reassembly.
 *
 * So a partial CSI opens a reassembly buffer and later fragments are appended
 * rather than delivered, which is what stops a Kitty Shift+Enter from
 * injecting `1u` into the operator's guidance.
 */
export function createTerminalInputDecoder(hooks: TerminalInputHooks = {}): TerminalInputDecoder {
  type CsiState = { buffer: string; digitRun: number; draining: boolean }
  let csi: CsiState | undefined
  let paste: string | undefined
  let watch: string | undefined

  const reportEvent = (report: CsiReport): TerminalInputEvent | undefined => {
    if (report.kind === 'input') return report.event
    if (report.kind === 'keyboard-flags') hooks.onKeyboardFlags?.(report.flags)
    if (report.kind === 'device-attributes') hooks.onDeviceAttributes?.()
    return undefined
  }

  /** Consume one parser fragment. `false` lets a malformed fragment reach the keymap. */
  const consumeCsi = (
    fragment: string,
    restart: boolean,
  ): { consumed: boolean; event?: TerminalInputEvent } => {
    if (restart) csi = { buffer: '\x1b[', digitRun: 0, draining: false }
    if (csi === undefined) return { consumed: false }
    const payload = restart ? fragment.slice(2) : fragment

    for (let index = 0; index < payload.length; index += 1) {
      const ch = payload[index] ?? ''
      if (isCsiParameterByte(ch)) {
        if (ch >= '0' && ch <= '9') csi.digitRun += 1
        else csi.digitRun = 0
        if (csi.digitRun > MAX_CSI_PARAM_DIGITS) {
          csi.draining = true
          csi.buffer = ''
        } else if (!csi.draining) {
          csi.buffer += ch
        }
        continue
      }

      const code = ch.charCodeAt(0)
      const final = code >= 0x40 && code <= 0x7e
      if (final && index === payload.length - 1) {
        const completed = csi.draining ? undefined : csi.buffer + ch
        csi = undefined
        return {
          consumed: true,
          ...(completed === undefined ? {} : { event: reportEvent(decodeCsi(completed)) }),
        }
      }

      csi = undefined
      return { consumed: false }
    }
    return { consumed: true }
  }

  return {
    cleanup(): void {
      csi = undefined
      paste = undefined
      watch = undefined
    },
    press(text: string | undefined, key: Keypress): TerminalInputEvent | undefined {
      const fragment = key.sequence ?? text ?? ''
      // Interrupt FIRST in every state. The parallel watch never consumes a
      // byte; it only adds an interrupt, including inside bracketed paste. A
      // pasted literal CSI-u Ctrl-C therefore interrupts, matching the existing
      // and deliberate behavior of a literal ETX in a paste.
      if ((key.ctrl === true && key.name === 'c') || key.sequence === '\u0003') {
        csi = undefined
        paste = undefined
        watch = undefined
        return { type: 'interrupt' }
      }
      if (fragment.startsWith('\x1b[')) watch = fragment
      else if (watch !== undefined) watch += fragment
      if (watch !== undefined && watch.length > INTERRUPT_WATCH_MAX) watch = undefined
      if (watch !== undefined && endsCsi(watch)) {
        const completed = watch
        watch = undefined
        if (isInterruptSequence(completed)) {
          csi = undefined
          paste = undefined
          return { type: 'interrupt' }
        }
      }

      // Inside a bracketed paste every byte is content, so this precedes both
      // reassembly and the keymap. Line endings normalize to `\n` and other
      // control characters are dropped, but the text is never shortened.
      if (paste !== undefined) {
        if (key.name === 'paste-end') {
          const pasted = paste
            .replace(/\r\n?/gu, '\n')
            .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/gu, '')
          paste = undefined
          return { type: 'paste', text: pasted }
        }
        paste += fragment
        return undefined
      }
      if (key.name === 'paste-start') {
        csi = undefined
        paste = ''
        return undefined
      }

      const restart = fragment.startsWith('\x1b[')
      if (csi !== undefined || (key.name === 'undefined' && restart)) {
        const consumed = consumeCsi(fragment, restart)
        if (consumed.consumed) return consumed.event
      }

      if (key.name === 'up') return { type: 'up' }
      if (key.name === 'down') return { type: 'down' }
      if (key.name === 'left') return { type: 'left' }
      if (key.name === 'right') return { type: 'right' }
      if (key.name === 'home') return { type: 'home' }
      if (key.name === 'end') return { type: 'end' }
      if (key.name === 'return' || key.sequence === '\r') {
        return key.meta === true ? { type: 'newline' } : { type: 'enter' }
      }
      if (key.name === 'enter' || key.sequence === '\n') return { type: 'newline' }
      if (key.name === 'backspace' || key.sequence === '\b' || key.sequence === '\u007f') {
        return { type: 'backspace' }
      }
      if (key.name === 'escape' || key.sequence === '\u001b') return { type: 'escape' }

      if (key.ctrl === true || key.meta === true) return undefined
      const printable =
        text ??
        (key.name?.length === 1 ? key.name : key.sequence !== undefined ? key.sequence : undefined)
      if (
        printable === undefined ||
        printable.length === 0 ||
        /[\u0000-\u001f\u007f]/u.test(printable)
      ) {
        return undefined
      }
      return { type: 'text', text: printable }
    },
  }
}

/**
 * Production raw-input adapter. It activates only for a TTY with raw-mode
 * support, disables terminal echo through raw mode, and restores the stream's
 * prior raw/flow state on every idempotent cleanup path.
 */
export function processTerminalInput(stream: NodeJS.ReadStream = process.stdin): TerminalInput {
  return {
    start(onKey, hooks = {}): () => void {
      if (stream.isTTY !== true || typeof stream.setRawMode !== 'function') {
        return () => {}
      }

      const priorRaw = stream.isRaw === true
      const priorFlowing = stream.readableFlowing
      let cleaned = false
      // One decoder per activation: its paste and CSI state belongs to this
      // region's lifetime, and an unterminated paste dies with it.
      const decoder = createTerminalInputDecoder(hooks)
      const listener = (text: string | undefined, key: Keypress = {}): void => {
        const normalized = decoder.press(text, key)
        if (normalized !== undefined) onKey(normalized)
      }

      let listening = false
      const cleanup = (): void => {
        if (cleaned) return
        cleaned = true
        decoder.cleanup()
        if (listening) stream.removeListener('keypress', listener)
        try {
          stream.setRawMode(priorRaw)
        } finally {
          if (priorFlowing === true) stream.resume()
          else stream.pause()
        }
      }

      try {
        emitKeypressEvents(stream)
        stream.on('keypress', listener)
        listening = true
        stream.setRawMode(true)
        stream.resume()
        hooks.onListening?.()
        return cleanup
      } catch (error) {
        try {
          cleanup()
        } catch {
          // Preserve the activation error; cleanup was best-effort here.
        }
        throw error
      }
    },
  }
}
