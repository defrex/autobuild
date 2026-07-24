/**
 * The dashboard's other pure half: model → `string[]`. No terminal, no state,
 * no I/O — `live.ts` owns the writer, this owns the pixels.
 *
 * Two constraints shape every choice here:
 *
 * **Never color-only for pipeline and row state.** Color is additive emphasis:
 * every step also carries a glyph (`[x]` `[>]` `[~]` `[ ]`) and every status
 * its literal word (`RUNNING` / `PAUSED` / `BLOCKED`). Auto-merge is the one
 * deliberate presentation exception: token presence carries on/off intent,
 * while color distinguishes requested, enabled, and cancelling. Strip the
 * escapes — as `--plain` and every pipe do — and the actionable intent remains.
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
import type {
  DashboardBuild,
  DashboardHarvest,
  DashboardModel,
  DashboardSelection,
  PipelineStep,
} from './model'
import { dashboardSelections, sameSelection } from './selection'

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
   * Hard cap on the NUMBER of lines — the screen's paintable rows.
   *
   * The live region clears its alternate display and anchors this frame at
   * terminal row 1 on every effective paint. The cap still matters: every
   * rendered line has a trailing newline, so a frame as tall as the screen
   * scrolls its own top away even on a freshly cleared display.
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

/** A dashboard presentation implementation. Kept as a named dependency so the
 * repo-local dev entry can replace presentation without replacing the live
 * dispatch loop that owns runners, input, timers, and leases. */
export type DashboardRenderer = (model: DashboardModel, opts: RenderOpts) => string[]

/** Resolve at paint time rather than capturing one renderer at loop startup. */
export type DashboardRendererResolver = () => DashboardRenderer

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
  if (width <= 0) return ''
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
  provisional: '[~]',
  pending: '[ ]',
}

const STEP_COLOR: Record<PipelineStep['state'], ColorName> = {
  done: 'green',
  current: 'cyan',
  provisional: 'yellow',
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
    const elapsedMs =
      accumulatedMs + (runningSince !== undefined ? Math.max(0, now - runningSince) : 0)
    const count = step.count !== undefined && step.count > 1 ? `/${step.count}` : ''
    parts.push(`${formatDuration(elapsedMs)}${count}`)
  }
  const note = parts.length > 0 ? `(${parts.join(', ')})` : ''
  const text = `${GLYPH[step.state]} ${step.label}${note}`
  const painted = paint(text, STEP_COLOR[step.state], color)
  return step.state === 'current' ? paint(painted, 'bold', color) : painted
}

// ── Builds ───────────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<DashboardBuild['status'] | DashboardHarvest['status'], ColorName> = {
  running: 'green',
  paused: 'yellow',
  blocked: 'red',
  escalated: 'yellow',
  failed: 'red',
}

/** The marker is one shared visual grammar for every selectable row. */
function selectionMarker(selected: boolean, selecting: boolean, color: boolean): string {
  // The marker owns a fixed two-column lane even when keyboard selection is
  // unavailable. No identity or detail text may drift into those columns.
  return selecting && selected ? paint('> ', 'cyan', color) : '  '
}

/** Pin a right cluster to the frame edge while keeping exactly one flexible,
 * truncatable segment on the left. */
function rightPinnedLine(prefix: string, flexible: string, right: string, width: number): string {
  const budget = width - visibleLength(prefix) - visibleLength(right) - 2
  const left = truncate(flexible, Math.max(0, budget))
  const used = visibleLength(prefix) + visibleLength(left)
  const gap = ' '.repeat(Math.max(1, width - used - visibleLength(right)))
  return truncate(`${prefix}${left}${gap}${right}`, width)
}

