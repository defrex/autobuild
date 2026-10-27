'use client'

import type { PipelineStep, StepState } from '@defrex/autobuild/operator-presentation'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { elapsedMilliseconds } from './view-model'

/** The terminal's step glyphs, verbatim. Every state also carries its word. */
export const GLYPH: Record<StepState, string> = {
  done: '[x]',
  current: '[>]',
  provisional: '[~]',
  pending: '[ ]',
}

/**
 * Elapsed duration in the terminal's format: `38s`, `4m12s`, `1h04m07s`.
 * Smaller units zero-pad when a larger unit precedes, so the field width is
 * stable as it ticks.
 */
export function durationText(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  if (totalSec < 60) return `${totalSec}s`
  const totalMin = Math.floor(totalSec / 60)
  if (totalMin < 60) return `${totalMin}m${String(totalSec % 60).padStart(2, '0')}s`
  return `${Math.floor(totalMin / 60)}h${String(totalMin % 60).padStart(2, '0')}m${String(totalSec % 60).padStart(2, '0')}s`
}

/** The parenthesised note after a step label, in row or detail register. */
export function stepNote(step: PipelineStep, now: number, register: 'row' | 'detail'): string {
  const parts: string[] = []
  if (step.qualifier !== undefined) parts.push(step.qualifier)
  const elapsed = elapsedMilliseconds(step.timing, now)
  if (register === 'row') {
    if (elapsed !== undefined) {
      const count = step.count !== undefined && step.count > 1 ? `/${step.count}` : ''
      parts.push(`${durationText(elapsed)}${count}`)
    }
  } else {
    if (step.count !== undefined) {
      const kind =
        step.label.startsWith('verify:') || step.label === 'reconcile' ? 'attempt' : 'round'
      parts.push(`${kind} ${step.count}`)
    }
    if (elapsed !== undefined) parts.push(durationText(elapsed))
  }
  return parts.length > 0 ? `(${parts.join(', ')})` : ''
}

/** The step's display-only reason — the parked merge step's no-consent
 * explanation — as its own ` — … ` segment after the parenthetical, so the web
 * steps say the same words as the terminal's `renderStep`/`detailStep`. */
export function stepReason(step: PipelineStep): string {
  return step.reason !== undefined ? ` — ${step.reason}` : ''
}

export function StepLine({
  steps,
  now,
  label,
  register = 'row',
}: {
  steps: readonly PipelineStep[]
  now: number
  label: string
  register?: 'row' | 'detail'
}) {
  return (
    <ol className="steps" data-register={register} aria-label={label}>
      {steps.map((step) => (
        <li key={step.label} data-state={step.state}>
          <span aria-hidden>{GLYPH[step.state]}</span> {step.label}
          <span className="note">{stepNote(step, now, register)}</span>
          <span className="reason">{stepReason(step)}</span>
          <span className="sr-only">, {step.state}</span>
        </li>
      ))}
    </ol>
  )
}

/**
 * A word that flashes reverse-video once when its value changes after mount.
 * The only motion in the system: it marks a state change, then stops.
 */
export function Flash({
  value,
  className,
  children,
}: {
  value: string
  className?: string
  children: ReactNode
}) {
  const previous = useRef(value)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (previous.current !== value) {
      previous.current = value
      setTick((count) => count + 1)
    }
  }, [value])
  return (
    <span key={tick} className={`${className ?? ''}${tick > 0 ? ' flash' : ''}`.trim()}>
      {children}
    </span>
  )
}

const PREVIEW_ROWS = 3

/** Collapse blank runs to one row, exactly as the terminal preview does. */
export function messageRows(value: string): string[] {
  const rows: string[] = []
  let previousBlank = false
  for (const line of value.split(/\r?\n/)) {
    const blank = line.trim().length === 0
    if (!blank || !previousBlank) rows.push(line)
    previousBlank = blank
  }
  return rows
}

/**
 * A dense-list preview of a build-owned message: three rows, a `!` prefix
 * on the first, and a count of what the detail view holds beyond them.
 */
export function MessagePreview({
  value,
  tone,
  expandable,
}: {
  value: string
  tone: 'alert' | 'warn' | 'live' | 'ok'
  expandable: boolean
}) {
  const rows = messageRows(value)
  const remaining = rows.length - Math.min(rows.length, PREVIEW_ROWS)
  // Rows may repeat (blank lines do), so the key counts occurrences.
  const seen = new Map<string, number>()
  const shown = rows.slice(0, PREVIEW_ROWS).map((row, position) => {
    const occurrence = (seen.get(row) ?? 0) + 1
    seen.set(row, occurrence)
    return { row, key: `${occurrence}:${row}`, first: position === 0 }
  })
  return (
    <div className="message" data-tone={tone}>
      {shown.map(({ row, key, first }) => (
        <p key={key}>
          <span aria-hidden>{first ? '! ' : '  '}</span>
          {row}
        </p>
      ))}
      {remaining > 0 && (
        <p className="more">
          <span aria-hidden>{'  '}</span>
          ... {remaining} more {remaining === 1 ? 'row' : 'rows'}
          {expandable ? ' - Enter details' : ''}
        </p>
      )}
    </div>
  )
}

