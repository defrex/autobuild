'use client'

import type {
  OperatorAnswerRequest,
  OperatorBuildControlRequest,
} from '@defrex/autobuild-hosted-store-service/operator-api'
import {
  formatHandoff,
  formatRollback,
  handPushedLabel,
  handPushedText,
  displayText,
  buildActionAvailability,
  capacityExplanation,
  landingPolicyDisplay,
  mergeVocabulary,
  mergeSummary,
  mergedChildren,
  type DashboardBuild,
  repositoryActionAvailability,
  type DashboardHarvest,
  type DashboardModel,
} from '@defrex/autobuild/operator-presentation'
import type { OperatorTicketDetail } from '@defrex/autobuild-hosted-store-service/operator-api'
import Link from 'next/link'
import {
  type CSSProperties,
  type PointerEvent,
  type PointerEventHandler,
  type ReactNode,
  useCallback,
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
  StepLine,
} from './frame'
import { ConfirmDialog } from './ConfirmDialog'
import { LoadMore } from './LoadMore'
import { buildLink } from './project-selection'
import { BuildTicketSection } from './tickets'
import { pipelineProvenance } from './view-model'

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

interface RowClickTarget {
  closest: (selectors: string) => unknown
}

/**
 * Whether a pointer click landed on the row itself rather than on a control,
 * a link, or a field. Only such clicks open the build, so every explicit
 * action keeps its own meaning.
 */
export function isRowSurfaceClick(target: RowClickTarget | null, selectedText = ''): boolean {
  if (selectedText.length > 0) return false
  return (
    target?.closest(
      'button, a[href], input, select, textarea, label, .detail, .answer-step, .signoff',
    ) == null
  )
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
  onActivate: (selection: Selection) => void
  onHoverPreview: (selection: Selection | undefined) => void
  onOpenBuild: (slug: string) => void
  onRowBuildControl: (slug: string, action: BuildControlAction) => void
  onRowHarvest: (body: Extract<HarvestControl, { action: 'run' }>) => void
}

export type AnswerStep = { slug: string; escalationIds: string[]; input: string }

export interface BuildPageViewProps {
  repo: string
  slug: string
  model?: DashboardModel
  now: number
  pending?: string
  confirmingAbort: boolean
  answerStep?: AnswerStep
  answerPending: boolean
  /** The build's ticket, read live from the ticket source. */
  ticket: { detail?: OperatorTicketDetail; error?: string }
  onRowBuildControl: (slug: string, action: BuildControlAction) => void
  onRowRequestAbort: (slug: string) => void
  onCancelAbort: () => void
  onAnswerStepInput: (input: string) => void
  onSubmitAnswerStep: () => void
  onCancelAnswerStep: () => void
  onAnswer: (slug: string, body: OperatorAnswerRequest) => void
}

type Tone = 'alert' | 'warn' | 'live' | 'ok'

