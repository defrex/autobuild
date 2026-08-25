/**
 * Durable operator controls for one build.
 *
 * The dashboard and the sessionless CLI both call this module: it owns the
 * event-reduced active-build checks, human attribution, and event ordering so
 * the two surfaces cannot drift. Controls only append requests/answers; the
 * normal runner and dispatcher consume them.
 */
import type { AbEvent } from '../events/catalog'
import { humanActor, KERNEL } from '../events/envelope'
import { reduceBuild, type BuildState, type OpenEscalation } from '../kernel/reducer'
import type { ArtifactRef, BuildOutcome, BuildStatus, TicketRef } from '../ontology'
import type { Exec } from '../ports/workspace/git-worktree'
import { specConformance } from '../spec-standard'
import type { BuildStore } from '../store/types'
import { withSessionlessStore, type StoreOpener } from './store-opening'

const ACTIVE_STATUSES: readonly BuildStatus[] = ['running', 'paused', 'blocked']

/** Retry carries no phase guidance, but the event schema still requires a
 * nonempty audit answer. The reducer/materializer route on `resolution`, so
 * this text is never presented to the next phase as guidance. */
export const BARE_RETRY_ANSWER = 'Operator requested a bare retry with no feedback'
export const DISMISSAL_ANSWER = 'Operator dismissed the cited findings with no feedback'
export const SPEC_REVISION_ANSWER = 'Operator replaced the spec; the build restarts from plan'

/** Both forms are lazy: completing an earlier authorization must not open the
 * replacement source supplied to the retrying invocation. */
export type SpecBodySource =
  | { kind: 'supplied'; origin: string; read: () => Promise<string> }
  | { kind: 'ticket' }

export type AnswerResolutionRequest =
  | { kind: 'dismiss-finding' }
  | { kind: 'revise-spec'; body: SpecBodySource }

export type BuildControlAction =
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'abort' }
  | { kind: 'discard' }
  | { kind: 'auto-merge-on' }
  | { kind: 'auto-merge-off' }
  | { kind: 'dashboard-pause' }
  | { kind: 'dashboard-resume' }
  | { kind: 'toggle-auto-merge' }
  | {
      kind: 'answer'
      text?: string
      /** Omitted preserves the historical nonblank-guidance/blank-retry rule. */
      resolve?: AnswerResolutionRequest
      /** Absolute cap for the review loop named by an open round-limit escalation. */
      reviewRoundCeiling?: number
      /** Dashboard prompts answer only blockers captured when the field
       * opened. Omitted by the CLI, which answers every currently open one. */
      escalationIds?: readonly string[]
    }

export type BuildControlCommand =
  | 'pause'
  | 'resume'
  | 'abort'
  | 'discard'
  | 'auto-merge-on'
  | 'auto-merge-off'

export type BuildControlResult =
  | {
      kind: 'command'
      slug: string
      command: BuildControlCommand
      event: AbEvent
    }
  | {
      kind: 'answer-required'
      slug: string
      escalationIds: string[]
    }
  | {
      kind: 'answered'
      slug: string
      count: number
      resolution: 'guidance' | 'retry' | 'dismiss-finding' | 'revise-spec'
      resumed: boolean
      specRev?: number
      authorizedEarlier?: boolean
      remainingOpen?: number
      reviewRoundCeiling?: { loop: 'plan' | 'code'; value: number }
      /** A durable post-append fact says this build cannot restart. */
      terminalSignal?: TerminalSignal
    }

export type TerminalSignal =
  | { kind: 'terminal-status'; status: 'done' | 'aborted'; outcome?: BuildOutcome }
  | { kind: 'abort-requested' }
  | { kind: 'pr-ended'; state: 'merged' | 'closed' }

export type BuildControlErrorCode =
  | 'not-found'
  | 'wrong-repository'
  | 'inactive'
  | 'no-open-escalations'
  | 'own-session'
  | 'spec-nonconforming'
  | 'no-cited-findings'
  | 'ticket-unavailable'
  | 'missing-authorization'
  | 'no-longer-active'
  | 'abort-pending'
  | 'review-round-ceiling-unavailable'
  | 'incompatible-answer-options'

/** Typed codes let the dashboard turn stale selections/prompts into warnings
 * while the CLI can surface the same underlying conflict as a command error. */
export class BuildControlError extends Error {
  readonly code: BuildControlErrorCode

  constructor(code: BuildControlErrorCode, message: string) {
    super(message)
    this.name = 'BuildControlError'
    this.code = code
  }
}

