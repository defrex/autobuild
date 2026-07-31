import { describe, expect, test } from 'bun:test'
import { cellWidth, graphemes } from './cells'
import {
  clampCursor,
  composerBudget,
  deleteBefore,
  displayText,
  insertText,
  layoutComposer,
  moveCursor,
  packAtomic,
  wrapDisplay,
  type ComposerMotion,
} from './composer'

describe('display-safe Unicode', () => {
  test('keeps readable clusters literal and escapes controls only', () => {
    expect(displayText('naïve — 日本語 ☕️ 🇺🇸 👨‍👩‍👧‍👦')).toBe('naïve — 日本語 ☕️ 🇺🇸 👨‍👩‍👧‍👦')
    expect(displayText('\t')).toBe('\\u{9}')
  })
})

describe('wrapDisplay', () => {
  test('packs words by cells and splits long tokens only between clusters', () => {
    expect(wrapDisplay('one two three four', 9)).toEqual(['one two', 'three', 'four'])
    const value = `a${'🇺🇸'}${'👨‍👩‍👧‍👦'}b`
    expect(wrapDisplay(value, 3)).toEqual([`a🇺🇸`, `👨‍👩‍👧‍👦b`])
  })

  test('CJK consumes two cells while combining and zero-width clusters stay attached', () => {
    expect(wrapDisplay('日本語', 4)).toEqual(['日本', '語'])
    expect(wrapDisplay(`e\u0301x\u200by`, 2)).toEqual([`e\u0301x\u200b`, 'y'])
    expect(wrapDisplay('界', 1)).toEqual([''])
  })

  test('preserves paragraphs, indentation, and long content', () => {
    expect(wrapDisplay('a\n\nb', 10)).toEqual(['a', '', 'b'])
    expect(wrapDisplay('abc', 2, '    ')).toEqual(['ab', 'c'])
    const rows = wrapDisplay(`see ${'x'.repeat(80)} now`, 40)
    expect(rows.join(' ')).not.toContain('~')
    expect(rows.join('').replaceAll(' ', '')).toContain('x'.repeat(80))
  })

  test('every row is cell-bounded over representative Unicode', () => {
    for (const value of [
      'short',
      'café au lait',
      '日本語日本語',
      '🇺🇸 flags 👨‍👩‍👧‍👦',
      'e\u0301\u200b',
    ]) {
      for (let width = 1; width <= 12; width += 1) {
        for (const row of wrapDisplay(value, width))
          expect(cellWidth(row)).toBeLessThanOrEqual(width)
      }
    }
  })
})

describe('packAtomic', () => {
  test('packs by cells and drops an over-wide token whole', () => {
    expect(packAtomic(['ok', 'enormous-label', '界'], 8)).toEqual(['ok  界'])
    expect(packAtomic(['🇺🇸', 'x'], 5)).toEqual(['🇺🇸  x'])
    expect(packAtomic(['界'], 1)).toEqual([])
  })
})

describe('layoutComposer', () => {
  test('reports separate UTF-16 and cell coordinates', () => {
    const value = 'a界🇺🇸b'
    const cursor = value.indexOf('b')
    const layout = layoutComposer(value, cursor, 20)
    expect(layout.rows).toEqual([value])
    expect(layout.cursorColumn).toBe(5)
    expect(layout.cursorOffset).toBe(cursor)
  })

  test('wraps whole clusters and keeps the caret on a valid boundary', () => {
    const value = `a🇺🇸👨‍👩‍👧‍👦b`
    const atFamily = value.indexOf('👨')
    const layout = layoutComposer(value, atFamily, 4) // three-cell content budget
    expect(layout.rows).toEqual(['a🇺🇸', '👨‍👩‍👧‍👦b'])
    expect(layout.cursorRow).toBe(0)
    expect(layout.cursorColumn).toBe(3)
    expect(layout.cursorOffset).toBe(layout.rows[0]!.length)
  })

  test('combining and zero-width text consume no extra geometry', () => {
    const layout = layoutComposer(`e\u0301\u200bx`, 'e\u0301\u200b'.length, 10)
    expect(layout.cursorColumn).toBe(1)
    expect(layout.cursorOffset).toBe('e\u0301\u200b'.length)
  })

  test('logical newlines create rows and impossible wide clusters are omitted whole', () => {
    expect(layoutComposer('ab\ncd', 3, 20).rows).toEqual(['ab', 'cd'])
    const narrow = layoutComposer('界', 0, 2) // one-cell content budget
    expect(narrow.rows).toEqual([''])
  })

  test('all rows and caret rows fit in display cells', () => {
    const values = ['', 'abc', 'a\nb', 'café', '日本語', '🇺🇸👨‍👩‍👧‍👦', 'e\u0301\u200bx']
    for (const value of values) {
      const boundaries = [0, ...graphemes(value).map((cluster) => cluster.end)]
      for (let width = 1; width <= 10; width += 1) {
        for (const cursor of boundaries) {
          const layout = layoutComposer(value, cursor, width)
          for (const row of layout.rows)
            expect(cellWidth(row)).toBeLessThanOrEqual(composerBudget(width))
          expect(layout.cursorColumn + 1).toBeLessThanOrEqual(Math.max(2, width))
        }
      }
    }
  })
})

describe('composer editing uses UTF-16 grapheme boundaries', () => {
  test('insertion and deletion preserve exact bytes', () => {
    const inserted = insertText('ab', 1, '🇺🇸e\u0301')
    expect(inserted.value).toBe('a🇺🇸e\u0301b')
    expect(inserted.cursor).toBe('a🇺🇸e\u0301'.length)
    expect(deleteBefore(inserted.value, inserted.cursor)).toEqual({
      value: 'a🇺🇸b',
      cursor: 'a🇺🇸'.length,
    })
    expect(deleteBefore('a🇺🇸b', 'a🇺🇸'.length)).toEqual({ value: 'ab', cursor: 1 })
  })

  test('insertion advances over a cluster formed with a following combining mark', () => {
    expect(insertText('\u0301', 0, 'a')).toEqual({ value: 'a\u0301', cursor: 2 })
  })

  test('arbitrary offsets clamp before a cluster rather than splitting it', () => {
    expect(clampCursor('a🇺🇸b', 3)).toBe(1)
    expect(insertText('a🇺🇸b', 3, 'x')).toEqual({ value: 'ax🇺🇸b', cursor: 2 })
  })
})

describe('moveCursor', () => {
  const value = 'alpha\n界🇺🇸\n\nlast'
  const at = (motion: ComposerMotion, cursor: number): number => moveCursor(value, cursor, motion)

  test('left/right move one grapheme and are inverse motions', () => {
    for (const cluster of graphemes(value)) {
      expect(at('right', cluster.start)).toBe(cluster.end)
      expect(at('left', cluster.end)).toBe(cluster.start)
    }
    expect(at('left', 0)).toBe(0)
    expect(at('right', value.length)).toBe(value.length)
  })

  test('home/end and vertical motion use logical grapheme columns', () => {
    const secondStart = value.indexOf('界')
    const flagEnd = secondStart + '界🇺🇸'.length
    expect(at('home', flagEnd)).toBe(secondStart)
    expect(at('end', secondStart)).toBe(flagEnd)
    expect(at('down', 2)).toBe(flagEnd)
    expect(at('up', secondStart + '界'.length)).toBe(1)
  })
})
