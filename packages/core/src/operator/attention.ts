/**
 * The operator attention digest (`repository.attention`): one read of
 * everything that currently waits on the operator for a repository, for a
 * connected agent that cannot hold `ab watch --operator` open.
 *
 * The digest composes the services the dedicated tools already run — the
 * open escalations `builds.get` reports, the consent queue `merges.list`
 * returns, the attention page `repository.events` serves and the
 * `repository.status` projection — so each section matches its dedicated tool
 * by construction. It adds only a closed `resolve` list per item: the
 * registry tool call that acts on it.
 *
 * Read cost per call is bounded: one `repository.status` pass, one open-build
 * view pass (one facts read per open, nonterminal build; settled builds are
 * never listed), and one repository journal page of at most 256 rows after
 * the cursor. Nothing grows with log length or settled history, and the call
 * reads zero event rows when nothing changed since the cursor.
 */
import { isDiverged } from '../cli/build-progress'
import { summarizeFrom, type BuildSummary } from '../cli/status'
import type { RepositoryStatus } from '../cli/repository-status'
import type { ConsentQueueEntry } from '../cli/dashboard/tree'
import type { RepositoryEvent } from '../events/repository'
import { integrationFailed, missingIntegrationFailures } from '../kernel/integration-state'
import type { BuildState, OpenEscalation } from '../kernel/reducer'
import type { TicketRef } from '../ontology'
import type { BuildStore } from '../store/types'
import type { OperatorToolName } from './annotations'
import { consentEntryFromView } from './landings'
import { getRepositoryStatus } from './query'
import { withOperatorView } from './read-view'
import { readRepositoryAttentionPage } from './repository-events'

/** A tool call that resolves an attention item. `input` is partial: it names
 * the repository and the subject (slug, ticket id, action, head…); the agent
 * supplies the rest (an answer's text, a ticket's title). `by: 'human'` marks a
 * condition no agent call fixes: the named tool is the read that supplies the
 * evidence to report to a human. */
export interface Resolution {
  tool: OperatorToolName
  input: Record<string, unknown>
  by: 'operator' | 'human'
  note?: string
}

export interface AttentionEscalationItem {
  slug: string
  ticket?: TicketRef
  status: BuildSummary['status']
  phase?: BuildSummary['phase']
  round?: number
  escalations: OpenEscalation[]
  resolve: Resolution[]
}

export interface AttentionMergeItem {
  slug: string
  pr: { number: number; url: string } | null
  entry: ConsentQueueEntry
  resolve: Resolution[]
}

export interface AttentionEventItem {
  event: RepositoryEvent
  resolve: Resolution[]
}

export type AttentionWaitingReason = 'paused' | 'stalled' | 'verification-failed' | 'ci-failing'

export interface AttentionWaitingItem {
  slug: string
  ticket?: TicketRef
  reason: AttentionWaitingReason
  detail: unknown
  resolve: Resolution[]
}

export type DispatcherAttentionKind = 'no-holder' | 'upgrade-failed' | 'rollback' | 'forge-cooldown'

export interface DispatcherAttentionItem {
  kind: DispatcherAttentionKind
  detail: string
  /** The `repository.status` fragment the item came from. */
  source: unknown
  resolve: Resolution[]
}

export interface OperatorAttention {
  repo: string
  generatedAt: string
  escalations: AttentionEscalationItem[]
  merges: AttentionMergeItem[]
  events: { items: AttentionEventItem[]; cursor: number; hasMore: boolean }
  waiting: AttentionWaitingItem[]
  dispatcher: DispatcherAttentionItem[]
}

const REPAIR_NOTE = 'file a repair child targeting this node'

const reportToHuman = (repo: string, note: string): Resolution[] => [
  { tool: 'repository.status', input: { repo }, by: 'human', note },
]

const FORGE_CLEAR_NOTE =
  'only when the cooldown is erroneous; otherwise it lifts on its own at resetAt'

