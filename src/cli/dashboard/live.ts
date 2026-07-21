/**
 * The live region: the one impure piece of the dashboard, and the only thing
 * here that touches the writer.
 *
 * The job is narrow — keep a block of lines repainted in place from the top
 * of the screen, and never let it accumulate. Everything interesting about it
 * is a consequence of one invariant:
 *
 *   >>> The region's first line is always terminal row 1. <<<
 *
 * Dispatcher messages are part of the frame's reserved status row, so this
 * seam owns only in-place replacement and cursor restoration. Nothing may
 * print through it into dashboard scrollback.
 */
import type { TerminalOut } from '../terminal'

const ENTER_ALTERNATE_SCREEN = '\x1b[?1049h'
const LEAVE_ALTERNATE_SCREEN = '\x1b[?1049l'
/** Clear the entire active display. */
const CLEAR_DISPLAY = '\x1b[2J'
const CURSOR_POSITION = (row: number): string => `\x1b[${row};1H`
const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'

/**
 * How many lines a region may paint on a `rows`-row screen: **one fewer than
 * the screen has**.
 *
 * `update` terminates EVERY line with `\n`, the last one included, so after
 * painting N lines the cursor rests on a fresh row BELOW the frame — and that
 * row has to exist. At N === rows the final newline scrolls the frame's top
 * line away even when painting a freshly cleared alternate screen. N === rows
 * is therefore the one height that cannot be painted.
 *
 * This lives here, next to the newline that causes it, because no other seam
 * can see it: `render.ts` counts lines and knows nothing of the trailing
 * newline, and a fake `TerminalOut` collects strings and knows nothing of
 * scrolling. The invariant is `frame.length < term.rows`, and it is only
 * observable where a real region meets a real screen.
 *
 * 0 for a 1-row screen: there is no paintable height, and the honest answer is
 * to paint nothing rather than a header that scrolls itself off.
 */
export function paintableRows(rows: number): number {
  return Math.max(0, rows - 1)
}

export class LiveRegion {
  /** The frame currently painted — `[]` when the region is empty. Also the
   * identical-frame check's comparand. */
  private painted: string[] = []
  /** Terminal height at the last paint; a resize invalidates equality. */
  private paintedRows: number | undefined
  private alternate = false
  private hidden = false
  private finished = false

  constructor(private readonly term: TerminalOut) {}

  /**
   * Repaint the region in place.
   *
   * Each effective paint replaces the whole alternate display and anchors the
   * frame at row 1, so its header stays fixed as the frame grows, shrinks, or
   * crosses a resize. Equal lines at equal height cost zero writes and zero
   * flicker; a resize invalidates the paint even when the lines are unchanged.
   */
  update(lines: string[]): void {
    if (this.finished) return

    const rows = this.term.rows
    // An empty initial render (for example, a one-row terminal) is not a real
    // paint and must not switch screens merely to display nothing.
    if (!this.alternate && lines.length === 0) return
    if (this.paintedRows === rows && sameFrame(this.painted, lines)) return

    if (!this.alternate) {
      this.term.write(ENTER_ALTERNATE_SCREEN)
      this.alternate = true
      this.term.write(HIDE_CURSOR)
      this.hidden = true
    }

    this.term.write(CLEAR_DISPLAY + CURSOR_POSITION(1))
    const frame = lines.map((line) => `${line}\n`).join('')
    if (frame.length > 0) this.term.write(frame)
    this.painted = [...lines]
    this.paintedRows = rows
  }

  /**
   * Release the region: restore the normal screen, copy the last frame there,
   * restore the cursor, and stop tracking. Idempotent.
   *
   * The copy preserves the existing external contract: the final frame is the
   * answer the operator ran the command for, just as `git log` and a finished
   * progress bar leave their output on screen. The normal display is never
   * erased during teardown.
   */
  finish(): void {
    if (this.finished) return
    this.finished = true

    if (this.alternate) {
      this.term.write(LEAVE_ALTERNATE_SCREEN)
      this.alternate = false
      const frame = this.painted.map((line) => `${line}\n`).join('')
      if (frame.length > 0) this.term.write(frame)
    }
    if (this.hidden) {
      this.term.write(SHOW_CURSOR)
      this.hidden = false
    }
    this.painted = []
    this.paintedRows = undefined
  }
}

function sameFrame(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i])
}
