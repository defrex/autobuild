/**
 * The dispatcher process (SPEC §3.3, §12): watches the TicketSource for
 * Ready tickets, claims, provisions a workspace, and launches build-runners
 * up to a capacity limit — plus janitor duty over the post-PR epilogue
 * (§15.7, D1) and the stale-lease sweep (§15.6-C). Cron-friendly: one
 * `tick()` does one pass over everything and is safe to re-run — every
 * action is deduped against the reduced event log, and single-writer
 * discipline (§12) means at most one dispatcher runs per repo.
 *
 * Order within a tick (deliberate):
 *   a. JANITOR   — settles finished work first, releasing capacity that the
 *                  dispatch step below can immediately reuse.
 *   b. STARTUP RESUME (first CLI tick only) — attempts every actionable
 *                  current build, including policy-exhausted infra failures.
 *   c. LEASE SWEEP — re-attaches runners to builds whose runner died.
 *   d. DISPATCH  — fills remaining capacity from Ready tickets.
 *   e. HARVEST   — observation back-pressure, independent of build capacity.
 * A build launched in an earlier step is never launched again by a later
 * one (per-tick launch dedupe); a build dispatched in step (d) is not swept
 * in the same tick because the sweep already ran.
 *
 * The dispatcher never runs pipeline agents (§15.7) — conflicted PRs and
 * stale leases both resolve by re-attaching a build-runner via
 * `launchRunner`. Optional pre-build judgment (spec authoring and short slug
 * naming) lives behind bounded seams before a build exists; deterministic
 * validation and fallback remain here. The runner claims the build's lease
 * itself; the dispatcher only ever reads lease expiry.
 */
import type { Config } from '../config/schema'
import { DISPATCHER, agentActor, humanActor } from '../events/envelope'
import type { AbEvent, EventWrite } from '../events/catalog'
import type { IdSource } from '../ids'
import {
  autoMergeApplicationType,
  pendingAutoMerge,
} from '../kernel/auto-merge'
import { decideNext } from '../kernel/engine'
import {
  DEFAULT_MAX_HARVEST_RECOVERY_ATTEMPTS,
  decideHarvestControl,
  reduceHarvest,
} from '../kernel/harvest'
import { reduceBuild, type BuildState } from '../kernel/reducer'
import type { ArtifactRef } from '../ontology'
import type {
  DependencyState,
  Forge,
  Ticket,
  TicketSource,
  WorkspaceProvider,
} from '../ports/types'
import type { Exec } from '../ports/workspace/git-worktree'
import type { ArtifactMeta, BuildRecord, BuildStore, Clock } from '../store/types'
import { specConformance } from '../spec-standard'
export { specConformance, type SpecConformance } from '../spec-standard'

// ── Readiness resolution (SPEC §3.3) ─────────────────────────────────────────

/**
 * What "ready for dispatch" means, resolved against the ticket source.
 *
 * The state gate is no longer source-defaulted: `readyState` is a required,
 * non-blank config value (src/config/schema.ts), so both sources gate on the
 * exact configured state and always return one. The removed branch — where the
 * linear source left `state` unset when `readyState` was absent — was the
 * AUT-10 hole: with no state filter, every labelled ticket was eligible in any
 * workflow state, so a completed ticket still carrying the label got dispatched
 * again. That branch is now unrepresentable.
 *
 * The only per-source difference left is the *label* default. Linear has no
 * `ready/` directory, so a label is the only thing that can mark a ticket
 * dispatchable: the historical `["autobuild"]` default. The file tracker's gate
 * is otherwise the directory, so it defaults to no label gate. An explicit
 * `readyLabels` wins for either source.
 */
export function readyCriteria(config: Config): { labels: string[]; state: string } {
  const { readyLabels, readyState } = config.tickets
  if (config.tickets.source === 'linear') {
    return { labels: readyLabels ?? ['autobuild'], state: readyState }
  }
  return { labels: readyLabels ?? [], state: readyState }
}

/**
 * Where the dispatcher hands work back to a human — spec-gate bounces (§6.3),
 * aborted builds, closed-unmerged PRs. Source-dependent for the same reason
 * readiness is: the file tracker's grooming area IS the `triage/` directory,
 * while a Linear team only has a "Triage" workflow state when the team's
 * triage feature is enabled — Backlog is the state every Linear team has.
 */
export function defaultTriageState(config: Config): string {
  return (
    config.tickets.triageState ??
    (config.tickets.source === 'linear' ? 'Backlog' : 'Triage')
  )
}

// ── Spec quality gate (SPEC §6.3, docs/spec-standard.md) ─────────────────────
// Shared with deterministic harvest filing; imported/re-exported above so the
// long-standing dispatcher API remains stable.

// ── Ticket dependency gate (SPEC §13) ────────────────────────────────────────
//
// Division of labor: the TicketSource answers FACTS (does this blocker exist,
// is it resolved by my native lifecycle, what does it declare as its own
// blockers); the dispatcher decides POLICY (an unresolved blocker means don't
// dispatch; a broken graph means skip this ticket, not the tick). Keeping the
// decision here means one tested implementation instead of one per adapter,
// and no adapter's state taxonomy leaks upward.

export interface DependencyVerdict {
  /** Unresolved blocker ids — nonempty means DO NOT dispatch. */
  unresolved: string[]
  /** Actionable lines naming the affected ticket and the dependency. */
  diagnostics: string[]
}

/**
 * Walks back from `from` looking for a node already on `path`; returns the
 * cycle (first repeated node → … → itself) or null. `explored` prunes nodes
 * proven acyclic on an earlier branch, so a wide graph cannot blow up.
 *
 * Note the repeat test is against `path`, not `nodes` — which is why closing a
 * cycle back onto the ticket under analysis needs no entry for it in `nodes`.
 */
