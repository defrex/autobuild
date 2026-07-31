import { describe, expect, test } from 'bun:test'
import { cellWidth, displayText, graphemeBoundary, graphemes, splitCells } from './cells'

describe('dashboard Unicode cell geometry', () => {
  test.each([
    ['precomposed accent', 'é', 1],
    ['combining accent', 'e\u0301', 1],
    ['em dash', '—', 1],
    ['zero-width space', '\u200b', 0],
    ['wide CJK', '界', 2],
    ['variation-selector emoji', '☕️', 2],
    ['regional-indicator flag', '🇺🇸', 2],
    ['ZWJ family', '👨‍👩‍👧‍👦', 2],
  ] as const)('%s occupies the expected terminal cells', (_name, value, width) => {
    expect(cellWidth(value)).toBe(width)
    expect(graphemes(value)).toHaveLength(1)
  })

  test('readable Unicode is literal while terminal controls are escaped', () => {
    expect(displayText('naïve — “界” ☕️')).toBe('naïve — “界” ☕️')
    expect(displayText('a\tb\x1bc')).toBe('a\\u{9}b\\u{1b}c')
  })

  test('splitCells keeps combining and fitting wide graphemes whole', () => {
    const flag = '🇺🇸'
    const family = '👨‍👩‍👧‍👦'
    expect(splitCells(`e\u0301x`, 1)).toEqual([`e\u0301`, 'x'])
    expect(splitCells(`a${flag}${family}b`, 3)).toEqual([`a${flag}`, `${family}b`])
  })

  test('splitCells omits an impossible middle cluster and resumes later clusters', () => {
    expect(splitCells('a界b', 1)).toEqual(['a', 'b'])
    expect(splitCells('🇺🇸', 1)).toEqual([''])
  })

  test('UTF-16 offsets normalize to whole-grapheme boundaries', () => {
    const value = `a🇺🇸${'e\u0301'}z`
    expect(graphemeBoundary(value, 3)).toBe(1)
    expect(graphemeBoundary(value, 5)).toBe(5)
    expect(graphemeBoundary(value, 6)).toBe(5)
    expect(graphemeBoundary(value, value.length)).toBe(value.length)
  })
})
