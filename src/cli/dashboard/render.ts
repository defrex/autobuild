/**
 * The dashboard's other pure half: model → `string[]`. No terminal, no state,
 * no I/O — `live.ts` owns the writer, this owns the pixels.
 *
 * Two constraints shape every choice here:
 *
 * **Never color-only.** Color is additive emphasis and nothing else: every
 * state also carries a glyph (`[x]` `[>]` `[ ]`) and every status its literal
 * word (`RUNNING` / `PAUSED` / `BLOCKED`). Strip the escapes — as `--plain`
 * and every pipe do — and no information is lost.
 *
 * **ASCII only.** There is no string-width dependency in this repo and none
 * should be added: `.length` is honest only for ASCII, and a lying width
 * miscounts the painted rows, which is what makes a redraw accumulate
 * fragments. So the glyphs are ASCII, and we render ticket IDs but never
 * ticket titles.
 *
 * The ~40 lines of ANSI are hand-rolled for the same reason: this repo has
 * four runtime deps and none is terminal-related; `chalk`/`ink` would be a
 * posture change to win a color map.
 */
import { basename } from 'node:path'
import type { DashboardBuild, DashboardModel, PipelineStep } from './model'

export interface RenderOpts {
  /** ANSI on. False ⇒ not a single `\x1b` in the output (the `--plain` AC). */
  color: boolean
  /** Hard cap per line; one rendered line must be one physical row. */
  width: number
}

// ── ANSI ─────────────────────────────────────────────────────────────────────

const ESC = '\x1b['
const RESET = `${ESC}0m`
const CODES = {
  dim: 2,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  cyan: 36,
  bold: 1,
} as const
type ColorName = keyof typeof CODES

function paint(text: string, color: ColorName, on: boolean): string {
  return on ? `${ESC}${CODES[color]}m${text}${RESET}` : text
}

/** OSC 8: the escape common terminals turn into a real hyperlink. In plain
 * mode we emit the bare URL, which those same terminals linkify on sight —
 * so "PR URLs are recognized as a link" holds on both paths. */
function link(url: string, text: string, on: boolean): string {
  return on ? `\x1b]8;;${url}\x07${text}\x1b]8;;\x07` : url
}

/** Visible length: what the operator's eye counts, not what `.length` does. */
function visibleLength(text: string): number {
  return stripAnsi(text).length
}

export function stripAnsi(text: string): string {
  // CSI (colors) and OSC 8 (hyperlinks) — the only two families we emit.
  return text.replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b\[[0-9;]*m/g, '')
}

/**
 * Truncate to `width` VISIBLE columns without ever splitting an escape.
 *
 * Walking the string escape-aware (rather than slicing and hoping) is the
 * whole point: a cut mid-sequence leaks raw escape bytes onto the screen, and
 * a cut that drops a trailing reset bleeds color into every line below it.
 * Escapes are copied through and cost zero columns; the reset is re-appended
 * whenever we cut a line that had any.
 */
function truncate(text: string, width: number): string {
  if (visibleLength(text) <= width) return text
  let out = ''
  let visible = 0
  let sawEscape = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!
    if (char === '\x1b') {
      // Copy the whole sequence: CSI ends at a letter, OSC 8 at BEL.
      const end = text[i + 1] === ']' ? text.indexOf('\x07', i) : text.slice(i).search(/[A-Za-z]/) + i
      const stop = end === -1 || end < i ? text.length - 1 : end
      out += text.slice(i, stop + 1)
      i = stop
      sawEscape = true
      continue
    }
    if (visible >= width - 1) {
      out += '~' // ASCII ellipsis: `…` is 3 bytes and lies to `.length`
      break
    }
    out += char
    visible += 1
  }
  return sawEscape ? `${out}${RESET}` : out
}

// ── Steps ────────────────────────────────────────────────────────────────────

const GLYPH: Record<PipelineStep['state'], string> = {
  done: '[x]',
  current: '[>]',
  pending: '[ ]',
}

const STEP_COLOR: Record<PipelineStep['state'], ColorName> = {
  done: 'green',
  current: 'cyan',
  pending: 'dim',
}

function renderStep(step: PipelineStep, color: boolean): string {
  const note = step.note !== undefined ? `(${step.note})` : ''
  const text = `${GLYPH[step.state]} ${step.label}${note}`
  const painted = paint(text, STEP_COLOR[step.state], color)
  return step.state === 'current' ? paint(painted, 'bold', color) : painted
}

// ── Builds ───────────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<DashboardBuild['status'], ColorName> = {
  running: 'green',
  paused: 'yellow',
  blocked: 'red',
}

function renderBuild(build: DashboardBuild, opts: RenderOpts, widths: Widths): string[] {
  const { color, width } = opts
  const slug = build.slug.padEnd(widths.slug)
  // The literal word, not a symbol — the status must survive `| cat`.
  const badge = paint(build.status.toUpperCase().padEnd(widths.status), STATUS_COLOR[build.status], color)

  const bits: string[] = [paint(slug, 'bold', color), badge]
  // Blocked overrides paused visually, but the pause is still a fact the
  // operator needs — so it rides along rather than being overwritten.
  if (build.alsoPaused) bits.push(paint('(paused)', 'yellow', color))
  if (build.ticketId !== undefined) bits.push(paint(build.ticketId, 'blue', color))
  if (build.phase !== undefined) bits.push(paint(build.phase, 'dim', color))
  if (build.pr !== undefined) {
    bits.push(link(build.pr.url, `PR ${build.pr.state}`, color))
  }

  const lines = [truncate(bits.join('  '), width)]
  lines.push(truncate(`  ${build.steps.map((s) => renderStep(s, color)).join(' ')}`, width))
  for (const blocker of build.blockers) {
    lines.push(truncate(paint(`  ! ${blocker}`, 'red', color), width))
  }
  return lines
}

interface Widths {
  slug: number
  status: number
}

/** Pad slug and status to the widest in the FRAME, so columns line up down the
 * whole dashboard rather than per-build. */
function frameWidths(builds: DashboardBuild[]): Widths {
  return {
    slug: Math.max(0, ...builds.map((b) => b.slug.length)),
    status: Math.max(0, ...builds.map((b) => b.status.length)),
  }
}

// ── The frame ────────────────────────────────────────────────────────────────

export function renderDashboard(model: DashboardModel, opts: RenderOpts): string[] {
  const { color, width } = opts
  const header = [
    paint('ab dispatch', 'bold', color),
    basename(model.repo),
    paint(`${model.mode} · capacity ${model.capacity} · ${model.builds.length} active`, 'dim', color),
  ].join('  ')

  const lines = [truncate(header, width)]
  if (model.builds.length === 0) {
    lines.push(truncate(paint('  no active builds', 'dim', color), width))
    return lines
  }

  const widths = frameWidths(model.builds)
  for (const build of model.builds) {
    lines.push('')
    lines.push(...renderBuild(build, opts, widths))
  }
  return lines
}
