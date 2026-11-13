import { repositoryReadFactsReducer } from '../kernel/read-facts'
import { normalizeEffectiveConfigArtifact } from '../config/effective-artifact'
import { OPERATOR_PRESENCE_TTL_MS, type OperatorPresence } from '../store/operator-presence'
import { migrationIdentity } from '../kernel/ticket-migrations'
import {
  dispatchUpgradeReducer,
  upgradeRunRecency,
  type DispatchUpgradeState,
  type UpgradeRun,
} from '../kernel/dispatch-upgrade'
import { formatRuntimeIdentity } from '../events/runtime'
import { landingRestackDue } from '../kernel/engine'
import {
  dispatchCapacity,
  waitingExplanation,
  type DispatchCapacity,
  type CapacityBuild,
} from '../kernel/dispatch-capacity'
import {
  activeForgeCredentialLimits,
  forgeCredentialLimitsReducer,
  forgeHealthReducer,
  type ForgeCredentialLimit,
  type ForgeDegradation,
} from '../kernel/forge-health'
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

/** Why a status surface reports operator presence as unavailable. */
export const OPERATOR_PRESENCE_UNAVAILABLE =
  'operator presence is loaded only by ab repository status; this surface did not read registrations'

/**
 * Operator presence on a repository status. Only a `loaded` projection read
 * the presence registrations; its empty list is confirmed absence. An
 * `unavailable` projection is not evidence that no operator is present.
 */
export type RepositoryOperatorStatus =
  | { presence: 'loaded'; registrations: Array<OperatorPresence & { heartbeatAgeMs: number }> }
  | { presence: 'unavailable'; reason: string }

type UpgradeOutcome = NonNullable<
  UpgradeRun['completed' | 'failure' | 'handoff' | 'request' | 'prepared' | 'detected']
>

/** One run's upgrade condition. `superseded` marks a failure that later
 * evidence (a different resolved target or a later generation) replaced. */
export interface UpgradeStatusEntry {
  run: string
  resolved?: NonNullable<UpgradeRun['resolved']>['payload']['target']
  outcome?: UpgradeOutcome
  superseded?: true
}

/** The current, actionable upgrade condition: at most the live handoff, the
 * current generation, and the latest settled outcome from an earlier one. */
export interface RepositoryUpgradeStatus {
  handoff?: {
    run: string
    successor: string
    from: string
    to: string
    mode: string
    takenOver: boolean
    draining: Record<string, string>
    deadline?: string
  }
  current?: UpgradeStatusEntry
  previous?: UpgradeStatusEntry
}

export function projectUpgradeStatus(
  upgrades: DispatchUpgradeState,
  dispatcher: DispatcherLiveness,
): RepositoryUpgradeStatus {
  const runs = Object.entries(upgrades.runs)
  let live: [string, UpgradeRun] | undefined
  for (const entry of runs) {
    const state = entry[1]
    if (!state.handoff || !state.request || state.completed) continue
    if (!live || state.handoff.seq > live[1].handoff!.seq) live = entry
  }
  const currentRun =
    (dispatcher.holder ?? dispatcher.expiredHolder ?? dispatcher.latestRun)?.run ??
    upgrades.authoritativeRun ??
    runs.reduce<[string, UpgradeRun] | undefined>(
      (newest, entry) =>
        !newest || upgradeRunRecency(entry[1]) > upgradeRunRecency(newest[1]) ? entry : newest,
      undefined,
    )?.[0]
  const state = currentRun === undefined ? undefined : upgrades.runs[currentRun]
  const outcome =
    state &&
    (state.completed ??
      state.failure ??
      state.handoff ??
      state.request ??
      state.prepared ??
      state.detected)
  let previous: [string, NonNullable<UpgradeRun['completed' | 'failure']>] | undefined
  for (const [run, entry] of runs) {
    const settled = entry.completed ?? entry.failure
    if (!settled || run === currentRun || run === live?.[0]) continue
    if (!previous || settled.seq > previous[1].seq) previous = [run, settled]
  }
  return {
    ...(live && {
      handoff: {
        run: live[0],
        successor: live[1].request!.payload.successor,
        from: live[1].handoff!.payload.from.version,
        to: live[1].handoff!.payload.to.version,
        mode: live[1].request!.payload.mode,
        takenOver: live[1].takeover !== undefined,
        draining: { ...live[1].outstanding },
        ...(live[1].deadline === undefined ? {} : { deadline: live[1].deadline }),
      },
    }),
    ...(state &&
      currentRun !== undefined && {
        current: {
          run: currentRun,
          ...(state.resolved && { resolved: state.resolved.payload.target }),
          ...(outcome && { outcome }),
          // A failure stays recorded until a preparation or handoff clears it;
          // a later resolution of a different target supersedes it for status.
          ...(outcome?.type === 'dispatcher.upgrade-failed' &&
            state.resolved &&
            state.resolved.seq > outcome.seq &&
            state.resolved.payload.target.key !== outcome.payload.target.key && {
              superseded: true as const,
            }),
        },
      }),
    ...(previous && {
      previous: {
        run: previous[0],
        outcome: previous[1],
        // A later generation exists, so an earlier failure is never current.
        ...(previous[1].type === 'dispatcher.upgrade-failed' && { superseded: true as const }),
      },
    }),
  }
}