function findCycle(
  from: string,
  path: string[],
  nodes: Map<string, DependencyState>,
  explored: Set<string>,
): string[] | null {
  for (const next of nodes.get(from)?.blockedBy ?? []) {
    const seen = path.indexOf(next)
    if (seen !== -1) return [...path.slice(seen), next]
    if (explored.has(next)) continue
    const cycle = findCycle(next, [...path, next], nodes, explored)
    if (cycle) return cycle
    explored.add(next)
  }
  return null
}

/**
 * Whether the ticket `ticketId`, which declares `blockedBy`, may be
 * dispatched — given `nodes`, closed over its reachable blockers (see
 * `loadDependencyGraph`).
 *
 * The ticket's own blockers are a PARAMETER, not a lookup in `nodes`: they
 * come from the ticket itself, which is authoritative for them. `nodes` holds
 * only facts fetched from the source, so nothing here has to fabricate an
 * entry for the ticket under analysis — a fabrication that, in a cache shared
 * across a tick, is indistinguishable from a fact about a *blocker* when the
 * next ticket looks it up.
 *
 * Pure and total: a node the walk cannot find is treated as
 * already-reported-missing rather than throwing. Exported for testing, like
 * `specConformance`.
 */
export function analyzeDependencies(
  ticketId: string,
  blockedBy: string[],
  nodes: Map<string, DependencyState>,
): DependencyVerdict {
  const unresolved: string[] = []
  const diagnostics: string[] = []

  for (const blockerId of blockedBy) {
    if (blockerId === ticketId) {
      unresolved.push(blockerId)
      diagnostics.push(`ticket ${ticketId} depends on itself`)
      continue
    }
    const node = nodes.get(blockerId)
    if (!node || !node.exists) {
      unresolved.push(blockerId)
      diagnostics.push(
        `ticket ${ticketId} blocked by ${blockerId}, which does not exist in ` +
          'this ticket source',
      )
      continue
    }
    // A resolved blocker imposes nothing, and its own history is irrelevant —
    // never walked, so a cycle *behind* completed work is not a diagnostic.
    if (node.resolved) continue

    unresolved.push(blockerId)
    // Gating never needs the transitive walk (an unresolved blocker already
    // holds the ticket); the walk exists only to NAME a cycle, which direct
    // blockers alone cannot express.
    const cycle = findCycle(
      blockerId,
      [ticketId, blockerId],
      nodes,
      new Set<string>(),
    )
    diagnostics.push(
      cycle
        ? `ticket ${ticketId}: dependency cycle ${cycle.join(' → ')}`
        : `ticket ${ticketId} blocked by ${blockerId} (not complete)`,
    )
  }

  return { unresolved, diagnostics }
}

/** `Add rate limiting!` → `add-rate-limiting` (general title normalizer). */
export function kebab(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'build'
}

/** Deterministic naming fallback: the first three normalized title tokens. */
export function fallbackSlug(title: string): string {
  return kebab(title).split('-').slice(0, 3).join('-')
}

/**
 * Validate a judgment-produced slug base without repairing model prose. Outer
 * whitespace is harmless; everything else must already be one-to-three
 * lowercase ASCII kebab tokens. Collision suffixes are appended later and are
 * intentionally outside this budget.
 */
export function validateSlugCandidate(candidate: string | null | undefined): string | null {
  if (candidate === null || candidate === undefined) return null
  const trimmed = candidate.trim()
  return /^[a-z0-9]+(?:-[a-z0-9]+){0,2}$/.test(trimmed) ? trimmed : null
}

// ── Tick report ──────────────────────────────────────────────────────────────

/** Counts per action, for observability and tests. An idempotent re-run of
 * `tick()` over unchanged state reports all zeroes — except invalid-record and
 * dependency fields, which are standing queue reports rather than records of
 * action. They repeat on every ready scan by design, because that is the only
 * place the source problems are visible without provider inspection. */
export interface TickReport {
  /** Janitor (§15.7): builds completed as merged. */
  merged: number
  /** Janitor: builds completed as closed-unmerged. */
  closed: number
  /** Janitor: `pr.conflicted` emitted + build-runner re-attached. */
  conflicted: number
  /** Janitor: aborted builds cleaned up and completed as abandoned. */
  abandoned: number
  /** Dispatch-command startup: current builds for which a runner was launched. */
  resumed: number
  /** Lease sweep (§15.6-C): runners re-attached to stale builds. */
  swept: number
  /** Dispatch (§12): builds created and launched. */
  dispatched: number
  /** Of `dispatched`: specs produced via the authorSpec seam (§6.3). */
  authored: number
  /** Dispatch quality gate (§6.3): tickets bounced back to Triage. */
  bounced: number
  /** Claim-before-launch (§12): claims lost to another dispatcher. */
  claimRaces: number
  /** Invalid source records excluded from this ready listing. Like dependency
   * fields, this is a standing count and is re-reported until repaired. */
  invalidTickets: number
  /** Actionable source diagnostics for each excluded invalid record. */
  ticketDiagnostics: string[]
  /** Dependency gate (§13): ready tickets held back by unresolved blockers. */
  dependencyBlocked: number
  /** One line per held ticket naming its unresolved blockers — the operator's
   * only view of the dependency queue short of provider inspection. */
  dependencyDiagnostics: string[]
  /** Repository observation workflow counters (independent of build capacity).
   * The CLI's in-flight coordinator merges these when asynchronous harvest
   * runs settle; Dispatcher.tick itself only initiates the work. */
  harvestStarted: number
  harvestResumed: number
  harvestCompleted: number
  harvestEscalated: number
  harvestFailed: number
}