/** The terminal renderer's status color map, as tones. */
function statusTone(status: DashboardBuild['status'] | DashboardHarvest['status']): Tone {
  switch (status) {
    case 'collecting':
    case 'queued':
    case 'resuming':
      return 'live'
    case 'running':
      return 'ok'
    case 'pausing':
    case 'paused':
    case 'suspended':
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

/** Builds page like ticket lists; most projects fit on the first page. */
const BUILD_PAGE = 25

export function BuildsView(props: BuildsViewProps) {
  const { model, repo, now, selection, hoverPreview } = props
  const [shown, setShown] = useState(BUILD_PAGE)
  const showMore = useCallback(() => setShown((count) => count + BUILD_PAGE), [])
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
  return (
    <DashboardSurface>
      {Boolean(
        model.warningLines?.length ||
          model.availableUpgrade ||
          model.handoffs?.length ||
          model.rollback ||
          model.capacity?.borrowingNodes.length,
      ) && (
        <div className="messages">
          {model.capacity?.borrowingNodes.length ? (
            <p className="slack notice capacity-notice">
              active {model.active.current}/{model.active.limit}
              {capacityExplanation(model.capacity)}
            </p>
          ) : null}
          {model.rollback && <p className="warn notice">{formatRollback(model.rollback)}</p>}
          {model.handoffs?.map((handoff) => (
            <p className="warn notice" key={`${handoff.run}:${handoff.correlation}`}>
              {formatHandoff(handoff)}
            </p>
          ))}
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
            pending={props.pending}
            onPointerEnter={preview({ kind: 'harvest' })}
            onActivate={props.onActivate}
            onRowHarvest={props.onRowHarvest}
          />
        )}
        {model.builds.slice(0, shown).map((row) => (
          <BuildRow
            key={row.slug}
            row={row}
            model={model}
            now={now}
            href={buildLink(repo, row.slug)}
            pending={props.pending}
            hovered={hoverPreview?.kind === 'build' && hoverPreview.slug === row.slug}
            onPointerEnter={preview({ kind: 'build', slug: row.slug })}
            onOpen={props.onOpenBuild}
            onRowBuildControl={props.onRowBuildControl}
          />
        ))}
        {model.builds.length === 0 && !model.harvest && <li className="slack">no active builds</li>}
      </ol>
      <LoadMore
        shown={Math.min(shown, model.builds.length)}
        total={model.builds.length}
        loading={false}
        onMore={showMore}
      />
      <section className="legend" aria-label="Step marks">
        <span>
          <code className="ok">[x]</code> done
        </span>
        <span>
          <code className="live">[&gt;]</code> happening now
        </span>
        <span>
          <code className="warn">[~]</code> in progress or retried
        </span>
        <span>
          <code>[ ]</code> not started
        </span>
      </section>
    </DashboardSurface>
  )
}

export interface DispatcherControlsProps {
  model: DashboardModel
  pending?: string
  onSetting: (name: 'intake', enabled: boolean) => void
  onHarvest: (body: HarvestControl) => void
  onBulk: (action: 'pause' | 'resume') => void
}

/** Builds facts and settings composed into the shell's shared control line. */
export function DispatcherControls({
  model,
  pending,
  onSetting,
  onHarvest,
  onBulk,
}: DispatcherControlsProps) {
  const busy = pending !== undefined
  const repository = repositoryActionAvailability(model)
  return (
    <>
      {model.repositoryPaused && (
        <span className="control-item toggle repository-state">
          repository<b className="off">PAUSED</b>
        </span>
      )}
      <button
        type="button"
        className="word control-item toggle"
        disabled={busy}
        onClick={() => onSetting('intake', model.drained)}
      >
        intake<b className={model.drained ? 'off' : 'on'}>{model.drained ? 'OFF' : 'ON'}</b>
      </button>

      <button
        type="button"
        className="word control-item toggle"
        disabled={busy}
        onClick={() => onHarvest({ action: 'toggle-gate' })}
      >
        harvest
        <b className={model.harvestPaused ? 'off' : 'on'}>{model.harvestPaused ? 'OFF' : 'ON'}</b>
      </button>
      <button
        type="button"
        className="word control-item"
        disabled={busy || !repository.bulkPause}
        onClick={() => onBulk('pause')}
      >
        pause all
      </button>
      <button
        type="button"
        className="word control-item"
        disabled={busy || !repository.bulkResume}
        onClick={() => onBulk('resume')}
      >
        resume all
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
  pending?: string
  onPointerEnter: PointerEventHandler<HTMLLIElement>
  onActivate: BuildsViewProps['onActivate']
  onRowHarvest: BuildsViewProps['onRowHarvest']
}) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the row surface is a pointer convenience; the title button is the keyboard path
    <li
      className="row harvest"
      data-status={harvest.status}
      data-selected={selected || undefined}
      data-hovered={hovered || undefined}
      onPointerEnter={onPointerEnter}
      onClick={(event) => {
        if (isRowSurfaceClick(event.target as Element, window.getSelection()?.toString()))
          onActivate({ kind: 'harvest' })
      }}
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
          {harvest.action && (
            <button
              type="button"
              className="word run-action"
              disabled={pending !== undefined}
              aria-label={`${harvest.action.toUpperCase()} Harvest run ${harvest.run}`}
              onClick={() => onRowHarvest({ action: 'run', run: harvest.run })}
            >
              {harvest.action.toUpperCase()}
            </button>
          )}
          <span className="slack">
            {harvest.rounds} {harvest.rounds === 1 ? 'round' : 'rounds'}
          </span>
        </span>
        <span className="status" data-status={harvest.status}>
          <Flash value={harvest.status}>{harvest.status.toUpperCase()}</Flash>
        </span>
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
  href,
  pending,
  hovered,
  onPointerEnter,
  onOpen,
  onRowBuildControl,
}: {
  row: DashboardBuild
  model: DashboardModel
  now: number
  href: string
  pending?: string
  hovered: boolean
  onPointerEnter: PointerEventHandler<HTMLLIElement>
  onOpen: BuildsViewProps['onOpenBuild']
  onRowBuildControl: BuildsViewProps['onRowBuildControl']
}) {
  const tone = statusTone(row.status)
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the row surface is a pointer convenience; the title link is the keyboard path
    <li
      className="row"
      id={`build-${encodeURIComponent(row.slug)}`}
      data-status={row.status}
      data-hovered={hovered || undefined}
      onPointerEnter={onPointerEnter}
      onClick={(event) => {
        if (isRowSurfaceClick(event.target as Element, window.getSelection()?.toString()))
          onOpen(row.slug)
      }}
    >
      <BuildSummary
        row={row}
        model={model}
        heading={
          <Link className="rowhead" href={href} aria-label={`Open ${row.slug}`}>
            <BuildHeading row={row} />
          </Link>
        }
      />
      {row.integrationRow ? (
        <>
          <p className="sub integration-progress">
            integration into {row.integrationRow.destination}
            {row.integrationRow.parentDistance && (
              <span className="slack"> {row.integrationRow.parentDistance}</span>
            )}
            {'  '}
            {row.integrationRow.children.known ? (
              row.integrationRow.children.total ? (
                <>
                  <span className="ok">
                    {mergedChildren(
                      row.integrationRow.children.landed,
                      row.integrationRow.children.total,
                    )}
                  </span>
                  {row.integrationRow.children.building > 0 && (
                    <span className="live"> · {row.integrationRow.children.building} building</span>
                  )}
                  {row.integrationRow.children.queued > 0 && (
                    <span className="slack"> · {row.integrationRow.children.queued} queued</span>
                  )}
                </>
              ) : (
                <span className="slack">no children yet</span>
              )
            ) : (
              <span className="slack">children unknown</span>
            )}
            {row.integrationRow.verified && <span className="ok"> · verified</span>}
          </p>
          <StepLine steps={row.integrationRow.steps} now={now} label={`${row.slug} pipeline`} />
          {row.integrationRow.alert && (
            <p
              className={`sub integration-alert ${row.integrationRow.alert.tone === 'red' ? 'alert' : 'warn'}`}
              role="status"
            >
              <span aria-hidden>! </span>
              {row.integrationRow.alert.text}
            </p>
          )}
        </>
      ) : row.abortProgress !== undefined ? (
        <MessagePreview value={row.abortProgress} tone={tone} expandable={false} />
      ) : row.dispatch !== undefined ? (
        <MessagePreview value={row.dispatch} tone={tone} expandable={false} />
      ) : (
        <StepLine steps={row.steps} now={now} label={`${row.slug} pipeline`} />
      )}
      {!row.integrationRow && row.setupError !== undefined && (
        <MessagePreview value={row.setupError} tone="alert" expandable />
      )}
      {!row.integrationRow &&
        row.blockers.map((blocker) => (
          <p className="sub alert" key={blocker}>
            ! {blocker}
          </p>
        ))}
      {!row.integrationRow && row.status === 'blocked' && row.blockers.length > 0 && (
        <p className="sub">
          <Link className="word answer-link" href={href}>
            answer escalation
          </Link>
        </p>
      )}
      {awaitingConsent(row) && (
        <LandingSignoff
          slug={row.slug}
          pending={pending !== undefined}
          onControl={onRowBuildControl}
        />
      )}
    </li>
  )
}

