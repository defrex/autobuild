'use client'

import type { OperatorAnswerRequest, OperatorBuildControlRequest } from 'autobuild/operator-api'
import {
  buildActionAvailability,
  type DashboardBuild,
  type DashboardHarvest,
  type DashboardModel,
  type TranscriptPresentation,
} from 'autobuild/operator-presentation'
import {
  type CSSProperties,
  type PointerEvent,
  type PointerEventHandler,
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  columnWidths,
  DashboardSurface,
  Flash,
  LoadingRows,
  MessagePreview,
  Rule,
  StepLine,
} from './frame'

export type Selection = { kind: 'build'; slug: string } | { kind: 'harvest' }
export type BuildControlAction = OperatorBuildControlRequest['action']
export type HarvestControl = { action: 'toggle-gate' } | { action: 'run'; run: string }

export function sameSelection(a: Selection | undefined, b: Selection | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  if (a.kind !== b.kind) return false
  return a.kind === 'harvest' || (b.kind === 'build' && a.slug === b.slug)
}

export function canPreviewPointer(pointerType: string, fineHover: boolean): boolean {
  return pointerType === 'mouse' && fineHover
}

interface RowControlKeyEvent {
  key: string
  preventDefault: () => void
  stopPropagation: () => void
}

/** Keep button activation from also reaching dashboard shortcuts; Esc cancels local abort. */
export function handleRowControlKey(event: RowControlKeyEvent, cancelAbort?: () => void): void {
  if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
  if (cancelAbort && event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    cancelAbort()
  }
}

export interface BuildsViewProps {
  repo: string
  model?: DashboardModel
  now: number
  pending?: string
  selection?: Selection
  hoverPreview?: Selection
  detailOpen: boolean
  confirmingAbort?: string
  answerStep?: { slug: string; escalationIds: string[]; input: string }
  answerPending: boolean
  transcript?: TranscriptPresentation
  onActivate: (selection: Selection) => void
  onHoverPreview: (selection: Selection | undefined) => void
  onRowBuildControl: (slug: string, action: BuildControlAction) => void
  onRowRequestAbort: (slug: string) => void
  onCancelAbort: () => void
  onRowToggleDetail: (slug: string) => void
  onAnswerStepInput: (input: string) => void
  onSubmitAnswerStep: () => void
  onCancelAnswerStep: () => void
  onAnswer: (slug: string, body: OperatorAnswerRequest) => void
  onTranscript: (build: DashboardBuild, kind: string, rev: number) => void
  onRowHarvest: (body: Extract<HarvestControl, { action: 'run' }>) => void
}

type Tone = 'alert' | 'warn' | 'live' | 'ok'

/** The terminal renderer's status color map, as tones. */
function statusTone(status: DashboardBuild['status'] | DashboardHarvest['status']): Tone {
  switch (status) {
    case 'queued':
    case 'resuming':
      return 'live'
    case 'running':
      return 'ok'
    case 'pausing':
    case 'paused':
    case 'cleaning':
    case 'escalated':
      return 'warn'
    case 'blocked':
    case 'aborting':
    case 'failed':
      return 'alert'
  }
}

function reviewCeilingText(build: DashboardBuild): string | undefined {
  if (build.reviewRoundCeilings === undefined) return undefined
  const values = [
    ...(build.reviewRoundCeilings.plan !== undefined
      ? [`plan ${build.reviewRoundCeilings.plan}`]
      : []),
    ...(build.reviewRoundCeilings.code !== undefined
      ? [`code ${build.reviewRoundCeilings.code}`]
      : []),
  ]
  return values.length === 0 ? undefined : `review round ceiling: ${values.join(', ')}`
}

interface CellVars extends CSSProperties {
  '--ticket-w'?: string
  '--status-w'?: string
}

export interface BuildRowAction {
  label: string
  action: BuildControlAction | 'request-abort'
}

export function autoMergeAction(row: DashboardBuild): BuildControlAction {
  return row.autoMerge === 'off' ? 'auto-merge-on' : 'auto-merge-off'
}

