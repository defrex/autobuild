/** Unicode text geometry shared by every dashboard compositor. */

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export interface Grapheme {
  /** Exact source bytes represented by this cluster. */
  text: string
  /** UTF-16 boundaries, suitable for String.prototype.slice. */
  start: number
  end: number
  /** Terminal display-cell width. */
  width: number
}

/** Segment a string into indivisible extended grapheme clusters. */
export function graphemes(value: string): Grapheme[] {
  return [...SEGMENTER.segment(value)].map(({ segment, index }) => ({
    text: segment,
    start: index,
    end: index + segment.length,
    width: Bun.stringWidth(segment),
  }))
}

function isTerminalControl(code: number): boolean {
  return code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)
}

/**
 * Preserve readable Unicode while making terminal control characters visible.
 * This is display-only: callers retain and submit the original value.
 */
export function displayText(value: string): string {
  let displayed = ''
  for (const character of value) {
    const code = character.codePointAt(0)!
    displayed += isTerminalControl(code) ? `\\u{${code.toString(16)}}` : character
  }
  return displayed
}

/** Display-safe clusters, with widths measured after controls are escaped. */
export function displayGraphemes(value: string): Grapheme[] {
  return graphemes(displayText(value))
}

/** Width in terminal display cells. Input must not contain ANSI sequences. */
export function cellWidth(value: string): number {
  return graphemes(value).reduce((sum, cluster) => sum + cluster.width, 0)
}

/** Pad to a terminal-cell width without trimming an over-wide value. */
export function padEndCells(value: string, width: number): string {
  return `${value}${' '.repeat(Math.max(0, width - cellWidth(value)))}`
}

/**
 * Return the longest whole-cluster prefix that fits. A cluster wider than the
 * complete budget is omitted rather than fragmented or allowed to overflow.
 */
export function fitCells(value: string, width: number): string {
  if (width <= 0) return ''
  let result = ''
  let used = 0
  for (const cluster of graphemes(value)) {
    if (cluster.width > width) continue
    if (used + cluster.width > width) break
    result += cluster.text
    used += cluster.width
  }
  return result
}

/** Split into cell-bounded rows without splitting a grapheme cluster. */
export function splitCells(value: string, width: number): string[] {
  if (width <= 0) return []
  const rows: string[] = []
  let row = ''
  let used = 0
  for (const cluster of graphemes(value)) {
    // At an impossible width, omission is safer than a partial cluster or an
    // overflowing physical terminal row.
    if (cluster.width > width) continue
    if (cluster.width > 0 && used + cluster.width > width) {
      rows.push(row)
      row = ''
      used = 0
    }
    row += cluster.text
    used += cluster.width
  }
  if (row !== '' || rows.length === 0) rows.push(row)
  return rows
}

/** Normalize an arbitrary UTF-16 offset to the preceding grapheme boundary. */
export function graphemeBoundary(value: string, offset: number): number {
  if (!Number.isFinite(offset)) return value.length
  const wanted = Math.max(0, Math.min(value.length, Math.floor(offset)))
  let boundary = 0
  for (const cluster of graphemes(value)) {
    if (cluster.end > wanted) return cluster.start
    boundary = cluster.end
  }
  return boundary
}