function BuildHeading({ row }: { row: DashboardBuild }) {
  return (
    <>
      <span className="ticket">{row.ticketId ?? ''}</span>
      <span className="build-title">{row.collectionIdentity?.title || row.slug}</span>
    </>
  )
}

/** Identity, status, and the meta line a build shows in its row and atop its page. */
function BuildSummary({
  row,
  model,
  heading,
}: {
  row: DashboardBuild
  model: DashboardModel
  heading: ReactNode
}) {
  const ceiling = reviewCeilingText(row)
  const held = model.repositoryPaused && row.status === 'queued'
  return (
    <>
      <div className="rowline">
        <span className="lane" aria-hidden />
        {heading}
        <span className="status" data-status={row.status}>
          <Flash value={row.status}>{row.status.toUpperCase()}</Flash>
        </span>
      </div>
      <div className="build-meta">
        <span className="slug">{row.slug}</span>
        {!row.integrationRow && row.target && (
          <>
            {' '}
            · {row.kind ?? 'work'} · target <span className="machine">{row.target}</span>
            {row.targetDistance && <span className="slack"> {row.targetDistance}</span>}
            {row.integration ? ` · ${row.integration}` : ''}
          </>
        )}
        {
          <span className="tokens">
            {!row.integrationRow && <span>{mergeSummary(row)}</span>}
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
            {row.draining && <span className="warn draining">(draining)</span>}
            {row.alsoPaused && <span className="warn">(paused)</span>}
          </span>
        }
      </div>
      {!row.integrationRow && ceiling && <p className="sub">{ceiling}</p>}
    </>
  )
}

