/**
 * The dashboard's shared row, header and overview text: what each row says,
 * as plain data. The terminal renderer paints these values, and the web
 * protocol carries the same ones, so a term changes here or nowhere.
 *
 * Pure projections over the existing `DashboardModel`: no IO, no clock, and no
 * terminal escapes. Every value survives a JSON round trip unchanged (no
 * `undefined` members), because web frames are compared serialized. Elapsed
 * time travels as step `timing` and is formatted against the viewer's clock by
 * `./vocabulary`, so a frame does not change every second.
 *
 * Layout (padding, truncation, wrapping, separators) stays with each frontend.
 */
import { capacityExplanation, type SlotState } from '../../kernel/dispatch-capacity'
import type { BuildRosterFinished } from '../../kernel/build-roster'
import type { DispatchHealth } from '../../kernel/dispatch-status'
import { NO_DISPATCHER_RUN_LINE, activeCounterText } from './configuration'
import type { DashboardHandoff } from './handoff'
import type { IntegrationRow } from './integration-row'
import { mergeSummary, mergeVocabulary, mergedChildren } from './landing-display'
import type { DashboardBuild, DashboardHarvest, DashboardModel, PipelineStep } from './model'
import type { ObjectiveRow } from './objective-row'
import { treeVocabulary } from './tree'
import {
  dispatchedByText,
  dispatcherModeWord,
  finishedOutcomeText,
  statusText,
  stepMark,
  stepTone,
  type DashboardTone,
  type DispatcherMode,
  type StatusText,
} from './vocabulary'

export interface ToneText {
  text: string
  tone: DashboardTone
}

/** A pipeline step with its glyph and tone. Timing stays raw for the clock. */
export type StepText = PipelineStep & { mark: string; tone: DashboardTone }

export type RowFlag = 'held' | 'draining' | 'paused'

export type RowAttentionKind = 'alert' | 'wait' | 'setup-error' | 'escalation'

export interface RowAttention extends ToneText {
  kind: RowAttentionKind
}

export interface RowProgress {
  /** Raw child counts for a progress bar. */
  children: IntegrationRow['children']
  /** Ordered count terms; the first is never preceded by a separator. */
  counts: ToneText[]
  verified: boolean
}

export interface DashboardRowText {
  slug: string
  ticketId?: string
  /** The ticket's title. Ticket identity: the terminal row does not show it,
   * and the web titles the row with it (Title First), falling back to the slug. */
  title?: string
  /** The ticket's address in its tracker. Ticket identity, as `title` is. */
  ticketUrl?: string
  kind: 'work' | 'integration'
  status: StatusText
  /** The build's slot state, passed through from the projection; absent is
   * unknown, never `none`. */
  slot?: SlotState
  /** The label of the step currently running. */
  phase?: string
  /** Ordered parenthesised annotations beside the status. */
  flags: { term: RowFlag; tone: DashboardTone }[]
  /** Merge intent; absent for integration builds. */
  merge?: ToneText
  pr?: { text: string; url: string }
  /** Destination and its distance suffix, raw text. */
  target?: { destination: string; distance: string }
  progress?: RowProgress
  objective?: ObjectiveRow
  tree?: string[]
  ceiling?: string
  steps: StepText[]
  /** Shown in place of the steps while present. */
  notice?: ToneText
  attention: RowAttention[]
}

export interface HarvestRowText {
  title: string
  status: StatusText
  observations: string
  steps: StepText[]
  detail?: ToneText
}

export interface HeaderCount {
  label: 'triage' | 'queue' | 'active'
  value: string
}

export interface HeaderGate {
  label: 'intake' | 'harvest' | 'repository'
  word: string
  tone: DashboardTone
}

export interface DashboardHeaderText {
  counts: HeaderCount[]
  /** Why the active limit differs from the configured one. */
  capacityNote?: string
  gates: HeaderGate[]
}

export interface DispatcherModeText {
  mode: DispatcherMode
  word: string
  tone: DashboardTone
  detail?: string
}

export type AttentionKind =
  | 'escalation'
  | 'setup-error'
  | 'failure'
  | 'consent'
  | 'wait'
  | 'harvest'

export interface AttentionItem extends ToneText {
  kind: AttentionKind
  slug?: string
  ticketId?: string
}

export interface FinishedRowText {
  slug: string
  kind: 'work' | 'integration'
  outcome: BuildRosterFinished['outcome']
  word: string
  tone: DashboardTone
  completedAt: string
}

