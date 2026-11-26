import type { ReactNode } from 'react'
import type { StepText } from '../../../core/src/cli/dashboard/row-text'
import {
  type DashboardTone,
  PROGRESS_VERIFIED,
  stepNote,
} from '../../../core/src/cli/dashboard/vocabulary'
import type { WebBuildRow, WebFinishedRow, WebHarvestRow } from '../../../core/src/web/protocol'
import type { BuildRowModel, RowLine } from '../components/composites'
import { type Step, SignOff, type StateTone } from '../components/display'
import { AttentionLine } from '../components/composites'
import { buildHref } from './routes'

/* The projection's tones and the design system's state tones share names. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const tonesMatch: Same<DashboardTone, StateTone> = true
void tonesMatch

/** The longest elapsed time a step note reserves room for: 99h59m59s. */
export const MAX_ELAPSED_MS = (99 * 3600 + 59 * 60 + 59) * 1000

/**
 * The widest text a step's note can reach while its other facts hold: the
 * projection's own note at the reserved elapsed time. A reservation width,
 * never shown, so a tick or a step starting never rewraps the step list.
 */
export function noteSizer(step: StepText): string {
  const accumulatedMs = Math.max(step.timing?.accumulatedMs ?? 0, MAX_ELAPSED_MS)
  return stepNote({ ...step, timing: { accumulatedMs } }, 0, 'row')
}

export function stepModel(step: StepText, now: number): Step {
  const note = stepNote(step, now, 'row')
  return {
    name: step.label,
    state: step.state,
    mark: step.mark,
    ...(note !== '' ? { note } : {}),
    noteSizer: noteSizer(step),
    ...(step.reason !== undefined ? { reason: step.reason } : {}),
  }
}

function joined(parts: readonly ReactNode[]): ReactNode {
  return parts.map((part, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: parts keep projection order
    <span key={index}>
      {index > 0 ? ' · ' : ''}
      {part}
    </span>
  ))
}

function rowMeta(row: WebBuildRow): ReactNode | undefined {
  const parts: ReactNode[] = [
    ...(row.target !== undefined
      ? [
          <span
            key="target"
            data-ansi="machine"
          >{`${row.target.destination} ${row.target.distance}`}</span>,
        ]
      : []),
    ...(row.merge !== undefined
      ? [
          <span key="merge" data-ansi="toned" data-tone={row.merge.tone}>
            {row.merge.text}
          </span>,
        ]
      : []),
    ...(row.pr !== undefined
      ? [
          <a key="pr" href={row.pr.url}>
            {row.pr.text}
          </a>,
        ]
      : []),
  ]
  return parts.length === 0 ? undefined : joined(parts)
}

function rowLines(row: WebBuildRow): RowLine[] {
  const lines: RowLine[] = []
  if (row.progress !== undefined)
    lines.push({
      text: joined([
        ...row.progress.counts.map((count) => (
          <span key={count.text} data-ansi="toned" data-tone={count.tone}>
            {count.text}
          </span>
        )),
        ...(row.progress.verified
          ? [
              <span key="verified" data-ansi="toned" data-tone="ok">
                {PROGRESS_VERIFIED}
              </span>,
            ]
          : []),
      ]),
    })
  for (const line of row.tree ?? []) lines.push({ text: line, mono: true })
  if (row.ceiling !== undefined) lines.push({ text: row.ceiling, tone: 'pending' })
  if (row.notice !== undefined) lines.push({ text: row.notice.text, tone: row.notice.tone })
  return lines
}

/** A row's attention in projection order: a blocker keeps its red question,
 * every other item is a toned line. */
export function rowAttention(row: WebBuildRow): ReactNode {
  if (row.attention.length === 0) return undefined
  return row.attention.map((item, index) =>
    item.kind === 'escalation' ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: attention keeps projection order
      <SignOff key={index} kind="escalation" question={item.text} />
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: attention keeps projection order
      <AttentionLine key={index} tone={item.tone}>
        {item.text}
      </AttentionLine>
    ),
  )
}

/** A live build row. Every fact is the projection's; a notice stands in for
 * the steps, as it does in the terminal. */
export function liveRowModel(row: WebBuildRow, now: number): BuildRowModel {
  const meta = rowMeta(row)
  const lines = rowLines(row)
  const attention = rowAttention(row)
  return {
    ...(row.ticketId !== undefined ? { ticket: row.ticketId } : {}),
    title: row.title ?? row.slug,
    slug: row.slug,
    status: row.status.word,
    tone: row.status.tone,
    ...(row.status.note !== undefined ? { note: row.status.note } : {}),
    href: buildHref(row.slug),
    flags: row.flags,
    ...(meta !== undefined ? { meta } : {}),
    ...(lines.length > 0 ? { lines } : {}),
    steps: row.notice !== undefined ? [] : row.steps.map((step) => stepModel(step, now)),
    ...(attention !== undefined ? { attention } : {}),
  }
}

export function harvestRowModel(harvest: WebHarvestRow, now: number): BuildRowModel {
  return {
    title: harvest.title,
    slug: harvest.observations,
    status: harvest.status.word,
    tone: harvest.status.tone,
    ...(harvest.detail !== undefined
      ? { lines: [{ text: harvest.detail.text, tone: harvest.detail.tone }] }
      : {}),
    steps: harvest.steps.map((step) => stepModel(step, now)),
  }
}

const pad = (n: number) => String(n).padStart(2, '0')

/** A fixed-width `YYYY-MM-DD HH:MM` in the viewer's time zone. */
export function completedText(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function finishedRowModel(row: WebFinishedRow): BuildRowModel {
  return {
    title: row.slug,
    slug: row.slug,
    status: row.word,
    tone: row.tone,
    href: buildHref(row.slug),
    meta: (
      <time data-ansi="machine" dateTime={row.completedAt}>
        {completedText(row.completedAt)}
      </time>
    ),
    steps: [],
  }
}