/** Human-only repository attention: the agent reports it, never fixes it. */
const HUMAN_EVENT_NOTES = {
  'dispatcher.config-rejected': 'the dispatcher rejected a configuration change',
  'dispatcher.runtime-rolled-back': 'the dispatcher rolled back to its previous runtime',
  'dispatcher.upgrade-failed': 'a dispatcher upgrade failed',
  'dispatcher.kernel-git-unavailable': 'the dispatcher cannot run kernel git operations',
  'dispatcher.forge-readiness-failed': 'the dispatcher’s forge readiness check failed',
  'dispatcher.config-reloaded': 'a configuration change needs a dispatcher restart',
  'dispatcher.run-stopped': 'a dispatcher run stopped abnormally',
  'hook.failing': 'a configured hook is failing',
  'hook.recovered': 'a configured hook recovered',
  'hook.skipped': 'a configured hook skipped deliveries',
  'account.credentials-unavailable': 'a runner account’s credentials are unavailable',
  'forge.credential-limited': 'a forge credential outside the dispatcher is rate limited',
} as const satisfies Partial<Record<RepositoryEvent['type'], string>>

/** The note an attention type that no branch names resolves with. */
export const UNMAPPED_EVENT_NOTE = 'report this repository attention to the maintainer'

/** The tool calls that resolve one repository attention event. */
export function repositoryEventResolution(event: RepositoryEvent, repo: string): Resolution[] {
  switch (event.type) {
    case 'ticket.handed-back':
      return [
        {
          tool: 'tickets.move',
          input: { repo, id: event.payload.ticket.id },
          by: 'operator',
          note: 'decide where the handed-back ticket goes next',
        },
      ]
    case 'ticket-preparation.resolved':
      return [
        {
          tool: 'tickets.move',
          input: { repo, id: event.payload.ticket.id },
          by: 'operator',
          note: 'ticket preparation was abandoned; decide where the ticket goes next',
        },
      ]
    case 'ticket.start-settled':
      return event.payload.slug !== undefined
        ? [
            {
              tool: 'builds.get',
              input: { repo, slug: event.payload.slug },
              by: 'operator',
            },
          ]
        : [
            {
              tool: 'tickets.start',
              input: { repo, id: event.payload.ticket.id },
              by: 'operator',
              note: 'the start request settled without a build; fix the cause, then request again',
            },
          ]
    case 'harvest.escalated':
    case 'harvest.recovery-exhausted':
      return [
        { tool: 'harvest.status', input: { repo }, by: 'operator' },
        { tool: 'harvest.control', input: { repo }, by: 'operator' },
      ]
    case 'dispatcher.forge-degraded':
      return [
        {
          tool: 'repository.forge_clear',
          input: { repo, forge: event.payload.forge },
          by: 'operator',
          note: FORGE_CLEAR_NOTE,
        },
      ]
    case 'dispatcher.config-rejected':
    case 'dispatcher.runtime-rolled-back':
    case 'dispatcher.upgrade-failed':
    case 'dispatcher.kernel-git-unavailable':
    case 'dispatcher.forge-readiness-failed':
    case 'dispatcher.config-reloaded':
    case 'dispatcher.run-stopped':
    case 'hook.failing':
    case 'hook.recovered':
    case 'hook.skipped':
    case 'account.credentials-unavailable':
    case 'forge.credential-limited':
      return reportToHuman(repo, `${HUMAN_EVENT_NOTES[event.type]}; report it to the maintainer`)
    default:
      return reportToHuman(repo, UNMAPPED_EVENT_NOTE)
  }
}

/** Why one open build waits on operator action. Every reason is checked on
 * its own; no status — `blocked` included — short-circuits another. An open
 * escalation is never a reason here: the escalations section reports it. */
