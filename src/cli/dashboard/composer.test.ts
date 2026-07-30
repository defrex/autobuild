/**
 * The composer (src/cli/dashboard/composer.ts) — pure geometry and motion
 * arithmetic, tested with no terminal and no model.
 *
 * This is where off-by-one cursor bugs and escape-expansion bugs live, and
 * where the non-lossiness guarantees are PROVED: `wrapDisplay` keeps every
 * cell, `packAtomic` keeps every token whole, and `layoutComposer` keeps every
 * row within budget with the caret visible. The first two are asserted as
 * properties over a generated sweep rather than as a handful of examples,
 * because a hand-picked case is exactly what a width bug slips past.
 */
import { describe, expect, test } from 'bun:test'
import {
  clampCursor,
  composerBudget,
  deleteBefore,
  displayCells,
  displayText,
  insertText,
  layoutComposer,
  moveCursor,
  packAtomic,
  wrapDisplay,
  type ComposerMotion,
} from './composer'

/** Render a layout row with the caret inserted, the way `render.ts` does. */
function withCaret(row: string, column: number): string {
  return `${row.slice(0, column)}|${row.slice(column)}`
}

describe('displayCells: the shared primitive', () => {
  test('printable ASCII is one cell each; everything else is its escape', () => {
    expect(displayCells('ab')).toEqual(['a', 'b'])
    expect(displayCells('é').join('')).toBe('\\u{e9}')
    expect(displayCells('é')).toHaveLength(6)
  })

  test('newline contributes NO cells — callers own the row break', () => {
    expect(displayCells('a\nb')).toEqual(['a', 'b'])
  })

  test('other control characters are escaped, not dropped', () => {
    expect(displayCells('\t').join('')).toBe('\\u{9}')
  })
})

describe('wrapDisplay: prose is split, never truncated', () => {
  test('word packing matches the existing look', () => {
    expect(wrapDisplay('one two three four', 9)).toEqual(['one two', 'three', 'four'])
  })

  test('a token longer than the width SPLITS across rows — no ~, no lost cells', () => {
    const url = 'x'.repeat(80)
    const rows = wrapDisplay(`see ${url} now`, 40)
    expect(rows.join('')).not.toContain('~')
    expect(rows.join(' ').replace(/\s+/g, '')).toContain(url)
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(40)
  })

  test('a non-ASCII token at a width narrower than one escape still keeps every cell', () => {
    // `\u{e9}` is 6 cells; at width 3 it can only survive by splitting.
    const rows = wrapDisplay('éé', 3)
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(3)
    expect(rows.join('')).toBe(displayText('éé'))
  })

  test('embedded newlines start new rows, and a blank paragraph keeps its row', () => {
    expect(wrapDisplay('a\n\nb', 10)).toEqual(['a', '', 'b'])
    expect(wrapDisplay('a\r\nb', 10)).toEqual(['a', 'b'])
  })

  test('degenerate widths', () => {
    expect(wrapDisplay('abc', 0)).toEqual([])
    expect(wrapDisplay('abc', -1)).toEqual([])
    expect(wrapDisplay('abc', 1)).toEqual(['a', 'b', 'c'])
  })

  test('an indent wider than the row is dropped rather than starving the content', () => {
    expect(wrapDisplay('abc', 2, '    ')).toEqual(['ab', 'c'])
    expect(wrapDisplay('ab cd', 8, '  ')).toEqual(['  ab cd'])
  })

  test('PROPERTY: over a generated sweep, no row overflows and no cell is lost', () => {
    const inputs = [
      'short',
      'a bb ccc dddd eeeee',
      'supercalifragilistic',
      'café au lait',
      'ééééé',
      'mixed café and a-very-long-unbroken-token-here',
      'line one\nline two is longer\n\nlast',
      '',
      '   ',
    ]
    for (const input of inputs) {
      for (let width = 1; width <= 12; width += 1) {
        const rows = wrapDisplay(input, width)
        for (const row of rows) expect(row.length).toBeLessThanOrEqual(width)
        // Every display cell survives, in order, with whitespace normalized.
        const expected = input.split(/\r?\n/).map(displayText).join('').replace(/\s+/g, '')
        expect(rows.join('').replace(/\s+/g, '')).toBe(expected)
      }
    }
  })
})

