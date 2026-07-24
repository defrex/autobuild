/**
 * The live region (src/cli/dashboard/live.ts) over a fake TerminalOut, so the
 * escape traffic itself is the assertion.
 */
import { describe, expect, test } from 'bun:test'
import { LiveRegion, paintableRows } from './live'
import type { TerminalOut } from '../terminal'

interface FakeTerm extends TerminalOut {
  writes: string[]
  all(): string
}

function fakeTerm(rows = 24): FakeTerm {
  const writes: string[] = []
  return {
    writes,
    all: () => writes.join(''),
    write: (chunk) => {
      writes.push(chunk)
    },
    columns: 80,
    rows,
    interactive: true,
  }
}

const ENTER_ALTERNATE_SCREEN = '\x1b[?1049h'
const LEAVE_ALTERNATE_SCREEN = '\x1b[?1049l'
const CLEAR_DISPLAY = '\x1b[2J'
const CURSOR_POSITION = (row: number): string => `\x1b[${row};1H`
const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'
const frame = (lines: string[]): string => lines.map((line) => `${line}\n`).join('')

describe('paintableRows: the frame needs one row fewer than the screen', () => {
  // `update` terminates EVERY line with `\n`, the last one included, so after
  // painting N lines the cursor rests on a fresh row BELOW the frame, and that
  // row has to exist. At N === rows the final newline scrolls the frame's top
  // line away even on a freshly cleared alternate display.
  //
  // This file's fake CANNOT observe that — it appends to an array, so nothing
  // ever scrolls. Neither can render.test.ts, which counts lines and knows
  // nothing of the trailing newline. The rule is therefore asserted here,
  // next to the newline that causes it.

  test('one fewer than the screen', () => {
    expect(paintableRows(24)).toBe(23)
    expect(paintableRows(50)).toBe(49)
    expect(paintableRows(2)).toBe(1)
  })

  test('a 1-row screen has NO paintable height — the honest answer is nothing', () => {
    expect(paintableRows(1)).toBe(0)
  })

  test('never negative, whatever the terminal claims', () => {
    expect(paintableRows(0)).toBe(0)
    expect(paintableRows(-5)).toBe(0)
  })

  test('update() really does terminate every line — the reason for the -1', () => {
    const term = fakeTerm()
    new LiveRegion(term).update(['a', 'b', 'c'])
    expect(term.writes.at(-1)).toBe('a\nb\nc\n')
  })

  test('a maximum-paintable frame starts at row 1 and keeps the spare row below it', () => {
    const rows = 5
    const term = fakeTerm(rows)
    const lines = Array.from({ length: paintableRows(rows) }, (_, i) => `line-${i}`)

    new LiveRegion(term).update(lines)

    expect(lines).toHaveLength(rows - 1)
    expect(term.writes).toEqual([
      ENTER_ALTERNATE_SCREEN,
      HIDE_CURSOR,
      CLEAR_DISPLAY + CURSOR_POSITION(1),
      frame(lines),
    ])
  })
})

describe('LiveRegion: alternate-screen replacement', () => {
  test('the first frame enters before clearing and anchors at the top', () => {
    const term = fakeTerm(24)
    new LiveRegion(term).update(['one', 'two'])

    expect(term.writes).toEqual([
      ENTER_ALTERNATE_SCREEN,
      HIDE_CURSOR,
      CLEAR_DISPLAY + CURSOR_POSITION(1),
      'one\ntwo\n',
    ])
  })

  test('a changed frame clears the whole display and ignores the old line count', () => {
    const term = fakeTerm(24)
    const region = new LiveRegion(term)
    region.update(['a', 'b', 'c'])
    const before = term.writes.length

    region.update(['x'])

    expect(term.writes.slice(before)).toEqual([CLEAR_DISPLAY + CURSOR_POSITION(1), 'x\n'])
  })

  test('an initial empty frame is inert', () => {
    const term = fakeTerm(1)
    const region = new LiveRegion(term)
    region.update([])
    term.rows = 2
    region.update([])
    expect(term.writes).toEqual([])
  })
})

describe('LiveRegion: terminal resize', () => {
  test('shrink and grow both clear and repaint at row 1', () => {
    const term = fakeTerm(8)
    const region = new LiveRegion(term)
    const tall = ['summary', 'toggles', 'warning', '', 'row', '', 'controls']
    region.update(tall)

    // Shrink below the seven-line frame that was actually painted. The next
    // render is already capped for the new screen, and its repaint must not
    // depend on how much of the old frame survived the resize.
    term.rows = 4
    const shrunk = ['summary', 'toggles', 'controls']
    let before = term.writes.length
    region.update(shrunk)
    expect(term.writes.slice(before)).toEqual([CLEAR_DISPLAY + CURSOR_POSITION(1), frame(shrunk)])

    // An ordinary changed repaint is likewise a whole-display replacement.
    const changed = ['summary', 'changed']
    before = term.writes.length
    region.update(changed)
    expect(term.writes.slice(before)).toEqual([CLEAR_DISPLAY + CURSOR_POSITION(1), frame(changed)])

    // Equal frame and equal height remains the zero-write fast path, including
    // after the shrink.
    before = term.writes.length
    region.update(changed)
    region.update(changed)
    expect(term.writes.length).toBe(before)

    // Height is part of paint identity: the same frame after a grow is cleared
    // and repainted at its stable row-1 origin on the very next update.
    term.rows = 9
    before = term.writes.length
    region.update(changed)
    expect(term.writes.slice(before)).toEqual([CLEAR_DISPLAY + CURSOR_POSITION(1), frame(changed)])

    before = term.writes.length
    region.update(changed)
    expect(term.writes.length).toBe(before)
  })
})

describe('LiveRegion: an identical frame writes nothing', () => {
  test('a repeat update at the same height is a no-op', () => {
    const term = fakeTerm()
    const region = new LiveRegion(term)
    region.update(['one', 'two'])
    const before = term.writes.length
    region.update(['one', 'two'])
    region.update(['one', 'two'])
    expect(term.writes.length).toBe(before)
  })
})

describe('LiveRegion: finish() leaves the last frame on the normal screen', () => {
  test('leaves alternate screen before copying the frame and restoring the cursor', () => {
    const term = fakeTerm()
    const region = new LiveRegion(term)
    region.update(['final-frame'])
    const before = term.writes.length

    region.finish()

    const teardown = term.writes.slice(before)
    expect(teardown).toEqual([LEAVE_ALTERNATE_SCREEN, 'final-frame\n', SHOW_CURSOR])
    expect(teardown.join('')).not.toContain(CLEAR_DISPLAY)
  })

  test('finish() on an unpainted region leaves no escapes at all', () => {
    const term = fakeTerm()
    new LiveRegion(term).finish()
    expect(term.all()).toBe('')
  })

  test('finish() is idempotent and ignores late updates', () => {
    const term = fakeTerm()
    const region = new LiveRegion(term)
    region.update(['final-frame'])
    region.finish()
    region.finish()
    const before = term.writes.length

    region.update(['late'])
    expect(term.writes.length).toBe(before)
  })
})
