'use client'

import type {
  OperatorAnswerRequest,
  OperatorBuildControlRequest,
  OperatorTicketBuild,
} from 'autobuild/operator-api'
import {
  buildActionAvailability,
  type DashboardBuild,
  type DashboardHarvest,
  type DashboardModel,
  repositoryActionAvailability,
  type TranscriptPresentation,
} from 'autobuild/operator-presentation'
import { type CSSProperties, type PointerEvent, type PointerEventHandler, useState } from 'react'
import {
  columnWidths,
  Fastext,
  type FastextCell,
  Flash,
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

export interface BuildsViewProps {
  repo: string
  model?: DashboardModel
  now: number
  pending?: string
  selection?: Selection
  hoverPreview?: Selection
  detailOpen: boolean
  confirmingAbort: boolean
  transcript?: TranscriptPresentation
  linkedBuild?: OperatorTicketBuild
  onActivate: (selection: Selection) => void
  onHoverPreview: (selection: Selection | undefined) => void
  onDeselect: () => void
  onToggleDetail: () => void
  onBuildControl: (slug: string, action: BuildControlAction) => void
  onRequestAbort: () => void
  onCancelAbort: () => void
  onAnswer: (slug: string, body: OperatorAnswerRequest) => void
  onTranscript: (build: DashboardBuild, kind: string, rev: number) => void
  onSetting: (name: 'intake' | 'auto-merge-default', enabled: boolean) => void
  onBulk: (action: 'pause' | 'resume') => void
  onHarvest: (body: HarvestControl) => void
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

const EMPTY_CELLS: readonly [FastextCell?, FastextCell?, FastextCell?, FastextCell?] = [
  undefined,
  undefined,
  undefined,
  undefined,
]

/**
 * The key legend as four Fastext cells. Slot colors are fixed; the labels
 * follow the selection context exactly as the terminal legend does.
 */
export function fastextCells(
  props: Pick<
    BuildsViewProps,
    | 'model'
    | 'pending'
    | 'selection'
    | 'detailOpen'
    | 'confirmingAbort'
    | 'onDeselect'
    | 'onToggleDetail'
    | 'onBuildControl'
    | 'onRequestAbort'
    | 'onCancelAbort'
    | 'onSetting'
    | 'onBulk'
    | 'onHarvest'
  >,
): readonly [FastextCell?, FastextCell?, FastextCell?, FastextCell?] {
  const { model, selection } = props
  if (!model) return EMPTY_CELLS
  const busy = props.pending !== undefined
  const build =
    selection?.kind === 'build'
      ? model.builds.find((row) => row.slug === selection.slug)
      : undefined

  if (build && props.confirmingAbort) {
    return [
      {
        key: '↵',
        label: 'CONFIRM ABORT',
        disabled: busy,
        onPress: () => props.onBuildControl(build.slug, 'abort'),
      },
      undefined,
      undefined,
      { key: 'Esc', label: 'CANCEL', onPress: props.onCancelAbort },
    ]
  }

  if (build) {
    const available = buildActionAvailability(build)
    const primary: FastextCell | undefined = available.primary
      ? {
          key: available.primary === 'resume' ? 'r' : 'p',
          label: available.primary.replace('-', ' ').toUpperCase(),
          disabled: busy,
          onPress: () => props.onBuildControl(build.slug, available.primary!),
        }
      : available.discard
        ? {
            key: 'd',
            label: 'DISCARD',
            disabled: busy,
            onPress: () => props.onBuildControl(build.slug, 'discard'),
          }
        : undefined
    return [
      {
        key: 'a',
        label: 'ABORT',
        disabled: busy || !available.abort,
        onPress: props.onRequestAbort,
      },
      primary,
      {
        key: 'm',
        label: 'AUTO MERGE',
        disabled: busy || !available.autoMerge,
        onPress: () =>
          props.onBuildControl(
            build.slug,
            build.autoMerge === 'off' ? 'auto-merge-on' : 'auto-merge-off',
          ),
      },
      { key: '↵', label: props.detailOpen ? 'CLOSE' : 'DETAILS', onPress: props.onToggleDetail },
    ]
  }

  if (selection?.kind === 'harvest' && model.harvest) {
    const harvest = model.harvest
    return [
      undefined,
      harvest.action
        ? {
            key: 'p',
            label: harvest.action.toUpperCase(),
            disabled: busy,
            onPress: () => props.onHarvest({ action: 'run', run: harvest.run }),
          }
        : undefined,
      {
        key: 'h',
        label: 'HARVEST',
        disabled: busy,
        onPress: () => props.onHarvest({ action: 'toggle-gate' }),
      },
      { key: 'Esc', label: 'DESELECT', onPress: props.onDeselect },
    ]
  }

  const repository = repositoryActionAvailability(model)
  return [
    {
      key: 'p',
      label: 'PAUSE ALL',
      disabled: busy || !repository.bulkPause,
      onPress: () => props.onBulk('pause'),
    },
    {
      key: 'r',
      label: 'RESUME ALL',
      disabled: busy || !repository.bulkResume,
      onPress: () => props.onBulk('resume'),
    },
    {
      key: 'm',
      label: 'AUTO MERGE',
      disabled: busy,
      onPress: () => props.onSetting('auto-merge-default', !model.defaultAutoMerge),
    },
    {
      key: 'i',
      label: 'INTAKE',
      disabled: busy,
      onPress: () => props.onSetting('intake', model.drained),
    },
  ]
}

export function BuildsView(props: BuildsViewProps) {
  const { model, repo, now, selection, hoverPreview, detailOpen, confirmingAbort, linkedBuild } =
    props
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
      <>
        <p className="slack dispatch" aria-live="polite">
          polling {repo || 'no repository'} for its first frame...
        </p>
        <Fastext label="Controls" cells={EMPTY_CELLS} />
      </>
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
  const showTerminalNotice =
    linkedBuild !== undefined &&
    selection?.kind === 'build' &&
    selection.slug === linkedBuild.slug &&
    selectedBuild === undefined

  return (
    <>
      <DispatcherLine
        model={model}
        pending={props.pending}
        onSetting={props.onSetting}
        onHarvest={props.onHarvest}
      />
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
      {showTerminalNotice && (
        <section
          className="terminal-notice"
          id={`build-${encodeURIComponent(linkedBuild.slug)}`}
          aria-label="Most recent ticket build"
        >
          <p>
            <b>Build {linkedBuild.slug}</b>{' '}
            <span className="status" data-status={linkedBuild.status}>
              {linkedBuild.status.toUpperCase()}
            </span>
          </p>
          <p className="slack">This terminal build is not part of the active pipeline table.</p>
        </section>
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
            onPointerEnter={preview({ kind: 'harvest' })}
            onActivate={props.onActivate}
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
            confirmingAbort={confirmingAbort}
            transcript={props.transcript}
            onPointerEnter={preview({ kind: 'build', slug: row.slug })}
            onActivate={props.onActivate}
            onToggleDetail={props.onToggleDetail}
            onAnswer={props.onAnswer}
            onTranscript={props.onTranscript}
          />
        ))}
        {model.builds.length === 0 && !model.harvest && <li className="slack">no active builds</li>}
      </ol>
      <Fastext label="Controls" cells={fastextCells(props)} />
    </>
  )
}

function DispatcherLine({
  model,
  pending,
  onSetting,
  onHarvest,
}: {
  model: DashboardModel
  pending?: string
  onSetting: BuildsViewProps['onSetting']
  onHarvest: BuildsViewProps['onHarvest']
}) {
  const busy = pending !== undefined
  return (
    <section className="line dispatch" aria-label="Dispatcher settings">
      <span>queue {model.queued}</span>
      <span className="sep" aria-hidden>
        |
      </span>
      <span>
        active {model.active.current}/{model.active.limit}
      </span>
      <span className="sep" aria-hidden>
        |
      </span>
      <span>
        observations {model.observations.current}/{model.observations.limit}
      </span>
      <span className="sep" aria-hidden>
        |
      </span>
      <span>
        repository{' '}
        <b className={model.repositoryPaused ? 'off' : 'on'}>
          {model.repositoryPaused ? 'PAUSED' : 'RUNNING'}
        </b>
      </span>
      <span className="settings">
        <button
          type="button"
          className="word"
          disabled={busy}
          onClick={() => onSetting('intake', model.drained)}
        >
          intake <b className={model.drained ? 'off' : 'on'}>{model.drained ? 'OFF' : 'ON'}</b>
        </button>
        <button
          type="button"
          className="word"
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
          className="word"
          disabled={busy}
          onClick={() => onHarvest({ action: 'toggle-gate' })}
        >
          harvest{' '}
          <b className={model.harvestPaused ? 'off' : 'on'}>{model.harvestPaused ? 'OFF' : 'ON'}</b>
        </button>
      </span>
    </section>
  )
}

function HarvestRow({
  harvest,
  now,
  hasTicketColumn,
  selected,
  hovered,
  dimmed,
  onPointerEnter,
  onActivate,
}: {
  harvest: DashboardHarvest
  now: number
  hasTicketColumn: boolean
  selected: boolean
  hovered: boolean
  dimmed: boolean
  onPointerEnter: PointerEventHandler<HTMLLIElement>
  onActivate: BuildsViewProps['onActivate']
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
  transcript,
  onPointerEnter,
  onActivate,
  onToggleDetail,
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
  transcript?: TranscriptPresentation
  onPointerEnter: PointerEventHandler<HTMLLIElement>
  onActivate: BuildsViewProps['onActivate']
  onToggleDetail: BuildsViewProps['onToggleDetail']
  onAnswer: BuildsViewProps['onAnswer']
  onTranscript: BuildsViewProps['onTranscript']
}) {
  const tone = statusTone(row.status)
  const ceiling = reviewCeilingText(row)
  const detailId = `detail-${encodeURIComponent(row.slug)}`
  const open = selected && detailOpen
  const held = model.repositoryPaused && row.status === 'queued'
  const hasTokens = row.autoMerge !== 'off' || row.pr !== undefined || held || row.alsoPaused
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
          aria-pressed={selected}
          aria-expanded={selected ? detailOpen : undefined}
          aria-controls={open ? detailId : undefined}
          onClick={() => onActivate({ kind: 'build', slug: row.slug })}
        >
          <span className="ticket">{row.ticketId ?? ''}</span>
          <span className="slug">{row.slug}</span>
        </button>
        {hasTokens && (
          <span className="tokens">
            {row.autoMerge !== 'off' && (
              <span className="am" data-am={row.autoMerge}>
                auto merge
              </span>
            )}
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
        )}
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
      {selected && confirmingAbort && (
        <p className="message alert" role="status">
          <span aria-hidden>! </span>abort {row.slug}? Enter confirms, Esc cancels
        </p>
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
          onClose={onToggleDetail}
        />
      )}
    </li>
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