/** Lifecycle and destructive actions shown in a build's reserved row register. */
export function buildRowActions(row: DashboardBuild): BuildRowAction[] {
  const available = buildActionAvailability(row)
  const actions: BuildRowAction[] = []
  if (available.abort) actions.push({ label: 'ABORT', action: 'request-abort' })
  if (available.primary) {
    actions.push({
      label: available.primary.replace('-', ' ').toUpperCase(),
      action: available.primary,
    })
  } else if (available.discard) {
    actions.push({ label: 'DISCARD', action: 'discard' })
  }
  return actions
}

export function BuildsView(props: BuildsViewProps) {
  const { model, repo, now, selection, hoverPreview, detailOpen, confirmingAbort } = props
  const preview = (next: Selection) => (event: PointerEvent) => {
    if (
      canPreviewPointer(
        event.pointerType,
        window.matchMedia('(hover: hover) and (pointer: fine)').matches,
      )
    ) {
      props.onHoverPreview(next)
    }
  }
  if (!model) {
    return (
      <DashboardSurface>
        <LoadingRows label={`Loading builds for ${repo || 'the selected repository'}.`} />
      </DashboardSurface>
    )
  }

  const widths = columnWidths(
    model.builds.map((row) => row.ticketId),
    [...model.builds.map((row) => row.status), ...(model.harvest ? [model.harvest.status] : [])],
    model.harvest !== undefined,
  )
  const vars: CellVars = {
    '--ticket-w': `${widths.ticket}ch`,
    '--status-w': `${widths.status}ch`,
  }
  const selectedBuild =
    selection?.kind === 'build'
      ? model.builds.find((row) => row.slug === selection.slug)
      : undefined
  const focused =
    selection !== undefined &&
    (selection.kind === 'harvest' ? model.harvest !== undefined : selectedBuild !== undefined)
  return (
    <DashboardSurface>
      {(model.warningLines?.length || model.availableUpgrade) && (
        <div className="messages">
          {model.warningLines?.map((line) => (
            <p className="warn notice" key={line}>
              {line}
            </p>
          ))}
          {model.availableUpgrade && (
            <p className="live notice">
              Autobuild v{model.availableUpgrade} is available: run ab upgrade
            </p>
          )}
        </div>
      )}
      <ol
        className="rows"
        style={vars}
        data-ticket-col={widths.ticket}
        data-focused={focused || undefined}
        aria-label="Build pipelines"
        onPointerLeave={() => props.onHoverPreview(undefined)}
      >
        {model.harvest && (
          <HarvestRow
            harvest={model.harvest}
            now={now}
            hasTicketColumn={widths.ticket > 0}
            selected={selection?.kind === 'harvest'}
            hovered={hoverPreview?.kind === 'harvest'}
            dimmed={focused && selection?.kind !== 'harvest'}
            pending={props.pending}
            onPointerEnter={preview({ kind: 'harvest' })}
            onActivate={props.onActivate}
            onRowHarvest={props.onRowHarvest}
          />
        )}
        {model.builds.map((row) => (
          <BuildRow
            key={row.slug}
            row={row}
            model={model}
            now={now}
            pending={props.pending}
            selected={selection?.kind === 'build' && selection.slug === row.slug}
            hovered={hoverPreview?.kind === 'build' && hoverPreview.slug === row.slug}
            dimmed={focused && !(selection?.kind === 'build' && selection.slug === row.slug)}
            detailOpen={detailOpen}
            confirmingAbort={confirmingAbort === row.slug}
            answerStep={props.answerStep}
            answerPending={props.answerPending}
            transcript={props.transcript}
            onPointerEnter={preview({ kind: 'build', slug: row.slug })}
            onRowBuildControl={props.onRowBuildControl}
            onRowRequestAbort={props.onRowRequestAbort}
            onRowToggleDetail={props.onRowToggleDetail}
            onCancelAbort={props.onCancelAbort}
            onAnswerStepInput={props.onAnswerStepInput}
            onSubmitAnswerStep={props.onSubmitAnswerStep}
            onCancelAnswerStep={props.onCancelAnswerStep}
            onAnswer={props.onAnswer}
            onTranscript={props.onTranscript}
          />
        ))}
        {model.builds.length === 0 && !model.harvest && <li className="slack">no active builds</li>}
      </ol>
    </DashboardSurface>
  )
}

