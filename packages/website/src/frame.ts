import {
  type FrameRun,
  type Foreground,
  parseFrame,
} from '../../core/src/cli/dashboard/frame-parse'
import { WEBSITE_HERO_COLUMNS } from '../../../tools/dashboard-capture'
import { COLOR, esc } from './svg'

/**
 * The hero is the real `ab dispatch` frame, not a drawing of one.
 *
 * `hero-frame.txt` holds the exact ANSI lines the dashboard painted for the
 * scripted `website-hero` capture (`bun run capture:website-hero` regenerates
 * it, and `bun run check` fails when it drifts). This module only translates
 * that terminal vocabulary into preformatted HTML: the same glyphs in the
 * same cells, each terminal colour mapped to the design system's token for
 * the state it encodes.
 */

export const HERO_FRAME_DESCRIPTION =
  'The ab dispatch dashboard showing five builds and a harvest run'

/** Terminal hue → site token. Blue carries no state in the design system, so
 * the ticket id reads in ink, as it does on the web dashboard. */
const HUE: Record<Foreground, string | undefined> = {
  foreground: undefined,
  red: COLOR.alert,
  green: COLOR.ok,
  yellow: COLOR.title,
  blue: undefined,
  cyan: COLOR.live,
}

/** The lines of a tracked frame file: one per terminal row, final newline dropped. */
export function frameLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function runHtml(run: FrameRun): string {
  const text = esc(run.text)
  // Dim applies the recessive neutral unless a hue already says what the
  // text means; a hyperlink keeps its text and nothing else, since the
  // fixture PR is not a page to send a reader to.
  const color = HUE[run.style.foreground] ?? (run.style.dim ? COLOR.slack : undefined)
  const style = color ? ` style="color: ${color}"` : ''
  if (run.style.bold) return `<b${style}>${text}</b>`
  return style ? `<span${style}>${text}</span>` : text
}

/** The frame with every escape removed, one string per terminal row. */
export function frameText(lines: readonly string[]): string[] {
  return parseFrame(lines, WEBSITE_HERO_COLUMNS).map((line) => line.text)
}

/** Preformatted HTML for the frame, one `<pre>` row per terminal row. */
export function frameHtml(lines: readonly string[]): string {
  const parsed = parseFrame(lines, WEBSITE_HERO_COLUMNS)
  return parsed.map((line) => line.runs.map(runHtml).join('')).join('\n')
}

/** The hero figure: the frame in a well that scrolls sideways inside itself
 * on any viewport narrower than its cells. */
export function heroFrame(text: string): string {
  return `<div class="scroll" tabindex="0" role="region" aria-label="${esc(HERO_FRAME_DESCRIPTION)}"><pre class="frame">${frameHtml(frameLines(text))}</pre></div>`
}