function renderBuild(
  build: DashboardBuild,
  opts: RenderOpts,
  widths: Widths,
  selected: boolean,
  selecting: boolean,
): string[] {
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
  const marker = selectionMarker(selected, selecting, color)
  const ticketCol =
    widths.ticket > 0 ? paint((build.ticketId ?? '').padEnd(widths.ticket), 'blue', color) : ''
  const leftPrefix = `${marker}${ticketCol === '' ? '' : `${ticketCol}  `}`

  // Right cluster, rightmost last: [PR] [(paused)] STATUS. `padStart`
  // right-justifies the status word so it is never truncated and always ends at
  // the frame's right edge (AC 3, AC 5).
  const rightTokens: string[] = []
  if (build.autoMerge !== 'off') {
    const autoColor: ColorName =
      build.autoMerge === 'enabled' ? 'green' : build.autoMerge === 'requested' ? 'cyan' : 'yellow'
    rightTokens.push(paint('auto merge', autoColor, color))
  }
  if (build.pr !== undefined) rightTokens.push(link(build.pr.url, `PR ${build.pr.state}`, color))
  // Blocked overrides paused visually, but the pause is still a fact the
  // operator needs — so it rides along rather than being overwritten.
  if (build.alsoPaused) rightTokens.push(paint('(paused)', 'yellow', color))
  rightTokens.push(
    paint(build.status.toUpperCase().padStart(widths.status), STATUS_COLOR[build.status], color),
  )
  const rightStr = rightTokens.join('  ')

  // The slug is the only element that truncates; ticket id and status never do.
  // Final truncation inside `rightPinnedLine` is only a safety net for widths
  // narrower than the fixed columns.
  const lines = [rightPinnedLine(leftPrefix, paint(build.slug, 'bold', color), rightStr, width)]

  // The progress row wraps rather than truncating: the tail is `finalize` and
  // `merge waiting`, which the ACs require and the operator is waiting on.
  lines.push(
    ...packLines(
      build.steps.map((s) => renderStep(s, color, now)),
      width,
      '  ',
    ),
  )
  // Blockers wrap too — "every unresolved blocker message is displayed" is not
  // satisfied by its first 80 characters, and a policy escalation's question
  // is routinely longer than that. Escape external text before tokenization so
  // the visible code-point escapes participate in width accounting, then paint
  // each line so no ANSI escape is ever split across a wrap.
  for (const blocker of build.blockers) {
    const [first, ...rest] = packLines(displayText(blocker).split(/\s+/), width - 4, '')
    if (first === undefined) continue
    lines.push(truncate(paint(`  ! ${first}`, 'red', color), width))
    for (const line of rest) lines.push(truncate(paint(`    ${line}`, 'red', color), width))
  }
  return lines
}

function renderHarvest(
  harvest: DashboardHarvest,
  opts: RenderOpts,
  widths: Widths,
  selected: boolean,
  selecting: boolean,
): string[] {
  const { color, width, now } = opts
  const marker = selectionMarker(selected, selecting, color)
  // Harvest has no ticket id, so its title takes the ticket column itself —
  // aligned with the ids, not the slugs — and the observation count sits in
  // the flexible slug slot, keeping one row grammar across mixed frames.
  const title = widths.ticket > 0 ? HARVEST_TITLE.padEnd(widths.ticket) : HARVEST_TITLE
  const leftPrefix = `${marker}${paint(title, 'bold', color)}  `
  const identity = paint(`${harvest.observations} observations`, 'dim', color)
  const statusColor = STATUS_COLOR[harvest.status]
  const status = paint(harvest.status.toUpperCase().padStart(widths.status), statusColor, color)
  const lines = [rightPinnedLine(leftPrefix, identity, status, width)]
  lines.push(
    ...packLines(
      harvest.steps.map((item) => renderStep(item, color, now)),
      width,
      '  ',
    ),
  )
  if (harvest.detail !== undefined) {
    const wrapped = packLines(displayText(harvest.detail).split(/\s+/), width - 4, '')
    for (const [index, line] of wrapped.entries()) {
      lines.push(
        truncate(paint(`${index === 0 ? '  ! ' : '    '}${line}`, statusColor, color), width),
      )
    }
  }
  return lines
}

interface Widths {
  ticket: number
  status: number
}

const HARVEST_TITLE = 'Harvest'

/** Pad ticket id and status to the widest in the FRAME, so columns line up down
 * the whole dashboard rather than per-row. `ticket` is 0 when no build in the
 * frame has a ticket id — then there is no ticket column at all. The Harvest
 * title lives in the ticket column, so when that column exists it must also fit
 * the title; Harvest joins the status-width calculation even in a mixed frame. */
function frameWidths(builds: DashboardBuild[], harvest: DashboardHarvest | undefined): Widths {
  const ticketIds = builds.map((b) => (b.ticketId ?? '').length)
  const hasTicketColumn = ticketIds.some((length) => length > 0)
  return {
    ticket: Math.max(
      0,
      ...ticketIds,
      ...(harvest !== undefined && hasTicketColumn ? [HARVEST_TITLE.length] : []),
    ),
    status: Math.max(
      0,
      ...builds.map((b) => b.status.length),
      ...(harvest !== undefined ? [harvest.status.length] : []),
    ),
  }
}

// ── The frame ────────────────────────────────────────────────────────────────

export const DASHBOARD_GLOBAL_LEGEND =
  'Keys: Up/Down select  h harvest on/off  m auto-merge default  p intake on/off  Ctrl-C quit'