export interface DashboardOverview {
  dispatcher: DispatcherModeText
  header: DashboardHeaderText
  attention: AttentionItem[]
  active: DashboardRowText[]
  queued: DashboardRowText[]
  finished: FinishedRowText[]
  harvest?: HarvestRowText
}

export const HARVEST_TITLE = 'Harvest'

const alertTone = (tone: 'red' | 'yellow'): DashboardTone => (tone === 'red' ? 'alert' : 'held')

function stepText(step: PipelineStep): StepText {
  return {
    label: step.label,
    state: step.state,
    ...(step.qualifier !== undefined ? { qualifier: step.qualifier } : {}),
    ...(step.count !== undefined ? { count: step.count } : {}),
    ...(step.timing !== undefined
      ? {
          timing: {
            accumulatedMs: step.timing.accumulatedMs,
            ...(step.timing.runningSince !== undefined
              ? { runningSince: step.timing.runningSince }
              : {}),
          },
        }
      : {}),
    ...(step.reason !== undefined ? { reason: step.reason } : {}),
    mark: stepMark(step.state),
    tone: stepTone(step.state),
  }
}

function mergeTone(autoMerge: DashboardBuild['autoMerge']): DashboardTone {
  if (autoMerge === 'enabled') return 'ok'
  if (autoMerge === 'requested' || autoMerge === 'polling') return 'live'
  if (autoMerge === 'cancelling' || autoMerge === 'human-merge') return 'held'
  return 'pending'
}