/** A build's own page: its identity, any escalation to answer, and its full detail. */
export function BuildPageView(props: BuildPageViewProps) {
  const { model, slug, now, pending, answerStep, answerPending } = props
  if (!model) {
    return (
      <DashboardSurface>
        <LoadingRows kind="build-page" label={`Loading ${slug}.`} />
      </DashboardSurface>
    )
  }
  const row = model.builds.find((build) => build.slug === slug)
  if (!row) {
    return (
      <DashboardSurface>
        <p className="slack build-missing">
          {slug} is not an active build. It may have merged, closed, or been aborted.
        </p>
      </DashboardSurface>
    )
  }
  const answering = answerStep?.slug === row.slug
  return (
    <DashboardSurface>
      <article className="build-page" aria-label={row.slug}>
        <header className="build-head">
          <BuildSummary
            row={row}
            model={model}
            heading={
              <h2 className="rowhead">
                <BuildHeading row={row} />
              </h2>
            }
          />
          {!answering && (
            <BuildActions
              build={row}
              pending={pending}
              confirmingAbort={props.confirmingAbort}
              onRowBuildControl={props.onRowBuildControl}
              onRowRequestAbort={props.onRowRequestAbort}
              onCancelAbort={props.onCancelAbort}
            />
          )}
        </header>
        {!row.integrationRow && row.status === 'blocked' && row.blockers.length > 0 && (
          <section className="signoff" aria-label={`Escalation for ${row.slug}`}>
            {row.blockers.map((blocker) => (
              <p className="q" key={blocker}>
                ! {blocker}
              </p>
            ))}
            <p className="why">
              The build stopped to ask a person. Your answer resumes it from where it paused.
            </p>
            {answering && answerStep && (
              <>
                <BlockedAnswerStep
                  blocker={row.blockers[0] ?? ''}
                  input={answerStep.input}
                  pending={answerPending}
                  onInput={props.onAnswerStepInput}
                  onSubmit={props.onSubmitAnswerStep}
                  onCancel={props.onCancelAnswerStep}
                />
                <div
                  className="controls actions"
                  role="toolbar"
                  aria-label={`Controls for ${row.slug}`}
                  onKeyDown={(event) => handleRowControlKey(event, props.onCancelAnswerStep)}
                >
                  <button
                    type="button"
                    className="btn primary action"
                    disabled={pending !== undefined || answerPending}
                    aria-label={`SUBMIT answer for ${row.slug}`}
                    onClick={props.onSubmitAnswerStep}
                  >
                    SUBMIT
                  </button>
                  <button
                    type="button"
                    className="word action"
                    disabled={pending !== undefined || answerPending}
                    aria-label={`CANCEL answer for ${row.slug}`}
                    onClick={props.onCancelAnswerStep}
                  >
                    CANCEL
                  </button>
                </div>
              </>
            )}
            {!answering && (
              <AnswerComposer
                build={row}
                busy={pending !== undefined || answerPending}
                onAnswer={props.onAnswer}
              />
            )}
          </section>
        )}
        {!row.integrationRow &&
          row.status !== 'blocked' &&
          row.blockers.map((blocker) => (
            <p className="sub alert" key={blocker}>
              ! {blocker}
            </p>
          ))}
        {awaitingConsent(row) && (
          <LandingSignoff
            slug={row.slug}
            pending={pending !== undefined}
            onControl={props.onRowBuildControl}
          />
        )}
        <BuildDetail build={row} now={now} />
        <BuildTicketSection ticketId={row.ticketId} {...props.ticket} />
      </article>
    </DashboardSurface>
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
      <span className="sr-only">{blocker}</span>
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

/** The emphasis each build control carries: one primary, destructive ones ghosted. */
function actionClass(action: BuildRowAction['action']): string {
  if (action === 'request-abort') return 'btn ghost action'
  if (action === 'discard') return 'btn action'
  return 'btn primary action'
}

/**
 * A build's controls as buttons beside its identity. Abort asks again in a
 * modal, so nothing destructive is written on the first press and the page
 * does not shift.
 */
function BuildActions({
  build,
  pending,
  confirmingAbort,
  onRowBuildControl,
  onRowRequestAbort,
  onCancelAbort,
}: {
  build: DashboardBuild
  pending?: string
  confirmingAbort: boolean
  onRowBuildControl: BuildPageViewProps['onRowBuildControl']
  onRowRequestAbort: BuildPageViewProps['onRowRequestAbort']
  onCancelAbort: BuildPageViewProps['onCancelAbort']
}) {
  const busy = pending !== undefined
  // The primary control leads; abort, the destructive one, goes last.
  const controls = buildRowActions(build).sort(
    (a, b) => Number(a.action === 'request-abort') - Number(b.action === 'request-abort'),
  )
  if (!controls.length) return null
  return (
    <>
      <div
        className="controls actions build-actions"
        role="toolbar"
        aria-label={`Controls for ${build.slug}`}
        onKeyDown={(event) => handleRowControlKey(event)}
      >
        {controls.map((control) => (
          <button
            type="button"
            className={actionClass(control.action)}
            key={control.action}
            disabled={busy}
            aria-label={`${control.label} ${build.slug}`}
            onClick={() => {
              if (control.action === 'request-abort') onRowRequestAbort(build.slug)
              else onRowBuildControl(build.slug, control.action)
            }}
          >
            {control.label}
          </button>
        ))}
      </div>
      <ConfirmDialog
        open={confirmingAbort}
        title={`Abort ${build.slug}?`}
        confirmLabel="Abort build"
        pending={busy}
        onConfirm={() => onRowBuildControl(build.slug, 'abort')}
        onCancel={onCancelAbort}
      >
        <p>
          The live session stops, the workspace and branches are removed, and an open pull request
          is closed. The ticket returns to Triage labelled as aborted.
        </p>
      </ConfirmDialog>
    </>
  )
}

function BuildDetail({ build, now }: { build: DashboardBuild; now: number }) {
  const ceilingText = reviewCeilingText(build)

  return (
    <article
      className={build.integrationDetail ? 'detail integration-detail' : 'detail'}
      aria-label={`${build.slug} detail`}
    >
      <div className="kv">
        {build.ticketId && (
          <span>
            <span className="k">ticket </span>
            {build.ticketId}
          </span>
        )}
        {!build.integrationDetail && (
          <span>
            <span className="k">{mergeVocabulary.label} </span>
            {landingPolicyDisplay(build.landing)}
          </span>
        )}
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
        {build.draining && <span className="warn draining">(draining)</span>}
        {build.alsoPaused && <span className="warn">(paused)</span>}
        {pipelineProvenance(build) && (
          <span>
            <span className="k">pipeline </span>
            {pipelineProvenance(build)}
          </span>
        )}
      </div>

      {build.integrationDetail &&
        build.integrationRow &&
        (() => {
          const detail = build.integrationDetail
          const counts = build.integrationRow.children
          const open = detail.children.filter((c) => !c.landed).length
          return (
            <>
              <section className="section">
                <div className="kv">
                  <span>
                    <span className="k">Integration </span>
                    {displayText(detail.destination)}
                  </span>
                </div>
                <div className="kv">
                  <span>
                    <span className="k">Progress </span>
                    {counts.known
                      ? `${mergedChildren(counts.landed, counts.total)} · ${counts.building} building · ${counts.queued} queued`
                      : 'children unknown'}
                  </span>
                </div>
                <div className="kv">
                  <span>
                    <span className="k">Branch </span>
                    {displayText(detail.branch)} · restack {displayText(detail.restack)}
                    <span className="slack">
                      {' '}
                      · Parent {build.integrationRow?.destination}
                      {detail.parentDistance ? ` ${displayText(detail.parentDistance)}` : ''}
                    </span>
                  </span>
                </div>
                {detail.conflictFiles?.map((path) => (
                  <p className="alert" style={{ overflowWrap: 'anywhere' }} key={displayText(path)}>
                    {displayText(path)}
                  </p>
                ))}
                <div className="kv" style={{ overflowWrap: 'anywhere' }}>
                  <span>
                    <span className="k">{handPushedLabel} </span>
                    {displayText(handPushedText(detail.handPushedCommits))}
                  </span>
                </div>
                <h3>Steps</h3>
                <StepLine
                  steps={build.integrationRow.steps}
                  now={now}
                  register="detail"
                  label={`${build.slug} integration steps`}
                />
              </section>
              <section className="section">
                <h3>
                  Children · {open} open · {detail.children.length - open} {mergeVocabulary.merged}
                  {!detail.membershipKnown && ' · membership unknown'}
                </h3>
                {detail.children.map((child) => (
                  <div
                    className="kv"
                    style={{ display: 'flex', flexWrap: 'nowrap', gap: '1ch' }}
                    key={`${child.source}:${displayText(child.id)}`}
                  >
                    <span style={{ flexShrink: 0, maxWidth: '40%', overflowWrap: 'anywhere' }}>
                      {displayText(child.id)}
                    </span>
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={displayText(child.title)}
                    >
                      {displayText(child.title)}
                    </span>
                    <span
                      style={{ flexShrink: 0, maxWidth: '40%', overflowWrap: 'anywhere' }}
                      className={child.landed ? 'ok' : child.state === 'queued' ? 'slack' : 'live'}
                    >
                      {displayText(child.state)}
                    </span>
                  </div>
                ))}
                {detail.diagnostics.map((text) => (
                  <p className="slack" key={displayText(text)}>
                    {displayText(text)}
                  </p>
                ))}
              </section>
              <section className="section" style={{ overflowWrap: 'anywhere' }}>
                <h3>Verification</h3>
                <p>{displayText(detail.verification)}</p>
                {detail.verifySteps.map((result) => (
                  <div className="kv" key={displayText(result.step)}>
                    <span>
                      <span className="k">{displayText(result.step)} </span>
                      {displayText(result.outcome)}
                    </span>
                  </div>
                ))}
              </section>
              <section className="section" style={{ overflowWrap: 'anywhere' }}>
                <h3>{mergeVocabulary.title}</h3>
                <p>{displayText(detail.landing)}</p>
              </section>
            </>
          )
        })()}

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
      ) : !build.integrationDetail ? (
        <section className="section">
          <h3>Pipeline</h3>
          <StepLine
            steps={build.steps}
            now={now}
            register="detail"
            label={`${build.slug} pipeline detail`}
          />
        </section>
      ) : null}

      {build.setupError !== undefined && (
        <section className="section alert">
          <h3>Setup failure</h3>
          <pre className="block">{build.setupError}</pre>
        </section>
      )}
    </article>
  )
}