export const DASHBOARD_HARVEST_LEGEND = 'Keys: Up/Down select  Ctrl-C quit'
export const DASHBOARD_HARVEST_RESUME_LEGEND = 'Keys: Up/Down select  p resume  Ctrl-C quit'
export const DASHBOARD_HARVEST_ACKNOWLEDGE_LEGEND =
  'Keys: Up/Down select  p acknowledge  Ctrl-C quit'
export const DASHBOARD_BUILD_LEGEND =
  'Keys: Up/Down select  m auto-merge  p pause/resume  Ctrl-C quit'

/** Keep the renderer's one-physical-row ASCII/width invariant while retaining
 * exact process state. Non-ASCII and control characters (including newlines)
 * are displayed as code-point escapes; the model value is never rewritten. */
function displayText(value: string): string {
  let displayed = ''
  for (const char of value) {
    const code = char.codePointAt(0)!
    displayed += code >= 0x20 && code <= 0x7e ? char : `\\u{${code.toString(16)}}`
  }
  return displayed
}

function dashboardControls(model: DashboardModel, color: boolean, width: number): string {
  if (model.resumeInput === undefined) {
    const legend =
      model.selection?.kind === 'build'
        ? DASHBOARD_BUILD_LEGEND
        : model.selection?.kind === 'harvest'
          ? model.harvest?.action === 'resume'
            ? DASHBOARD_HARVEST_RESUME_LEGEND
            : model.harvest?.action === 'acknowledge'
              ? DASHBOARD_HARVEST_ACKNOWLEDGE_LEGEND
              : DASHBOARD_HARVEST_LEGEND
          : DASHBOARD_GLOBAL_LEGEND
    return truncate(paint(legend, 'dim', color), width)
  }

  // Instructions are right-pinned and the field is the flexible segment, just
  // like status on a build row. The full value remains in DashboardModel even
  // when this display copy is truncated.
  const prefix = 'Resume feedback (empty retries): ['
  const suffix = ']  Enter submit  Esc cancel'
  const fieldWidth = width - prefix.length - suffix.length
  const plain =
    fieldWidth > 0
      ? `${prefix}${truncate(displayText(model.resumeInput.value), fieldWidth)}${suffix}`
      : 'Resume: Enter=submit Esc=cancel'
  return truncate(paint(plain, 'cyan', color), width)
}

function overflowNotice(text: string, color: boolean, width: number): string {
  return truncate(paint(`  ... ${text}`, 'dim', color), width)
}

interface RenderedDashboardRow {
  selection: DashboardSelection
  lines: string[]
}

function flattenRows(rows: readonly RenderedDashboardRow[]): string[] {
  const lines: string[] = []
  for (const [index, row] of rows.entries()) {
    if (index > 0) lines.push('')
    lines.push(...row.lines)
  }
  return lines
}

