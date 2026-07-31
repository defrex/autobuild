/**
 * Text geometry for the dashboard's one editable field.
 *
 * A cursor over wrapped, escaped, multi-line text is arithmetic: map a
 * code-point offset to a display row and column, and map a motion back to an
 * offset. `render.ts` should not grow an editor and `dispatch.ts` must not grow
 * terminal geometry, but both need the same rules — so they live here, pure,
 * ANSI-free, `string` in and `string` out. No knowledge of width beyond the
 * argument, and not one escape byte emitted.
 *
 * Everything below is defined against ONE primitive: **a string becomes a
 * sequence of display cells, and rows are slices of that sequence**
 * (`displayCells`). That is what makes "no row exceeds its width" a single
 * proof rather than three.
 */

/** Keep the renderer's one-physical-row ASCII/width invariant while retaining
 * exact process state. Non-ASCII and control characters (including newlines)
 * are displayed as code-point escapes; the model value is never rewritten. */
export function displayText(value: string): string {
  let displayed = ''
  for (const char of value) {
    const code = char.codePointAt(0)!
    displayed += code >= 0x20 && code <= 0x7e ? char : `\\u{${code.toString(16)}}`
  }
  return displayed
}

/**
 * One entry per DISPLAY CELL — the shared primitive.
 *
 * Each code point contributes its `displayText` cells: a printable ASCII
 * character is one cell (itself), everything else is the several cells of
 * `\u{hex}`. `\n` contributes NO cells; callers that care about line structure
 * split on it first and treat it as a row break.
 */
export function displayCells(value: string): string[] {
  const cells: string[] = []
  for (const char of value) {
    if (char === '\n') continue
    for (const cell of displayText(char)) cells.push(cell)
  }
  return cells
}

/**
 * Wrap prose to `width` cells WITHOUT ever losing a cell.
 *
 * The non-truncating sibling of `render.ts`'s `wrappedText`. It packs
 * whitespace-separated tokens greedily like `packLines`, but a single token
 * whose cells exceed the row budget is SPLIT ACROSS ROWS rather than
 * truncated with a `~`.
 *
 * Which one to reach for:
 * - `wrapDisplay` (here) — operator-facing prose that must survive in full:
 *   an escalation question, the resume panel's hint.
 * - `packAtomic` (below) — short labels that must stay readable: an oversized
 *   one is dropped whole, never fragmented.
 * - `render.ts`'s `wrappedText`/`packLines` — the legacy build/harvest rows,
 *   where a `~` on a status token beats a reflowed row. Unchanged on purpose:
 *   every existing frame depends on its exact output.
 *
 * Guarantees: every returned row's length is `<= width`, and concatenating the
 * rows (minus indents) reproduces every display cell of the input in order,
 * with runs of whitespace normalized to one space.
 */
export function wrapDisplay(value: string, width: number, indent = ''): string[] {
  if (width <= 0) return []
  // An indent at least as wide as the row would leave no budget for content;
  // dropping it keeps the cell guarantee rather than emitting empty rows.
  const pad = indent.length < width ? indent : ''
  const budget = width - pad.length
  const rows: string[] = []
  for (const paragraph of value.split(/\r?\n/)) {
    const tokens = displayText(paragraph)
      .split(/\s+/)
      .filter((token) => token.length > 0)
    if (tokens.length === 0) {
      rows.push(pad)
      continue
    }
    let line = ''
    for (const token of tokens) {
      if (line !== '' && line.length + 1 + token.length <= budget) {
        line = `${line} ${token}`
        continue
      }
      if (line !== '') {
        rows.push(`${pad}${line}`)
        line = ''
      }
      let rest = token
      while (rest.length > budget) {
        rows.push(`${pad}${rest.slice(0, budget)}`)
        rest = rest.slice(budget)
      }
      line = rest
    }
    if (line !== '') rows.push(`${pad}${line}`)
  }
  return rows
}

/**
 * Greedily pack tokens onto shared rows of at most `width` cells, each token
 * ATOMIC: a token wider than the row is DROPPED rather than split or
 * truncated.
 *
 * That is the contrast with `wrapDisplay`, and it is stated at the primitive
 * rather than only at the caller: prose is split, labels are never. A partial
 * label ("Ctrl-J new") misnames the binding it exists to name, so a row that
 * cannot hold one is better without it.
 */
export function packAtomic(tokens: string[], width: number, separator = '  '): string[] {
  if (width <= 0) return []
  const rows: string[] = []
  let line = ''
  for (const token of tokens) {
    if (token.length > width) continue
    if (line === '') {
      line = token
      continue
    }
    const candidate = `${line}${separator}${token}`
    if (candidate.length <= width) {
      line = candidate
      continue
    }
    rows.push(line)
    line = token
  }
  if (line !== '') rows.push(line)
  return rows
}

