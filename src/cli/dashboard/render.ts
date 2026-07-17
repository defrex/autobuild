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
  /**
   * The render-time clock (epoch ms). A running step's elapsed is
   * `timing.accumulatedMs + (now - timing.runningSince)`, so painting the same
   * cached model against a moving `now` is what makes the elapsed tick without
   * recomputing the model (AC 8). Steps with no open interval ignore it.
   */
  now: number
  /**
   * Hard cap on the NUMBER of lines — the screen's rows.
   *
   * Same invariant as `width`, on the other axis, and for a sharper reason:
   * the live region repaints by cursoring up over the rows it painted, which
   * only works while they are still on screen. A frame taller than the screen
   * scrolls its own top away, so the cursor-up clamps at the top margin and
   * the header — the line the ACs name — is the first thing lost.
   *
   * This is a cap on LINES, and it is NOT the screen's row count: the region
   * needs a row for the cursor to rest on, so a caller painting a terminal
   * must pass `paintableRows(rows)`, not `rows`. This module cannot enforce
   * that — it counts lines and knows nothing of the region's trailing newline.
   *
   * Absent ⇒ unbounded, for callers that are not painting a screen.
   */
  height?: number
}

// ── ANSI ─────────────────────────────────────────────────────────────────────

const ESC = '\x1b['
const RESET = `${ESC}0m`
/** Closes an OSC 8 hyperlink. `RESET` does NOT: it is an SGR reset, and the
 * two families are independent — only this ends the link. */
const LINK_OFF = '\x1b]8;;\x07'
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
  return on ? `\x1b]8;;${url}\x07${text}${LINK_OFF}` : url
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
 * Truncate to `width` VISIBLE columns without ever splitting an escape, and
 * without leaving any mode it cut through switched ON.
 *
 * Walking the string escape-aware (rather than slicing and hoping) is the
 * whole point: a cut mid-sequence leaks raw escape bytes onto the screen, and
 * a cut that drops a closer leaves the mode running down the rest of the
 * frame. Escapes are copied through and cost zero columns.
 *
 * BOTH families this file emits are stateful, and both must be closed — the
 * SGR colors with `RESET`, and an OSC 8 hyperlink with `LINK_OFF`. `RESET` does
 * not close a hyperlink. Getting this wrong is not cosmetic: `renderBuild` puts
 * the PR link LAST, so it is the first thing truncation eats, and an unclosed
 * OSC 8 makes every line painted afterwards — the progress row, the blockers,
 * every later build — clickable to that one PR. `finish()` deliberately leaves
 * the final frame up, so the state would outlive the process and land on the
 * operator's shell prompt.
 */
function truncate(text: string, width: number): string {
  if (visibleLength(text) <= width) return text
  let out = ''
  let visible = 0
  let sawSgr = false
  let linkOpen = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!
    if (char === '\x1b') {
      // Copy the whole sequence: CSI ends at a letter, OSC 8 at BEL.
      const osc = text[i + 1] === ']'
      const end = osc ? text.indexOf('\x07', i) : text.slice(i).search(/[A-Za-z]/) + i
      const stop = end === -1 || end < i ? text.length - 1 : end
      const seq = text.slice(i, stop + 1)
      out += seq
      i = stop
      // An OSC 8 with a URL opens the link; the empty-param form closes it.
      if (osc) linkOpen = seq !== LINK_OFF
      else sawSgr = true
      continue
    }
    if (visible >= width - 1) {
      out += '~' // ASCII ellipsis: `…` is 3 bytes and lies to `.length`
      break
    }
    out += char
    visible += 1
  }
  // Close what we cut through — the link first, so the `~` stays inside it.
  if (linkOpen) out += LINK_OFF
  return sawSgr ? `${out}${RESET}` : out
}

/**
 * Greedily pack pre-rendered tokens into `indent`-prefixed lines of at most
 * `width` VISIBLE columns.
 *
 * Why wrap rather than truncate: truncation is mandatory for redraw
 * correctness (one rendered line must be one physical row, or the painted-line
 * count under-counts and the redraw leaves fragments) — but a truncated
 * progress row loses `finalize` and `merge waiting` off the right edge, i.e.
 * exactly the steps the ACs require and the ones the operator is waiting on.
 * Both hold at once because WE do the wrapping: every line we emit is within
 * the width, so the row count stays honest AND nothing is dropped.
 *
 * A single token wider than the line is truncated — it cannot be helped, and
 * it keeps the width guarantee absolute.
 */