describe('packAtomic: labels are kept whole or dropped', () => {
  test('a token wider than the row is ABSENT, not fragmented', () => {
    const rows = packAtomic(['ok', 'enormous-label', 'fine'], 8)
    expect(rows.join(' ')).not.toContain('enormous')
    expect(rows).toEqual(['ok  fine'])
  })

  test('the contrast with wrapDisplay on the same input', () => {
    const token = 'enormous-label'
    expect(packAtomic([token], 8)).toEqual([])
    expect(wrapDisplay(token, 8)).toEqual(['enormous', '-label'])
  })

  test('greedy packing respects the separator and never overflows', () => {
    const rows = packAtomic(['aaa', 'bbb', 'ccc'], 8)
    expect(rows).toEqual(['aaa  bbb', 'ccc'])
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(8)
  })

  test('degenerate widths', () => {
    expect(packAtomic(['a'], 0)).toEqual([])
    expect(packAtomic([], 10)).toEqual([])
  })
})

describe('layoutComposer: wrapping and cursor geometry', () => {
  test('a short value is one row with the cursor at its offset', () => {
    const layout = layoutComposer('hello', 3, 20)
    expect(layout.rows).toEqual(['hello'])
    expect(layout.cursorRow).toBe(0)
    expect(layout.cursorColumn).toBe(3)
  })

  test('soft wrap reserves the caret column: budget is width - 1', () => {
    expect(composerBudget(10)).toBe(9)
    const layout = layoutComposer('abcdefghijkl', 0, 10)
    expect(layout.rows).toEqual(['abcdefghi', 'jkl'])
  })

  test('a cursor at the end of a FULL soft-wrapped row stays on that row', () => {
    // Column `budget`, not column 0 of the next row — the reserved column is
    // what makes that legal, and it is why the field does not reflow as the
    // caret crosses a wrap.
    const layout = layoutComposer('abcdefghij', 9, 10)
    expect(layout.cursorRow).toBe(0)
    expect(layout.cursorColumn).toBe(9)
    expect(withCaret(layout.rows[0]!, layout.cursorColumn).length).toBe(10)
  })

  test('an embedded newline breaks the row and puts the caret at column 0', () => {
    const layout = layoutComposer('ab\ncd', 3, 20)
    expect(layout.rows).toEqual(['ab', 'cd'])
    expect(layout.cursorRow).toBe(1)
    expect(layout.cursorColumn).toBe(0)
  })

  test('a trailing newline leaves an empty last row the caret can sit on', () => {
    const layout = layoutComposer('ab\n', 3, 20)
    expect(layout.rows).toEqual(['ab', ''])
    expect(layout.cursorRow).toBe(1)
    expect(layout.cursorColumn).toBe(0)
  })

  test('an escaped code point SPLITS across a wrap rather than overflowing (f_14906a08)', () => {
    // `café` at width 6 wraps at budget 5: `\u{e9}` is 6 cells and cannot fit
    // one row, so it straddles. Letting one unit exceed the row was revision
    // 1's choice and it hid the caret.
    const layout = layoutComposer('café', 4, 6)
    for (const row of layout.rows) expect(row.length).toBeLessThanOrEqual(composerBudget(6))
    expect(layout.rows.join('')).toBe('caf\\u{e9}')
    expect(
      withCaret(layout.rows[layout.cursorRow]!, layout.cursorColumn).length,
    ).toBeLessThanOrEqual(6)
  })

  test('the cursor never lands inside a split escape', () => {
    const layout = layoutComposer('café', 3, 6)
    // Offset 3 is the boundary BEFORE `é`, so it is a cell boundary by
    // construction whatever the wrap did.
    expect(layout.rows[layout.cursorRow]!.slice(layout.cursorColumn)).not.toContain('u{')
  })

  test('width 1 and 2 still produce a visible caret', () => {
    for (const width of [1, 2]) {
      const layout = layoutComposer('abc', 2, width)
      for (const row of layout.rows) expect(row.length).toBeLessThanOrEqual(composerBudget(width))
      expect(layout.cursorRow).toBeLessThan(layout.rows.length)
    }
  })

  test('an out-of-range cursor clamps to the buffer', () => {
    expect(layoutComposer('abc', 99, 10).cursorColumn).toBe(3)
    expect(layoutComposer('abc', -5, 10).cursorColumn).toBe(0)
    expect(clampCursor('abc', 99)).toBe(3)
    expect(clampCursor('café', 4)).toBe(4)
  })

  test('PROPERTY: every rendered caret row fits its width, at every width', () => {
    const values = ['', 'abc', 'a\nb', 'café au lait', 'ééé', 'x'.repeat(30), 'a\n\nb\nc']
    for (const value of values) {
      const length = [...value].length
      for (let width = 1; width <= 10; width += 1) {
        for (let cursor = 0; cursor <= length; cursor += 1) {
          const layout = layoutComposer(value, cursor, width)
          for (const row of layout.rows) {
            expect(row.length).toBeLessThanOrEqual(composerBudget(width))
          }
          const row = layout.rows[layout.cursorRow]
          expect(row).toBeDefined()
          expect(layout.cursorColumn).toBeLessThanOrEqual(row!.length)
          const rendered = withCaret(row!, layout.cursorColumn)
          expect(rendered).toContain('|')
          expect(rendered.length).toBeLessThanOrEqual(Math.max(2, width))
        }
      }
    }
  })
})

