import { emitKeypressEvents } from 'node:readline'

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

/** Injectable keyboard seam. Starting returns an idempotent cleanup. */
export interface TerminalInput {
  start(onInput: (input: TerminalInputEvent) => void): () => void
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

/**
 * Lock modifiers in the CSI-u / `modifyOtherKeys` modifier bitfield.
 *
 * Per Kitty's keyboard-protocol reference the parameter is `1 + bitfield` over
 * `shift 1, alt 2, ctrl 4, super 8, hyper 16, meta 32, caps_lock 64,
 * num_lock 128`, and the LOCK bits ARE reported for every key once "report all
 * keys as escape codes" is on - which is exactly the mode that makes Return
 * arrive as CSI-u in the first place. So an unmodified Enter with caps lock on
 * is `ESC[13;65u`, and with num lock on `ESC[13;129u`.
 *
 * That is why the decision below MASKS rather than compares. A `mod >= 2` test
 * reads correct and would make Enter insert a line break instead of submitting
 * for every operator with a lock key engaged - invisible to anyone reading the
 * arithmetic cold. xterm's `modifyOtherKeys` parameter is also `1 + bitfield`
 * but defines only bits 1-8, so the same mask is a no-op there and one decoder
 * serves both. Treat any change to this comparison as requiring a re-read of
 * the protocol reference, not a reasoned edit.
 */
const MODIFIER_LOCK_MASK = 0b1100_0000

/** A malformed or unsupported CSI run is abandoned past this many characters.
 * Bounded in practice by the parser itself: every ASCII letter is a CSI final
 * byte, so only a run of digits and `;:<=>?` can extend a buffer at all. */
const CSI_MAX = 32

/** CSI sequences end at a byte in 0x40-0x7E. The leading `ESC[` never counts:
 * `[` is 0x5B and would otherwise terminate every sequence at birth. */
function endsCsi(sequence: string): boolean {
  if (sequence.length <= 2) return false
  const code = sequence.charCodeAt(sequence.length - 1)
  return code >= 0x40 && code <= 0x7e
}

/** Decode a `1 + bitfield` modifier parameter into submit-versus-newline. */
function modifiedReturn(mod: number | undefined): TerminalInputEvent {
  if (mod === undefined) return { type: 'enter' }
  const bits = Math.max(0, mod - 1)
  return (bits & ~MODIFIER_LOCK_MASK) === 0 ? { type: 'enter' } : { type: 'newline' }
}

function parseParam(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Interpret ONE complete CSI sequence - a Return disambiguator, not a second
 * keymap. Only key code 13 is acted on; every other report yields `undefined`,
 * so the named-key normalization stays authoritative.
 *
 * Two encodings reach us: Kitty's
 * `ESC[<key>[:<alt>][;<mod>[:<event>]][;<text>]u`, and xterm's
 * `modifyOtherKeys` `ESC[27;<mod>;<key>~`. The dashboard does not REQUEST
 * either - that would be scope this change does not ask for - but a terminal
 * already configured for one must have its Return decoded rather than injected
 * as text.
 */
export function interpretCsi(sequence: string): TerminalInputEvent | undefined {
  if (!sequence.startsWith('\u001b[') || !endsCsi(sequence)) return undefined
  const final = sequence.at(-1)
  const params = sequence.slice(2, -1).split(';')
  if (final === 'u') {
    if (parseParam(params[0]?.split(':')[0]) !== 13) return undefined
    const [modRaw, eventRaw] = (params[1] ?? '').split(':')
    // Event 1 is a press and 2 a repeat; 3 is a RELEASE and is not a
    // keystroke - emitting it would double every Shift+Enter. Absent is press.
    const event = parseParam(eventRaw) ?? 1
    if (event !== 1 && event !== 2) return undefined
    return modifiedReturn(parseParam(modRaw))
  }
  if (final === '~') {
    if (params[0] !== '27' || parseParam(params[2]) !== 13) return undefined
    return modifiedReturn(parseParam(params[1]))
  }
  return undefined
}

/** A keyboard decoder holding the small amount of state a composer needs:
 * bracketed-paste accumulation and CSI reassembly. One per `start()`. */
export interface TerminalInputDecoder {
  press(text: string | undefined, key: Keypress): TerminalInputEvent | undefined
  /** Drop any partial paste or CSI run when the region tears down. */
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
 * - The parser gives up at the first `:` in a parameter list, and at a
 *   two-digit parameter, emitting the partial sequence plus the remaining
 *   bytes as ordinary printable text. `ESC[13;2:1u` arrives as THREE events
 *   and `ESC[13;65u` as two.
 *
 * So a partial CSI opens a reassembly buffer and later fragments are appended
 * rather than delivered, which is what stops a Kitty Shift+Enter from
 * injecting `1u` into the operator's guidance.
 */
export function createTerminalInputDecoder(): TerminalInputDecoder {
  let csi: string | undefined
  let paste: string | undefined

  return {
    cleanup(): void {
      csi = undefined
      paste = undefined
    },
    press(text: string | undefined, key: Keypress): TerminalInputEvent | undefined {
      // Interrupt FIRST, always. Ctrl-C arrives mid-fragment as a plain
      // `\u0003`, which is not a CSI final byte and would otherwise be
      // swallowed into the reassembly buffer. Quitting must never depend on
      // the terminal's keyboard protocol.
      if ((key.ctrl === true && key.name === 'c') || key.sequence === '\u0003') {
        csi = undefined
        paste = undefined
        return { type: 'interrupt' }
      }

      // Inside a bracketed paste every byte is content, so this precedes both
      // reassembly and the keymap. Line endings normalize to `\n` and other
      // control characters are dropped, but the text is never SHORTENED and
      // there is no size cap: the buffer must hold what the operator pasted.
      if (paste !== undefined) {
        if (key.name === 'paste-end') {
          // Normalize ONCE, over the whole accumulation: a CRLF arrives as two
          // separate keypresses, so per-event normalization would turn one line
          // break into two.
          const pasted = paste
            .replace(/\r\n?/gu, '\n')
            .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/gu, '')
          paste = undefined
          return { type: 'paste', text: pasted }
        }
        paste += key.sequence ?? text ?? ''
        return undefined
      }
      if (key.name === 'paste-start') {
        csi = undefined
        paste = ''
        return undefined
      }

      if (csi !== undefined) {
        csi += key.sequence ?? text ?? ''
        if (endsCsi(csi)) {
          const completed = csi
          csi = undefined
          return interpretCsi(completed)
        }
        if (csi.length > CSI_MAX) csi = undefined
        // The fragment is CONSUMED either way - never emitted as text, which
        // is what keeps a stray `1u` out of the guidance buffer. Discarding an
        // abandoned run discards CONTROL traffic, categorically unlike the
        // operator content a paste carries.
        return undefined
      }

      if (key.name === 'up') return { type: 'up' }
      if (key.name === 'down') return { type: 'down' }
      if (key.name === 'left') return { type: 'left' }
      if (key.name === 'right') return { type: 'right' }
      if (key.name === 'home') return { type: 'home' }
      if (key.name === 'end') return { type: 'end' }
      // Meta+Return is Alt+Enter, and is also what a terminal configured to
      // send "Shift+Enter" emits (`ESC` `CR`).
      if (key.name === 'return' || key.sequence === '\r') {
        return key.meta === true ? { type: 'newline' } : { type: 'enter' }
      }
      if (key.name === 'enter' || key.sequence === '\n') return { type: 'newline' }
      if (key.name === 'backspace' || key.sequence === '\b' || key.sequence === '\u007f') {
        return { type: 'backspace' }
      }
      if (key.name === 'escape' || key.sequence === '\u001b') {
        return { type: 'escape' }
      }

      // An unrecognized CSI: a complete one is interpreted now, a partial one
      // opens the reassembly buffer.
      if (key.name === 'undefined' && key.sequence?.startsWith('\u001b[') === true) {
        if (endsCsi(key.sequence)) return interpretCsi(key.sequence)
        csi = key.sequence
        return undefined
      }

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
    start(onKey): () => void {
      if (stream.isTTY !== true || typeof stream.setRawMode !== 'function') {
        return () => {}
      }

      const priorRaw = stream.isRaw === true
      const priorFlowing = stream.readableFlowing
      let cleaned = false
      // One decoder per activation: its paste and CSI state belongs to this
      // region's lifetime, and an unterminated paste dies with it.
      const decoder = createTerminalInputDecoder()
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