/** Preserve the dashboard's attribution rule for both operator surfaces. */
export function buildControlUser(env: Record<string, string | undefined>): string {
  for (const name of ['USER', 'USERNAME']) {
    const value = env[name]?.trim()
    if (value !== undefined && value !== '') return value
  }
  return 'dashboard'
}

function activeState(slug: string, state: BuildState): void {
  if (ACTIVE_STATUSES.includes(state.status)) return
  throw new BuildControlError(
    'inactive',
    `build "${slug}" is not active (status: ${state.status}); ` +
      'build controls require running, paused, or blocked',
  )
}

async function appendCommand(
  store: BuildStore,
  slug: string,
  user: string,
  command: BuildControlCommand,
): Promise<BuildControlResult> {
  const actor = humanActor(user)
  let event: AbEvent
  switch (command) {
    case 'pause':
      event = await store.append(slug, {
        actor,
        type: 'build.pause-requested',
        payload: {},
      })
      break
    case 'resume':
      event = await store.append(slug, {
        actor,
        type: 'build.resume-requested',
        payload: {},
      })
      break
    case 'abort':
      event = await store.append(slug, {
        actor,
        type: 'build.abort-requested',
        payload: {},
      })
      break
    case 'discard':
      event = await store.append(slug, {
        actor,
        type: 'build.discard-requested',
        payload: {},
      })
      break
    case 'auto-merge-on':
      event = await store.append(slug, {
        actor,
        type: 'build.auto-merge-requested',
        payload: {},
      })
      break
    case 'auto-merge-off':
      event = await store.append(slug, {
        actor,
        type: 'build.auto-merge-cancelled',
        payload: {},
      })
      break
  }
  return { kind: 'command', slug, command, event }
}

function selectedOpen(state: BuildState, captured?: Set<string>): OpenEscalation[] {
  return captured === undefined
    ? state.openEscalations
    : state.openEscalations.filter((item) => captured.has(item.id))
}

function reviewRoundLimitEscalation(
  slug: string,
  open: OpenEscalation[],
): OpenEscalation & { phase: 'plan-review' | 'code-review' } {
  const eligible = open.filter(
    (item): item is OpenEscalation & { phase: 'plan-review' | 'code-review' } =>
      item.source === 'policy' &&
      item.policyCause === 'review-round-limit' &&
      (item.phase === 'plan-review' || item.phase === 'code-review'),
  )
  if (eligible.length !== 1) {
    throw new BuildControlError(
      'review-round-ceiling-unavailable',
      `cannot set a review round ceiling for build "${slug}": ` +
        'exactly one open review-round-limit escalation is required; nothing was recorded',
    )
  }
  return eligible[0]!
}

function hasPendingAbort(state: BuildState): boolean {
  return state.pendingCommands.some((command) => command.command === 'abort')
}

function abortPending(slug: string): BuildControlError {
  return new BuildControlError(
    'abort-pending',
    `build "${slug}" is aborting; nothing was recorded. Abort is not revocable — ` +
      'after cleanup returns the ticket to Triage, dispatch it as a fresh build',
  )
}

export function terminalSignal(state: BuildState): TerminalSignal | undefined {
  if (state.status === 'done' || state.status === 'aborted') {
    return {
      kind: 'terminal-status',
      status: state.status,
      ...(state.outcome !== undefined ? { outcome: state.outcome } : {}),
    }
  }
  if (hasPendingAbort(state)) return { kind: 'abort-requested' }
  if (state.prState === 'merged' || state.prState === 'closed') {
    return { kind: 'pr-ended', state: state.prState }
  }
  return undefined
}

export type ReviseDecision =
  | { kind: 'refuse'; code: BuildControlErrorCode; message: string }
  | {
      kind: 'complete'
      artifact: ArtifactRef
      open: OpenEscalation[]
      escalationSeq: number
    }
  | { kind: 'fresh'; open: OpenEscalation[]; escalationSeq: number }

/** Pure restart decision, run once before body preparation and once against a
 * fresh reduction immediately before publication. */
