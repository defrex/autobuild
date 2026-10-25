import { normalizeEffectiveConfigArtifact } from '../config/effective-artifact'
import { OPERATOR_PRESENCE_TTL_MS, type OperatorPresence } from '../store/operator-presence'
import { migrationIdentity } from '../kernel/ticket-migrations'
import { dispatchUpgradeReducer, type DispatchUpgradeState } from '../kernel/dispatch-upgrade'
import { formatRuntimeIdentity } from '../events/runtime'
import {
  dispatchCapacity,
  type DispatchCapacity,
  type CapacityBuild,
} from '../kernel/dispatch-capacity'
import { forgeHealthReducer, type ForgeDegradation } from '../kernel/forge-health'
import { forgeHotspot, type ForgeRequestCounts } from '../ports/forge-telemetry'
import { configSchema } from '../config/schema'
import type { BuildStore } from '../store/types'
import { readBuildFacts } from '../store/reduced-reads'
import { forgeReadinessWarnings, reduceDispatchStatus } from '../kernel/dispatch-status'
import { readRepositoryFacts, type RepositoryReadFacts } from '../store/reduced-reads'
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
  operator: { registrations: Array<OperatorPresence & { heartbeatAgeMs: number }> }
  repo: string
  upgrades: DispatchUpgradeState
  rollbackHold?: DispatchUpgradeState['lastRollback']
  capacity?: DispatchCapacity
  warningLines?: string[]
  dispatcher: DispatcherLiveness
  forgeRequests?: ForgeRequestCounts
  forgeRequestHotspot?: string
  forgeDegradation?: ForgeDegradation
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
  const latestRun = events.findLast((event) => event.type === 'dispatcher.run-started')
  const warningLines =
    latestRun?.type === 'dispatcher.run-started'
      ? forgeReadinessWarnings(reduceDispatchStatus(events, latestRun.payload.run))
      : []
  return {
    ...(forgeHealthReducer.reduce(events)
      ? { forgeDegradation: forgeHealthReducer.reduce(events) }
      : {}),
    ...(active === undefined ? {} : { ticketSourceDegradation: active }),
    repo,
    operator: { registrations: [] },
    upgrades: dispatchUpgradeReducer.reduce(events),
    rollbackHold: effectiveRollbackHold(dispatchUpgradeReducer.reduce(events), dispatcher),
    ...(warningLines.length ? { warningLines } : {}),
    dispatcher,
    ...(() => {
      const tick = (dispatcher.holder ?? dispatcher.expiredHolder ?? dispatcher.latestRun)?.lastTick
      const forgeRequests =
        tick?.outcome === 'completed' ? tick.counters.forgeRequests : tick?.forgeRequests
      return forgeRequests
        ? { forgeRequests, forgeRequestHotspot: forgeHotspot(forgeRequests) }
        : {}
    })(),
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

export function repositoryStatusFromFacts(
  repo: string,
  facts: RepositoryReadFacts,
  dispatcher: DispatcherLiveness,
): RepositoryStatus {
  const warningLines = facts.status ? forgeReadinessWarnings(facts.status) : []
  return {
    repo,
    operator: { registrations: [] },
    upgrades: facts.upgrades,
    rollbackHold: effectiveRollbackHold(facts.upgrades, dispatcher),
    ...(warningLines.length ? { warningLines } : {}),
    dispatcher,
    ...(() => {
      const tick = (dispatcher.holder ?? dispatcher.expiredHolder ?? dispatcher.latestRun)?.lastTick
      const forgeRequests =
        tick?.outcome === 'completed' ? tick.counters.forgeRequests : tick?.forgeRequests
      return forgeRequests
        ? { forgeRequests, forgeRequestHotspot: forgeHotspot(forgeRequests) }
        : {}
    })(),
    ...facts.settings,
    ...(facts.forgeHealth ? { forgeDegradation: facts.forgeHealth } : {}),
    ...(facts.health === undefined ? {} : { ticketSourceDegradation: facts.health }),
    sandboxes: facts.sandboxes
      .filter((state) => state.state !== 'released')
      .map((state) => ({
        operator: state.operator,
        environmentId: state.environmentId,
        provider: state.provider,
        state: state.state === 'stopped' ? ('stopped' as const) : ('live' as const),
        lastEvidenceAt: state.lastEvidenceTs,
      })),
    publications: [...facts.publications].reverse().map((event) => ({
      operator: event.payload.operator,
      branch: event.payload.branch,
      sha: event.payload.sha,
      prNumber: event.payload.pr.number,
      prUrl: event.payload.pr.url,
      ...(event.payload.session !== undefined ? { session: event.payload.session } : {}),
      at: event.ts,
    })),
  }
}

function effectiveRollbackHold(upgrades: DispatchUpgradeState, dispatcher: DispatcherLiveness) {
  const run = dispatcher.holder ?? dispatcher.expiredHolder ?? dispatcher.latestRun
  const lineage = run && upgrades.lineages[run.run]
  return lineage ? upgrades.holds[lineage] : undefined
}

function formatRepositoryDispatcherIdentity(
  run: NonNullable<DispatcherLiveness['latestRun']>,
): string {
  return `${formatDispatcherIdentity(run)}; ${formatRuntimeIdentity(run.runtime)}`
}

export function renderRepositoryStatus(status: RepositoryStatus): string[] {
  const tick = (
    status.dispatcher.holder ??
    status.dispatcher.expiredHolder ??
    status.dispatcher.latestRun
  )?.lastTick
  const requests = tick?.outcome === 'completed' ? tick.counters.forgeRequests : tick?.forgeRequests
  const hotspot = forgeHotspot(requests)
  const setting = (enabled: boolean): string => (enabled ? 'ON' : 'OFF')
  const active = status.ticketSourceDegradation
  return [
    status.operator.registrations.length
      ? `operator: present (${status.operator.registrations.length} registrations)`
      : 'operator: absent',
    ...(status.upgrades.lastRollback
      ? [
          `runtime rollback: ${status.upgrades.lastRollback.payload.failed.version} → ${status.upgrades.lastRollback.payload.restored.version}; ${status.upgrades.lastRollback.payload.reason}`,
        ]
      : []),
    ...(status.rollbackHold
      ? [
          `held runtime: ${status.rollbackHold.payload.failed.version}; target ${status.rollbackHold.payload.target.key}`,
        ]
      : []),
    ...Object.entries(status.upgrades.runs).flatMap(([run, state]) => {
      const event =
        state.completed ??
        state.failure ??
        state.handoff ??
        state.request ??
        state.prepared ??
        state.detected
      const resolved = state.resolved?.payload.target
      const lines = resolved
        ? [
            `resolved target ${run}: ${resolved.mode}; base ${resolved.base ?? '-'}; source ${resolved.source}${resolved.sha ? ` at ${resolved.sha}` : ''}`,
          ]
        : []
      if (!event) return lines
      const target = event.payload.target
      const overlap =
        state.handoff && state.request && !state.completed
          ? [
              `handoff ${run} (${state.handoff.payload.from.version}) → ${state.request.payload.successor} (${state.handoff.payload.to.version}): ${state.request.payload.mode}; ${state.takeover ? 'taken over' : 'awaiting takeover'}; draining ${
                Object.entries(state.outstanding)
                  .map(([slug, instance]) => `${slug} (${instance})`)
                  .join(', ') || 'none'
              }; deadline ${state.deadline ?? 'unknown'}`,
            ]
          : []
      return [
        ...lines,
        ...overlap,
        `upgrade ${run}: ${event.type.slice('dispatcher.'.length)}; ${target.mode} ${target.version ?? target.source}; source ${target.source}${target.sha ? ` at ${target.sha}` : ''}${event.type === 'dispatcher.upgrade-failed' ? `; ${event.payload.reason}` : ''}`,
      ]
    }),
    requests
      ? `forge requests: ${requests.total}${requests.restPrimary === undefined ? '' : `; REST primary ${requests.restPrimary}`}${requests.restNotModified === undefined ? '' : `; REST 304 ${requests.restNotModified}`}${requests.graphql === undefined ? '' : `; GraphQL ${requests.graphql}`} (${requests.unattributed} unattributed)${hotspot ? `; hotspot ${hotspot}` : ''}`
      : 'forge requests: unavailable',
    ...(status.forgeDegradation
      ? [
          `forge ${status.forgeDegradation.forge}: degraded — ${status.forgeDegradation.message}; reset ${status.forgeDegradation.resetAt}`,
        ]
      : []),
    ...(active === undefined
      ? []
      : [
          `ticket source ${active.source}: ${active.cause} (${active.operation}) — ${active.message}${'resetAt' in active ? `; reset ${active.resetAt}` : ''}`,
        ]),
    `repository: ${status.repo}`,
    ...(status.capacity
      ? [
          `capacity: ${status.capacity.occupied}/${status.capacity.effective} effective; ${status.capacity.configured} configured; ${status.capacity.borrowingNodes.length} node${status.capacity.borrowingNodes.length === 1 ? '' : 's'} using descendant-held slots${status.capacity.borrowingNodes.length ? `: ${status.capacity.borrowingNodes.join(', ')}` : ''}`,
        ]
      : []),
    ...(status.warningLines ?? []),
    `dispatcher: ${status.dispatcher.state}${status.dispatcher.holder ? ` — ${formatRepositoryDispatcherIdentity(status.dispatcher.holder)}` : ' — no dispatcher holds the repository'}`,
    ...(status.dispatcher.expiredHolder
      ? [
          `expired dispatcher: ${formatRepositoryDispatcherIdentity(status.dispatcher.expiredHolder)}`,
        ]
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

/** Capacity is optional when no held dispatcher has a retrievable configuration. */
export async function readRepositoryCapacity(
  store: BuildStore,
  repo: string,
  facts: RepositoryReadFacts,
  dispatcher: DispatcherLiveness,
  now: Date,
): Promise<DispatchCapacity | undefined> {
  if (
    dispatcher.state === 'held' &&
    facts.status?.effectiveConfig &&
    facts.status.run === dispatcher.holder?.run
  ) {
    const ref = facts.status.effectiveConfig
    const artifact = await store.getRepoArtifact(repo, ref.kind, ref.rev)
    if (artifact) {
      const config = configSchema.parse(
        normalizeEffectiveConfigArtifact(JSON.parse(new TextDecoder().decode(artifact.content))),
      )
      const builds: CapacityBuild[] = []
      const records = await store.listBuildsForRepo(repo)
      const digests = await store.getRepoBuildDigests(repo)
      for (const record of records) {
        if (digests.get(record.slug)?.terminal) continue
        const build = (await readBuildFacts(store, record.slug)).value
        builds.push({
          record,
          state: build.state,
          workspace: build.workspace !== null,
          provisioning: build.provisionMarker !== undefined,
        })
      }
      return dispatchCapacity(
        builds,
        config.capacity,
        now,
        migrationIdentity(facts.ticketMigrations, config.tickets.source),
      )
    }
  }
  return undefined
}

/**
 * `ab repository status` — read the durable dispatcher controls without
 * creating a repository stream or starting any dispatcher work.
 */
export async function abRepositoryStatus(opts: RepositoryStatusOpts): Promise<void> {
  await withSessionlessStore(opts, async ({ store, repo }) => {
    // A fresh store has no repository row. Do not call ensureRepo: this query's
    // empty-stream defaults must remain a genuinely read-only operation.
    const observedAt = opts.now?.() ?? new Date()
    const { dispatcher } = await readDispatcherLiveness(store, repo, observedAt)
    const facts = (await readRepositoryFacts(store, repo)).value
    const status = repositoryStatusFromFacts(repo, facts, dispatcher)
    status.operator.registrations = (await store.listOperatorPresence(repo))
      .map((row) => ({
        ...row,
        heartbeatAgeMs: Math.max(0, observedAt.getTime() - Date.parse(row.heartbeatAt)),
      }))
      .filter((row) => row.heartbeatAgeMs < OPERATOR_PRESENCE_TTL_MS)
    const capacity = await readRepositoryCapacity(store, repo, facts, dispatcher, observedAt)
    if (capacity) status.capacity = capacity
    if (opts.json === true) {
      opts.stdout(JSON.stringify(status, null, 2))
      return
    }
    for (const line of renderRepositoryStatus(status)) opts.stdout(line)
  })
}