export interface ComposerLayout {
  /** Wrapped rows, each at most `max(1, width - 1)` cells. No caret: the
   * caller inserts it, because only the caller knows how to paint it. */
  rows: string[]
  cursorRow: number
  cursorColumn: number
}

/** The cell budget a field of `width` columns wraps at. The spare column is
 * reserved for the inserted caret, which is what stops the field reflowing as
 * the cursor moves: inserting the caret can push a row's last cell to column
 * `width` and no further. */
export function composerBudget(width: number): number {
  return Math.max(1, width - 1)
}

/**
 * Wrap `value` into rows and resolve `cursor` (a CODE-POINT offset) to a
 * `(row, column)` on them.
 *
 * The wrapping unit is the display cell, not the code point, so a code point's
 * cells may straddle a row boundary — `café` in a 6-column field splits
 * `\u{e9}` across rows rather than producing an over-wide row. Every row is
 * within budget by construction, for every input, at every width. One escape
 * reading across a wrap is the accepted cost; a caret pushed off the row is
 * not.
 *
 * Because the cursor is a code-point offset it always lands on a boundary
 * BETWEEN code points, so it can never fall inside a split escape. A cursor at
 * the end of a full soft-wrapped row renders at column `budget` of that row
 * rather than column 0 of the next — the reserved column is what makes that
 * legal.
 */
export function layoutComposer(value: string, cursor: number, width: number): ComposerLayout {
  const budget = composerBudget(width)
  const points = [...value]
  const rows: string[] = []
  // `positions[i]` is where the boundary BEFORE code point `i` renders;
  // `positions[points.length]` is the end of the buffer.
  const positions: Array<{ row: number; column: number }> = [{ row: 0, column: 0 }]
  let current = ''
  for (const char of points) {
    if (char === '\n') {
      rows.push(current)
      current = ''
      positions.push({ row: rows.length, column: 0 })
      continue
    }
    for (const cell of displayText(char)) {
      if (current.length === budget) {
        rows.push(current)
        current = ''
      }
      current += cell
    }
    positions.push({ row: rows.length, column: current.length })
  }
  rows.push(current)
  const at = positions[clampCursor(value, cursor)]!
  return { rows, cursorRow: at.row, cursorColumn: at.column }
}

export function clampCursor(value: string, cursor: number): number {
  const length = [...value].length
  if (!Number.isFinite(cursor)) return length
  return Math.max(0, Math.min(length, Math.floor(cursor)))
}

export function insertText(
  value: string,
  cursor: number,
  text: string,
): { value: string; cursor: number } {
  const points = [...value]
  const at = clampCursor(value, cursor)
  const inserted = [...text]
  return {
    value: [...points.slice(0, at), ...inserted, ...points.slice(at)].join(''),
    cursor: at + inserted.length,
  }
}

export function deleteBefore(value: string, cursor: number): { value: string; cursor: number } {
  const points = [...value]
  const at = clampCursor(value, cursor)
  if (at === 0) return { value, cursor: 0 }
  return {
    value: [...points.slice(0, at - 1), ...points.slice(at)].join(''),
    cursor: at - 1,
  }
}

export type ComposerMotion = 'left' | 'right' | 'up' | 'down' | 'home' | 'end'

interface LogicalLine {
  /** Code-point offset of the line's first character. */
  start: number
  /** Code-point count, excluding the terminating newline. */
  length: number
}

/** Split into LOGICAL lines (the buffer's own `\n`s), which is what Up/Down and
 * Home/End move over. Soft wraps are display geometry and deliberately do not
 * participate: the operator's line structure is what survives submission. */
function logicalLines(points: string[]): LogicalLine[] {
  const lines: LogicalLine[] = []
  let start = 0
  for (const [index, char] of points.entries()) {
    if (char !== '\n') continue
    lines.push({ start, length: index - start })
    start = index + 1
  }
  lines.push({ start, length: points.length - start })
  return lines
}

export function moveCursor(value: string, cursor: number, motion: ComposerMotion): number {
  const points = [...value]
  const at = clampCursor(value, cursor)
  const lines = logicalLines(points)
  const index = lines.findLastIndex((line) => line.start <= at)
  const line = lines[index]!
  const column = at - line.start
  switch (motion) {
    case 'left':
      return Math.max(0, at - 1)
    case 'right':
      return Math.min(points.length, at + 1)
    case 'home':
      return line.start
    case 'end':
      return line.start + line.length
    case 'up': {
      // Off the top is the start of the buffer, matching every line editor:
      // the motion still does something rather than silently no-op'ing.
      if (index === 0) return 0
      const target = lines[index - 1]!
      return target.start + Math.min(column, target.length)
    }
    case 'down': {
      if (index === lines.length - 1) return points.length
      const target = lines[index + 1]!
      return target.start + Math.min(column, target.length)
    }
  }
}