export function decideRevise(
  slug: string,
  state: BuildState,
  captured?: Set<string>,
): ReviseDecision {
  const open = selectedOpen(state, captured)
  const pending = state.answeredEscalations.filter(
    (item) => item.resolution === 'revise-spec' && item.answeredSeq > state.restartSince,
  )
  const authorized = pending[0]

  if (hasPendingAbort(state)) {
    return { kind: 'refuse', code: 'abort-pending', message: abortPending(slug).message }
  }
  if (authorized !== undefined) {
    if (authorized.artifact === undefined) {
      return {
        kind: 'refuse',
        code: 'missing-authorization',
        message:
          `build "${slug}" has a pending spec revision from escalation ` +
          `"${authorized.id}", but its recorded answer names no replacement body. ` +
          'Autobuild will not infer authorization from the newest deposited spec: the spec is ' +
          'the contract for every downstream approval. The build remains parked; use ' +
          `ab abort ${slug} and dispatch the ticket fresh to exit this state.`,
      }
    }
    const escalationSeq = Math.max(...[...open, ...pending].map((item) => item.seq))
    return { kind: 'complete', artifact: authorized.artifact, open, escalationSeq }
  }
  if (open.length === 0) {
    const paused =
      state.status === 'paused'
        ? ` If a revision already landed, the build remains paused; run ab resume ${slug}.`
        : ''
    return {
      kind: 'refuse',
      code: 'no-open-escalations',
      message:
        `build "${slug}" has no open escalation for a spec revision (status: ${state.status}). ` +
        'The spec is the build contract and changes only through an escalation raised by a phase; ' +
        `the phase must use ab escalate first.${paused}`,
    }
  }
  return {
    kind: 'fresh',
    open,
    escalationSeq: Math.max(...open.map((item) => item.seq)),
  }
}

function throwRefusal(decision: Extract<ReviseDecision, { kind: 'refuse' }>): never {
  throw new BuildControlError(decision.code, decision.message)
}

function assertStillActive(slug: string, state: BuildState): void {
  if (ACTIVE_STATUSES.includes(state.status)) return
  throw new BuildControlError(
    'no-longer-active',
    `build "${slug}" became ${state.status}${
      state.outcome !== undefined ? ` (${state.outcome})` : ''
    } while the answer was being prepared; nothing was appended. ` +
      'Any deposited replacement revision is inert because no spec event cites it.',
  )
}

function knownFindingIds(state: BuildState): Set<string> {
  return new Set(
    [...state.reviewFindings.planReview.flat(), ...state.reviewFindings.codeReview.flat()].map(
      (finding) => finding.id,
    ),
  )
}

function dismissPartition(
  state: BuildState,
  captured?: Set<string>,
): {
  eligible: OpenEscalation[]
  ineligible: OpenEscalation[]
} {
  const known = knownFindingIds(state)
  const open = selectedOpen(state, captured)
  return {
    eligible: open.filter((item) => (item.refs ?? []).some((ref) => known.has(ref))),
    ineligible: open.filter((item) => !(item.refs ?? []).some((ref) => known.has(ref))),
  }
}

function noCitedFindings(slug: string, open: OpenEscalation[]): BuildControlError {
  const refs = [...new Set(open.flatMap((item) => item.refs ?? []))]
  const detail =
    refs.length === 0
      ? 'the selected escalation(s) cite no references'
      : `their references are not review finding ids: ${refs.join(', ')}`
  return new BuildControlError(
    'no-cited-findings',
    `cannot dismiss findings for build "${slug}": ${detail}. ` +
      `Use ab answer ${slug} <text> for guidance, or ab answer ${slug} for a bare retry.`,
  )
}

export interface ControlBuildOpts {
  store: BuildStore
  /** Canonical main-repository identity stored on BuildRecord.repo. */
  repo: string
  slug: string
  env: Record<string, string | undefined>
  action: BuildControlAction
  /** Injected only for --revise-spec-from-ticket. */
  readTicketBody?: (ref: TicketRef) => Promise<string>
}

