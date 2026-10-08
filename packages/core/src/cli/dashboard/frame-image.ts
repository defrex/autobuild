import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { distributionPath } from '../../distribution'
import { type Foreground, type ParsedFrameLine, parseFrame } from './frame-parse'

/**
 * Deterministic dashboard-frame rendering.
 *
 * `frame-parse.ts` owns the strict reading of the dashboard's terminal
 * vocabulary; this adapter paints those exact cells into an SVG and PNG.
 */

const FONT_FAMILY = 'DejaVu Sans Mono'
const FONT_FAMILIES = [
  FONT_FAMILY,
  'Dashboard CJK 113',
  'Dashboard CJK 117',
  'Dashboard CJK 118',
  'Dashboard Emoji Flags',
  'Dashboard Emoji Food',
  'Dashboard Emoji People',
].join(', ')
const FONT_SIZE = 16
const CELL_WIDTH = 10
const LINE_HEIGHT = 20
const PADDING_X = 12
const PADDING_Y = 10
const BASELINE = 16
const EMOJI_CLUSTER = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u

const PALETTE: Record<Foreground | 'background', string> = {
  background: '#0d1117',
  foreground: '#c9d1d9',
  red: '#ff7b72',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  cyan: '#39c5cf',
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

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function svgFor(
  parsed: ParsedFrameLine[],
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
      // DejaVu's native advance is slightly narrower than the 10 px evidence
      // grid. Fit coalesced ASCII runs to their exact terminal cells so the
      // error cannot accumulate into a visible gap before a pinned Unicode
      // cluster. Emoji get the same exact fit at a slightly larger size: the
      // monochrome fallback remains readable without crossing its cell range.
      const emoji = EMOJI_CLUSTER.test(run.text)
      const geometry =
        /^[\x20-\x7e]+$/.test(run.text) || emoji
          ? ` textLength="${run.cells * CELL_WIDTH}" lengthAdjust="spacingAndGlyphs"`
          : ''
      const size = emoji ? ' font-size="18"' : ''
      const node =
        `<text x="${x}" y="${y}" fill="${PALETTE[run.style.foreground]}"` +
        `${weight}${opacity}${geometry}${size}>${xml(run.text)}</text>`
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
      `<g font-family="${FONT_FAMILIES}" font-size="${FONT_SIZE}" xml:space="preserve" text-rendering="geometricPrecision">`,
      ...content,
      '</g>',
      '</svg>',
    ].join(''),
  }
}

function fontFiles(): string[] {
  const require = createRequire(import.meta.url)
  const root = dirname(require.resolve('dejavu-fonts-ttf/package.json'))
  const fallbacks = distributionPath('tools', 'fonts')
  return [
    join(root, 'ttf', 'DejaVuSansMono.ttf'),
    join(root, 'ttf', 'DejaVuSansMono-Bold.ttf'),
    ...readdirSync(fallbacks)
      .filter((name) => name.endsWith('.ttf'))
      .sort()
      .map((name) => join(fallbacks, name)),
  ]
}

/** Parse once, then derive both evidence forms from the same exact cells. */
export function renderDashboardFrameImage(
  lines: readonly string[],
  options: FrameImageOptions,
): RenderedFrameImage {
  const parsed = parseFrame(lines, options.columns)

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