export function Rule() {
  return <div className="rule" aria-hidden />
}

export function DashboardSurface({ children }: { children: ReactNode }) {
  return <section className="dashboard-surface">{children}</section>
}

/** One placeholder text line; `w` is its width in `ch` or percent of the measure. */
function Line({ w, className }: { w: string; className?: string }) {
  return <span className={className ? `sk ${className}` : 'sk'} style={{ width: w }} />
}

/** Deterministic width variety so the placeholders read as text, not bars. */
const TITLE_W = ['46%', '58%', '38%', '64%', '50%', '42%']
const META_W = ['34%', '28%', '40%', '30%', '36%', '26%']
const PROSE_W = ['96%', '100%', '92%', '98%', '71%']

/** Neutral geometry for the right-aligned repository controls. */
export function LoadingControls() {
  return (
    <span className="loading-controls" aria-hidden="true">
      {['8ch', '9ch', '7ch', '8ch'].map((width, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed decorative geometry
        <span className="sk sk-control" style={{ width }} key={index} />
      ))}
    </span>
  )
}

export type LoadingKind = 'builds' | 'tickets' | 'build-page' | 'ticket-page' | 'ticket-body'

/** Paragraphs of placeholder prose, as a ticket body renders. */
function LoadingProse({ paragraphs }: { paragraphs: number }) {
  return (
    <div className="sk-prose">
      {Array.from({ length: paragraphs }, (_, p) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed decorative geometry
        <div className="sk-paragraph" key={p}>
          {(p === 0 ? PROSE_W.slice(0, 3) : PROSE_W).map((w, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed decorative geometry
            <Line w={w} key={i} />
          ))}
        </div>
      ))}
    </div>
  )
}

/** The identity column, title and status line every row and page head shares. */
function LoadingHead({ index, status = true }: { index: number; status?: boolean }) {
  return (
    <>
      <Line w="7ch" className="sk-id" />
      <div className="sk-main">
        <div className="sk-titleline">
          <Line w={TITLE_W[index % TITLE_W.length]!} className="sk-title" />
          {status && <Line w="7ch" className="sk-status" />}
        </div>
        <Line w={META_W[index % META_W.length]!} className="sk-meta" />
      </div>
    </>
  )
}

function LoadingGeometry({ kind, rows }: { kind: LoadingKind; rows: number }) {
  switch (kind) {
    case 'builds':
    case 'tickets':
      return (
        <>
          {Array.from({ length: rows }, (_, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed decorative geometry
            <div className="sk-row" data-loading-row="" key={index}>
              <LoadingHead index={index} status={kind === 'builds'} />
              {kind === 'builds' ? (
                <div className="sk-steps">
                  {['10ch', '15ch', '15ch', '17ch', '15ch'].map((w, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: fixed decorative geometry
                    <Line w={w} key={i} />
                  ))}
                </div>
              ) : (
                <div className="sk-excerpt">
                  <Line w="88%" />
                  <Line w={index % 2 ? '52%' : '67%'} />
                </div>
              )}
            </div>
          ))}
        </>
      )
    case 'build-page':
    case 'ticket-page':
      return (
        <div className="sk-page">
          <div className="sk-row sk-head" data-loading-row="">
            <LoadingHead index={0} />
            <div className="sk-buttons">
              <span className="sk sk-button" />
              <span className="sk sk-button ghost" />
            </div>
          </div>
          <div className="sk-sections">
            {kind === 'build-page' && (
              <>
                <Line w="30%" />
                <div className="sk-section">
                  <Line w="8ch" className="sk-heading" />
                  {['18ch', '24ch', '20ch', '24ch', '22ch', '12ch', '16ch'].map((w, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: fixed decorative geometry
                    <Line w={w} key={i} />
                  ))}
                </div>
                <Line w="6ch" className="sk-heading" />
              </>
            )}
            <LoadingProse paragraphs={3} />
          </div>
        </div>
      )
    case 'ticket-body':
      return <LoadingProse paragraphs={2} />
  }
}

/** Static, decorative geometry shaped like the content it stands in for, with one assistive announcement. */
export function LoadingRows({
  label,
  kind = 'builds',
  rows = 5,
}: {
  label: string
  kind?: LoadingKind
  rows?: number
}) {
  return (
    <div className="loading-state" data-loading={kind}>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {label}
      </p>
      <div className="skeletons" aria-hidden="true">
        <LoadingGeometry kind={kind} rows={rows} />
      </div>
    </div>
  )
}

/** Frame-wide column widths in cells, so ids and STATUS align down the page. */
export function columnWidths(
  ticketIds: readonly (string | undefined)[],
  statuses: readonly string[],
  harvest: boolean,
): { ticket: number; status: number } {
  const ids = ticketIds.map((id) => id?.length ?? 0)
  const hasTicketColumn = ids.some((length) => length > 0)
  return {
    ticket: Math.max(0, ...ids, ...(harvest && hasTicketColumn ? ['Harvest'.length] : [])),
    status: Math.max(0, ...statuses.map((status) => status.length)),
  }
}
