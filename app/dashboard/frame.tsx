'use client'

import type { PipelineStep, StepState } from 'autobuild/operator-presentation'
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
 * Elapsed duration in the terminal's format: `38s`, `4m12s`, `1h04m`.
 * Smaller units zero-pad when a larger unit precedes, so the field width is
 * stable as it ticks.
 */
export function durationText(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  if (totalSec < 60) return `${totalSec}s`
  const totalMin = Math.floor(totalSec / 60)
  if (totalMin < 60) return `${totalMin}m${String(totalSec % 60).padStart(2, '0')}s`
  return `${Math.floor(totalMin / 60)}h${String(totalMin % 60).padStart(2, '0')}m`
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
          {stepNote(step, now, register)}
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

const LOADING_ROWS = ['first', 'second', 'third', 'fourth', 'fifth'] as const

/** Static, decorative row geometry with one assistive loading announcement. */
export function LoadingRows({ label }: { label: string }) {
  return (
    <div className="loading-state">
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {label}
      </p>
      <div className="skeletons" aria-hidden="true">
        <div className="skeleton-dispatch">
          <span />
          <span />
          <span />
        </div>
        {LOADING_ROWS.map((row) => (
          <div className="skeleton-row" data-loading-row="" key={row}>
            <span className="skeleton-identity" />
            <span className="skeleton-state" />
            <span className="skeleton-steps" />
          </div>
        ))}
      </div>
    </div>
  )
}

/** Wall clock as HH:MM:SS, the header's top-right corner. */
export function clockText(iso: string | undefined, fallback: number): string {
  const date = iso ? new Date(iso) : new Date(fallback)
  const time = Number.isNaN(date.getTime()) ? new Date(fallback) : date
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`
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