/** Script-facing projection returned by `ab repository status`. */
export interface RepositoryStatus extends DispatchSettings {
  operator: RepositoryOperatorStatus
  repo: string
  /** Bounded retention window; full history stays in the repository journal. */
  upgrades: DispatchUpgradeState
  upgradeStatus: RepositoryUpgradeStatus
  rollbackHold?: DispatchUpgradeState['lastRollback']
  capacity?: DispatchCapacity
  /** Dispatcher startup warnings, then forge readiness warnings. */
  warningLines?: string[]
  /** Standing ticket diagnostics from the latest completed ticket scan — for
   * example an invalid ticket, or a ready ticket whose labels select more than
   * one role profile and is therefore not claimed. */
  ticketDiagnostics?: string[]
  /** Standing dependency/target diagnostics from the latest completed ticket
   * scan — for example a ticket held because its target node is being built
   * by another store. */
  dependencyDiagnostics?: string[]
  missingAccounts?: RepositoryReadFacts['missingAccounts']
  dispatcher: DispatcherLiveness
  forgeRequests?: ForgeRequestCounts
  forgeRequestHotspot?: string
  forgeDegradation?: ForgeDegradation
  /** Active rate limits outside the dispatcher's credential (unauthenticated
   * requests, build runners, phase sessions). They never pause dispatcher
   * forge work; each names the limited process. */
  forgeCredentialLimits?: ForgeCredentialLimit[]
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
  now: Date = new Date(),
): RepositoryStatus {
  const credentialLimits = activeForgeCredentialLimits(
    forgeCredentialLimitsReducer.reduce(events),
    now,
  )
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
  const runStatus =
    latestRun?.type === 'dispatcher.run-started'
      ? reduceDispatchStatus(events, latestRun.payload.run)
      : undefined
  const warningLines = runStatus
    ? [...runStatus.roleWarnings, ...forgeReadinessWarnings(runStatus)]
    : []
  const latestScan = events.findLast((event) => event.type === 'dispatcher.ticket-scan-completed')
  const dependencyDiagnostics =
    latestScan?.type === 'dispatcher.ticket-scan-completed'
      ? latestScan.payload.dependencyDiagnostics
      : []
  const ticketDiagnostics =
    latestScan?.type === 'dispatcher.ticket-scan-completed'
      ? latestScan.payload.ticketDiagnostics
      : []
  return {
    ...(forgeHealthReducer.reduce(events)
      ? { forgeDegradation: forgeHealthReducer.reduce(events) }
      : {}),
    ...(credentialLimits.length ? { forgeCredentialLimits: credentialLimits } : {}),
    ...(active === undefined ? {} : { ticketSourceDegradation: active }),
    ...(Object.keys(repositoryReadFactsReducer.reduce(events).missingAccounts).length
      ? { missingAccounts: repositoryReadFactsReducer.reduce(events).missingAccounts }
      : {}),
    repo,
    operator: { presence: 'unavailable', reason: OPERATOR_PRESENCE_UNAVAILABLE },
    upgrades: dispatchUpgradeReducer.reduce(events),
    upgradeStatus: projectUpgradeStatus(dispatchUpgradeReducer.reduce(events), dispatcher),
    rollbackHold: effectiveRollbackHold(dispatchUpgradeReducer.reduce(events), dispatcher),
    ...(warningLines.length ? { warningLines } : {}),
    ...(ticketDiagnostics.length ? { ticketDiagnostics: [...ticketDiagnostics] } : {}),
    ...(dependencyDiagnostics.length ? { dependencyDiagnostics: [...dependencyDiagnostics] } : {}),
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
  now: Date = new Date(),
): RepositoryStatus {
  const credentialLimits = activeForgeCredentialLimits(facts.forgeCredentialLimits, now)
  const warningLines = facts.status
    ? [...facts.status.roleWarnings, ...forgeReadinessWarnings(facts.status)]
    : []
  const dependencyDiagnostics = facts.scan?.dependencyDiagnostics ?? []
  const ticketDiagnostics = facts.scan?.ticketDiagnostics ?? []
  return {
    ...(Object.keys(facts.missingAccounts).length
      ? { missingAccounts: facts.missingAccounts }
      : {}),
    repo,
    operator: { presence: 'unavailable', reason: OPERATOR_PRESENCE_UNAVAILABLE },
    upgrades: facts.upgrades,
    upgradeStatus: projectUpgradeStatus(facts.upgrades, dispatcher),
    rollbackHold: effectiveRollbackHold(facts.upgrades, dispatcher),
    ...(warningLines.length ? { warningLines } : {}),
    ...(ticketDiagnostics.length ? { ticketDiagnostics: [...ticketDiagnostics] } : {}),
    ...(dependencyDiagnostics.length ? { dependencyDiagnostics: [...dependencyDiagnostics] } : {}),
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
    ...(credentialLimits.length ? { forgeCredentialLimits: credentialLimits } : {}),
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

function renderUpgradeOutcome(entry: UpgradeStatusEntry): string[] {
  const event = entry.outcome
  if (!event) return []
  const target = event.payload.target
  const type = `${event.type.slice('dispatcher.'.length)}${entry.superseded ? ' (superseded)' : ''}`
  return [
    `upgrade ${entry.run}: ${type}; ${target.mode} ${target.version ?? target.source}; source ${target.source}${target.sha ? ` at ${target.sha}` : ''}${event.type === 'dispatcher.upgrade-failed' ? `; ${event.payload.reason}` : ''}`,
  ]
}

function renderUpgradeStatus({ handoff, current, previous }: RepositoryUpgradeStatus): string[] {
  const resolved = current?.resolved
  return [
    ...(handoff
      ? [
          `handoff ${handoff.run} (${handoff.from}) → ${handoff.successor} (${handoff.to}): ${handoff.mode}; ${handoff.takenOver ? 'taken over' : 'awaiting takeover'}; draining ${
            Object.entries(handoff.draining)
              .map(([slug, instance]) => `${slug} (${instance})`)
              .join(', ') || 'none'
          }; deadline ${handoff.deadline ?? 'unknown'}`,
        ]
      : []),
    ...(current && resolved
      ? [
          `resolved target ${current.run}: ${resolved.mode}; base ${resolved.base ?? '-'}; source ${resolved.source}${resolved.sha ? ` at ${resolved.sha}` : ''}`,
        ]
      : []),
    ...(current ? renderUpgradeOutcome(current) : []),
    ...(previous ? renderUpgradeOutcome(previous) : []),
  ]
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
    ...Object.values(status.missingAccounts ?? {}).map(
      (account) => `Missing credentials: ${account.remedy} [${account.source}]`,
    ),
    status.operator.presence === 'unavailable'
      ? 'operator: unavailable (presence not loaded)'
      : status.operator.registrations.length
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
    ...renderUpgradeStatus(status.upgradeStatus),
    requests
      ? `forge requests: ${requests.total}${requests.restPrimary === undefined ? '' : `; REST primary ${requests.restPrimary}`}${requests.restNotModified === undefined ? '' : `; REST 304 ${requests.restNotModified}`}${requests.graphql === undefined ? '' : `; GraphQL ${requests.graphql}`} (${requests.unattributed} unattributed)${hotspot ? `; hotspot ${hotspot}` : ''}`
      : 'forge requests: unavailable',
    ...(status.forgeDegradation
      ? [
          `forge ${status.forgeDegradation.forge}: degraded — ${status.forgeDegradation.message}; reset ${status.forgeDegradation.resetAt}`,
        ]
      : []),
    ...(status.forgeCredentialLimits ?? []).map(
      (limit) =>
        `forge ${limit.forge}: ${limit.process} rate-limited (${limit.credential}${limit.missingCredential ? `: ${limit.missingCredential}` : ''}) until ${limit.resetAt}; dispatcher forge work is not paused`,
    ),
    ...(active === undefined
      ? []
      : [
          `ticket source ${active.source}: ${active.cause} (${active.operation}) — ${active.message}${'resetAt' in active ? `; reset ${active.resetAt}` : ''}`,
        ]),
    `repository: ${status.repo}`,
    ...(status.capacity
      ? [
          `capacity: ${status.capacity.occupied}/${status.capacity.effective} effective; ${status.capacity.configured} configured; ${status.capacity.borrowingNodes.length} node${status.capacity.borrowingNodes.length === 1 ? '' : 's'} using descendant-held slots${status.capacity.borrowingNodes.length ? `: ${status.capacity.borrowingNodes.join(', ')}` : ''}${status.capacity.waitingNodes?.length || status.capacity.waitingBuilds?.length ? `; ${waitingExplanation(status.capacity, { requests: true })}` : ''}`,
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
    ...(status.ticketDiagnostics ?? []).map((line) => `queue: ${line}`),
    ...(status.dependencyDiagnostics ?? []).map((line) => `queue: ${line}`),
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
          restackDue: landingRestackDue(build.state, build.log),
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
    const status = repositoryStatusFromFacts(repo, facts, dispatcher, observedAt)
    status.operator = {
      presence: 'loaded',
      registrations: (await store.listOperatorPresence(repo))
        .map((row) => ({
          ...row,
          heartbeatAgeMs: Math.max(0, observedAt.getTime() - Date.parse(row.heartbeatAt)),
        }))
        .filter((row) => row.heartbeatAgeMs < OPERATOR_PRESENCE_TTL_MS),
    }
    const capacity = await readRepositoryCapacity(store, repo, facts, dispatcher, observedAt)
    if (capacity) status.capacity = capacity
    if (opts.json === true) {
      opts.stdout(JSON.stringify(status, null, 2))
      return
    }
    for (const line of renderRepositoryStatus(status)) opts.stdout(line)
  })
}