export function reviewRoundCeilingText(build: DashboardBuild): string | undefined {
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

/** An integration row's progress terms: child counts and verification. */
export function projectProgress(row: IntegrationRow): RowProgress {
  const children = row.children
  let counts: ToneText[] = [{ text: 'children unknown', tone: 'pending' }]
  if (children.known) {
    counts = children.total
      ? [
          { text: mergedChildren(children.landed, children.total), tone: 'ok' },
          ...(children.building
            ? [{ text: `${children.building} building`, tone: 'live' as const }]
            : []),
          ...(children.queued
            ? [{ text: `${children.queued} queued`, tone: 'pending' as const }]
            : []),
        ]
      : [{ text: 'no children yet', tone: 'pending' }]
  }
  return { children: { ...children }, counts, verified: row.verified }
}

function treeLines(build: DashboardBuild): string[] | undefined {
  const tree = build.tree
  if (!tree || (build.kind !== 'integration' && !tree.consent)) return undefined
  return [
    `${tree.branch ?? 'unknown branch'} · ${treeVocabulary.restack} ${tree.restack} · ${treeVocabulary.verify} ${tree.verification.current ? treeVocabulary.current : treeVocabulary.pending} · ${tree.reason ?? (tree.ready ? treeVocabulary.readyToLand : treeVocabulary.notReady)}`,
    ...(tree.kind === 'node'
      ? [
          `${treeVocabulary.children} ${tree.children?.length ?? 'unknown'} · ${tree.completeness}${tree.diagnostics?.length ? ` · ${tree.diagnostics.join('; ')}` : ''}`,
        ]
      : []),
  ]
}

/**
 * Everything one build row says. Integration rows (an `integrationRow` is
 * present) show their own steps, progress and alert, and hide the tree,
 * ceiling, notice and blockers, as the terminal row does.
 */
export function projectRowText(
  build: DashboardBuild,
  options: { repositoryPaused: boolean },
): DashboardRowText {
  const status = statusText(build.status)
  const row = build.integrationRow
  const steps = (row?.steps ?? build.steps).map(stepText)
  const phase = steps.find((step) => step.state === 'current')?.label
  const flags: DashboardRowText['flags'] = [
    // A repository hold changes no build lifecycle state: QUEUED stays literal
    // and only the rows the hold prevents from launching are annotated.
    ...(options.repositoryPaused && build.status === 'queued'
      ? [{ term: 'held' as const, tone: 'held' as const }]
      : []),
    ...(build.draining ? [{ term: 'draining' as const, tone: 'held' as const }] : []),
    // Blocked overrides paused visually; the pause still rides along.
    ...(build.alsoPaused ? [{ term: 'paused' as const, tone: 'held' as const }] : []),
  ]
  const destination = row?.destination ?? build.target
  const distance = row?.parentDistance ?? build.targetDistance ?? '+?'
  const ceiling = row ? undefined : reviewRoundCeilingText(build)
  const tree = row ? undefined : treeLines(build)
  const noticeText = row ? undefined : (build.abortProgress ?? build.dispatch)
  const attention: RowAttention[] = row
    ? row.alert
      ? [
          {
            kind: 'alert',
            tone: alertTone(row.alert.tone),
            text: row.alert.text,
          },
        ]
      : []
    : [
        ...(build.alert
          ? [
              {
                kind: 'alert' as const,
                tone: alertTone(build.alert.tone),
                text: build.alert.text,
              },
            ]
          : []),
        // A ticket wait is held work, not a blocker.
        ...(build.wait
          ? [
              {
                kind: 'wait' as const,
                tone: 'held' as const,
                text: build.wait.text,
              },
            ]
          : []),
        ...(build.setupError !== undefined
          ? [
              {
                kind: 'setup-error' as const,
                tone: 'alert' as const,
                text: build.setupError,
              },
            ]
          : []),
        ...build.blockers.map((text) => ({
          kind: 'escalation' as const,
          tone: 'alert' as const,
          text,
        })),
      ]
  return {
    slug: build.slug,
    ...(build.ticketId !== undefined ? { ticketId: build.ticketId } : {}),
    ...(build.collectionIdentity?.title !== undefined
      ? { title: build.collectionIdentity.title }
      : {}),
    ...(build.collectionIdentity?.url !== undefined
      ? { ticketUrl: build.collectionIdentity.url }
      : {}),
    kind: build.kind === 'integration' ? 'integration' : 'work',
    status,
    ...(build.slot !== undefined ? { slot: build.slot } : {}),
    ...(phase !== undefined ? { phase } : {}),
    flags,
    ...(build.kind !== 'integration'
      ? {
          merge: {
            text: mergeSummary(build),
            tone: mergeTone(build.autoMerge),
          },
        }
      : {}),
    ...(build.pr !== undefined ? { pr: { text: `PR ${build.pr.state}`, url: build.pr.url } } : {}),
    ...(destination ? { target: { destination, distance } } : {}),
    ...(row ? { progress: projectProgress(row) } : {}),
    ...(row && build.objectiveRow ? { objective: build.objectiveRow } : {}),
    ...(tree !== undefined ? { tree } : {}),
    ...(ceiling !== undefined ? { ceiling } : {}),
    steps,
    ...(noticeText !== undefined ? { notice: { text: noticeText, tone: status.tone } } : {}),
    attention,
  }
}

export function projectHarvestRowText(harvest: DashboardHarvest): HarvestRowText {
  const status = statusText(harvest.status)
  return {
    title: HARVEST_TITLE,
    status,
    observations: `${harvest.observations} observations`,
    steps: harvest.steps.map(stepText),
    ...(harvest.detail !== undefined
      ? { detail: { text: harvest.detail, tone: status.tone } }
      : {}),
  }
}

const gateTone = (off: boolean): DashboardTone => (off ? 'held' : 'ok')

/** The header's counters, capacity note and repository gates. */
export function projectHeaderText(
  model: Pick<
    DashboardModel,
    | 'triage'
    | 'queued'
    | 'active'
    | 'configuration'
    | 'capacity'
    | 'drained'
    | 'harvestPaused'
    | 'repositoryPaused'
  >,
): DashboardHeaderText {
  const capacityNote =
    model.configuration === 'no-dispatcher-run'
      ? ''
      : capacityExplanation(model.capacity).trimStart()
  return {
    counts: [
      {
        label: 'triage',
        value: model.triage === undefined ? '–' : String(model.triage),
      },
      { label: 'queue', value: String(model.queued) },
      { label: 'active', value: activeCounterText(model) },
    ],
    ...(capacityNote !== '' ? { capacityNote } : {}),
    gates: [
      {
        label: 'intake',
        word: model.drained ? 'OFF' : 'ON',
        tone: gateTone(model.drained),
      },
      {
        label: 'harvest',
        word: model.harvestPaused ? 'OFF' : 'ON',
        tone: gateTone(model.harvestPaused),
      },
      ...(model.repositoryPaused
        ? [
            {
              label: 'repository' as const,
              word: 'PAUSED',
              tone: 'held' as const,
            },
          ]
        : []),
    ],
  }
}

/**
 * The dispatcher's mode. An upgrade handoff outranks everything; then a
 * dispatcher that is not up reads stopped, even for a viewer, because the mode
 * describes the dispatcher rather than this process.
 */
export function projectDispatcherMode(input: {
  health?: DispatchHealth
  viewer?: { dispatchedBy?: string }
  handoffs?: readonly DashboardHandoff[]
  configuration?: DashboardModel['configuration']
}): DispatcherModeText {
  const mode = (m: DispatcherMode, detail?: string): DispatcherModeText => ({
    mode: m,
    ...dispatcherModeWord(m),
    ...(detail !== undefined ? { detail } : {}),
  })
  if ((input.handoffs?.length ?? 0) > 0) return mode('handoff')
  if (input.health === undefined || input.health === 'stopped' || input.health === 'failed') {
    return mode(
      'stopped',
      input.health === undefined || input.configuration === 'no-dispatcher-run'
        ? NO_DISPATCHER_RUN_LINE
        : undefined,
    )
  }
  if (input.viewer !== undefined) {
    return mode(
      'viewer',
      input.viewer.dispatchedBy !== undefined
        ? dispatchedByText(input.viewer.dispatchedBy)
        : undefined,
    )
  }
  return mode('running')
}

/**
 * Everything waiting on an operator, red before yellow. Built from the builds
 * themselves, so an integration row's hidden blockers are still listed. Within
 * a tone, harvest comes first and builds keep model order.
 */
export function projectAttention(
  builds: readonly DashboardBuild[],
  harvest?: DashboardHarvest,
): AttentionItem[] {
  const items: AttentionItem[] = []
  if (harvest !== undefined && (harvest.status === 'escalated' || harvest.status === 'failed')) {
    const status = statusText(harvest.status)
    items.push({
      kind: 'harvest',
      tone: status.tone,
      text: harvest.detail ?? status.word,
    })
  }
  for (const build of builds) {
    const identity = {
      slug: build.slug,
      ...(build.ticketId !== undefined ? { ticketId: build.ticketId } : {}),
    }
    for (const text of build.blockers)
      items.push({ kind: 'escalation', tone: 'alert', text, ...identity })
    if (build.setupError !== undefined)
      items.push({
        kind: 'setup-error',
        tone: 'alert',
        text: build.setupError,
        ...identity,
      })
    const alert = build.alert ?? build.integrationRow?.alert
    if (alert?.tone === 'red')
      items.push({
        kind: 'failure',
        tone: 'alert',
        text: alert.text,
        ...identity,
      })
    if (build.tree?.consent)
      items.push({
        kind: 'consent',
        tone: 'held',
        text: mergeVocabulary.consent,
        ...identity,
      })
    if (build.wait)
      items.push({
        kind: 'wait',
        tone: 'held',
        text: build.wait.text,
        ...identity,
      })
  }
  return [
    ...items.filter((item) => item.tone === 'alert'),
    ...items.filter((item) => item.tone !== 'alert'),
  ]
}

/** One finished build. A roster `node` is the dashboard's integration kind. */
export function projectFinishedRow(entry: BuildRosterFinished): FinishedRowText {
  const outcome = finishedOutcomeText(entry.outcome)
  return {
    slug: entry.slug,
    kind: entry.kind === 'node' ? 'integration' : 'work',
    outcome: entry.outcome,
    word: outcome.word,
    tone: outcome.tone,
    completedAt: entry.completedAt,
  }
}

/** The whole overview page as data. Pure: it performs no reads. */
export function projectOverview(
  model: DashboardModel,
  input: { health?: DispatchHealth; finished: readonly BuildRosterFinished[] },
): DashboardOverview {
  const row = (build: DashboardBuild) =>
    projectRowText(build, { repositoryPaused: model.repositoryPaused })
  return {
    dispatcher: projectDispatcherMode({
      ...(input.health !== undefined ? { health: input.health } : {}),
      ...(model.viewer !== undefined ? { viewer: model.viewer } : {}),
      ...(model.handoffs !== undefined ? { handoffs: model.handoffs } : {}),
      ...(model.configuration !== undefined ? { configuration: model.configuration } : {}),
    }),
    header: projectHeaderText(model),
    attention: projectAttention(model.builds, model.harvest),
    active: model.builds.filter((build) => build.status !== 'queued').map(row),
    queued: model.builds.filter((build) => build.status === 'queued').map(row),
    finished: input.finished.map(projectFinishedRow),
    ...(model.harvest !== undefined ? { harvest: projectHarvestRowText(model.harvest) } : {}),
  }
}