export interface DispatcherControlsProps {
  model: DashboardModel
  pending?: string
  onSetting: (name: 'intake' | 'auto-merge-default', enabled: boolean) => void
  onHarvest: (body: HarvestControl) => void
}

/** Builds facts and settings composed into the shell's shared control line. */
export function DispatcherControls({
  model,
  pending,
  onSetting,
  onHarvest,
}: DispatcherControlsProps) {
  const busy = pending !== undefined
  return (
    <>
      <span className="control-item fact-item">
        <span>queue {model.queued}</span>
        <span className="sep" aria-hidden>
          |
        </span>
      </span>
      <span className="control-item fact-item">
        <span>
          active {model.active.current}/{model.active.limit}
        </span>
        <span className="sep" aria-hidden>
          |
        </span>
      </span>
      <span className="control-item fact-item">
        <span>
          observations {model.observations.current}/{model.observations.limit}
        </span>
        <span className="sep" aria-hidden>
          |
        </span>
      </span>
      {model.repositoryPaused && (
        <span className="control-item repository-state">
          repository <b className="off">PAUSED</b>
        </span>
      )}
      <button
        type="button"
        className="word control-item"
        disabled={busy}
        onClick={() => onSetting('intake', model.drained)}
      >
        intake <b className={model.drained ? 'off' : 'on'}>{model.drained ? 'OFF' : 'ON'}</b>
      </button>
      <button
        type="button"
        className="word control-item"
        disabled={busy}
        onClick={() => onSetting('auto-merge-default', !model.defaultAutoMerge)}
      >
        auto merge{' '}
        <b className={model.defaultAutoMerge ? 'on' : 'off'}>
          {model.defaultAutoMerge ? 'ON' : 'OFF'}
        </b>
      </button>
      <button
        type="button"
        className="word control-item"
        disabled={busy}
        onClick={() => onHarvest({ action: 'toggle-gate' })}
      >
        harvest{' '}
        <b className={model.harvestPaused ? 'off' : 'on'}>{model.harvestPaused ? 'OFF' : 'ON'}</b>
      </button>
    </>
  )
}

function HarvestRow({
  harvest,
  now,
  hasTicketColumn,
  selected,
  hovered,
  dimmed,
  pending,
  onPointerEnter,
  onActivate,
  onRowHarvest,
}: {
  harvest: DashboardHarvest
  now: number
  hasTicketColumn: boolean
  selected: boolean
  hovered: boolean
  dimmed: boolean
  pending?: string
  onPointerEnter: PointerEventHandler<HTMLLIElement>
  onActivate: BuildsViewProps['onActivate']
  onRowHarvest: BuildsViewProps['onRowHarvest']
}) {
  return (
    <li
      className="row harvest"
      data-status={harvest.status}
      data-selected={selected || undefined}
      data-hovered={hovered || undefined}
      data-dimmed={dimmed || undefined}
      onPointerEnter={onPointerEnter}
    >
      <div className="rowline">
        <span className="lane" aria-hidden />
        <button
          type="button"
          className="rowhead"
          aria-pressed={selected}
          onClick={() => onActivate({ kind: 'harvest' })}
        >
          {hasTicketColumn ? (
            <>
              <span className="ticket">Harvest</span>
              <span className="slug identity-text">{harvest.observations} observations</span>
            </>
          ) : (
            <span className="slug">
              Harvest <span className="identity-text">{harvest.observations} observations</span>
            </span>
          )}
        </button>
        <span className="tokens">
          <span className="slack">
            {harvest.rounds} {harvest.rounds === 1 ? 'round' : 'rounds'}
          </span>
        </span>
        <span className="status" data-status={harvest.status}>
          <Flash value={harvest.status}>{harvest.status.toUpperCase()}</Flash>
        </span>
      </div>
      <div
        className="row-controls"
        role="toolbar"
        aria-label={`Controls for Harvest run ${harvest.run}`}
        onKeyDown={(event) => handleRowControlKey(event)}
      >
        {harvest.action && (
          <button
            type="button"
            className="word row-control"
            disabled={pending !== undefined}
            aria-label={`${harvest.action.toUpperCase()} Harvest run ${harvest.run}`}
            onClick={() => onRowHarvest({ action: 'run', run: harvest.run })}
          >
            {harvest.action.toUpperCase()}
          </button>
        )}
      </div>
      <StepLine steps={harvest.steps} now={now} label="Harvest pipeline" />
      {harvest.detail !== undefined && (
        <MessagePreview
          value={harvest.detail}
          tone={statusTone(harvest.status)}
          expandable={false}
        />
      )}
    </li>
  )
}