export function waitingReasons(input: {
  repo: string
  slug: string
  ticket?: TicketRef
  summary: BuildSummary
  state: BuildState
  now: Date
}): AttentionWaitingItem[] {
  const { repo, slug, summary, state } = input
  const subject = {
    slug,
    ...(input.ticket !== undefined ? { ticket: input.ticket } : {}),
  }
  const items: AttentionWaitingItem[] = []
  if (summary.status === 'paused')
    items.push({
      ...subject,
      reason: 'paused',
      detail: { phase: summary.phase ?? null },
      resolve: [
        {
          tool: 'builds.control',
          input: { repo, slug, action: 'resume' },
          by: 'operator',
          note: 'a build with open escalations needs them answered first',
        },
      ],
    })
  if (isDiverged(summary.progress, input.now))
    items.push({
      ...subject,
      reason: 'stalled',
      detail: {
        lastEventAt: summary.progress.lastEventAt,
        heartbeatAt: summary.progress.heartbeatAt,
      },
      resolve: [
        {
          tool: 'builds.control',
          input: { repo, slug, action: 'pause' },
          by: 'operator',
          note: 'inspect builds.events first; aborting needs the human’s consent',
        },
        {
          tool: 'builds.control',
          input: { repo, slug, action: 'resume' },
          by: 'operator',
        },
      ],
    })
  if (state.kind === 'node' && integrationFailed(state)) {
    const cycle = state.integration!.cycle!
    const failure =
      state.integration?.failures?.find((entry) => entry.id === cycle.id) ??
      missingIntegrationFailures(state, slug)[0]
    items.push({
      ...subject,
      reason: 'verification-failed',
      detail: {
        cycle: cycle.id,
        head: failure?.head ?? cycle.head,
        parent: failure?.parent ?? cycle.parent,
        steps: failure?.steps ?? [],
        guidance: failure?.guidance ?? `${REPAIR_NOTE}: ${slug}`,
      },
      resolve: [
        {
          tool: 'tickets.create',
          input: {
            repo,
            kind: 'work',
            ...(input.ticket !== undefined ? { target: input.ticket.id } : {}),
          },
          by: 'operator',
          note: REPAIR_NOTE,
        },
        {
          tool: 'builds.answer',
          input: { repo, slug },
          by: 'operator',
          note: 'or revise the node spec',
        },
      ],
    })
  }
  if (summary.ciFailure !== undefined)
    items.push({
      ...subject,
      reason: 'ci-failing',
      detail: summary.ciFailure.text,
      resolve: [
        {
          tool: 'builds.reopen',
          input: { repo, slug },
          by: 'operator',
          note: 're-run CI on the forge if the failure looks flaky or external; reopen with feedback if the change broke it',
        },
      ],
    })
  return items
}

/** The dispatcher conditions in a `repository.status` projection that wait on
 * the operator, in a fixed kind order. */
export function dispatcherAttention(
  status: RepositoryStatus,
  now: Date,
): DispatcherAttentionItem[] {
  const repo = status.repo
  const items: DispatcherAttentionItem[] = []
  const dispatcher = status.dispatcher
  if (dispatcher.state !== 'held') {
    const run = (dispatcher.expiredHolder ?? dispatcher.latestRun)?.run ?? null
    items.push({
      kind: 'no-holder',
      detail: `dispatcher ${dispatcher.state}; latest run ${run ?? 'none'}`,
      source: {
        state: dispatcher.state,
        run,
        stop: dispatcher.latestStoppedRun?.stop ?? null,
      },
      resolve: reportToHuman(repo, 'no dispatcher holds this repository; report it'),
    })
  }
  for (const entry of [status.upgradeStatus.current, status.upgradeStatus.previous]) {
    if (entry?.outcome?.type !== 'dispatcher.upgrade-failed' || entry.superseded) continue
    items.push({
      kind: 'upgrade-failed',
      detail: `run ${entry.run}: upgrade to ${entry.outcome.payload.target.key} failed: ${entry.outcome.payload.reason}`,
      source: entry,
      resolve: reportToHuman(repo, 'a dispatcher upgrade failed; report it'),
    })
  }
  if (status.rollbackHold !== undefined)
    items.push({
      kind: 'rollback',
      detail: `held runtime ${status.rollbackHold.payload.failed.version}; target ${status.rollbackHold.payload.target.key}`,
      source: status.rollbackHold,
      resolve: reportToHuman(repo, 'the dispatcher rolled back and holds the failed target'),
    })
  const degradation = status.forgeDegradation
  if (
    status.forgeRateLimit?.paused === true &&
    degradation !== undefined &&
    Date.parse(degradation.resetAt) > now.getTime()
  )
    items.push({
      kind: 'forge-cooldown',
      detail: `forge ${degradation.forge} paused until ${degradation.resetAt}: ${degradation.message}`,
      source: {
        forgeRateLimit: status.forgeRateLimit,
        forgeDegradation: degradation,
      },
      resolve: [
        {
          tool: 'repository.forge_clear',
          input: { repo, forge: degradation.forge },
          by: 'operator',
          note: FORGE_CLEAR_NOTE,
        },
      ],
    })
  return items
}

