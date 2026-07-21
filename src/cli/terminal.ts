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
  | { type: 'enter' }
  | { type: 'backspace' }
  | { type: 'escape' }
  | { type: 'interrupt' }
  | { type: 'text'; text: string }

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

/** Normalize readline's platform-dependent keypress shape without deciding
 * what printable characters mean. In particular, `m`, `p`, and `d` remain
 * text here: the dispatch controller maps them to commands only while no text
 * input is active, so they can be typed into blocked-build feedback. */
function dashboardInput(
  text: string | undefined,
  key: Keypress,
): TerminalInputEvent | undefined {
  if ((key.ctrl === true && key.name === 'c') || key.sequence === '\u0003') {
    return { type: 'interrupt' }
  }
  if (key.name === 'up') return { type: 'up' }
  if (key.name === 'down') return { type: 'down' }
  if (
    key.name === 'return' ||
    key.name === 'enter' ||
    key.sequence === '\r' ||
    key.sequence === '\n'
  ) {
    return { type: 'enter' }
  }
  if (
    key.name === 'backspace' ||
    key.sequence === '\b' ||
    key.sequence === '\u007f'
  ) {
    return { type: 'backspace' }
  }
  if (key.name === 'escape' || key.sequence === '\u001b') {
    return { type: 'escape' }
  }
  if (key.ctrl === true || key.meta === true) return undefined

  const printable =
    text ??
    (key.name?.length === 1
      ? key.name
      : key.sequence !== undefined
        ? key.sequence
        : undefined)
  if (
    printable === undefined ||
    printable.length === 0 ||
    /[\u0000-\u001f\u007f]/u.test(printable)
  ) {
    return undefined
  }
  return { type: 'text', text: printable }
}

/**
 * Production raw-input adapter. It activates only for a TTY with raw-mode
 * support, disables terminal echo through raw mode, and restores the stream's
 * prior raw/flow state on every idempotent cleanup path.
 */
export function processTerminalInput(
  stream: NodeJS.ReadStream = process.stdin,
): TerminalInput {
  return {
    start(onKey): () => void {
      if (stream.isTTY !== true || typeof stream.setRawMode !== 'function') {
        return () => {}
      }

      const priorRaw = stream.isRaw === true
      const priorFlowing = stream.readableFlowing
      let cleaned = false
      const listener = (text: string | undefined, key: Keypress = {}): void => {
        const normalized = dashboardInput(text, key)
        if (normalized !== undefined) onKey(normalized)
      }

      let listening = false
      const cleanup = (): void => {
        if (cleaned) return
        cleaned = true
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