function packLines(tokens: string[], width: number, indent: string): string[] {
  const lines: string[] = []
  let line = ''
  for (const token of tokens) {
    const candidate = line === '' ? `${indent}${token}` : `${line} ${token}`
    if (line !== '' && visibleLength(candidate) > width) {
      lines.push(line)
      line = `${indent}${token}`
    } else {
      line = candidate
    }
  }
  if (line !== '') lines.push(line)
  return lines.map((l) => truncate(l, width))
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

/**
 * Elapsed duration, ASCII only: `Xs` under a minute, `MmSSs` under an hour,
 * `HhMMm` above — seconds/minutes zero-padded when a larger unit precedes, so
 * the field width is stable as it ticks (`38s`, `4m12s`, `1h04m`).
 */
export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  if (totalSec < 60) return `${totalSec}s`
  const totalMin = Math.floor(totalSec / 60)
  if (totalMin < 60) return `${totalMin}m${String(totalSec % 60).padStart(2, '0')}s`
  return `${Math.floor(totalMin / 60)}h${String(totalMin % 60).padStart(2, '0')}m`
}

function renderStep(step: PipelineStep, color: boolean, now: number): string {
  const parts: string[] = []
  if (step.qualifier !== undefined) parts.push(step.qualifier)
  // The elapsed segment can only be composed here — it depends on the
  // render-time clock. A running step's open interval grows with `now`; a
  // frozen or done step has none, so its elapsed is stable across repaints.
  // `count` rides the time as `/n` (AC 7); with no time in scope it is not
  // shown (a fresh/restarted step should not carry a stale round).
  if (step.timing !== undefined) {
    const { accumulatedMs, runningSince } = step.timing
    const elapsedMs = accumulatedMs + (runningSince !== undefined ? Math.max(0, now - runningSince) : 0)
    const count = step.count !== undefined && step.count > 1 ? `/${step.count}` : ''
    parts.push(`${formatDuration(elapsedMs)}${count}`)
  }
  const note = parts.length > 0 ? `(${parts.join(', ')})` : ''
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
  const { color, width, now } = opts

  // ── The slug line: TICKET-ID  slug  …  <right cluster> ──────────────────────
  //
  // Explicit left / flexible / right layout, NOT "join then truncate the whole
  // line" — the latter eats the rightmost token (the status, the PR link) first,
  // exactly what this change moves away from. Ticket id is the left column, the
  // slug is the sole flexible/truncatable element, and the right cluster hugs
  // `width` so the status word ends at the same column on every row (AC 1).

  // Left column: ticket id, padded frame-wide so slugs align even for a build
  // with no ticket (AC 2). No column at all when the frame has zero ticket ids.
  const ticketCol =
    widths.ticket > 0 ? paint((build.ticketId ?? '').padEnd(widths.ticket), 'blue', color) : ''
  const leftPrefix = ticketCol === '' ? '' : `${ticketCol}  `

  // Right cluster, rightmost last: [PR] [(paused)] STATUS. `padStart`
  // right-justifies the status word so it is never truncated and always ends at
  // the frame's right edge (AC 3, AC 5).
  const rightTokens: string[] = []
  if (build.pr !== undefined) rightTokens.push(link(build.pr.url, `PR ${build.pr.state}`, color))
  // Blocked overrides paused visually, but the pause is still a fact the
  // operator needs — so it rides along rather than being overwritten.
  if (build.alsoPaused) rightTokens.push(paint('(paused)', 'yellow', color))
  rightTokens.push(
    paint(build.status.toUpperCase().padStart(widths.status), STATUS_COLOR[build.status], color),
  )
  const rightStr = rightTokens.join('  ')

  // The slug is the only element that truncates; ticket id and status never do.
  const slugBudget = width - visibleLength(leftPrefix) - visibleLength(rightStr) - 2
  const slug = paint(truncate(build.slug, Math.max(0, slugBudget)), 'bold', color)
  // Pad the gap so the right cluster hugs the edge; `visibleLength`, never
  // `.length`, so colored/linked tokens don't miscount the gap.
  const used = visibleLength(leftPrefix) + visibleLength(slug)
  const gap = ' '.repeat(Math.max(1, width - used - visibleLength(rightStr)))
  // Final safety for widths narrower than the fixed parts: keeps the one-row
  // invariant and closes any hyperlink the cut crosses. Under normal widths the
  // line is exactly `width` with no `~`, so status/ticket/PR are intact.
  const lines = [truncate(`${leftPrefix}${slug}${gap}${rightStr}`, width)]

  // The progress row wraps rather than truncating: the tail is `finalize` and
  // `merge waiting`, which the ACs require and the operator is waiting on.
  lines.push(...packLines(build.steps.map((s) => renderStep(s, color, now)), width, '  '))
  // Blockers wrap too — "every unresolved blocker message is displayed" is not
  // satisfied by its first 80 characters, and a policy escalation's question
  // is routinely longer than that. Wrap the words, then paint each line, so no
  // escape is ever split across a wrap.
  for (const blocker of build.blockers) {
    const [first, ...rest] = packLines(blocker.split(/\s+/), width - 4, '')
    if (first === undefined) continue
    lines.push(truncate(paint(`  ! ${first}`, 'red', color), width))
    for (const line of rest) lines.push(truncate(paint(`    ${line}`, 'red', color), width))
  }
  return lines
}