function BuildRow({
  row,
  model,
  now,
  pending,
  selected,
  hovered,
  dimmed,
  detailOpen,
  confirmingAbort,
  answerStep,
  answerPending,
  transcript,
  onPointerEnter,
  onRowBuildControl,
  onRowRequestAbort,
  onRowToggleDetail,
  onCancelAbort,
  onAnswerStepInput,
  onSubmitAnswerStep,
  onCancelAnswerStep,
  onAnswer,
  onTranscript,
}: {
  row: DashboardBuild
  model: DashboardModel
  now: number
  pending?: string
  selected: boolean
  hovered: boolean
  dimmed: boolean
  detailOpen: boolean
  confirmingAbort: boolean
  answerStep?: BuildsViewProps['answerStep']
  answerPending: boolean
  transcript?: TranscriptPresentation
  onPointerEnter: PointerEventHandler<HTMLLIElement>
  onRowBuildControl: BuildsViewProps['onRowBuildControl']
  onRowRequestAbort: BuildsViewProps['onRowRequestAbort']
  onRowToggleDetail: BuildsViewProps['onRowToggleDetail']
  onCancelAbort: BuildsViewProps['onCancelAbort']
  onAnswerStepInput: BuildsViewProps['onAnswerStepInput']
  onSubmitAnswerStep: BuildsViewProps['onSubmitAnswerStep']
  onCancelAnswerStep: BuildsViewProps['onCancelAnswerStep']
  onAnswer: BuildsViewProps['onAnswer']
  onTranscript: BuildsViewProps['onTranscript']
}) {
  const tone = statusTone(row.status)
  const ceiling = reviewCeilingText(row)
  const detailId = `detail-${encodeURIComponent(row.slug)}`
  const abortConfirmationId = `abort-confirmation-${encodeURIComponent(row.slug)}`
  const open = selected && detailOpen
  const answering = selected && answerStep?.slug === row.slug
  const held = model.repositoryPaused && row.status === 'queued'
  const autoMergeAvailable = buildActionAvailability(row).autoMerge
  const autoMergeOn = row.autoMerge === 'requested' || row.autoMerge === 'enabled'
  return (
    <li
      className="row"
      id={`build-${encodeURIComponent(row.slug)}`}
      data-status={row.status}
      data-selected={selected || undefined}
      data-hovered={hovered || undefined}
      data-dimmed={dimmed || undefined}
      onPointerEnter={onPointerEnter}
    >
      <div className="rowline">
        <span className="lane" aria-hidden />
        <button
          type="button"
          className="rowhead"
          disabled={answering}
          aria-label={`${open ? 'Close' : 'Open'} details for ${row.slug}`}
          aria-pressed={selected}
          aria-expanded={open}
          aria-controls={detailId}
          onClick={() => onRowToggleDetail(row.slug)}
        >
          <span className="ticket">{row.ticketId ?? ''}</span>
          <span className="slug">{row.slug}</span>
        </button>
        <span className="tokens">
          <button
            type="button"
            className="word am"
            data-am={row.autoMerge}
            disabled={answering || pending !== undefined || !autoMergeAvailable}
            aria-label={`Auto merge ${row.autoMerge} for ${row.slug}`}
            aria-pressed={autoMergeOn}
            onClick={() => onRowBuildControl(row.slug, autoMergeAction(row))}
          >
            auto merge <b>{row.autoMerge}</b>
          </button>
          {row.pr && (
            <a
              className="pr"
              data-pr={row.pr.state}
              href={row.pr.url}
              target="_blank"
              rel="noreferrer"
            >
              PR {row.pr.state}
            </a>
          )}
          {held && <span className="warn held">(held)</span>}
          {row.alsoPaused && <span className="warn">(paused)</span>}
        </span>
        <span className="status" data-status={row.status}>
          <Flash value={row.status}>{row.status.toUpperCase()}</Flash>
        </span>
      </div>
      {ceiling && <p className="sub">{ceiling}</p>}
      {row.abortProgress !== undefined ? (
        <MessagePreview value={row.abortProgress} tone={tone} expandable={false} />
      ) : row.dispatch !== undefined ? (
        <MessagePreview value={row.dispatch} tone={tone} expandable={false} />
      ) : (
        <StepLine steps={row.steps} now={now} label={`${row.slug} pipeline`} />
      )}
      {row.setupError !== undefined && (
        <MessagePreview value={row.setupError} tone="alert" expandable />
      )}
      {row.blockers.map((blocker) => (
        <MessagePreview key={blocker} value={blocker} tone="alert" expandable />
      ))}
      <div
        className="row-controls"
        role="toolbar"
        aria-label={`Controls for ${row.slug}`}
        aria-describedby={confirmingAbort ? abortConfirmationId : undefined}
        onKeyDown={(event) =>
          handleRowControlKey(
            event,
            answering ? onCancelAnswerStep : confirmingAbort ? onCancelAbort : undefined,
          )
        }
      >
        {answering ? (
          <>
            <button
              type="button"
              className="word row-control"
              disabled={pending !== undefined || answerPending}
              aria-label={`SUBMIT answer for ${row.slug}`}
              onClick={onSubmitAnswerStep}
            >
              SUBMIT
            </button>
            <button
              type="button"
              className="word row-control"
              disabled={pending !== undefined || answerPending}
              aria-label={`CANCEL answer for ${row.slug}`}
              onClick={onCancelAnswerStep}
            >
              CANCEL
            </button>
          </>
        ) : confirmingAbort ? (
          <>
            <button
              type="button"
              className="word row-control"
              disabled={pending !== undefined}
              aria-label={`CONFIRM ABORT ${row.slug}`}
              onClick={() => onRowBuildControl(row.slug, 'abort')}
            >
              CONFIRM ABORT
            </button>
            <button
              type="button"
              className="word row-control"
              disabled={pending !== undefined}
              aria-label={`CANCEL abort ${row.slug}`}
              onClick={onCancelAbort}
            >
              CANCEL
            </button>
          </>
        ) : (
          buildRowActions(row).map((control) => (
            <button
              type="button"
              className="word row-control"
              key={control.action}
              disabled={pending !== undefined}
              aria-label={`${control.label} ${row.slug}`}
              onClick={() => {
                if (control.action === 'request-abort') onRowRequestAbort(row.slug)
                else onRowBuildControl(row.slug, control.action)
              }}
            >
              {control.label}
            </button>
          ))
        )}
      </div>
      {selected && confirmingAbort && (
        <p className="message alert" id={abortConfirmationId} role="status">
          <span aria-hidden>! </span>abort {row.slug}? Enter confirms, Esc cancels
        </p>
      )}
      {selected && answerStep?.slug === row.slug && (
        <BlockedAnswerStep
          blocker={row.blockers[0] ?? `Answer required for ${row.slug}.`}
          input={answerStep.input}
          pending={answerPending}
          onInput={onAnswerStepInput}
          onSubmit={onSubmitAnswerStep}
          onCancel={onCancelAnswerStep}
        />
      )}
      {open && (
        <BuildDetail
          id={detailId}
          build={row}
          now={now}
          pending={pending}
          transcript={transcript}
          onAnswer={onAnswer}
          onTranscript={onTranscript}
          onClose={() => onRowToggleDetail(row.slug)}
        />
      )}
    </li>
  )
}