export function renderDashboard(model: DashboardModel, opts: RenderOpts): string[] {
  const { color, width, height } = opts
  const selecting = model.selection !== undefined
  const globalSelection = { kind: 'global' } as const
  const marker = selectionMarker(sameSelection(globalSelection, model.selection), selecting, color)
  const intake = model.drained
    ? paint('intake OFF', 'yellow', color)
    : paint('intake ON', 'green', color)
  // "default" is implicit at the top level — the header is repo-wide state,
  // while a build row's own `auto merge` token is that build's setting.
  const autoMergeDefault = model.defaultAutoMerge
    ? paint('auto merge ON', 'green', color)
    : paint('auto merge OFF', 'yellow', color)
  const harvestGate = model.harvestPaused
    ? paint('harvest OFF', 'yellow', color)
    : paint('harvest ON', 'green', color)
  const summary = truncate(
    `${marker}${[
      paint('Auto Build', 'bold', color),
      displayText(basename(model.repo)),
      paint(`queue ${model.queued} | active ${model.builds.length}`, 'dim', color),
    ].join('  ')}`,
    width,
  )
  // The global controls live on their own mandatory line. Its fixed blank
  // marker prefix aligns the first toggle with the title while keeping the
  // selection lane empty.
  const toggles = truncate(`  ${[intake, autoMergeDefault, harvestGate].join('  ')}`, width)
  // A warning is conditional chrome, not a reserved log slot. Escaping
  // controls prevents external text from adding rows or violating ASCII width.
  const warning =
    model.warningLine === undefined
      ? undefined
      : truncate(`  ${displayText(model.warningLine)}`, width)
  const top = [summary, toggles, ...(warning !== undefined ? [warning] : [])]
  const controls = dashboardControls(model, color, width)

  // No paintable height at all (a 1-row screen — see `paintableRows`): paint
  // nothing. Its trailing newline would scroll a single line off even on the
  // alternate display, which is worse than an empty region. The two mandatory
  // header lines outrank warning/body/controls as height disappears.
  if (height !== undefined && height <= 0) return []
  if (height !== undefined && height <= top.length) return top.slice(0, height)
  // Once the complete top section fits, retain controls before spending rows
  // on body content. One additional row has no room for spacing; two retain
  // the top/body separator. A visible body requires both separators.
  if (height !== undefined && height === top.length + 1) {
    return [...top, controls]
  }
  if (height !== undefined && height === top.length + 2) {
    return [...top, '', controls]
  }

  const widths = frameWidths(model.builds, model.harvest)
  const rows: RenderedDashboardRow[] = dashboardSelections(model).flatMap(
    (selection): RenderedDashboardRow[] => {
      // The global selection is fixed frame chrome above the body. It still
      // participates in navigation/reconciliation, but never enters viewport
      // clamping because its header is always visible.
      if (selection.kind === 'global') return []
      if (selection.kind === 'harvest') {
        return [
          {
            selection,
            lines: renderHarvest(
              model.harvest!,
              opts,
              widths,
              sameSelection(selection, model.selection),
              selecting,
            ),
          },
        ]
      }
      const build = model.builds.find((candidate) => candidate.slug === selection.slug)!
      return [
        {
          selection,
          lines: renderBuild(
            build,
            opts,
            widths,
            sameSelection(selection, model.selection),
            selecting,
          ),
        },
      ]
    },
  )

  const bodyBudget =
    height === undefined ? Number.POSITIVE_INFINITY : Math.max(0, height - top.length - 3)
  let body: string[]
  if (rows.length === 0) {
    body = bodyBudget >= 1 ? [truncate(paint('  no active builds', 'dim', color), width)] : []
  } else {
    const allRows = flattenRows(rows)
    if (allRows.length <= bodyBudget) {
      body = allRows
    } else if (bodyBudget <= 0) {
      body = []
    } else {
      const selectedIndex = Math.max(
        0,
        rows.findIndex((row) => sameSelection(row.selection, model.selection)),
      )
      const prefix = [0]
      for (const row of rows) prefix.push(prefix.at(-1)! + row.lines.length)

      // Brute force is intentional and tiny (dashboard row counts are bounded
      // by operator workload): choose the largest contiguous whole-row window
      // containing selection, with explicit omission notices. Harvest and
      // builds participate identically.
      let best: { start: number; end: number; count: number; used: number } | undefined
      for (let start = 0; start <= selectedIndex; start += 1) {
        for (let end = selectedIndex; end < rows.length; end += 1) {
          const rowLines = prefix[end + 1]! - prefix[start]! + (end - start)
          const notices = (start > 0 ? 1 : 0) + (end < rows.length - 1 ? 1 : 0)
          const used = rowLines + notices
          if (used > bodyBudget) continue
          const count = end - start + 1
          if (
            best === undefined ||
            count > best.count ||
            (count === best.count && used > best.used)
          ) {
            best = { start, end, count, used }
          }
        }
      }

      if (best !== undefined) {
        body = []
        if (best.start > 0) {
          body.push(overflowNotice(`${best.start} more above`, color, width))
        }
        body.push(...flattenRows(rows.slice(best.start, best.end + 1)))
        const below = rows.length - best.end - 1
        if (below > 0) {
          body.push(overflowNotice(`and ${below} more below`, color, width))
        }
      } else {
        // A detailed selected row itself cannot fit. Keep its selectable
        // identity visible, then spend remaining rows on detail and omission.
        const selectedLines = rows[selectedIndex]!.lines
        const above = selectedIndex
        const below = rows.length - selectedIndex - 1
        let noticeLines = 0
        if (bodyBudget > 1 && (above > 0 || below > 0)) {
          noticeLines = bodyBudget > 2 && above > 0 && below > 0 ? 2 : 1
        }
        const detailCapacity = Math.max(1, bodyBudget - noticeLines)
        body = []
        if (noticeLines === 2 && above > 0) {
          body.push(overflowNotice(`${above} more above`, color, width))
        }
        body.push(...selectedLines.slice(0, detailCapacity))
        if (noticeLines === 2 && below > 0) {
          body.push(overflowNotice(`and ${below} more below`, color, width))
        } else if (noticeLines === 1) {
          body.push(
            overflowNotice(
              above > 0 && below > 0
                ? `${above} above, ${below} below`
                : above > 0
                  ? `${above} more above`
                  : `and ${below} more below`,
              color,
              width,
            ),
          )
        }
        body = body.slice(0, bodyBudget)
      }
    }
  }

  // Both blank separators are fixed frame chrome, not part of a row block:
  // the first separates the global top section from harvest/build content and
  // the second separates that content from the contextual controls.
  return [...top, '', ...body, '', controls]
}
