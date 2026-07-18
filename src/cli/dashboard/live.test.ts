/**
 * The live region (src/cli/dashboard/live.ts) over a fake TerminalOut, so the
 * escape traffic itself is the assertion.
 */
import { describe, expect, test } from 'bun:test'
import { LiveRegion, paintableRows } from './live'
import type { TerminalOut } from '../terminal'

function fakeTerm(): TerminalOut & { writes: string[]; all: () => string } {
  const writes: string[] = []
  return {
    writes,
    all: () => writes.join(''),
    write: (chunk) => {
      writes.push(chunk)
    },
    columns: 80,
    rows: 24,
    interactive: true,
  }
}

const CURSOR_UP = (n: number): string => `\x1b[${n}A`
const CLEAR_TO_END = '\x1b[0J'

describe('paintableRows: the frame needs one row fewer than the screen', () => {
  // f_c9449563 — `update` terminates EVERY line with `\n`, the last one
  // included, so after painting N lines the cursor rests on a fresh row BELOW
  // the frame, and that row has to exist. At N === rows the final newline
  // scrolls the frame's top line away before erase() ever runs, and CURSOR_UP
  // then clamps at the top margin: the header is gone and a copy lands in
  // scrollback on every repaint.
  //
  // This file's fake CANNOT observe that — it appends to an array, so nothing
  // ever scrolls. Neither can render.test.ts, which counts lines and knows
  // nothing of the trailing newline. So the rule is asserted as a rule here,
  // next to the newline that causes it, and the end-to-end consequence is
  // asserted at the dispatch seam that owns both (dispatch.test.ts).

  test('one fewer than the screen', () => {
    expect(paintableRows(24)).toBe(23)
    expect(paintableRows(50)).toBe(49)
    expect(paintableRows(2)).toBe(1)
  })

  test('a 1-row screen has NO paintable height — the honest answer is nothing', () => {
    // A single line there would scroll itself off behind its own newline.
    expect(paintableRows(1)).toBe(0)
  })

  test('never negative, whatever the terminal claims', () => {
    expect(paintableRows(0)).toBe(0)
    expect(paintableRows(-5)).toBe(0)
  })

  test('update() really does terminate every line — the reason for the -1', () => {
    // Pin the convention the rule depends on: if this ever stops being true,
    // `paintableRows` is wrong and this test says so.
    const term = fakeTerm()
    new LiveRegion(term).update(['a', 'b', 'c'])
    const painted = term.writes.find((w) => w.includes('a'))
    expect(painted).toBe('a\nb\nc\n') // trailing newline on the LAST line too
  })
})

describe('LiveRegion: the region does not accumulate', () => {
  test('a changed frame erases the previous one before repainting', () => {
    const term = fakeTerm()
    const region = new LiveRegion(term)
    region.update(['one', 'two'])
    const before = term.all()
    expect(before).toContain('one\ntwo\n')

    region.update(['one', 'three'])
    const added = term.all().slice(before.length)
    // Two lines painted ⇒ cursor up two, clear to end, then repaint.
    expect(added).toContain(CURSOR_UP(2) + CLEAR_TO_END)
    expect(added).toContain('one\nthree\n')
  })

  test('the erase counts the LINES ACTUALLY PAINTED, not the new frame', () => {
    const term = fakeTerm()
    const region = new LiveRegion(term)
    region.update(['a', 'b', 'c'])
    const before = term.all().length
    region.update(['x'])
    expect(term.all().slice(before)).toContain(CURSOR_UP(3))
  })

  test('the first frame has nothing to erase', () => {
    const term = fakeTerm()
    new LiveRegion(term).update(['one'])
    expect(term.all()).not.toContain('\x1b[0A')
    expect(term.all()).not.toContain(CLEAR_TO_END)
  })
})

describe('LiveRegion: an identical frame writes nothing', () => {
  test('a repeat update is a no-op — the frame is a pure function of state', () => {
    const term = fakeTerm()
    const region = new LiveRegion(term)
    region.update(['one', 'two'])
    const before = term.writes.length
    region.update(['one', 'two'])
    region.update(['one', 'two'])
    expect(term.writes.length).toBe(before)
  })
})

describe('LiveRegion: the cursor', () => {
  test('hidden on the first paint, restored by finish()', () => {
    const term = fakeTerm()
    const region = new LiveRegion(term)
    region.update(['frame'])
    expect(term.all()).toContain('\x1b[?25l')
    region.finish()
    expect(term.all()).toContain('\x1b[?25h')
  })

  test('finish() on an unpainted region leaves no escapes at all', () => {
    const term = fakeTerm()
    new LiveRegion(term).finish()
    expect(term.all()).toBe('')
  })
})

describe('LiveRegion: finish() leaves the last frame on screen', () => {
  test('the final frame stays painted, with no erase after it', () => {
    // The last frame is the answer the operator ran the command for — `git log`
    // and a finished progress bar both leave their output up. Erasing it would
    // make the exit render pointless work.
    const term = fakeTerm()
    const region = new LiveRegion(term)
    region.update(['final-frame'])
    const beforeFinish = term.all().length

    region.finish()

    const after = term.all().slice(beforeFinish)
    expect(after).not.toContain(CLEAR_TO_END)
    expect(after).not.toContain('\x1b[1A')
    expect(term.all()).toContain('final-frame\n')
  })

  test('finish() is idempotent and stops tracking — nothing cursors up afterwards', () => {
    const term = fakeTerm()
    const region = new LiveRegion(term)
    region.update(['final-frame'])
    region.finish()
    region.finish()
    const before = term.all().length

    // A late update must not cursor-up over lines the region no longer owns.
    region.update(['late'])
    expect(term.all().length).toBe(before)
  })
})
