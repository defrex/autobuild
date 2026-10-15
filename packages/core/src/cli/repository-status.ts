import {
  formatDispatcherIdentity,
  projectDispatcherLiveness,
  type DispatcherLiveness,
} from '../kernel/dispatcher-liveness'
import { readDispatcherLiveness } from './dispatcher-liveness'
import {
  reduceTicketSourceHealth,
  type TicketSourceDegradation,
} from '../kernel/ticket-source-health'
import type { RepositoryEvent } from '../events/repository'
import { reduceDispatchSettings, type DispatchSettings } from '../kernel/dispatch-settings'
import { sandboxStates } from '../processes/sandbox-state'
import type { Exec } from '../ports/workspace/git-worktree'
import { withSessionlessStore, type StoreOpener } from './store-opening'

/** Script-facing projection returned by `ab repository status`. */
export interface RepositoryStatus extends DispatchSettings {
  repo: string
  dispatcher: DispatcherLiveness
  ticketSourceDegradation?: TicketSourceDegradation
  /** Live operator sandboxes (AUT-340); released environments are omitted. */
  sandboxes: Array<{
    operator: string
    environmentId: string
    provider: string
    state: 'live' | 'stopped'
    lastEvidenceAt: string
  }>
  /** PR-only publications from operator sandboxes (AUT-343), newest first,
   * latest per (operator, branch). */
  publications: Array<{
    operator: string
    branch: string
    sha: string
    prNumber: number
    prUrl: string
    session?: string
    at: string
  }>
}

export interface RepositoryStatusOpts {
  /** The cwd, resolved to the canonical main repository before store access. */
  targetRepo: string
  /** Raw process environment for AB_STORE / AB_TOKEN selection. */
  env: Record<string, string | undefined>
  exec: Exec
  stdout: (line: string) => void
  json?: boolean
  /** Explicit --store reference; precedence is owned by repo-state.ts. */
  storeRef?: string
  now?: () => Date
  openStore?: StoreOpener
}

export function projectRepositoryStatus(
  repo: string,
  events: RepositoryEvent[],
  dispatcher = projectDispatcherLiveness(null, [], new Date()),
): RepositoryStatus {
  const publications: RepositoryStatus['publications'] = []
  for (const event of events) {
    if (event.type !== 'orchestrator.sandbox.published') continue
    const payload = event.payload
    // Latest per (operator, branch): a later fact for the same pair
    // supersedes the earlier one.
    const index = publications.findIndex(
      (entry) => entry.operator === payload.operator && entry.branch === payload.branch,
    )
    if (index !== -1) publications.splice(index, 1)
    publications.push({
      operator: payload.operator,
      branch: payload.branch,
      sha: payload.sha,
      prNumber: payload.pr.number,
      prUrl: payload.pr.url,
      ...(payload.session !== undefined ? { session: payload.session } : {}),
      at: event.ts,
    })
  }
  publications.reverse()
  const active = reduceTicketSourceHealth(events)
  return {
    ...(active === undefined ? {} : { ticketSourceDegradation: active }),
    repo,
    dispatcher,
    ...reduceDispatchSettings(events),
    sandboxes: sandboxStates(events)
      .filter((state) => state.state !== 'released')
      .map((state) => ({
        operator: state.operator,
        environmentId: state.environmentId,
        provider: state.provider,
        state: state.state === 'stopped' ? ('stopped' as const) : ('live' as const),
        lastEvidenceAt: state.lastEvidenceTs,
      })),
    publications,
  }
}

export function renderRepositoryStatus(status: RepositoryStatus): string[] {
  const setting = (enabled: boolean): string => (enabled ? 'ON' : 'OFF')
  const active = status.ticketSourceDegradation
  return [
    ...(active === undefined
      ? []
      : [
          `ticket source ${active.source}: ${active.cause} (${active.operation}) — ${active.message}${'resetAt' in active ? `; reset ${active.resetAt}` : ''}`,
        ]),
    `repository: ${status.repo}`,
    `dispatcher: ${status.dispatcher.state}${status.dispatcher.holder ? ` — ${formatDispatcherIdentity(status.dispatcher.holder)}` : ' — no dispatcher holds the repository'}`,
    ...(status.dispatcher.expiredHolder
      ? [`expired dispatcher: ${formatDispatcherIdentity(status.dispatcher.expiredHolder)}`]
      : []),
    ...[status.dispatcher.holder ?? status.dispatcher.expiredHolder].flatMap((run) =>
      run
        ? [
            `last tick: ${run.lastTickAt ?? 'unknown'} (${run.lastTickAgeMs ?? 'unknown'}ms ago); ${JSON.stringify(run.lastTick)}`,
          ]
        : [],
    ),
    ...(status.dispatcher.latestStoppedRun
      ? [
          `last dispatcher stop: ${status.dispatcher.latestStoppedRun.stoppedAt}; ${status.dispatcher.latestStoppedRun.stop?.outcome}; signal ${status.dispatcher.latestStoppedRun.stop?.signal ?? 'none'}`,
        ]
      : []),
    `intake: ${setting(status.intake)}`,
    `repository pause: ${setting(status.paused)}`,
    `default auto-merge: ${setting(status.defaultAutoMerge)}`,
    ...status.sandboxes.map(
      (sandbox) =>
        `operator sandbox ${sandbox.environmentId} (${sandbox.provider}) — ${sandbox.state}, idle since ${sandbox.lastEvidenceAt}`,
    ),
    ...status.publications.map(
      (publication) =>
        `publication by ${publication.operator} — ${publication.branch} at ${publication.sha.slice(0, 8)} → PR #${publication.prNumber} (${publication.prUrl})`,
    ),
  ]
}

/**
 * `ab repository status` — read the durable dispatcher controls without
 * creating a repository stream or starting any dispatcher work.
 */
export async function abRepositoryStatus(opts: RepositoryStatusOpts): Promise<void> {
  await withSessionlessStore(opts, async ({ store, repo }) => {
    // A fresh store has no repository row. Do not call ensureRepo: this query's
    // empty-stream defaults must remain a genuinely read-only operation.
    const { events, dispatcher } = await readDispatcherLiveness(store, repo, opts.now?.())
    const status = projectRepositoryStatus(repo, events, dispatcher)
    if (opts.json === true) {
      opts.stdout(JSON.stringify(status, null, 2))
      return
    }
    for (const line of renderRepositoryStatus(status)) opts.stdout(line)
  })
}