export function awaitingConsent(build: DashboardBuild): boolean {
  if (build.landing?.decision?.mode !== 'consent' || build.landing.command?.kind === 'land')
    return false
  if (build.integrationRow)
    return build.status === 'collecting' && build.integration === 'awaiting consent'
  const merge = build.steps.find((step) => step.label === 'merge')
  return build.status === 'running' && merge?.state === 'current' && merge.qualifier === 'waiting'
}

function AnswerComposer({
  build,
  busy,
  onAnswer,
}: {
  build: DashboardBuild
  busy: boolean
  onAnswer: BuildPageViewProps['onAnswer']
}) {
  const [resolution, setResolution] = useState<AnswerChoice>('guidance')
  const [text, setText] = useState('')
  const [ceiling, setCeiling] = useState(1)

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
            disabled={busy}
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
            disabled={busy}
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
          <textarea
            disabled={busy}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
      )}
      <div className="controls">
        <button
          type="submit"
          className="btn primary"
          disabled={busy || (resolution === 'guidance' && !text.trim())}
        >
          Answer escalation
        </button>
      </div>
    </form>
  )
}

export function LandingSignoff({
  slug,
  pending,
  onControl,
}: {
  slug: string
  pending: boolean
  onControl: BuildPageViewProps['onRowBuildControl']
}) {
  return (
    <section
      className="signoff landing"
      aria-label={`${mergeVocabulary.title} consent for ${slug}`}
    >
      <p>{mergeVocabulary.consent}</p>
      <div className="controls">
        <button
          type="button"
          className="btn primary"
          disabled={pending}
          onClick={() => onControl(slug, 'land')}
        >
          {mergeVocabulary.title}
        </button>
        <button
          type="button"
          className="btn"
          disabled={pending}
          onClick={() => onControl(slug, 'hold')}
        >
          Hold
        </button>
      </div>
    </section>
  )
}
