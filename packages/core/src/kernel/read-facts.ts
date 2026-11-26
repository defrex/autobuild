import { ticketMigrationsReducer } from './ticket-migrations'
import { projectEvents } from '../events/compatibility'
import { awaitsConsent } from './landing-readiness'
import { leafRestackReducer, type LeafRestackState } from './leaf-restack-state'
import { landingCandidateId } from './landing-policy'
import { referencesGitHistory, referencedGitTips } from './reconcile-head'
import { encodeLog } from './log-index-value'
import { summaryBoundaryReducer, summaryRequestsReducer } from './pr-summary'
import { infrastructureFailureResetReducer } from '../processes/infrastructure-failure-budget'
import {
  frozenPrImageHostReducer,
  currentPrAttachmentsReducer,
  hostedPrAttachmentsReducer,
  pendingPrAttachmentReclaimsReducer,
} from './pr-attachments'
import { isRemoteWorkspace } from '../events/workspace-remote'
/** JSON-safe projections for persisted current-state consumers. */
import type { AbEvent } from '../events/catalog'
import { defineReducer } from './incremental'
import { buildReducer, type BuildAcc } from './reducer'
import {
  currentDeferralObservationReducer,
  mergeAttentionFromFacts,
  type DeferralLedger,
} from './auto-merge'
import { logIndexReducer } from './log-index'
import { publicationStateReducer } from '../processes/publication-state'
import { executionNoProgressReducer } from '../processes/execution-no-progress'
import {
  openExecutionReducer,
  lastExecutionOutcomeReducer,
} from '../processes/execution-settlement'
import {
  baseBranchReducer,
  provisionMarkerReducer,
  recoveryCheckpointReducer,
  openBuildWorkspaceReducer,
} from '../processes/dispatcher-selectors'
import { dashboardFactsReducer } from '../cli/dashboard/facts'
import { verifyDiffBaseReducer } from './verify-diff-base'

export interface BuildStreamSeed {
  build: BuildAcc
  deferral: DeferralLedger
  mergeAttentionPrs: number[]
  branch?: string
  restack: LeafRestackState
  consentEpisode?: { seq: number; candidate: string }
  /** Terminal identity can precede later observations; retain it at the seed cursor. */
  terminalEvent?: AbEvent
}
// Revise with historical eligibility semantics; constituents add their own versions.
export const buildStreamSeedReducer = defineReducer<BuildStreamSeed, AbEvent, BuildStreamSeed>({
  rawEvents: true,
  identity: 'buildStreamSeed',
  parts: [
    ticketMigrationsReducer,
    leafRestackReducer,
    buildReducer,
    currentDeferralObservationReducer,
  ],
  initial: () => ({
    build: buildReducer.initial(),
    deferral: currentDeferralObservationReducer.initial(),
    mergeAttentionPrs: [],
    restack: leafRestackReducer.initial(),
  }),
  fold(acc, events) {
    for (const raw of events) {
      acc.build = buildReducer.advance(acc.build, [raw])
      const [event] = projectEvents([raw])
      if (!event) continue
      if (event.type === 'workspace.provisioned' || event.type === 'node.opening')
        acc.branch = event.payload.branch
      if (event.type === 'build.completed' || event.type === 'build.aborted')
        acc.terminalEvent = event
      acc.restack = leafRestackReducer.advance(acc.restack, [event])
      acc.deferral = currentDeferralObservationReducer.advance(acc.deferral, [event])
      const state = buildReducer.finish(acc.build)
      if (awaitsConsent(state, acc.restack)) {
        const candidate = landingCandidateId(state.landing!.decision!.candidate)
        if (acc.consentEpisode?.candidate !== candidate)
          acc.consentEpisode = { seq: event.seq, candidate }
      } else delete acc.consentEpisode
      const decision = mergeAttentionFromFacts(buildReducer.finish(acc.build), acc.deferral)
      if (decision && !acc.mergeAttentionPrs.includes(decision.pr.number))
        acc.mergeAttentionPrs.push(decision.pr.number)
    }
  },
  finish: (acc) => structuredClone(acc),
})

