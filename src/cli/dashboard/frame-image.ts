import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'

/**
 * Deterministic dashboard-frame rendering.
 *
 * The dashboard deliberately emits a tiny terminal vocabulary: SGR reset,
 * bold/dim and six named foreground colours, plus OSC 8 hyperlinks. This
 * adapter accepts exactly that vocabulary. Unknown control traffic is an
 * error rather than evidence that merely looks plausible after bytes were
 * dropped.
 */

const ESC = '\x1b'
const BEL = '\x07'
const FONT_FAMILY = 'DejaVu Sans Mono'
const FONT_SIZE = 16
const CELL_WIDTH = 10
const LINE_HEIGHT = 20
const PADDING_X = 12
const PADDING_Y = 10
const BASELINE = 16

const PALETTE = {
  background: '#0d1117',
  foreground: '#c9d1d9',
  red: '#ff7b72',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  cyan: '#39c5cf',
} as const

type Foreground = Exclude<keyof typeof PALETTE, 'background'>

interface Style {
  foreground: Foreground
  bold: boolean
  dim: boolean
  href?: string
}

interface TextRun {
  column: number
  text: string
  style: Style
}

interface ParsedLine {
  text: string
  cells: number
  runs: TextRun[]
}

export interface FrameImageOptions {
  /** Declared terminal width. Every parsed line must fit this grid. */
  columns: number
}

export interface RenderedFrameImage {
  /** ANSI/OSC-free text from the exact parsed cells, with a final newline. */
  text: string
  svg: string
  png: Uint8Array
  width: number
  height: number
  rows: number
  columns: number
}

function cloneStyle(style: Style): Style {
  return {
    foreground: style.foreground,
    bold: style.bold,
    dim: style.dim,
    ...(style.href !== undefined ? { href: style.href } : {}),
  }
}

function sameStyle(left: Style, right: Style): boolean {
  return (
    left.foreground === right.foreground &&
    left.bold === right.bold &&
    left.dim === right.dim &&
    left.href === right.href
  )
}

function applySgr(style: Style, raw: string, line: number): void {
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

function parseLine(value: string, lineNumber: number): ParsedLine {
  const style: Style = {
    foreground: 'foreground',
    bold: false,
    dim: false,
  }
  const runs: TextRun[] = []
  let text = ''
  let cells = 0

  const append = (character: string): void => {
    const previous = runs.at(-1)
    if (
      previous !== undefined &&
      previous.column + [...previous.text].length === cells &&
      sameStyle(previous.style, style)
    ) {
      previous.text += character
    } else {
      runs.push({ column: cells, text: character, style: cloneStyle(style) })
    }
    text += character
    cells += 1
  }

  for (let index = 0; index < value.length; ) {
    const code = value.codePointAt(index)!
    const character = String.fromCodePoint(code)

    if (character === ESC) {
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

    if (code < 0x20 || code === 0x7f) {
      throw new Error(
        `dashboard frame line ${lineNumber}: unsupported control U+${code
          .toString(16)
          .toUpperCase()
          .padStart(4, '0')}`,
      )
    }
    // render.ts guarantees an ASCII frame so one code point is one terminal
    // cell. Rejecting wider/non-ASCII input keeps this adapter from silently
    // inventing width semantics the dashboard itself intentionally avoids.
    if (code > 0x7e) {
      throw new Error(
        `dashboard frame line ${lineNumber}: non-ASCII cell U+${code
          .toString(16)
          .toUpperCase()} is outside the dashboard width contract`,
      )
    }

    append(character)
    index += character.length
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

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function svgFor(
  parsed: ParsedLine[],
  columns: number,
): {
  svg: string
  width: number
  height: number
} {
  const width = PADDING_X * 2 + columns * CELL_WIDTH
  const height = PADDING_Y * 2 + Math.max(1, parsed.length) * LINE_HEIGHT
  const content: string[] = []

  for (const [row, line] of parsed.entries()) {
    for (const run of line.runs) {
      const x = PADDING_X + run.column * CELL_WIDTH
      const y = PADDING_Y + BASELINE + row * LINE_HEIGHT
      const opacity = run.style.dim ? ' fill-opacity="0.58"' : ''
      const weight = run.style.bold ? ' font-weight="700"' : ' font-weight="400"'
      const node =
        `<text x="${x}" y="${y}" fill="${PALETTE[run.style.foreground]}"` +
        `${weight}${opacity}>${xml(run.text)}</text>`
      content.push(
        run.style.href === undefined ? node : `<a href="${xml(run.style.href)}">${node}</a>`,
      )
    }
  }

  return {
    width,
    height,
    svg: [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
      `<rect width="${width}" height="${height}" fill="${PALETTE.background}"/>`,
      `<g font-family="${FONT_FAMILY}" font-size="${FONT_SIZE}" xml:space="preserve" text-rendering="geometricPrecision">`,
      ...content,
      '</g>',
      '</svg>',
    ].join(''),
  }
}

function fontFiles(): string[] {
  const require = createRequire(import.meta.url)
  const root = dirname(require.resolve('dejavu-fonts-ttf/package.json'))
  return [join(root, 'ttf', 'DejaVuSansMono.ttf'), join(root, 'ttf', 'DejaVuSansMono-Bold.ttf')]
}

/** Parse once, then derive both evidence forms from the same exact cells. */
export function renderDashboardFrameImage(
  lines: readonly string[],
  options: FrameImageOptions,
): RenderedFrameImage {
  if (!Number.isInteger(options.columns) || options.columns <= 0) {
    throw new Error(`dashboard frame columns must be a positive integer, got ${options.columns}`)
  }
  if (lines.length === 0) {
    throw new Error('dashboard frame is empty')
  }
  const parsed = lines.map((line, index) => parseLine(line, index + 1))
  for (const [index, line] of parsed.entries()) {
    if (line.cells > options.columns) {
      throw new Error(
        `dashboard frame line ${index + 1} is ${line.cells} cells wide, exceeding declared terminal width ${options.columns}`,
      )
    }
  }

  const { svg, width, height } = svgFor(parsed, options.columns)
  const rendered = new Resvg(svg, {
    fitTo: { mode: 'original' },
    background: PALETTE.background,
    font: {
      fontFiles: fontFiles(),
      loadSystemFonts: false,
      defaultFontFamily: FONT_FAMILY,
      monospaceFamily: FONT_FAMILY,
      defaultFontSize: FONT_SIZE,
    },
    shapeRendering: 2,
    textRendering: 2,
    imageRendering: 0,
    logLevel: 'off',
  }).render()
  if (rendered.width !== width || rendered.height !== height) {
    throw new Error(
      `dashboard PNG dimensions ${rendered.width}x${rendered.height} did not match SVG ${width}x${height}`,
    )
  }

  return {
    text: `${parsed.map((line) => line.text).join('\n')}\n`,
    svg,
    png: new Uint8Array(rendered.asPng()),
    width,
    height,
    rows: lines.length,
    columns: options.columns,
  }
}