describe('insertText / deleteBefore: code points, not code units', () => {
  test('text inserts AT the cursor and advances it', () => {
    expect(insertText('ac', 1, 'b')).toEqual({ value: 'abc', cursor: 2 })
    expect(insertText('', 0, 'hi')).toEqual({ value: 'hi', cursor: 2 })
  })

  test('a multi-line paste inserts wholly in one step', () => {
    expect(insertText('ad', 1, 'b\nc')).toEqual({ value: 'ab\ncd', cursor: 4 })
  })

  test('an astral code point counts as one', () => {
    const inserted = insertText('', 0, '😀')
    expect(inserted.cursor).toBe(1)
    expect(deleteBefore(inserted.value, inserted.cursor)).toEqual({ value: '', cursor: 0 })
  })

  test('backspace deletes before the cursor, and is inert at offset 0', () => {
    expect(deleteBefore('abc', 2)).toEqual({ value: 'ac', cursor: 1 })
    expect(deleteBefore('abc', 0)).toEqual({ value: 'abc', cursor: 0 })
  })

  test('an out-of-range cursor clamps rather than corrupting the value', () => {
    expect(insertText('ab', 99, 'c')).toEqual({ value: 'abc', cursor: 3 })
    expect(deleteBefore('ab', 99)).toEqual({ value: 'a', cursor: 1 })
  })
})

describe('moveCursor: motions over LOGICAL lines', () => {
  const value = 'alpha\nbb\n\nlast line'
  const lines = value.split('\n')
  const startOf = (index: number): number =>
    lines.slice(0, index).reduce((sum, line) => sum + line.length + 1, 0)

  const at = (motion: ComposerMotion, cursor: number): number => moveCursor(value, cursor, motion)

  test('left and right step one code point and clamp at both ends', () => {
    expect(at('left', 3)).toBe(2)
    expect(at('left', 0)).toBe(0)
    expect(at('right', 3)).toBe(4)
    expect(at('right', [...value].length)).toBe([...value].length)
  })

  test('left and right count code points, not code units', () => {
    expect(moveCursor('😀x', 1, 'left')).toBe(0)
    expect(moveCursor('😀x', 0, 'right')).toBe(1)
  })

  test('home and end are LOGICAL line bounds', () => {
    expect(at('home', startOf(1) + 1)).toBe(startOf(1))
    expect(at('end', startOf(1))).toBe(startOf(1) + lines[1]!.length)
    expect(at('home', 0)).toBe(0)
    expect(at('end', [...value].length)).toBe([...value].length)
  })

  test('up and down keep the column, clamped to a shorter target line', () => {
    // Column 4 on `alpha` has no counterpart on `bb`; it clamps to its end.
    expect(at('down', 4)).toBe(startOf(1) + 2)
    // And onto the empty line, which clamps to column 0.
    expect(at('down', startOf(1) + 1)).toBe(startOf(2))
    expect(at('up', startOf(3) + 4)).toBe(startOf(2))
  })

  test('up off the top goes to offset 0; down off the bottom goes to the end', () => {
    expect(at('up', 3)).toBe(0)
    expect(at('down', startOf(3) + 2)).toBe([...value].length)
  })

  test('a single-line buffer has nowhere vertical to go', () => {
    expect(moveCursor('one line', 4, 'up')).toBe(0)
    expect(moveCursor('one line', 4, 'down')).toBe(8)
  })
})