const parts = {
  infrastructureReset: infrastructureFailureResetReducer,
  summaryRequests: summaryRequestsReducer,
  summaryBoundary: summaryBoundaryReducer,
  hostedImages: hostedPrAttachmentsReducer,
  designations: currentPrAttachmentsReducer,
  imageHost: frozenPrImageHostReducer,
  pendingAttachments: pendingPrAttachmentReclaimsReducer,
  recoveryCheckpoint: recoveryCheckpointReducer,
  provisionMarker: provisionMarkerReducer,
  verifyDiffBase: verifyDiffBaseReducer,
  baseBranch: baseBranchReducer,
  build: buildReducer,
  log: logIndexReducer,
  publication: publicationStateReducer,
  executionNoProgress: executionNoProgressReducer,
  open: openExecutionReducer,
  workspace: openBuildWorkspaceReducer,
  lastExecution: lastExecutionOutcomeReducer,
  dashboard: dashboardFactsReducer,
  deferral: currentDeferralObservationReducer,
}
/** Capacity of `replacedHeads`; supersession beyond it falls back to refusal. */
export const REPLACED_HEADS_CAP = 64
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
/** The published history each recorded rewrite replaced. */
function replacedShas(event: AbEvent): string[] {
  const shas =
    event.type === 'node.rewritten'
      ? [event.payload.previous]
      : event.type === 'restack.rewritten' || event.type === 'reconcile.rewritten'
        ? [event.payload.oldHead, event.payload.localBranchHead]
        : []
  return [...new Set(shas)].filter((sha) => OID.test(sha))
}
export interface RunnerAttach {
  seq: number
  ts: string
  instance: string
  host: string
  resumedFromSeq?: number
  runtime: import('../events/runtime').RuntimeIdentity | null
}
export interface BuildReadAcc {
  runnerAttaches: RunnerAttach[]
  summaryRequests: ReturnType<typeof summaryRequestsReducer.initial>
  summaryBoundary: ReturnType<typeof summaryBoundaryReducer.initial>
  hostedImages: ReturnType<typeof hostedPrAttachmentsReducer.initial>
  designations: ReturnType<typeof currentPrAttachmentsReducer.initial>
  imageHost: ReturnType<typeof frozenPrImageHostReducer.initial>
  pendingAttachments: ReturnType<typeof pendingPrAttachmentReclaimsReducer.initial>
  recoveryCheckpoint: ReturnType<typeof recoveryCheckpointReducer.initial>
  provisionMarker: ReturnType<typeof provisionMarkerReducer.initial>
  verifyDiffBase: ReturnType<typeof verifyDiffBaseReducer.initial>
  baseBranch: ReturnType<typeof baseBranchReducer.initial>
  build: ReturnType<typeof buildReducer.initial>
  log: ReturnType<typeof logIndexReducer.initial>
  publication: ReturnType<typeof publicationStateReducer.initial>
  executionNoProgress: ReturnType<typeof executionNoProgressReducer.initial>
  open: ReturnType<typeof openExecutionReducer.initial>
  workspace: ReturnType<typeof openBuildWorkspaceReducer.initial>
  lastExecution: ReturnType<typeof lastExecutionOutcomeReducer.initial>
  dashboard: ReturnType<typeof dashboardFactsReducer.initial>
  deferral: ReturnType<typeof currentDeferralObservationReducer.initial>
  summaryHistory: {
    kind: 'review' | 'verify'
    phase?: string
    round?: number
    verdict?: string
    count?: number
    result?: import('../events/payloads').EventPayload<'verify.completed'>
  }[]
  summaryAttempts: number[]
  summaryRequested: Record<string, Extract<AbEvent, { type: 'pr-summary.requested' }>>
  summaryEligibleAfter?: string
  finalizePublicationRequested: boolean
  workspaceFence?: Extract<AbEvent, { type: 'workspace.fenced' }>
  /** The latest preservation receipt, forge-only or with store-kept heads. */
  workspacePreservation?: Extract<
    AbEvent,
    { type: 'workspace.commits-preserved' | 'workspace.commits-retained' }
  >
  /** Bounded record of the latest distinct shas a recorded rewrite replaced,
   * newest last. Preserved branch heads it covers are superseded. */
  replacedHeads: string[]
  workspaceLoss?: Extract<AbEvent, { type: 'workspace.commits-lost' }>
  latestWorkspace?: Extract<
    AbEvent,
    { type: 'workspace.provisioned' | 'workspace.cleanup-required' }
  >
  findings: Record<string, import('../ontology').Finding>
  planFeedback: Record<string, import('../ontology').Feedback | null>
  feedback: Record<string, import('../ontology').Feedback | null>
  reconcileBases: Record<string, string>
  reconcileHistory: Extract<
    AbEvent,
    { type: `reconcile.${string}` | 'workspace.provisioned' | 'phase.failed' }
  >[]
  restackHistory: Extract<AbEvent, { type: `restack.${string}` }>[]
  candidateRecoveries: Partial<
    Record<
      'reconcile' | 'restack',
      import('../events/payloads').EventPayload<'publication.candidate-retired'>
    >
  >
  candidateRecoverySeqs: Partial<Record<'reconcile' | 'restack', number>>
  /** The two latest logical session starts; continuations keep their root's start. */
  sessionStarts: Array<{ session: string; seq: number }>
  tipSources: Record<string, string[]>
  gitTips: string[]
  reconcileTransaction?: import('../events/payloads').EventPayload<'reconcile.prepared'>
  reconcileReplay?: import('../events/payloads').EventPayload<'reconcile.replayed'>
  firstWorkspace?: Extract<AbEvent, { type: 'workspace.provisioned' }>
  latestAbort?: Extract<AbEvent, { type: 'build.abort-requested' }>
  /** The newest committed ticket hand-back checkpoint of either kind. */
  latestTicketReturned?: Extract<
    AbEvent,
    { type: 'abort.ticket-returned' | 'build.ticket-returned' }
  >
  latestDiscard?: Extract<AbEvent, { type: 'build.discard-requested' }>
  maxPlanRevision: number
  created?: Extract<AbEvent, { type: 'build.created' }>
  lastCreated?: Extract<AbEvent, { type: 'build.created' }>
  latestRelease?: Extract<AbEvent, { type: 'workspace.released' }>
  latestWorkspaceFailureSeq: number
  workspaceGenerations: number
  dispatchFailureCount: number
  commentPosted: boolean
  specRecorded: boolean
  autoMergeEverRequested: boolean
  seenTypes: AbEvent['type'][]
  localWorkspace: boolean
  cleanupCounts: Record<string, number>
  reclaimCounts: Record<string, number>
  infrastructureReset: ReturnType<typeof infrastructureFailureResetReducer.initial>
  infrastructureCount: number
  infrastructureRaisedSeq: number
  remoteWorkspace: boolean
  terminalEvent?: AbEvent
  mergeTimes: string[]
  observationFacts: {
    payload: import('../events/payloads').EventPayload<'observation.recorded'>
    seq: number
    ts: string
  }[]
  observations: Extract<AbEvent, { type: 'observation.recorded' }>['payload'][]
  /** Shas `history.retained` and `node.history-retained` recorded, by where
   * the displaced commit is kept. */
  retainedHistory: { store: string[]; target: string[]; unretained: string[] }
}
export const buildReadFactsReducer = defineReducer({
  rawEvents: true,
  identity: 'buildReadFacts',
  parts: Object.values(parts),
  initial: (): BuildReadAcc => ({
    runnerAttaches: [],
    summaryRequests: summaryRequestsReducer.initial(),
    summaryBoundary: summaryBoundaryReducer.initial(),
    hostedImages: hostedPrAttachmentsReducer.initial(),
    designations: currentPrAttachmentsReducer.initial(),
    imageHost: frozenPrImageHostReducer.initial(),
    pendingAttachments: pendingPrAttachmentReclaimsReducer.initial(),
    recoveryCheckpoint: recoveryCheckpointReducer.initial(),
    provisionMarker: provisionMarkerReducer.initial(),
    verifyDiffBase: verifyDiffBaseReducer.initial(),
    baseBranch: baseBranchReducer.initial(),
    build: buildReducer.initial(),
    log: logIndexReducer.initial(),
    publication: publicationStateReducer.initial(),
    executionNoProgress: executionNoProgressReducer.initial(),
    open: openExecutionReducer.initial(),
    workspace: openBuildWorkspaceReducer.initial(),
    lastExecution: lastExecutionOutcomeReducer.initial(),
    dashboard: dashboardFactsReducer.initial(),
    deferral: currentDeferralObservationReducer.initial(),
    observations: [],
    retainedHistory: { store: [], target: [], unretained: [] },
    observationFacts: [],
    mergeTimes: [],
    summaryHistory: [],
    summaryAttempts: [],
    summaryRequested: {},
    finalizePublicationRequested: false,
    findings: {},
    feedback: {},
    planFeedback: {},
    reconcileBases: {},
    reconcileHistory: [],
    restackHistory: [],
    replacedHeads: [],
    candidateRecoveries: {},
    candidateRecoverySeqs: {},
    sessionStarts: [],
    tipSources: {},
    gitTips: [],
    maxPlanRevision: -1,
    seenTypes: [],
    localWorkspace: false,
    cleanupCounts: {},
    reclaimCounts: {},
    infrastructureReset: infrastructureFailureResetReducer.initial(),
    infrastructureCount: 0,
    infrastructureRaisedSeq: 0,
    remoteWorkspace: false,
    latestWorkspaceFailureSeq: 0,
    workspaceGenerations: 0,
    dispatchFailureCount: 0,
    commentPosted: false,
    specRecorded: false,
    autoMergeEverRequested: false,
  }),
  fold(acc: BuildReadAcc, events: readonly AbEvent[]) {
    acc.baseBranch = baseBranchReducer.advance(acc.baseBranch, events)
    acc.provisionMarker = provisionMarkerReducer.advance(acc.provisionMarker, events)
    acc.verifyDiffBase = verifyDiffBaseReducer.advance(acc.verifyDiffBase, events)
    acc.recoveryCheckpoint = recoveryCheckpointReducer.advance(acc.recoveryCheckpoint, events)
    acc.pendingAttachments = pendingPrAttachmentReclaimsReducer.advance(
      acc.pendingAttachments,
      events,
    )
    acc.imageHost = frozenPrImageHostReducer.advance(acc.imageHost, events)
    acc.designations = currentPrAttachmentsReducer.advance(acc.designations, events)
    acc.hostedImages = hostedPrAttachmentsReducer.advance(acc.hostedImages, events)
    acc.summaryBoundary = summaryBoundaryReducer.advance(acc.summaryBoundary, events)
    acc.summaryRequests = summaryRequestsReducer.advance(acc.summaryRequests, events)
    acc.build = buildReducer.advance(acc.build, events)
    acc.log = logIndexReducer.advance(acc.log, events)
    acc.publication = publicationStateReducer.advance(acc.publication, events)
    acc.executionNoProgress = executionNoProgressReducer.advance(acc.executionNoProgress, events)
    acc.open = openExecutionReducer.advance(acc.open, events)
    acc.workspace = openBuildWorkspaceReducer.advance(acc.workspace, events)
    acc.lastExecution = lastExecutionOutcomeReducer.advance(acc.lastExecution, events)
    acc.dashboard = dashboardFactsReducer.advance(acc.dashboard, events)
    acc.deferral = currentDeferralObservationReducer.advance(acc.deferral, events)
    for (const event of projectEvents(events)) {
      if (event.type === 'runner.attached')
        acc.runnerAttaches.push({ seq: event.seq, ts: event.ts, ...event.payload, runtime: null })
      if (event.type === 'runner.runtime-recorded') {
        const attach = acc.runnerAttaches.find(
          (a) => a.seq === event.payload.attachedSeq && a.instance === event.payload.instance,
        )
        if (attach) attach.runtime = event.payload.runtime
      }
      if (event.type === 'plan-review.verdict' || event.type === 'code-review.verdict')
        acc.summaryHistory.push({
          kind: 'review',
          phase: event.type === 'plan-review.verdict' ? 'plan-review' : 'code-review',
          round: event.payload.round,
          verdict: event.payload.verdict,
          count: event.payload.findings.length,
        })
      if (event.type === 'verify.completed')
        acc.summaryHistory.push({ kind: 'verify', result: event.payload })
      if (
        event.type === 'pr-summary.attempted' &&
        !acc.summaryAttempts.includes(event.payload.occurrence)
      )
        acc.summaryAttempts.push(event.payload.occurrence)
      if (event.type === 'pr-summary.requested')
        acc.summaryRequested[String(event.payload.occurrence)] ??= event
      if (
        event.type === 'pr-summary.result' &&
        event.payload.eligibleAfter &&
        (!acc.summaryEligibleAfter ||
          Date.parse(event.payload.eligibleAfter) > Date.parse(acc.summaryEligibleAfter))
      )
        acc.summaryEligibleAfter = event.payload.eligibleAfter
      if (event.type === 'publication.requested' && event.payload.operation === 'finalize')
        acc.finalizePublicationRequested = true
      // Keep checkpoints through repeated replacements, but never restore an old
      // branch over a durably acknowledged rewrite of the public branch.
      if (event.type === 'reconcile.rewritten' || event.type === 'restack.rewritten')
        delete acc.workspacePreservation
      for (const sha of replacedShas(event)) {
        const index = acc.replacedHeads.indexOf(sha)
        if (index >= 0) acc.replacedHeads.splice(index, 1)
        acc.replacedHeads.push(sha)
        if (acc.replacedHeads.length > REPLACED_HEADS_CAP)
          acc.replacedHeads.splice(0, acc.replacedHeads.length - REPLACED_HEADS_CAP)
      }
      if (event.type === 'session.started') {
        const last = acc.sessionStarts.at(-1)
        if (event.payload.continuation && last?.session === event.payload.continuation.predecessor)
          acc.sessionStarts[acc.sessionStarts.length - 1] = {
            ...last,
            session: event.payload.session,
          }
        else
          acc.sessionStarts = [
            ...acc.sessionStarts.slice(-1),
            { session: event.payload.session, seq: event.seq },
          ]
      }
      if (event.type === 'workspace.fenced') acc.workspaceFence = event
      if (
        event.type === 'workspace.commits-preserved' ||
        event.type === 'workspace.commits-retained'
      )
        acc.workspacePreservation = event
      if (event.type === 'workspace.commits-lost') acc.workspaceLoss = event
      if (event.type === 'workspace.provisioned' || event.type === 'workspace.cleanup-required')
        acc.latestWorkspace = event
      if (event.type === 'plan-review.verdict')
        acc.planFeedback[String(event.payload.round + 1)] =
          event.payload.verdict === 'revise'
            ? { findings: event.payload.findings.map((finding) => finding.id) }
            : null
      if (event.type === 'plan-review.verdict' || event.type === 'code-review.verdict')
        for (const finding of event.payload.findings)
          acc.findings[JSON.stringify(finding.id)] = finding
      if (event.type === 'plan.started' || event.type === 'implement.started')
        acc.feedback[
          JSON.stringify([
            event.type === 'plan.started' ? 'plan' : 'implement',
            event.payload.round,
          ])
        ] = event.payload.feedback ?? null
      if (event.type === 'verify.started')
        acc.feedback[JSON.stringify([`verify:${event.payload.step}`, event.payload.attempt])] =
          event.payload.feedback ?? null
      if (event.type.startsWith('restack.'))
        acc.restackHistory.push(event as Extract<AbEvent, { type: `restack.${string}` }>)
      if (event.type === 'publication.candidate-retired') {
        acc.candidateRecoveries[event.payload.operation] = event.payload
        acc.candidateRecoverySeqs[event.payload.operation] = event.seq
        if (
          event.payload.operation === 'reconcile' &&
          acc.reconcileTransaction?.id === event.payload.id
        )
          delete acc.reconcileReplay
        const sources = acc.tipSources[event.payload.sha]
        if (sources) {
          acc.tipSources[event.payload.sha] = sources.filter(
            (source) => source !== `${event.payload.operation}:${event.payload.id}`,
          )
          if (!acc.tipSources[event.payload.sha]!.length) {
            delete acc.tipSources[event.payload.sha]
            acc.gitTips = acc.gitTips.filter((tip) => tip !== event.payload.sha)
          }
        }
      }
      // Most events carry no Git history. Skip the allocating history selector
      // entirely on that hot path; retirement is handled independently above.
      if (referencesGitHistory(event.type))
        for (const tip of referencedGitTips([event])) {
          const ephemeral =
            (event.type === 'reconcile.publish-intended' ||
              event.type === 'restack.publish-intended') &&
            event.payload.headSha === tip
          const source = ephemeral ? `${event.type.split('.')[0]}:${event.payload.id}` : 'proven'
          if (!acc.tipSources[tip]) {
            acc.tipSources[tip] = []
            acc.gitTips.push(tip)
          }
          if (!acc.tipSources[tip]!.includes(source)) acc.tipSources[tip]!.push(source)
        }

      if (
        event.type === 'reconcile.started' ||
        event.type === 'reconcile.completed' ||
        event.type === 'reconcile.prepared' ||
        event.type === 'reconcile.replayed' ||
        event.type === 'reconcile.contended' ||
        event.type === 'reconcile.publish-intended' ||
        event.type === 'reconcile.rewritten' ||
        event.type === 'reconcile.superseded' ||
        event.type === 'workspace.provisioned' ||
        event.type === 'phase.failed'
      )
        acc.reconcileHistory.push(event)
      // A superseded occurrence's replay is abandoned, never resumed.
      if (
        event.type === 'reconcile.superseded' &&
        acc.reconcileTransaction !== undefined &&
        (acc.reconcileTransaction.attempt === event.payload.attempt ||
          (event.payload.restackId !== undefined &&
            (acc.reconcileTransaction.id === event.payload.restackId ||
              acc.reconcileTransaction.restackId === event.payload.restackId)))
      ) {
        delete acc.reconcileTransaction
        delete acc.reconcileReplay
      }
      if (event.type === 'reconcile.prepared') {
        acc.reconcileTransaction = event.payload
        delete acc.reconcileReplay
      }
      if (event.type === 'reconcile.replayed') acc.reconcileReplay = event.payload
      if (event.type === 'reconcile.started')
        acc.reconcileBases[String(event.payload.attempt)] = event.payload.baseSha
      if (event.type === 'workspace.provisioned') acc.firstWorkspace ??= event
      if (event.type === 'build.abort-requested') acc.latestAbort ??= event
      if (event.type === 'abort.ticket-returned' || event.type === 'build.ticket-returned')
        acc.latestTicketReturned = event
      if (event.type === 'build.discard-requested') acc.latestDiscard = event
      if (event.type === 'plan.completed')
        acc.maxPlanRevision = Math.max(acc.maxPlanRevision, event.payload.artifact.rev)
      if (!acc.seenTypes.includes(event.type)) acc.seenTypes.push(event.type)
      if (event.type === 'workspace.provisioned' && !isRemoteWorkspace(event.payload))
        acc.localWorkspace = true
      if (event.type === 'infrastructure.cleanup-attempted') {
        const key = JSON.stringify(event.payload.workspaceRef)
        acc.cleanupCounts[key] = (acc.cleanupCounts[key] ?? 0) + 1
      }
      if (event.type === 'pr-attachment.reclaim-failed') {
        const key = String(event.payload.hostedSeq)
        acc.reclaimCounts[key] = (acc.reclaimCounts[key] ?? 0) + 1
      }
      const priorReset = infrastructureFailureResetReducer.finish(acc.infrastructureReset)
      acc.infrastructureReset = infrastructureFailureResetReducer.advance(acc.infrastructureReset, [
        event,
      ])
      if (infrastructureFailureResetReducer.finish(acc.infrastructureReset) !== priorReset)
        acc.infrastructureCount = 0
      if (event.type === 'infrastructure.failed') acc.infrastructureCount++
      if (
        event.type === 'escalation.raised' &&
        event.payload.policyCause === 'infrastructure-failure-limit'
      )
        acc.infrastructureRaisedSeq = event.seq
      if (event.type === 'build.created') {
        acc.created ??= event
        acc.lastCreated = event
      }
      if (event.type === 'workspace.provisioned' || event.type === 'workspace.cleanup-required')
        acc.workspaceGenerations++
      if (event.type === 'workspace.released') acc.latestRelease = event
      if (event.type === 'dispatch.failed') {
        acc.dispatchFailureCount++
        if (event.payload.stage === 'workspace') acc.latestWorkspaceFailureSeq = event.seq
      }
      if (event.type === 'dispatch.comment-posted') acc.commentPosted = true
      if (event.type === 'spec.imported' || event.type === 'spec.authored') acc.specRecorded = true
      if (event.type === 'build.auto-merge-requested') acc.autoMergeEverRequested = true
      if (event.type === 'workspace.provisioned' && isRemoteWorkspace(event.payload))
        acc.remoteWorkspace = true
      if (event.type === 'build.completed' || event.type === 'build.aborted')
        acc.terminalEvent = event
      if (event.type === 'observation.recorded') {
        acc.observations.push(event.payload)
        acc.observationFacts.push({ payload: event.payload, seq: event.seq, ts: event.ts })
      }
      if (event.type === 'pr.merged') acc.mergeTimes.push(event.ts)
      if (event.type === 'history.retained' || event.type === 'node.history-retained')
        for (const where of ['store', 'target', 'unretained'] as const)
          for (const sha of event.payload[where])
            if (!acc.retainedHistory[where].includes(sha)) acc.retainedHistory[where].push(sha)
    }
  },
  finish: (acc: BuildReadAcc) => ({
    runnerAttaches: structuredClone(acc.runnerAttaches),
    summaryRequests: summaryRequestsReducer.finish(acc.summaryRequests),
    summaryBoundary: summaryBoundaryReducer.finish(acc.summaryBoundary),
    hostedImages: [...hostedPrAttachmentsReducer.finish(acc.hostedImages)],
    designations: currentPrAttachmentsReducer.finish(acc.designations),
    imageHost: frozenPrImageHostReducer.finish(acc.imageHost),
    pendingAttachments: pendingPrAttachmentReclaimsReducer.finish(acc.pendingAttachments),
    recoveryCheckpoint: recoveryCheckpointReducer.finish(acc.recoveryCheckpoint),
    provisionMarker: provisionMarkerReducer.finish(acc.provisionMarker),
    verifyDiffBase: verifyDiffBaseReducer.finish(acc.verifyDiffBase),
    baseBranch: baseBranchReducer.finish(acc.baseBranch),
    state: buildReducer.finish(acc.build),
    log: encodeLog(logIndexReducer.finish(acc.log)),
    publication: structuredClone(acc.publication),
    executionNoProgress: executionNoProgressReducer.finish(acc.executionNoProgress),
    open: openExecutionReducer.finish(acc.open),
    workspace: openBuildWorkspaceReducer.finish(acc.workspace),
    lastExecution: lastExecutionOutcomeReducer.finish(acc.lastExecution),
    dashboard: dashboardFactsReducer.finish(acc.dashboard),
    deferral: currentDeferralObservationReducer.finish(acc.deferral),
    observationFacts: structuredClone(acc.observationFacts),
    mergeTimes: [...acc.mergeTimes],
    observations: structuredClone(acc.observations),
    retainedHistory: structuredClone(acc.retainedHistory),
    terminalEvent: acc.terminalEvent,
    summaryHistory: structuredClone(acc.summaryHistory),
    summaryAttempts: [...acc.summaryAttempts],
    summaryRequested: structuredClone(acc.summaryRequested),
    summaryEligibleAfter: acc.summaryEligibleAfter,
    finalizePublicationRequested: acc.finalizePublicationRequested,
    latestWorkspace: acc.latestWorkspace,
    workspaceFence: acc.workspaceFence,
    workspacePreservation: acc.workspacePreservation,
    replacedHeads: [...acc.replacedHeads],
    workspaceLoss: acc.workspaceLoss,
    planFeedback: structuredClone(acc.planFeedback),
    findings: structuredClone(acc.findings),
    feedback: structuredClone(acc.feedback),
    reconcileBases: { ...acc.reconcileBases },
    reconcileHistory: structuredClone(acc.reconcileHistory),
    restackHistory: structuredClone(acc.restackHistory),
    gitTips: [...acc.gitTips],
    candidateRecoveries: structuredClone(acc.candidateRecoveries),
    candidateRecoverySeqs: { ...acc.candidateRecoverySeqs },
    sessionStarts: acc.sessionStarts.map((start) => ({ ...start })),
    tipSources: structuredClone(acc.tipSources),
    reconcileTransaction: acc.reconcileTransaction,
    reconcileReplay: acc.reconcileReplay,
    firstWorkspace: acc.firstWorkspace,
    latestAbort: acc.latestAbort,
    latestTicketReturned: acc.latestTicketReturned,
    latestDiscard: acc.latestDiscard,
    maxPlanRevision: acc.maxPlanRevision,
    seenTypes: [...acc.seenTypes],
    localWorkspace: acc.localWorkspace,
    cleanupCounts: { ...acc.cleanupCounts },
    reclaimCounts: { ...acc.reclaimCounts },
    infrastructureReset: infrastructureFailureResetReducer.finish(acc.infrastructureReset),
    infrastructureCount: acc.infrastructureCount,
    infrastructureRaisedSeq: acc.infrastructureRaisedSeq,
    remoteWorkspace: acc.remoteWorkspace,
    created: acc.created,
    lastCreated: acc.lastCreated,
    latestRelease: acc.latestRelease,
    latestWorkspaceFailureSeq: acc.latestWorkspaceFailureSeq,
    workspaceGenerations: acc.workspaceGenerations,
    dispatchFailureCount: acc.dispatchFailureCount,
    commentPosted: acc.commentPosted,
    specRecorded: acc.specRecorded,
    autoMergeEverRequested: acc.autoMergeEverRequested,
  }),
})

export {
  RECENT_DISPATCH_RUN_LIMIT,
  repositoryReadFactsReducer,
  optionalValue,
  dispatcherRunFactsReducer,
  type RepositoryReadAcc,
  type DispatcherRunFacts,
} from './repository-read-facts'
