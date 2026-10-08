import { graphemes } from './cells'

/**
 * Deterministic parsing of a rendered dashboard frame.
 *
 * The dashboard deliberately emits a tiny terminal vocabulary: SGR reset,
 * bold/dim and six named foreground colours, plus OSC 8 hyperlinks. This
 * parser accepts exactly that vocabulary and nothing else. Unknown control
 * traffic is an error rather than evidence that merely looks plausible after
 * bytes were dropped. Every rendition of a frame — the PNG evidence, the
 * website's HTML — derives from these same exact cells.
 */

const ESC = '\x1b'
const BEL = '\x07'

export type Foreground = 'foreground' | 'red' | 'green' | 'yellow' | 'blue' | 'cyan'

export interface FrameStyle {
  foreground: Foreground
  bold: boolean
  dim: boolean
  href?: string
}

export interface FrameRun {
  /** Zero-based terminal cell column the run starts at. */
  column: number
  /** Terminal cells the run occupies. */
  cells: number
  text: string
  style: FrameStyle
}

export interface ParsedFrameLine {
  /** The line with every escape removed. */
  text: string
  /** Terminal cells the whole line occupies. */
  cells: number
  runs: FrameRun[]
}

function cloneStyle(style: FrameStyle): FrameStyle {
  return {
    foreground: style.foreground,
    bold: style.bold,
    dim: style.dim,
    ...(style.href !== undefined ? { href: style.href } : {}),
  }
}

function sameStyle(left: FrameStyle, right: FrameStyle): boolean {
  return (
    left.foreground === right.foreground &&
    left.bold === right.bold &&
    left.dim === right.dim &&
    left.href === right.href
  )
}

function applySgr(style: FrameStyle, raw: string, line: number): void {
  const codes = raw === '' ? [0] : raw.split(';').map((part) => Number(part))
  if (codes.some((code) => !Number.isInteger(code))) {
    throw new Error(`dashboard frame line ${line}: malformed SGR sequence ESC[${raw}m`)
  }
  for (const code of codes) {
    switch (code) {
      case 0:
        style.foreground = 'foreground'
        style.bold = false
        style.dim = false
        break
      case 1:
        style.bold = true
        break
      case 2:
        style.dim = true
        break
      case 22:
        style.bold = false
        style.dim = false
        break
      case 31:
        style.foreground = 'red'
        break
      case 32:
        style.foreground = 'green'
        break
      case 33:
        style.foreground = 'yellow'
        break
      case 34:
        style.foreground = 'blue'
        break
      case 36:
        style.foreground = 'cyan'
        break
      case 39:
        style.foreground = 'foreground'
        break
      default:
        throw new Error(`dashboard frame line ${line}: unsupported SGR code ${code} in ESC[${raw}m`)
    }
  }
}

/** Parse one rendered line into styled runs pinned to their terminal cells.
 * `lineNumber` is one-based and only names the line in errors. */
export function parseFrameLine(value: string, lineNumber: number): ParsedFrameLine {
  const style: FrameStyle = {
    foreground: 'foreground',
    bold: false,
    dim: false,
  }
  const runs: FrameRun[] = []
  let text = ''
  let cells = 0

  const append = (cluster: string, width: number): void => {
    const previous = runs.at(-1)
    // ASCII runs may coalesce. Unicode clusters stay independently pinned to
    // their terminal cell columns so font fallback/advance cannot shift the
    // run that follows a wide glyph.
    if (
      previous !== undefined &&
      previous.column + previous.cells === cells &&
      /^[\x20-\x7e]*$/.test(previous.text) &&
      /^[\x20-\x7e]$/.test(cluster) &&
      sameStyle(previous.style, style)
    ) {
      previous.text += cluster
      previous.cells += width
    } else {
      runs.push({ column: cells, cells: width, text: cluster, style: cloneStyle(style) })
    }
    text += cluster
    cells += width
  }

  for (let index = 0; index < value.length; ) {
    if (value[index] === ESC) {
      const family = value[index + 1]
      if (family === '[') {
        const rest = value.slice(index + 2)
        const match = /^([0-9;]*)m/.exec(rest)
        if (match === null) {
          throw new Error(
            `dashboard frame line ${lineNumber}: unsupported or unterminated CSI sequence`,
          )
        }
        applySgr(style, match[1]!, lineNumber)
        index += 2 + match[0].length
        continue
      }
      if (family === ']') {
        const end = value.indexOf(BEL, index + 2)
        if (end === -1) {
          throw new Error(`dashboard frame line ${lineNumber}: unterminated OSC sequence`)
        }
        const payload = value.slice(index + 2, end)
        const match = /^8;;(.*)$/.exec(payload)
        if (match === null) {
          throw new Error(
            `dashboard frame line ${lineNumber}: unsupported OSC sequence ${JSON.stringify(payload)}`,
          )
        }
        const href = match[1]!
        style.href = href === '' ? undefined : href
        index = end + 1
        continue
      }
      throw new Error(
        `dashboard frame line ${lineNumber}: unsupported escape family ${JSON.stringify(family ?? '')}`,
      )
    }

    const nextEscape = value.indexOf(ESC, index)
    const stop = nextEscape === -1 ? value.length : nextEscape
    const plain = value.slice(index, stop)
    for (const character of plain) {
      const code = character.codePointAt(0)!
      if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
        throw new Error(
          `dashboard frame line ${lineNumber}: unsupported control U+${code
            .toString(16)
            .toUpperCase()
            .padStart(4, '0')}`,
        )
      }
    }
    for (const cluster of graphemes(plain)) append(cluster.text, cluster.width)
    index = stop
  }

  if (style.href !== undefined) {
    throw new Error(`dashboard frame line ${lineNumber}: OSC 8 hyperlink was not closed`)
  }
  if (style.foreground !== 'foreground' || style.bold || style.dim) {
    throw new Error(
      `dashboard frame line ${lineNumber}: SGR style was not reset before end of line`,
    )
  }
  return { text, cells, runs }
}

/** Parse a whole frame, holding every line to the declared terminal width. */
export function parseFrame(lines: readonly string[], columns: number): ParsedFrameLine[] {
  if (!Number.isInteger(columns) || columns <= 0) {
    throw new Error(`dashboard frame columns must be a positive integer, got ${columns}`)
  }
  if (lines.length === 0) {
    throw new Error('dashboard frame is empty')
  }
  const parsed = lines.map((line, index) => parseFrameLine(line, index + 1))
  for (const [index, line] of parsed.entries()) {
    if (line.cells > columns) {
      throw new Error(
        `dashboard frame line ${index + 1} is ${line.cells} cells wide, exceeding declared terminal width ${columns}`,
      )
    }
  }
  return parsed
}