/** Apply one control against a freshly reduced build log. */
export async function controlBuild(opts: ControlBuildOpts): Promise<BuildControlResult> {
  const record = await opts.store.getBuild(opts.slug)
  if (record === null) {
    throw new BuildControlError(
      'not-found',
      `no build "${opts.slug}" in this store; run 'ab builds --all' to list builds`,
    )
  }
  if (record.repo !== opts.repo) {
    throw new BuildControlError(
      'wrong-repository',
      `build "${opts.slug}" belongs to repository "${record.repo}", ` + `not "${opts.repo}"`,
    )
  }

  const events = await opts.store.getEvents(opts.slug)
  const state = reduceBuild(events)
  const user = buildControlUser(opts.env)

  if (opts.action.kind === 'discard') {
    if (state.status !== 'queued') {
      throw new BuildControlError(
        'inactive',
        `build "${opts.slug}" cannot be discarded (status: ${state.status}); discard requires queued`,
      )
    }
    const existing = events.findLast((event) => event.type === 'build.discard-requested')
    if (existing !== undefined) {
      return { kind: 'command', slug: opts.slug, command: 'discard', event: existing }
    }
    return appendCommand(opts.store, opts.slug, user, 'discard')
  }

  if (opts.action.kind === 'abort') {
    if (state.status !== 'queued') activeState(opts.slug, state)
    const existing = events.findLast((event) => event.type === 'build.abort-requested')
    if (existing !== undefined) {
      return { kind: 'command', slug: opts.slug, command: 'abort', event: existing }
    }
    return appendCommand(opts.store, opts.slug, user, 'abort')
  }

  activeState(opts.slug, state)
  switch (opts.action.kind) {
    case 'pause':
    case 'resume':
    case 'auto-merge-on':
    case 'auto-merge-off':
      return appendCommand(opts.store, opts.slug, user, opts.action.kind)

    case 'dashboard-pause': {
      const pendingPause = state.pendingCommands.some((command) => command.command === 'pause')
      if (state.status !== 'running') {
        throw new BuildControlError(
          'inactive',
          `build "${opts.slug}" cannot use dashboard pause (status: ${state.status}); ` +
            'dashboard pause requires running or a pending pause',
        )
      }
      // The reducer already makes an opposing command supersede an
      // unacknowledged request. Reuse that durable rule to cancel PAUSING.
      return appendCommand(opts.store, opts.slug, user, pendingPause ? 'resume' : 'pause')
    }

    case 'dashboard-resume': {
      // A blocker takes precedence over pause state in the operator flow. The
      // prompt itself is process-local and writes nothing until submitted.
      if (state.openEscalations.length > 0) {
        return {
          kind: 'answer-required',
          slug: opts.slug,
          escalationIds: state.openEscalations.map((item) => item.id),
        }
      }
      const pendingResume = state.pendingCommands.some((command) => command.command === 'resume')
      if (state.status !== 'paused' || pendingResume) {
        throw new BuildControlError(
          'inactive',
          `build "${opts.slug}" cannot use dashboard resume (status: ${state.status}); ` +
            'dashboard resume requires paused with no pending resume',
        )
      }
      return appendCommand(opts.store, opts.slug, user, 'resume')
    }

    case 'toggle-auto-merge':
      return appendCommand(
        opts.store,
        opts.slug,
        user,
        state.autoMerge.requested ? 'auto-merge-off' : 'auto-merge-on',
      )

    case 'answer': {
      const captured =
        opts.action.escalationIds === undefined ? undefined : new Set(opts.action.escalationIds)
      const guidance = (opts.action.text ?? '').trim()
      const actor = humanActor(user)
      const requestedCeiling = opts.action.reviewRoundCeiling
      if (
        requestedCeiling !== undefined &&
        (!Number.isInteger(requestedCeiling) || requestedCeiling <= 0)
      ) {
        throw new BuildControlError(
          'review-round-ceiling-unavailable',
          'review round ceiling must be a positive integer; nothing was recorded',
        )
      }
      if (requestedCeiling !== undefined && opts.action.resolve?.kind === 'revise-spec') {
        throw new BuildControlError(
          'incompatible-answer-options',
          'cannot combine a review round ceiling with a spec revision: revision resets the loop round budget on its own; nothing was recorded',
        )
      }
      if (requestedCeiling !== undefined && opts.action.resolve?.kind === 'dismiss-finding') {
        throw new BuildControlError(
          'incompatible-answer-options',
          'cannot combine a review round ceiling with --dismiss; use guidance or a bare retry to answer the review-round-limit escalation; nothing was recorded',
        )
      }
      const ceilingEscalation =
        requestedCeiling === undefined
          ? undefined
          : reviewRoundLimitEscalation(opts.slug, selectedOpen(state, captured))

      if (opts.action.resolve?.kind === 'revise-spec') {
        const initial = decideRevise(opts.slug, state, captured)
        if (initial.kind === 'refuse') throwRefusal(initial)

        let artifact: ArtifactRef
        let authorizedEarlier = initial.kind === 'complete'
        if (initial.kind === 'complete') {
          // Completion rule: recorded authorization wins before the caller's
          // lazy body source is opened, regardless of remaining blockers.
          artifact = initial.artifact
        } else {
          let body: string
          const source = opts.action.resolve.body
          if (source.kind === 'supplied') {
            body = await source.read()
          } else {
            if (record.ticket === undefined) {
              throw new BuildControlError(
                'ticket-unavailable',
                `build "${opts.slug}" has no recorded ticket to re-import`,
              )
            }
            if (opts.readTicketBody === undefined) {
              throw new BuildControlError(
                'ticket-unavailable',
                'ticket body reader is unavailable for --revise-spec-from-ticket',
              )
            }
            body = await opts.readTicketBody(record.ticket)
          }
          const conformance = specConformance(body)
          if (!conformance.conforms) {
            throw new BuildControlError(
              'spec-nonconforming',
              `replacement spec from ${source.kind === 'supplied' ? source.origin : 'the build ticket'} ` +
                `does not conform: missing ${conformance.missing.join('; ')}; ` +
                'nothing was recorded and the build remains blocked',
            )
          }
          // A deposit without a later human authorization is deliberately inert:
          // every consumer reads the revision anchored by a spec.* event.
          const deposited = await opts.store.putArtifact(opts.slug, {
            kind: 'spec',
            content: body,
            ...(record.ticket !== undefined
              ? { metadata: { ticket: record.ticket.id, source: record.ticket.source } }
              : {}),
          })
          artifact = { kind: 'spec', rev: deposited.revision }
        }

        // Re-read at the last durable moment. The PR janitor and abort
        // acknowledgement may still write while a blocked build is parked.
        const freshState = reduceBuild(await opts.store.getEvents(opts.slug))
        assertStillActive(opts.slug, freshState)
        const decision = decideRevise(opts.slug, freshState, captured)
        if (decision.kind === 'refuse') throwRefusal(decision)
        if (decision.kind === 'complete') {
          artifact = decision.artifact
          authorizedEarlier = true
        }
        const answer = guidance === '' ? SPEC_REVISION_ANSWER : guidance
        const alsoPaused = freshState.status === 'paused'

        // Answers must precede spec.revised: the engine parks an answered
        // revise-spec escalation at awaiting-spec until this kernel fact lands.
        for (const escalation of decision.open) {
          await opts.store.append(opts.slug, {
            actor,
            type: 'escalation.answered',
            payload: {
              id: escalation.id,
              answer,
              resolution: 'revise-spec',
              artifact,
            },
          })
        }
        await opts.store.append(opts.slug, {
          actor: KERNEL,
          type: 'spec.revised',
          payload: { artifact, escalation: decision.escalationSeq },
        })
        if (alsoPaused) {
          await opts.store.append(opts.slug, {
            actor,
            type: 'build.resume-requested',
            payload: {},
          })
        }
        const after = reduceBuild(await opts.store.getEvents(opts.slug))
        const signal = terminalSignal(after)
        return {
          kind: 'answered',
          slug: opts.slug,
          count: decision.open.length,
          resolution: 'revise-spec',
          resumed: alsoPaused,
          ...(after.specRev !== undefined ? { specRev: after.specRev } : {}),
          ...(authorizedEarlier ? { authorizedEarlier: true } : {}),
          ...(signal !== undefined ? { terminalSignal: signal } : {}),
        }
      }

      if (opts.action.resolve?.kind === 'dismiss-finding') {
        if (hasPendingAbort(state)) throw abortPending(opts.slug)
        const initialOpen = selectedOpen(state, captured)
        if (initialOpen.length === 0) {
          throw new BuildControlError(
            'no-open-escalations',
            captured === undefined
              ? `build "${opts.slug}" has no open escalations to answer`
              : `build "${opts.slug}" is no longer blocked by the captured escalation(s)`,
          )
        }
        const initial = dismissPartition(state, captured)
        if (initial.eligible.length === 0) throw noCitedFindings(opts.slug, initialOpen)

        const freshState = reduceBuild(await opts.store.getEvents(opts.slug))
        assertStillActive(opts.slug, freshState)
        if (hasPendingAbort(freshState)) throw abortPending(opts.slug)
        const freshOpen = selectedOpen(freshState, captured)
        if (freshOpen.length === 0) {
          throw new BuildControlError(
            'no-open-escalations',
            `build "${opts.slug}" has no open escalations to answer`,
          )
        }
        const partition = dismissPartition(freshState, captured)
        if (partition.eligible.length === 0) throw noCitedFindings(opts.slug, freshOpen)
        const answer = guidance === '' ? DISMISSAL_ANSWER : guidance
        for (const escalation of partition.eligible) {
          await opts.store.append(opts.slug, {
            actor,
            type: 'escalation.answered',
            payload: { id: escalation.id, answer, resolution: 'dismiss-finding' },
          })
        }
        const resumed = freshState.status === 'paused' && partition.ineligible.length === 0
        if (resumed) {
          await opts.store.append(opts.slug, {
            actor,
            type: 'build.resume-requested',
            payload: {},
          })
        }
        const after = reduceBuild(await opts.store.getEvents(opts.slug))
        const signal = terminalSignal(after)
        return {
          kind: 'answered',
          slug: opts.slug,
          count: partition.eligible.length,
          resolution: 'dismiss-finding',
          resumed,
          remainingOpen: partition.ineligible.length,
          ...(signal !== undefined ? { terminalSignal: signal } : {}),
        }
      }

      const open = selectedOpen(state, captured)
      if (open.length === 0) {
        throw new BuildControlError(
          'no-open-escalations',
          captured === undefined
            ? `build "${opts.slug}" has no open escalations to answer`
            : `build "${opts.slug}" is no longer blocked by the captured escalation(s)`,
        )
      }
      const resolution = guidance === '' ? 'retry' : 'guidance'
      const answer = guidance === '' ? BARE_RETRY_ANSWER : guidance
      const alsoPaused = state.status === 'paused'
      // Appends are intentionally one-at-a-time. If an append fails midway, a
      // retry re-reduces the log and filters already answered ids out.
      for (const escalation of open) {
        await opts.store.append(opts.slug, {
          actor,
          type: 'escalation.answered',
          payload: {
            id: escalation.id,
            answer,
            resolution,
            ...(ceilingEscalation?.id === escalation.id
              ? { reviewRoundCeiling: requestedCeiling }
              : {}),
          },
        })
      }
      if (alsoPaused) {
        await opts.store.append(opts.slug, {
          actor,
          type: 'build.resume-requested',
          payload: {},
        })
      }
      return {
        kind: 'answered',
        slug: opts.slug,
        count: open.length,
        resolution,
        resumed: alsoPaused,
        ...(ceilingEscalation !== undefined && requestedCeiling !== undefined
          ? {
              reviewRoundCeiling: {
                loop:
                  ceilingEscalation.phase === 'plan-review' ? ('plan' as const) : ('code' as const),
                value: requestedCeiling,
              },
            }
          : {}),
      }
    }
  }
}

