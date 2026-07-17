/**
 * The live region: the one impure piece of the dashboard, and the only thing
 * here that touches the writer.
 *
 * The job is narrow — keep a block of lines repainted in place at the bottom
 * of the screen, and never let it accumulate. Everything interesting about it
 * is a consequence of one invariant:
 *
 *   >>> The region is always the LAST thing on screen. <<<
 *
 * which is why `log()` exists: a diagnostic printed straight to the stream
 * would land in the middle of a frame we are about to cursor-up over, and the
 * next repaint would eat it. So a line erases the region, prints, and repaints
 * — messages scroll cleanly ABOVE a dashboard that never moves.
 */
import type { TerminalOut } from '../terminal'

const CURSOR_UP = (n: number): string => `\x1b[${n}A`
/** Clear from the cursor to the end of the screen. */
const CLEAR_TO_END = '\x1b[0J'
const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'

/**
 * How many lines a region may paint on a `rows`-row screen: **one fewer than
 * the screen has**.
 *
 * `update` terminates EVERY line with `\n`, the last one included, so after
 * painting N lines the cursor rests on a fresh row BELOW the frame — and that
 * row has to exist. At N === rows the final newline scrolls the frame's top
 * line away before `erase()` ever runs; `CURSOR_UP(N)` then clamps at the top
 * margin, so the header is gone and a copy lands in scrollback on every
 * repaint. N === rows is the one height that cannot be painted.
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
  private hidden = false
  private finished = false

  constructor(private readonly term: TerminalOut) {}

  /**
   * Repaint the region in place.
   *
   * Skipped entirely when the lines are identical to the last frame: the frame
   * is a pure function of build state, so "refreshes as displayed build state
   * changes" falls out of this check — and a poll that finds nothing new costs
   * zero writes and zero flicker.
   */
  update(lines: string[]): void {
    if (this.finished) return
    if (sameFrame(this.painted, lines)) return
    if (!this.hidden) {
      this.term.write(HIDE_CURSOR)
      this.hidden = true
    }
    this.erase()
    this.term.write(lines.map((line) => `${line}\n`).join(''))
    this.painted = [...lines]
  }

  /**
   * Erase the region → hand `line` to the CALLER's sink → repaint.
   *
   * The sink is a parameter, not `this.term`, on purpose: a stderr diagnostic
   * must stay on stderr. The region changes WHEN a line is written (around an
   * erase/repaint), never WHICH stream it goes to. If stderr is redirected
   * while stdout is a TTY, the erase/repaint still applies to stdout and the
   * message still lands in the file — no corruption on either path.
   */
  log(line: string, write: (line: string) => void): void {
    if (this.finished) {
      write(line)
      return
    }
    const frame = this.painted
    this.erase()
    this.painted = []
    write(line)
    this.update(frame)
  }

  /**
   * Release the region: LEAVE the last frame painted, restore the cursor, stop
   * tracking. Idempotent.
   *
   * It deliberately does not erase. The final frame is the answer the operator
   * ran the command for — `git log` and a finished progress bar both leave
   * their output on screen, and erasing it would make the exit render pointless
   * work. Dropping the tracking state is what makes that safe: nothing will
   * later cursor-up over lines the region no longer owns.
   */
  finish(): void {
    if (this.finished) return
    this.finished = true
    if (this.hidden) {
      this.term.write(SHOW_CURSOR)
      this.hidden = false
    }
    this.painted = []
  }

  /** Cursor-up over the painted rows and clear to the end of the screen. Used
   * by `update` and `log` and nothing else — the region's only erasure. */
  private erase(): void {
    if (this.painted.length === 0) return
    this.term.write(CURSOR_UP(this.painted.length) + CLEAR_TO_END)
  }
}

function sameFrame(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i])
}