export function emptyTickReport(): TickReport {
  return {
    merged: 0,
    closed: 0,
    conflicted: 0,
    abandoned: 0,
    resumed: 0,
    swept: 0,
    dispatched: 0,
    authored: 0,
    bounced: 0,
    claimRaces: 0,
    invalidTickets: 0,
    ticketDiagnostics: [],
    dependencyBlocked: 0,
    dependencyDiagnostics: [],
    harvestStarted: 0,
    harvestResumed: 0,
    harvestCompleted: 0,
    harvestEscalated: 0,
    harvestFailed: 0,
  }
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

const DEFAULT_SLUG_NAMING_TIMEOUT_MS = 10_000

export interface DispatcherOpts {
  /**
   * Grace for builds with NO lease at all: the sweep treats an absent lease
   * as expired only once this long has passed since the build's last store
   * update — a just-launched runner needs time to claim its first lease.
   * Default 0 (the simple predicate: absent ≡ expired). Expired-but-present
   * leases are always swept immediately.
   */
  leaseTtlMs?: number
  /**
   * Ticket state that hands work back to a human. Aborted work and
   * closed-unmerged PRs go back here rather than to a done-state — an abort
   * or close is a human decision that the ticket needs human re-triage, not
   * silent completion. Bounced tickets (§6.3) land here too. Absent =
   * defaultTriageState(config): [tickets].triageState, else 'Backlog'
   * (linear) / 'Triage' (file).
   */
  triageState?: string
  /** Ticket state for merged builds. Default 'Done'. */
  doneState?: string
  /** Internal deadline for the optional pre-build naming seam. Production is
   * fixed; injection exists only so timeout behavior is deterministic in tests. */
  slugNamingTimeoutMs?: number
  /** Must match the HarvestRunner's durable outer recovery budget. */
  maxHarvestRecoveryAttempts?: number
}

export interface TickOpts {
  /**
   * Attempt every actionable, non-terminal build for this repo before the
   * ordinary stale-lease sweep. `ab dispatch` sets this only on its first
   * tick: a process restart is an explicit retry boundary, not an endless
   * reset of the per-phase failure budget on every watch tick.
   */
  resumeCurrent?: boolean
  /**
   * Repository-derived intake gate supplied by the CLI for this tick. False
   * skips only the ready-ticket list/claim/dispatch stage; janitor, startup
   * resume, lease sweep, and in-flight runners continue. Absent defaults true.
   */
  acceptNewWork?: boolean
  /**
   * Repository-derived claim-time default supplied by the CLI for this tick.
   * True records the existing durable auto-merge request only on builds
   * created by this tick's ticket claims. Absent/false preserves the sequence.
   */
  defaultAutoMerge?: boolean
  /** Human attribution for a claim-time auto-merge request. Required when
   * `defaultAutoMerge` is true; the CLI resolves USER/USERNAME/fallback. */
  autoMergeUser?: string
}

/** Process-local launch coordination result. Durable lease acquisition remains
 * the BuildRunner's responsibility; "scheduled" means only that this process
 * accepted a runner launch rather than suppressing a known in-flight slug. */
export type LaunchRunnerResult = 'scheduled' | 'already-active'

export interface DispatcherDeps {
  store: BuildStore
  tickets: TicketSource
  workspaces: WorkspaceProvider
  forge: Forge
  config: Config
  /** The repo this dispatcher serves — a local path (§15.7: `git ls-remote`
   * against it needs no network). One dispatcher per repo (§12). */
  repo: string
  exec: Exec
  /** Launch (or re-attach — §15.6-C, §15.7) a build-runner for `slug`. The
   * dispatcher never runs pipeline agents itself. The launcher reports local
   * single-flight suppression so resume/sweep counters describe real schedules. */
  launchRunner: (slug: string) => Promise<LaunchRunnerResult>
  /**
   * Non-interactive spec authoring for thin-but-groomed tickets (§6.3):
   * returns a candidate spec body, or null when the ticket cannot be
   * expanded. Pragmatism, documented: the seam returns only the body — the
   * dispatcher stamps the authoring agent's session id itself (via `ids`)
   * for the `spec.authored` actor/payload, rather than widening the seam to
   * return session metadata the fake would have to invent.
   */
  authorSpec?: (ticket: Ticket) => Promise<string | null>
  /** Start the repository-scoped observation workflow without awaiting it.
   * The owner must single-flight and track the promise; Dispatcher invokes
   * this after ready-ticket dispatch, independent of drain/build capacity. */
  startHarvest?: () => void
  /** Optional one-shot judgment over the final conforming spec. The dispatcher
   * supplies cancellation and treats every absence/failure/invalid result as a
   * local deterministic fallback, so naming can never prevent build creation. */
  nameSlug?: (spec: string, signal: AbortSignal) => Promise<string | null>
  ids: IdSource
  clock: Clock
  opts?: DispatcherOpts
}

/** Latest `workspace.provisioned` not followed by a `workspace.released` —
 * the reducer deliberately ignores workspace events (liveness is the
 * dispatcher's concern), so the janitor scans the raw log. */
function openWorkspace(
  events: AbEvent[],
): { provider: string; ref: string; branch: string } | null {
  let open: { provider: string; ref: string; branch: string } | null = null
  for (const event of events) {
    if (event.type === 'workspace.provisioned') open = event.payload
    else if (event.type === 'workspace.released') open = null
  }
  return open
}

/** The build's base branch, from its own `build.created` fact (§15.3);
 * falls back to the repo config for logs missing one. */
function baseBranchOf(events: AbEvent[], config: Config): string {
  for (const event of events) {
    if (event.type === 'build.created') return event.payload.baseBranch
  }
  return config.project.baseBranch
}

function artifactRefOf(deposited: ArtifactMeta[]): ArtifactRef {
  const meta = deposited[0]
  if (!meta) throw new Error('spec deposit produced no artifact meta')
  return { kind: meta.kind, rev: meta.revision }
}

function pendingDashboardFrameHosts(
  events: AbEvent[],
): Extract<AbEvent, { type: 'dashboard-frame.hosted' }>[] {
  const reclaimed = new Set(
    events
      .filter((event) => event.type === 'dashboard-frame.reclaimed')
      .map((event) => event.payload.hostedSeq),
  )
  return events.filter(
    (event): event is Extract<AbEvent, { type: 'dashboard-frame.hosted' }> =>
      event.type === 'dashboard-frame.hosted' && !reclaimed.has(event.seq),
  )
}

export class Dispatcher {
  private readonly leaseTtlMs: number
  private readonly triageState: string
  private readonly doneState: string
  private readonly slugNamingTimeoutMs: number
  private readonly maxHarvestRecoveryAttempts: number

  constructor(private readonly deps: DispatcherDeps) {
    this.leaseTtlMs = deps.opts?.leaseTtlMs ?? 0
    this.triageState = deps.opts?.triageState ?? defaultTriageState(deps.config)
    this.doneState = deps.opts?.doneState ?? 'Done'
    this.slugNamingTimeoutMs =
      deps.opts?.slugNamingTimeoutMs ?? DEFAULT_SLUG_NAMING_TIMEOUT_MS
    this.maxHarvestRecoveryAttempts =
      deps.opts?.maxHarvestRecoveryAttempts ??
      DEFAULT_MAX_HARVEST_RECOVERY_ATTEMPTS
  }

  /**
   * One cron-friendly pass (§3.3): janitor → optional startup resume → lease
   * sweep → dispatch. Startup resume is opt-in because the CLI invokes it
   * once per command, while ordinary watch ticks must preserve policy parks.
   */
  async tick(opts: TickOpts = {}): Promise<TickReport> {
    let autoMergeUser: string | undefined
    if (opts.defaultAutoMerge === true) {
      autoMergeUser = opts.autoMergeUser?.trim()
      if (autoMergeUser === undefined || autoMergeUser === '') {
        throw new Error(
          'defaultAutoMerge requires nonempty human attribution in autoMergeUser',
        )
      }
    }
    const report = emptyTickReport()
    /** Builds already launched this tick — a janitor/startup re-attach must
     * not be doubled by the sweep, nor a fresh dispatch by anything. */
    const launched = new Set<string>()
    await this.janitor(report, launched)
    if (opts.resumeCurrent === true) await this.resumeCurrent(report, launched)
    await this.leaseSweep(report, launched)
    if (opts.acceptNewWork !== false) {
      await this.dispatch(report, launched, autoMergeUser)
    }
    // Fire-and-forget by contract: long synthesize/review sessions must not
    // stop janitor, lease sweep, ticket dispatch, or signal handling on later
    // watch ticks. Durable pause and infrastructure-error stops suppress
    // launch. Pending control commands still launch the runner so the kernel
    // can settle them under the repository lease.
    await this.triggerHarvest()
    return report
  }

  private async triggerHarvest(): Promise<void> {
    const start = this.deps.startHarvest
    if (start === undefined) return
    const record = await this.deps.store.getRepo(this.deps.repo)
    if (record === null) {
      start()
      return
    }
    const state = reduceHarvest(
      await this.deps.store.getRepoEvents(this.deps.repo),
    )
    if (
      decideHarvestControl(state, this.maxHarvestRecoveryAttempts).kind !==
      'park'
    ) {
      start()
    }
  }

  private async launch(
    slug: string,
    launched: Set<string>,
  ): Promise<LaunchRunnerResult> {
    if (launched.has(slug)) return 'already-active'
    launched.add(slug)
    return this.deps.launchRunner(slug)
  }

  // ── a. Janitor (SPEC §15.7, D1) ────────────────────────────────────────────

  private async janitor(report: TickReport, launched: Set<string>): Promise<void> {
    for (const record of await this.deps.store.listBuilds()) {
      // One dispatcher per repo (§12), but the store is shared by design
      // (§7.2) — another repo's builds are another dispatcher's duty. Acting
      // on them would poll foreign PRs and break single-writer discipline.
      if (record.repo !== this.deps.repo) continue
      const events = await this.deps.store.getEvents(record.slug)
      const state = reduceBuild(events)
      // Pipeline/ticket/workspace state is settled, but release-asset cleanup
      // has its own crash window after build.completed. Revisit only pending
      // hosted handles; this never relaunches a runner or consumes capacity.
      if (state.status === 'done') {
        await this.reclaimDashboardFrames(record.slug, events)
        continue
      }
      if (state.status === 'aborted') {
        await this.cleanupAborted(record, events, report)
        continue
      }
      if (state.pr) await this.checkPr(record, events, state, report, launched)
    }
  }

  /** Aborted build: release the workspace, hand the ticket back to a human,
   * and complete as abandoned — aborting is a human judgment that this work
   * should not proceed as-is, so it re-enters Triage rather than Done.
   * Ticket ops run BEFORE the terminal event, matching checkPr: once
   * `build.completed` lands the janitor skips the build forever, so a crash
   * (or ticket-source outage) between the two must leave the transition
   * still due — the next tick re-runs it (§3.3 re-run safety, D1). */
  private async cleanupAborted(
    record: BuildRecord,
    events: AbEvent[],
    report: TickReport,
  ): Promise<void> {
    const { store, tickets } = this.deps
    await this.releaseWorkspace(record.slug, events)
    if (record.ticket) {
      await tickets.transition(record.ticket.id, this.triageState)
      await tickets.comment(
        record.ticket.id,
        `build ${record.slug} was aborted — returned to ${this.triageState} for human triage`,
      )
    }
    await store.append(record.slug, {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: 'abandoned' },
    } satisfies EventWrite<'build.completed'>)
    await this.reclaimDashboardFrames(record.slug, events)
    report.abandoned += 1
  }

  /** Post-PR epilogue (§15.7): poll the forge, emit `pr.*` facts (deduped
   * against the reduced `prState`), release/complete, project to the ticket. */
  private async checkPr(
    record: BuildRecord,
    events: AbEvent[],
    state: BuildState,
    report: TickReport,
    launched: Set<string>,
  ): Promise<void> {
    const { store, tickets, forge } = this.deps
    const pr = state.pr
    if (!pr) return
    // Forge calls run from the workspace when it still exists (it does until
    // the build completes); fall back to the repo itself for odd logs.
    const workspacePath = openWorkspace(events)?.ref ?? this.deps.repo
    const prState = await forge.getPrState(workspacePath, pr.number)
    const autoMerge =
      prState.state === 'open' ? pendingAutoMerge(state) : undefined

    // Revoking consent takes priority even while the PR is conflicted. A live
    // native request could otherwise merge immediately after reconcile pushes
    // and checks pass, before the next janitor poll gets a chance to cancel it.
    if (autoMerge?.enabled === false) {
      const result = await forge.setAutoMerge(workspacePath, pr.number, false)
      if (result.kind !== 'applied') {
        throw new Error(
          `forge returned ${result.kind} while disabling native auto-merge`,
        )
      }
      await store.append(record.slug, {
        actor: DISPATCHER,
        type: autoMergeApplicationType(false),
        payload: { commandSeq: autoMerge.commandSeq },
      })
    }

    // A positive conflict re-enters reconcile before any enable attempt. In
    // particular, an ungated fallback can never race ahead of the conflict
    // event and its full post-reconcile verification cycle.
    if (prState.state === 'open' && prState.mergeable === false) {
      // Dedupe: a reduced prState of 'conflicted' means reconcile is already
      // pending (a `reconcile.completed` returns it to 'open').
      if (state.prState === 'conflicted') return
      const baseSha = await this.baseSha(baseBranchOf(events, this.deps.config))
      await store.append(record.slug, {
        actor: DISPATCHER,
        type: 'pr.conflicted',
        payload: { baseSha },
      } satisfies EventWrite<'pr.conflicted'>)
      // The dispatcher never runs agents (§15.7): re-attach a build-runner,
      // which executes the reconcile epilogue phase.
      await this.launch(record.slug, launched)
      report.conflicted += 1
      return
    }

    // Enabling and the ungated fallback begin from the same durable intent
    // predicate. Only `applied` acknowledges native state. A direct merge is
    // owned solely by this janitor and only after the engine is parked at
    // awaiting-pr (all verify/finalize work complete).
    if (prState.state === 'open' && autoMerge?.enabled === true) {
      const result = await forge.setAutoMerge(workspacePath, pr.number, true)
      if (result.kind === 'applied') {
        await store.append(record.slug, {
          actor: DISPATCHER,
          type: autoMergeApplicationType(true),
          payload: { commandSeq: autoMerge.commandSeq },
        })
      } else if (result.kind === 'ungated' && prState.mergeable === true) {
        // Re-read at the last possible point. A cancellation, replacement
        // command, newly due pipeline work, or application fact suppresses
        // this attempt; the next tick reclassifies from fresh forge state.
        const latestEvents = await store.getEvents(record.slug)
        const latestState = reduceBuild(latestEvents)
        const latestIntent = pendingAutoMerge(latestState)
        const decision = decideNext(latestEvents, this.deps.config)
        if (
          latestState.pr?.number === pr.number &&
          latestIntent?.enabled === true &&
          latestIntent.commandSeq === autoMerge.commandSeq &&
          decision.kind === 'wait' &&
          decision.reason === 'awaiting-pr'
        ) {
          await forge.squashMerge(workspacePath, pr.number, result.headSha)
        }
      }
    }

    switch (prState.state) {
      case 'merged': {
        // Emit the fact once (a crash between steps re-runs this block; the
        // reduced prState dedupes the event, the log dedupes the release).
        if (state.prState !== 'merged') {
          await store.append(record.slug, {
            actor: DISPATCHER,
            type: 'pr.merged',
            payload: { sha: prState.sha },
          } satisfies EventWrite<'pr.merged'>)
        }
        await this.releaseWorkspace(record.slug, events)
        if (record.ticket) {
          await tickets.transition(record.ticket.id, this.doneState)
          await tickets.comment(
            record.ticket.id,
            `build ${record.slug} merged: ${pr.url}`,
          )
        }
        await store.append(record.slug, {
          actor: DISPATCHER,
          type: 'build.completed',
          payload: { outcome: 'merged' },
        } satisfies EventWrite<'build.completed'>)
        await this.reclaimDashboardFrames(record.slug, events)
        report.merged += 1
        return
      }
      case 'closed': {
        // Closed without merge is a human decision — back to Triage (§15.7).
        if (state.prState !== 'closed') {
          await store.append(record.slug, {
            actor: DISPATCHER,
            type: 'pr.closed',
            payload: {},
          } satisfies EventWrite<'pr.closed'>)
        }
        await this.releaseWorkspace(record.slug, events)
        if (record.ticket) {
          await tickets.transition(record.ticket.id, this.triageState)
          await tickets.comment(
            record.ticket.id,
            `build ${record.slug} PR closed without merging (${pr.url}) — returned to ${this.triageState}`,
          )
        }
        await store.append(record.slug, {
          actor: DISPATCHER,
          type: 'build.completed',
          payload: { outcome: 'closed-unmerged' },
        } satisfies EventWrite<'build.completed'>)
        await this.reclaimDashboardFrames(record.slug, events)
        report.closed += 1
        return
      }
      case 'open':
        // Unknown mergeability and transient auto-merge classifications are
        // retried on a later poll; never guess.
        return
    }
  }

  /** Reclaim review-window release copies after terminal completion. Cleanup
   * is deliberately post-terminal and best-effort: a provider, timeout, or
   * store failure cannot roll back build.completed/ticket/workspace work.
   * Pending handles remain derivable and are retried on every later tick. */
  private async reclaimDashboardFrames(
    slug: string,
    events: AbEvent[],
  ): Promise<void> {
    for (const hosted of pendingDashboardFrameHosts(events)) {
      const priorAttempts = events.filter(
        (event) =>
          event.type === 'dashboard-frame.reclaim-failed' &&
          event.payload.hostedSeq === hosted.seq,
      ).length
      try {
        const capability = this.deps.forge.dashboardFrames
        if (capability === undefined) {
          throw new Error(
            `forge ${this.deps.forge.name} does not support dashboard frame reclamation`,
          )
        }
        await capability.reclaim({
          workspacePath: this.deps.repo,
          asset: hosted.payload.asset,
        })
        await this.deps.store.append(slug, {
          actor: DISPATCHER,
          type: 'dashboard-frame.reclaimed',
          payload: { hostedSeq: hosted.seq },
        })
      } catch (error) {
        try {
          await this.deps.store.append(slug, {
            actor: DISPATCHER,
            type: 'dashboard-frame.reclaim-failed',
            payload: {
              hostedSeq: hosted.seq,
              attempt: priorAttempts + 1,
              error:
                (error instanceof Error ? error.message : String(error)).trim() ||
                'dashboard frame reclamation failed without an error message',
            },
          })
        } catch {
          // The hosted fact remains pending; a later tick retries both the
          // idempotent delete and its durable acknowledgement.
        }
      }
    }
  }

  /** Release the build's workspace if the log shows one still provisioned;
   * append `workspace.released`. Log-deduped, so re-runs are no-ops. */
  private async releaseWorkspace(slug: string, events: AbEvent[]): Promise<void> {
    const open = openWorkspace(events)
    if (!open) return
    // `ref` doubles as `path` for both the git-worktree and fake providers.
    await this.deps.workspaces.release({
      provider: open.provider,
      ref: open.ref,
      path: open.ref,
      branch: open.branch,
    })
    await this.deps.store.append(slug, {
      actor: DISPATCHER,
      type: 'workspace.released',
      payload: {},
    } satisfies EventWrite<'workspace.released'>)
  }

  /** Current tip of the base branch — `git ls-remote <repo> refs/heads/<b>`
   * against the dispatcher's local repo path (§15.7: no network). */
  private async baseSha(baseBranch: string): Promise<string> {
    const args = ['git', 'ls-remote', this.deps.repo, `refs/heads/${baseBranch}`]
    const result = await this.deps.exec(args, {})
    const sha = result.stdout.trim().split(/\s+/)[0]
    if (result.exitCode !== 0 || !sha) {
      throw new Error(
        `${args.join(' ')} exited ${result.exitCode}: ${
          result.stderr.trim() || result.stdout.trim() || '(no output)'
        }`,
      )
    }
    return sha
  }

  // ── b. Dispatch-command startup resume (SPEC §2.2, §15.6-C) ────────────────

  /**
   * A fresh `ab dispatch` invocation attempts every current build for this
   * repo, even when its old lease has not expired yet. Lease claiming remains
   * the exclusivity gate: a genuinely live runner wins and the attempted
   * replacement harmlessly skips.
   *
   * `decideNext` keeps human judgment gates intact. Paused builds, builds
   * awaiting a PR/spec, and agent/stall escalations remain parked. The one
   * automatic unpark is an all-policy escalation set: `phase.failed` retry
   * exhaustion describes an infrastructure budget, and restarting dispatch
   * is the operator's explicit request to re-arm that budget. Each policy
   * raise gets an auditable dispatcher-authored `escalation.answered{retry}`.
   */
  private async resumeCurrent(
    report: TickReport,
    launched: Set<string>,
  ): Promise<void> {
    const { store, config } = this.deps
    for (const record of await store.listBuilds()) {
      if (record.repo !== this.deps.repo || launched.has(record.slug)) continue

      let events = await store.getEvents(record.slug)
      const state = reduceBuild(events)
      if (state.status === 'done' || state.status === 'aborted') continue

      let decision = decideNext(events, config)
      if (
        decision.kind === 'wait' &&
        decision.reason === 'blocked' &&
        state.openEscalations.length > 0 &&
        state.openEscalations.every((escalation) => escalation.source === 'policy')
      ) {
        for (const escalation of state.openEscalations) {
          await store.append(record.slug, {
            actor: DISPATCHER,
            type: 'escalation.answered',
            payload: {
              id: escalation.id,
              answer: 'ab dispatch restarted this build from durable state',
              resolution: 'retry',
            },
          } satisfies EventWrite<'escalation.answered'>)
        }
        events = await store.getEvents(record.slug)
        decision = decideNext(events, config)
      }

      // Human pauses and judgment escalations are not "failures" for dispatch
      // to override; awaiting-pr/spec and terminal states have no runner work.
      if (decision.kind === 'wait') continue
      const result = await this.launch(record.slug, launched)
      if (result === 'scheduled') report.resumed += 1
    }
  }

  // ── c. Lease sweep (SPEC §15.6-C) ──────────────────────────────────────────

  /**
   * Predicate: lease expired or absent + the engine has runner work →
   * re-attach a runner. Actionability is `decideNext`'s, not a status
   * heuristic — the two must agree or work the engine would decide is never
   * executed (a runner is the only pendingCommands/decision consumer). Every
   * non-`wait` decision re-attaches; that covers phase work, but also:
   *
   * - pending operator commands on paused/blocked builds (D2, §15.2.7: "a
   *   runner that is dead still receives its commands on resume" — the
   *   request does not change status, only the kernel's acknowledgement
   *   does, so a status gate would strand resume/abort forever);
   * - post-PR phase work while prState is 'open' (§15.7: the verify re-run
   *   after `reconcile.completed`; §5: finalize post-steps still due after
   *   `finalize.completed`) and the reconcile run while 'conflicted';
   * - engine-side escalation raises (stall/policy) a dead runner never
   *   appended.
   *
   * Every `wait` reason is correctly parked: blocked/paused (human), awaiting
   * spec (human lands rev N+1; the next tick sees run-phase plan), awaiting
   * PR (janitor duty), done/aborted (janitor duty). The relaunched runner
   * claims the lease itself; the reduced log tells it where to resume
   * (started-without-terminal work re-runs from the phase start).
   */
  private async leaseSweep(report: TickReport, launched: Set<string>): Promise<void> {
    const now = this.deps.clock().getTime()
    for (const record of await this.deps.store.listBuilds()) {
      if (record.repo !== this.deps.repo) continue // §12: not this dispatcher's build
      if (launched.has(record.slug)) continue
      if (record.lease) {
        if (new Date(record.lease.expiresAt).getTime() > now) continue // healthy
      } else if (now - new Date(record.updatedAt).getTime() < this.leaseTtlMs) {
        continue // absent lease within the first-claim grace (see DispatcherOpts)
      }
      const events = await this.deps.store.getEvents(record.slug)
      if (decideNext(events, this.deps.config).kind === 'wait') continue
      const result = await this.launch(record.slug, launched)
      if (result === 'scheduled') report.swept += 1
    }
  }

  // ── d. Dispatch (SPEC §12, §6.3) ───────────────────────────────────────────

  private async dispatch(
    report: TickReport,
    launched: Set<string>,
    autoMergeUser: string | undefined,
  ): Promise<void> {
    const { store, tickets, config } = this.deps
    // Blocked and paused builds still occupy a slot: their workspaces and
    // pending work are live, only waiting on a human. Capacity is per repo
    // (§16.1) — another repo's builds never consume this repo's slots.
    let active = 0
    for (const record of await store.listBuilds()) {
      if (record.repo !== this.deps.repo) continue
      const state = reduceBuild(await store.getEvents(record.slug))
      if (state.status !== 'done' && state.status !== 'aborted') active += 1
    }
    let capacity = config.dispatcher.capacity - active
    if (capacity <= 0) return

    const listing = await tickets.listReady(readyCriteria(config))
    const ready = listing.tickets
    report.invalidTickets += listing.diagnostics.length
    report.ticketDiagnostics.push(...listing.diagnostics)
    // One dependency-node cache per tick: blockers are commonly shared across
    // the ready set, and a blocker's resolution must be re-read every tick
    // (never cached across them) so a completion lands on the next pass.
    const nodes = new Map<string, DependencyState>()

    for (const ticket of ready) {
      if (capacity <= 0) break

      // The dependency gate runs FIRST — before the claim, before the spec
      // gate. A blocked ticket must not be claimed, must not be bounced, must
      // create no build or workspace, and must not spend capacity; it is
      // simply not this tick's work. Note this sits *above* [tickets]'s
      // readyLabels / readyState gate: those criteria produced `ready`, and the
      // gate subtracts from it — labels and state can make a ticket a
      // candidate but can never override an unresolved blocker.
      if ((ticket.blockedBy ?? []).length > 0) {
        let verdict: DependencyVerdict
        try {
          await this.loadDependencyGraph(ticket, nodes)
          verdict = analyzeDependencies(
            ticket.ref.id,
            ticket.blockedBy ?? [],
            nodes,
          )
        } catch (error) {
          // A broken graph is this ticket's problem, not the tick's: skip it
          // and let unrelated eligible tickets dispatch normally.
          verdict = {
            unresolved: [ticket.ref.id],
            diagnostics: [
              `ticket ${ticket.ref.id}: dependency check failed — ${
                error instanceof Error ? error.message : String(error)
              }`,
            ],
          }
        }
        if (verdict.unresolved.length > 0) {
          report.dependencyBlocked += 1
          report.dependencyDiagnostics.push(...verdict.diagnostics)
          continue
        }
      }

      // Claim-before-launch (§12): losing the claim means another dispatcher
      // (or an earlier tick) owns this ticket.
      if (!(await tickets.claim(ticket.ref.id))) {
        report.claimRaces += 1
        continue
      }

      // Quality gate (§6.3): import a conforming ticket body as the spec;
      // author one for thin-but-groomed tickets; otherwise bounce.
      let body = ticket.body
      let conformance = specConformance(body)
      let authoredSession: string | undefined
      if (!conformance.conforms && this.deps.authorSpec) {
        const authored = await this.deps.authorSpec(ticket)
        if (authored !== null) {
          conformance = specConformance(authored)
          if (conformance.conforms) {
            body = authored
            authoredSession = this.deps.ids('s')
          }
        }
      }
      if (!conformance.conforms) {
        await this.bounce(ticket, conformance.missing)
        report.bounced += 1
        continue
      }

      const baseSlug = await this.chooseSlugBase(ticket.title, body)
      const slug = await this.uniqueSlug(baseSlug)
      const branch = `ab/${slug}`
      const baseBranch = config.project.baseBranch
      await store.createBuild({
        slug,
        repo: this.deps.repo,
        ticket: ticket.ref,
        branch,
      })
      await store.append(slug, {
        actor: DISPATCHER,
        type: 'build.created',
        payload: {
          ticket: ticket.ref,
          repo: this.deps.repo,
          baseBranch,
          ...(config.dashboardFrames !== undefined
            ? { dashboardFrames: config.dashboardFrames }
            : {}),
        },
      } satisfies EventWrite<'build.created'>)
      if (autoMergeUser !== undefined) {
        await store.append(slug, {
          actor: humanActor(autoMergeUser),
          type: 'build.auto-merge-requested',
          payload: {},
        } satisfies EventWrite<'build.auto-merge-requested'>)
      }

      const handle = await this.deps.workspaces.provision({
        repo: this.deps.repo,
        baseBranch,
        branch,
      })
      await store.append(slug, {
        actor: DISPATCHER,
        type: 'workspace.provisioned',
        payload: {
          provider: handle.provider,
          ref: handle.ref,
          branch: handle.branch,
          base: handle.base,
        },
      } satisfies EventWrite<'workspace.provisioned'>)

      // The contract artifact (§6.3): kind `spec`, revision 0 — deposited
      // atomically with its event (D6, via appendWithArtifacts).
      const spec = {
        kind: 'spec',
        content: body,
        metadata: { ticket: ticket.ref.id, source: ticket.ref.source },
      }
      if (authoredSession !== undefined) {
        const session = authoredSession
        await store.appendWithArtifacts(slug, [spec], (deposited) => ({
          actor: agentActor('spec', session),
          type: 'spec.authored' as const,
          payload: { artifact: artifactRefOf(deposited), session },
        }))
        report.authored += 1
      } else {
        await store.appendWithArtifacts(slug, [spec], (deposited) => ({
          actor: DISPATCHER,
          type: 'spec.imported' as const,
          payload: { artifact: artifactRefOf(deposited), ticket: ticket.ref },
        }))
      }

      await tickets.comment(ticket.ref.id, `build ${slug} dispatched`)
      await this.launch(slug, launched)
      report.dispatched += 1
      capacity -= 1
    }
  }

  /**
   * Close `nodes` over everything reachable from `ticket`'s blockers, so the
   * analyzer can both gate and name a cycle. Breadth-first, one port call per
   * level, skipping ids already cached — the common case (a blocker or two,
   * none of them blocked themselves) is a single call.
   *
   * INVARIANT: `nodes` contains only states actually returned by the source.
   * The cache is shared across the tick's tickets, so a node this ticket
   * invents is a node the *next* ticket will trust as a fact about its own
   * blocker. Nothing is seeded here for that reason (f_8bc9ee0c); the
   * analyzer takes the ticket's own blockers as an argument instead, and
   * `findCycle` closes a cycle via its path rather than the map.
   *
   * A provider-side cycle terminates the walk: an id already in `nodes` is
   * never re-queued, so every reachable node is fetched exactly once.
   */
  private async loadDependencyGraph(
    ticket: Ticket,
    nodes: Map<string, DependencyState>,
  ): Promise<void> {
    let frontier = [...new Set(ticket.blockedBy ?? [])].filter(
      (id) => !nodes.has(id),
    )
    while (frontier.length > 0) {
      const states = await this.deps.tickets.dependencyStates(frontier)
      for (const state of states) nodes.set(state.id, state)
      frontier = [...new Set(states.flatMap((state) => state.blockedBy))].filter(
        (id) => !nodes.has(id),
      )
    }
  }

  /** Bounce (§6.3): back to Triage with a comment citing the standard and
   * WHICH parts are missing — failure at the cheapest point, not a build
   * that thrashes and escalates. No build is created. */
  private async bounce(ticket: Ticket, missing: string[]): Promise<void> {
    await this.deps.tickets.transition(ticket.ref.id, this.triageState)
    await this.deps.tickets.comment(
      ticket.ref.id,
      `Bounced back to ${this.triageState}: this ticket does not conform to ` +
        `the spec standard (docs/spec-standard.md) and cannot be dispatched.\n` +
        `Missing: ${missing.join('; ')}.`,
    )
  }

  /**
   * Ask for a spec-aware base behind a hard deadline. Every failure mode is
   * deliberately indistinguishable here: naming is optional judgment, while
   * successful dispatch is deterministic policy.
   */
  private async chooseSlugBase(title: string, spec: string): Promise<string> {
    const fallback = fallbackSlug(title)
    const nameSlug = this.deps.nameSlug
    if (nameSlug === undefined) return fallback

    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('build slug naming deadline exceeded'))
      }, Math.max(0, this.slugNamingTimeoutMs))
    })

    try {
      const candidate = await Promise.race([
        nameSlug(spec, controller.signal),
        deadline,
      ])
      return validateSlugCandidate(candidate) ?? fallback
    } catch {
      return fallback
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** Valid bounded base, deduped store-wide with -2/-3/… suffixes. */
  private async uniqueSlug(base: string): Promise<string> {
    let slug = base
    for (let n = 2; (await this.deps.store.getBuild(slug)) !== null; n += 1) {
      slug = `${base}-${n}`
    }
    return slug
  }
}