function actionLabel(action: BuildControlAction): string {
  switch (action.kind) {
    case 'auto-merge-on':
      return 'enable auto-merge for'
    case 'auto-merge-off':
      return 'disable auto-merge for'
    case 'toggle-auto-merge':
      return 'toggle auto-merge for'
    case 'dashboard-pause':
      return 'pause or cancel pause for'
    case 'dashboard-resume':
      return 'resume'
    case 'discard':
      return 'discard'
    case 'answer':
      return 'answer'
    default:
      return action.kind
  }
}

/** A phase agent may operate on another build, but never control its own. */
export function refuseOwnSessionControl(
  slug: string,
  action: BuildControlAction,
  env: Record<string, string | undefined>,
): void {
  const session = env.AB_SESSION?.trim()
  const build = env.AB_BUILD?.trim()
  if (session === undefined || session === '' || build !== slug) return
  throw new BuildControlError(
    'own-session',
    `cannot ${actionLabel(action)} build "${slug}" from its own phase session ` +
      '(AB_SESSION/AB_BUILD conflict); run this command outside that build session',
  )
}

export interface AbBuildControlOpts {
  targetRepo: string
  env: Record<string, string | undefined>
  exec: Exec
  slug: string
  action: BuildControlAction
  /** Explicit `--store`; selection remains --store > AB_STORE > repo-local. */
  storeRef?: string
  /** Injected only for --revise-spec-from-ticket. */
  readTicketBody?: (ref: TicketRef) => Promise<string>
  /** Injectable adapter seam for unit tests. */
  openStore?: StoreOpener
}

/** Sessionless command shell: resolve repository/store, control, always close. */
export async function abBuildControl(opts: AbBuildControlOpts): Promise<BuildControlResult> {
  // Do this before opening a store: the conflict is ambient and no read is
  // needed to know that an own-phase control attempt is forbidden.
  refuseOwnSessionControl(opts.slug, opts.action, opts.env)

  return withSessionlessStore(opts, ({ store, repo }) =>
    controlBuild({
      store,
      repo,
      slug: opts.slug,
      env: opts.env,
      action: opts.action,
      ...(opts.readTicketBody !== undefined ? { readTicketBody: opts.readTicketBody } : {}),
    }),
  )
}