const bySlug = (a: { slug: string }, b: { slug: string }) => a.slug.localeCompare(b.slug)

/** Everything waiting on the operator for `repo`. An omitted cursor returns no
 * events and a baseline cursor beside the current-state sections; an expired
 * one fails with the `cursor-too-old` conflict `repository.events` raises. */
export async function getOperatorAttention(opts: {
  store: BuildStore
  repo: string
  cursor?: number
  now: Date
}): Promise<OperatorAttention> {
  const { store, repo, now } = opts
  // Never nest these: a view pass awaiting another pass on the same
  // repository deadlocks behind itself.
  const [status, builds] = await Promise.all([
    getRepositoryStatus(store, repo, now),
    withOperatorView(store, repo, 'builds', async (view) => {
      const escalations: AttentionEscalationItem[] = []
      const merges: AttentionMergeItem[] = []
      const waiting: AttentionWaitingItem[] = []
      for (const { record, digest } of await view.listOpenBuilds(repo)) {
        if (record.repo !== repo || digest.terminal !== undefined) continue
        const facts = await view.buildFacts(record.slug)
        const state = facts.state
        const summary = summarizeFrom(record, state, now)
        const ticket = record.ticket
        if (state.openEscalations.length > 0 && summary.waitOnly !== true)
          escalations.push({
            slug: record.slug,
            ...(ticket !== undefined ? { ticket } : {}),
            status: summary.status,
            ...(summary.phase !== undefined ? { phase: summary.phase } : {}),
            ...(summary.round !== undefined ? { round: summary.round } : {}),
            escalations: state.openEscalations,
            resolve: [
              {
                tool: 'builds.answer',
                input: { repo, slug: record.slug },
                by: 'operator',
              },
            ],
          })
        const entry = await consentEntryFromView(view, record, facts)
        if (entry !== null)
          merges.push({
            slug: record.slug,
            pr: summary.pr ? { number: summary.pr.number, url: summary.pr.url } : null,
            entry,
            resolve: [
              {
                tool: 'builds.control',
                input: {
                  repo,
                  slug: record.slug,
                  action: 'merge',
                  head: entry.currentHead,
                },
                by: 'operator',
                ...(entry.reason === 'held' ? { note: 'merging releases the hold' } : {}),
              },
              {
                tool: 'builds.control',
                input: { repo, slug: record.slug, action: 'hold' },
                by: 'operator',
              },
            ],
          })
        waiting.push(
          ...waitingReasons({
            repo,
            slug: record.slug,
            ...(ticket !== undefined ? { ticket } : {}),
            summary,
            state,
            now,
          }),
        )
      }
      return {
        escalations: escalations.sort(bySlug),
        merges: merges.sort(bySlug),
        waiting: waiting.sort(bySlug),
      }
    }),
  ])
  const page = await readRepositoryAttentionPage(store, repo, {
    ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
    filter: 'attention',
  })
  return {
    repo,
    generatedAt: now.toISOString(),
    escalations: builds.escalations,
    merges: builds.merges,
    events: {
      items: page.events.map((event) => ({
        event,
        resolve: repositoryEventResolution(event, repo),
      })),
      cursor: page.cursor,
      hasMore: page.hasMore,
    },
    waiting: builds.waiting,
    dispatcher: dispatcherAttention(status, now),
  }
}
