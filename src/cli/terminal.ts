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

export interface TerminalOut {
  /** Raw write — no newline appended (unlike the line-oriented stdout dep). */
  write(chunk: string): void
  /** Terminal width in columns; a sane fallback when unknown. */
  columns: number
  /** Terminal height in rows; a sane fallback when unknown. The live region
   * repaints by cursoring UP over the rows it painted, which only works while
   * those rows are still on screen — so a frame taller than this is not a
   * cosmetic problem, it is an unpaintable one. */
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