function BlockedAnswerStep({
  blocker,
  input,
  pending,
  onInput,
  onSubmit,
  onCancel,
}: {
  blocker: string
  input: string
  pending: boolean
  onInput: (input: string) => void
  onSubmit: () => void
  onCancel: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => inputRef.current?.focus(), [])

  return (
    <form
      className="answer-step"
      aria-label="Answer blocker"
      onSubmit={(event) => {
        event.preventDefault()
        if (!pending) onSubmit()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          if (!pending) onCancel()
        }
      }}
    >
      <p className="alert answer-blocker" role="status">
        <span aria-hidden>! </span>
        {blocker}
      </p>
      <label className="field">
        <span>optional guidance (empty retries)</span>
        <input
          ref={inputRef}
          // biome-ignore lint/a11y/noAutofocus: opening the keyboard-driven answer step must focus its only field
          autoFocus
          type="text"
          value={input}
          disabled={pending}
          onChange={(event) => onInput(event.target.value)}
        />
      </label>
    </form>
  )
}

type AnswerChoice = OperatorAnswerRequest['resolution'] | 'revise-spec-ticket'

function BuildDetail({
  id,
  build,
  now,
  pending,
  transcript,
  onAnswer,
  onTranscript,
  onClose,
}: {
  id: string
  build: DashboardBuild
  now: number
  pending?: string
  transcript?: TranscriptPresentation
  onAnswer: BuildsViewProps['onAnswer']
  onTranscript: BuildsViewProps['onTranscript']
  onClose: () => void
}) {
  const [resolution, setResolution] = useState<AnswerChoice>('guidance')
  const [text, setText] = useState('')
  const [ceiling, setCeiling] = useState(1)
  const busy = pending !== undefined
  const ceilingText = reviewCeilingText(build)
  const sessions = build.sessions ?? []

  const submit = () => {
    const body: OperatorAnswerRequest =
      resolution === 'guidance'
        ? { resolution, text }
        : resolution === 'retry'
          ? { resolution }
          : resolution === 'dismiss'
            ? { resolution, ...(text ? { text } : {}) }
            : resolution === 'review-round-ceiling'
              ? { resolution, ceiling, ...(text ? { text } : {}) }
              : {
                  resolution: 'revise-spec',
                  origin: resolution === 'revise-spec-ticket' ? 'ticket' : 'body',
                  body: text,
                }
    onAnswer(build.slug, body)
  }

  return (
    <article className="detail" id={id} aria-label={`${build.slug} detail`}>
      <Rule />
      <div className="kv">
        {build.ticketId && (
          <span>
            <span className="k">ticket </span>
            {build.ticketId}
          </span>
        )}
        <span>
          <span className="k">auto merge </span>
          {build.autoMerge}
        </span>
        {ceilingText && <span>{ceilingText}</span>}
        {build.pr && (
          <span>
            <span className="k">PR </span>
            <a
              className="pr"
              data-pr={build.pr.state}
              href={build.pr.url}
              target="_blank"
              rel="noreferrer"
            >
              {build.pr.state}
            </a>{' '}
            <a href={build.pr.url} target="_blank" rel="noreferrer">
              {build.pr.url}
            </a>
          </span>
        )}
        {build.alsoPaused && <span className="warn">(paused)</span>}
      </div>

      {build.abortProgress !== undefined ? (
        <section className="section">
          <h3>Abort progress</h3>
          <pre className="block">{build.abortProgress}</pre>
        </section>
      ) : build.dispatch !== undefined ? (
        <section className="section">
          <h3>Dispatch</h3>
          <pre className="block">{build.dispatch}</pre>
        </section>
      ) : (
        <section className="section">
          <h3>Pipeline</h3>
          <StepLine
            steps={build.steps}
            now={now}
            register="detail"
            label={`${build.slug} pipeline detail`}
          />
        </section>
      )}

      {build.setupError !== undefined && (
        <section className="section alert">
          <h3>Setup failure</h3>
          <pre className="block">{build.setupError}</pre>
        </section>
      )}

      {build.blockers.length > 0 && (
        <section className="section">
          <h3>Unresolved blockers</h3>
          {build.blockers.map((blocker) => (
            <pre className="block alert" key={blocker}>
              ! {blocker}
            </pre>
          ))}
          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault()
              submit()
            }}
          >
            <label className="field">
              <span>resolution</span>
              <span className="selectwrap">
                <select
                  value={resolution}
                  onChange={(event) => setResolution(event.target.value as AnswerChoice)}
                >
                  <option value="guidance">Guidance</option>
                  <option value="retry">Retry</option>
                  <option value="dismiss">Dismiss</option>
                  <option value="review-round-ceiling">Review ceiling</option>
                  <option value="revise-spec">Supply revised spec</option>
                  <option value="revise-spec-ticket">Use amended ticket body</option>
                </select>
              </span>
            </label>
            {resolution === 'review-round-ceiling' && (
              <label className="field">
                <span>ceiling</span>
                <input
                  type="number"
                  min="1"
                  value={ceiling}
                  onChange={(event) => setCeiling(event.target.valueAsNumber)}
                />
              </label>
            )}
            {resolution !== 'retry' && (
              <label className="field">
                <span>
                  {resolution === 'revise-spec' || resolution === 'revise-spec-ticket'
                    ? 'revised body'
                    : 'message'}
                </span>
                <textarea value={text} onChange={(event) => setText(event.target.value)} />
              </label>
            )}
            <div className="controls">
              <button
                type="submit"
                className="btn"
                disabled={busy || (resolution === 'guidance' && !text.trim())}
              >
                Answer escalation
              </button>
            </div>
          </form>
        </section>
      )}

      <section className="section">
        <h3>Sessions</h3>
        {sessions.length > 0 ? (
          <ul className="sessions">
            {sessions.map((session) => (
              <li key={session.id}>
                <b>{session.role}</b>
                <span>phase {session.phase}</span>
                {session.round !== undefined && <span>round {session.round}</span>}
                <span>runtime {session.runtime}</span>
                {session.model !== undefined && <span>model {session.model}</span>}
                <span>{session.status}</span>
                {session.reclaimedBy && (
                  <span className="slack">
                    by {session.reclaimedBy.instance} at resume boundary{' '}
                    {session.reclaimedBy.resumedFromSeq}, transcript unavailable
                  </span>
                )}
                {session.usage && (
                  <span className="slack">
                    tokens {session.usage.inputTokens} in/{session.usage.outputTokens} out,{' '}
                    {session.usage.turns} turns
                  </span>
                )}
                {session.transcript && (
                  <button
                    type="button"
                    className="word"
                    disabled={busy}
                    onClick={() =>
                      onTranscript(build, session.transcript!.kind, session.transcript!.rev)
                    }
                  >
                    open transcript
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="slack">no agent sessions recorded</p>
        )}
        {transcript && <Transcript value={transcript} />}
      </section>

      <div className="controls">
        <button type="button" className="word" onClick={onClose}>
          close detail
        </button>
      </div>
      <Rule />
    </article>
  )
}

function Transcript({ value }: { value: TranscriptPresentation }) {
  if (value.kind === 'raw') {
    return (
      <section className="section">
        <h3>Transcript</h3>
        <pre className="block">{value.text}</pre>
      </section>
    )
  }
  return (
    <section className="section transcript">
      <h3>Transcript</h3>
      {'notice' in value && <p className="warn">{value.notice}</p>}
      {value.turns.map((turn, index) => (
        <article key={`${turn.prompt}-${turn.text}`}>
          <h4>Turn {index + 1}</h4>
          <p>
            <span className="slack">prompt </span>
            {turn.prompt}
          </p>
          <pre className="block">{turn.text}</pre>
          {turn.failure && <p className="alert notice">{turn.failure}</p>}
          {turn.usage && (
            <p className="slack">
              usage {turn.usage.inputTokens} in/{turn.usage.outputTokens} out
              {turn.usage.turns ? `, ${turn.usage.turns} turns` : ''}
            </p>
          )}
        </article>
      ))}
    </section>
  )
}
