import { describe, expect, test } from 'bun:test'
import { parseFrame, parseFrameLine } from './frame-parse'

describe('parseFrameLine', () => {
  test('pins styled runs to terminal cells and strips every escape from the text', () => {
    const line = parseFrameLine(
      ' \x1b[1mAutobuild\x1b[0m  \x1b[32mintake ON\x1b[0m \x1b]8;;https://example.invalid/pr/1\x07PR\x1b]8;;\x07',
      1,
    )

    expect(line.text).toBe(' Autobuild  intake ON PR')
    expect(line.cells).toBe(24)
    expect(line.runs).toEqual([
      {
        column: 0,
        cells: 1,
        text: ' ',
        style: { foreground: 'foreground', bold: false, dim: false },
      },
      {
        column: 1,
        cells: 9,
        text: 'Autobuild',
        style: { foreground: 'foreground', bold: true, dim: false },
      },
      {
        column: 10,
        cells: 2,
        text: '  ',
        style: { foreground: 'foreground', bold: false, dim: false },
      },
      {
        column: 12,
        cells: 9,
        text: 'intake ON',
        style: { foreground: 'green', bold: false, dim: false },
      },
      {
        column: 21,
        cells: 1,
        text: ' ',
        style: { foreground: 'foreground', bold: false, dim: false },
      },
      {
        column: 22,
        cells: 2,
        text: 'PR',
        style: {
          foreground: 'foreground',
          bold: false,
          dim: false,
          href: 'https://example.invalid/pr/1',
        },
      },
    ])
  })

  test('nested bold and colour read as one run, and dim is its own flag', () => {
    const line = parseFrameLine('\x1b[1m\x1b[36m[>] plan\x1b[0m\x1b[0m \x1b[2m[ ] review\x1b[0m', 3)
    expect(
      line.runs.map((run) => [run.text, run.style.foreground, run.style.bold, run.style.dim]),
    ).toEqual([
      ['[>] plan', 'cyan', true, false],
      [' ', 'foreground', false, false],
      ['[ ] review', 'foreground', false, true],
    ])
  })

  test('refuses anything outside the dashboard vocabulary, naming the line', () => {
    expect(() => parseFrameLine('\x1b[35mmagenta\x1b[0m', 7)).toThrow(
      'line 7: unsupported SGR code 35',
    )
    expect(() => parseFrameLine('tab\there', 2)).toThrow('line 2: unsupported control U+0009')
    expect(() => parseFrameLine('\x1b[31mleaked', 4)).toThrow('line 4: SGR style was not reset')
    expect(() => parseFrameLine('\x1b]8;;https://x\x07open', 5)).toThrow(
      'line 5: OSC 8 hyperlink was not closed',
    )
    expect(() => parseFrameLine('\x1b[2J', 6)).toThrow(
      'line 6: unsupported or unterminated CSI sequence',
    )
    expect(() => parseFrameLine('\x1bP', 8)).toThrow('line 8: unsupported escape family "P"')
  })
})

describe('parseFrame', () => {
  test('holds every line to the declared width and rejects an empty frame', () => {
    expect(parseFrame(['ab', 'c'], 2).map((line) => line.text)).toEqual(['ab', 'c'])
    expect(() => parseFrame(['too wide'], 3)).toThrow(
      'line 1 is 8 cells wide, exceeding declared terminal width 3',
    )
    expect(() => parseFrame([], 80)).toThrow('dashboard frame is empty')
    expect(() => parseFrame(['x'], 0)).toThrow('columns must be a positive integer')
  })
})
