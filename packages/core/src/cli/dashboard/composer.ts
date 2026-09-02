/** Pure Unicode-aware text geometry for the dashboard's editable field. */
import {
  cellWidth,
  displayGraphemes,
  displayText,
  graphemeBoundary,
  graphemes,
  splitCells,
} from './cells'

export { displayText } from './cells'

/** Wrap prose in terminal cells without splitting a grapheme cluster. */
export function wrapDisplay(value: string, width: number, indent = ''): string[] {
  if (width <= 0) return []
  const pad = cellWidth(indent) < width ? indent : ''
  const budget = width - cellWidth(pad)
  const rows: string[] = []

  for (const paragraph of value.split(/\r?\n/)) {
    const paragraphStart = rows.length
    const tokens = displayText(paragraph)
      .split(/\s+/u)
      .filter((token) => token !== '')
    if (tokens.length === 0) {
      rows.push(pad)
      continue
    }

    let line = ''
    let used = 0
    for (const token of tokens) {
      const tokenWidth = cellWidth(token)
      if (line !== '' && used + 1 + tokenWidth <= budget) {
        line += ` ${token}`
        used += 1 + tokenWidth
        continue
      }
      if (line !== '') {
        rows.push(`${pad}${line}`)
        line = ''
        used = 0
      }
      if (tokenWidth <= budget) {
        line = token
        used = tokenWidth
        continue
      }
      const pieces = splitCells(token, budget)
      for (const piece of pieces.slice(0, -1)) rows.push(`${pad}${piece}`)
      line = pieces.at(-1) ?? ''
      used = cellWidth(line)
    }
    if (line !== '') rows.push(`${pad}${line}`)
    else if (rows.length === paragraphStart) rows.push(pad)
  }
  return rows
}

/** Pack labels atomically, dropping a label that cannot fit one row. */
export function packAtomic(tokens: string[], width: number, separator = '  '): string[] {
  if (width <= 0) return []
  const rows: string[] = []
  let line = ''
  for (const token of tokens) {
    if (cellWidth(token) > width) continue
    if (line === '') {
      line = token
      continue
    }
    const candidate = `${line}${separator}${token}`
    if (cellWidth(candidate) <= width) line = candidate
    else {
      rows.push(line)
      line = token
    }
  }
  if (line !== '') rows.push(line)
  return rows
}

export interface ComposerLayout {
  rows: string[]
  cursorRow: number
  /** Caret column in terminal display cells. */
  cursorColumn: number
  /** UTF-16 insertion offset within cursorRow. */
  cursorOffset: number
}

export function composerBudget(width: number): number {
  return Math.max(1, width - 1)
}

/** Wrap the original value and map a UTF-16 grapheme boundary to its caret. */
export function layoutComposer(value: string, cursor: number, width: number): ComposerLayout {
  const budget = composerBudget(width)
  const rows: string[] = []
  const positions = new Map<number, { row: number; column: number; offset: number }>()
  let current = ''
  let used = 0
  positions.set(0, { row: 0, column: 0, offset: 0 })

  for (const source of graphemes(value)) {
    positions.set(source.start, { row: rows.length, column: used, offset: current.length })
    if (source.text === '\n') {
      rows.push(current)
      current = ''
      used = 0
      positions.set(source.end, { row: rows.length, column: 0, offset: 0 })
      continue
    }

    for (const displayed of displayGraphemes(source.text)) {
      if (displayed.width > budget) continue
      if (displayed.width > 0 && used + displayed.width > budget) {
        rows.push(current)
        current = ''
        used = 0
      }
      current += displayed.text
      used += displayed.width
    }
    positions.set(source.end, {
      row: rows.length,
      column: used,
      offset: current.length,
    })
  }
  rows.push(current)
  const normalized = clampCursor(value, cursor)
  const at = positions.get(normalized) ?? {
    row: rows.length - 1,
    column: used,
    offset: current.length,
  }
  return {
    rows,
    cursorRow: at.row,
    cursorColumn: at.column,
    cursorOffset: at.offset,
  }
}

/** Clamp to a UTF-16 offset that is also a whole-grapheme boundary. */
export function clampCursor(value: string, cursor: number): number {
  return graphemeBoundary(value, cursor)
}

export function insertText(
  value: string,
  cursor: number,
  text: string,
): { value: string; cursor: number } {
  const at = clampCursor(value, cursor)
  const next = `${value.slice(0, at)}${text}${value.slice(at)}`
  const wanted = at + text.length
  // Insertion can combine with a following mark and erase the exact boundary
  // that used to follow the inserted bytes. In that case advance over the
  // newly formed cluster rather than jumping the caret back before it.
  const combined = graphemes(next).find((cluster) => cluster.start < wanted && wanted < cluster.end)
  return { value: next, cursor: combined?.end ?? graphemeBoundary(next, wanted) }
}

export function deleteBefore(value: string, cursor: number): { value: string; cursor: number } {
  const at = clampCursor(value, cursor)
  if (at === 0) return { value, cursor: 0 }
  const previous = graphemes(value).findLast((cluster) => cluster.end <= at)
  if (previous === undefined) return { value, cursor: 0 }
  return {
    value: `${value.slice(0, previous.start)}${value.slice(at)}`,
    cursor: previous.start,
  }
}

export type ComposerMotion = 'left' | 'right' | 'up' | 'down' | 'home' | 'end'

interface LogicalLine {
  start: number
  end: number
  /** UTF-16 boundaries by grapheme column, including both line ends. */
  boundaries: number[]
}

function logicalLines(value: string): LogicalLine[] {
  const lines: LogicalLine[] = []
  let start = 0
  let boundaries = [0]
  for (const cluster of graphemes(value)) {
    if (cluster.text === '\n') {
      lines.push({ start, end: cluster.start, boundaries })
      start = cluster.end
      boundaries = [start]
    } else {
      boundaries.push(cluster.end)
    }
  }
  lines.push({ start, end: value.length, boundaries })
  return lines
}

export function moveCursor(value: string, cursor: number, motion: ComposerMotion): number {
  const clusters = graphemes(value)
  const at = clampCursor(value, cursor)
  const lines = logicalLines(value)
  const lineIndex = lines.findLastIndex((line) => line.start <= at)
  const line = lines[lineIndex]!
  const column = Math.max(0, line.boundaries.indexOf(at))

  switch (motion) {
    case 'left':
      return clusters.findLast((cluster) => cluster.end <= at)?.start ?? 0
    case 'right':
      return clusters.find((cluster) => cluster.start >= at)?.end ?? value.length
    case 'home':
      return line.start
    case 'end':
      return line.end
    case 'up': {
      if (lineIndex === 0) return 0
      const target = lines[lineIndex - 1]!
      return target.boundaries[Math.min(column, target.boundaries.length - 1)]!
    }
    case 'down': {
      if (lineIndex === lines.length - 1) return value.length
      const target = lines[lineIndex + 1]!
      return target.boundaries[Math.min(column, target.boundaries.length - 1)]!
    }
  }
}