interface Widths {
  ticket: number
  status: number
}

/** Pad ticket id and status to the widest in the FRAME, so columns line up down
 * the whole dashboard rather than per-build. `ticket` is 0 when no build in the
 * frame has a ticket id — then there is no ticket column at all. */
function frameWidths(builds: DashboardBuild[]): Widths {
  return {
    ticket: Math.max(0, ...builds.map((b) => (b.ticketId ?? '').length)),
    status: Math.max(0, ...builds.map((b) => b.status.length)),
  }
}

// ── The frame ────────────────────────────────────────────────────────────────

export function renderDashboard(model: DashboardModel, opts: RenderOpts): string[] {
  const { color, width, height } = opts
  const header = truncate(
    [
      paint('ab dispatch', 'bold', color),
      basename(model.repo),
      paint(
        `${model.mode} · capacity ${model.capacity} · ${model.builds.length} active`,
        'dim',
        color,
      ),
    ].join('  '),
    width,
  )

  // No paintable height at all (a 1-row screen — see `paintableRows`): paint
  // nothing. A single line would scroll itself off and land in scrollback on
  // every repaint, which is worse than an empty region.
  if (height !== undefined && height <= 0) return []

  // Room for nothing but the header gets the header: it is the line the ACs
  // name, and it carries the active COUNT, so it still tells the operator the
  // builds exist.
  if (height !== undefined && height <= 1) return [header]

  if (model.builds.length === 0) {
    return [header, truncate(paint('  no active builds', 'dim', color), width)]
  }

  // Build blocks first — each is its blank separator plus its lines — so the
  // frame's height is known before anything is painted.
  const widths = frameWidths(model.builds)
  const blocks = model.builds.map((build) => ['', ...renderBuild(build, opts, widths)])

  const total = blocks.reduce((n, block) => n + block.length, 1)
  if (height === undefined || total <= height) return [header, ...blocks.flat()]

  // Overflow: keep whole builds from the top (they are slug-sorted, so the
  // set stays stable across frames) and spend one line saying what was
  // dropped. Silent truncation would read as "these are all the builds", which
  // is worse than the scrolling it replaces.
  const budget = height - 2 // the header, and the overflow notice
  let used = 0
  let shown = 0
  for (const block of blocks) {
    if (used + block.length > budget) break
    used += block.length
    shown += 1
  }
  const dropped = blocks.length - shown
  return [
    header,
    ...blocks.slice(0, shown).flat(),
    truncate(paint(`  ... and ${dropped} more`, 'dim', color), width),
  ]
}
