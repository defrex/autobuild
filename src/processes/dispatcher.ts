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
 * A build launched in an earlier step is never launched again by a later
 * one (per-tick launch dedupe); a build dispatched in step (d) is not swept
 * in the same tick because the sweep already ran.
 *
 * The dispatcher itself never runs agents (§15.7) — conflicted PRs and
 * stale leases both resolve by re-attaching a build-runner via
 * `launchRunner`. The runner claims the build's lease itself; the
 * dispatcher only ever reads lease expiry.
 */
import type { Config } from '../config/schema'
import { DISPATCHER, agentActor } from '../events/envelope'
import type { AbEvent, EventWrite } from '../events/catalog'
import type { IdSource } from '../ids'
import { decideNext } from '../kernel/engine'
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

// ── Spec quality gate (SPEC §6.3, docs/spec-standard.md) ─────────────────────

export interface SpecConformance {
  conforms: boolean
  /** Human-readable names of the missing parts — the bounce comment cites
   * exactly these, moving failure to the cheapest point (§6.3). */
  missing: string[]
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\S/
const HEADING = /^#{2,6}\s*(.+?)\s*$/

/** Lines of the section under the first heading whose text starts with
 * `name` (case-insensitive), up to the next heading of any level. */
function sectionUnder(lines: string[], name: string): string[] | null {
  let start = -1
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i]?.match(HEADING)
    if (match?.[1]?.toLowerCase().startsWith(name)) {
      start = i + 1
      break
    }
  }
  if (start === -1) return null
  const section: string[] = []
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i]
    if (line === undefined || HEADING.test(line)) break
    section.push(line)
  }
  return section
}

/**
 * The spec standard's checkable core (docs/spec-standard.md): nonempty body,
 * a case-insensitive '## Acceptance criteria' heading with at least one list
 * item, and an '## Out of scope' heading. A heuristic by design — full
 * conformance is judgment and lives in the skills; this gate only catches
 * tickets that would certainly thrash (§6.3). Exported for testing.
 */
export function specConformance(body: string): SpecConformance {
  const missing: string[] = []
  if (body.trim().length === 0) missing.push('a nonempty spec body')
  const lines = body.split('\n')
  const criteria = sectionUnder(lines, 'acceptance criteria')
  if (criteria === null) {
    missing.push("an '## Acceptance criteria' heading")
  } else if (!criteria.some((line) => LIST_ITEM.test(line))) {
    missing.push("at least one list item under '## Acceptance criteria'")
  }
  if (sectionUnder(lines, 'out of scope') === null) {
    missing.push("an '## Out of scope' heading")
  }
  return { conforms: missing.length === 0, missing }
}

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
 * Whether `ticketId` may be dispatched, given the dependency graph `nodes`
 * (which must be closed over the ticket's reachable blockers — see
 * `loadDependencyGraph`). Pure and total: a node the walk cannot find is
 * treated as already-reported-missing rather than throwing. Exported for
 * testing, like `specConformance`.
 */
export function analyzeDependencies(
  ticketId: string,
  nodes: Map<string, DependencyState>,
): DependencyVerdict {
  const blockedBy = nodes.get(ticketId)?.blockedBy ?? []
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

/** `Add rate limiting!` → `add-rate-limiting` (build slugs, branch names). */
export function kebab(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'build'
}

// ── Tick report ──────────────────────────────────────────────────────────────

/** Counts per action, for observability and tests. An idempotent re-run of
 * `tick()` over unchanged state reports all zeroes — except the dependency
 * fields, which are a standing queue report rather than a record of action: a
 * still-blocked ticket re-reports every tick by design, because that is the
 * only place its blockers are visible without provider inspection. */
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
  /** Dependency gate (§13): ready tickets held back by unresolved blockers. */
  dependencyBlocked: number
  /** One line per held ticket naming its unresolved blockers — the operator's
   * only view of the dependency queue short of provider inspection. */
  dependencyDiagnostics: string[]
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
    dependencyBlocked: 0,
    dependencyDiagnostics: [],
  }
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

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
   * silent completion. Bounced tickets (§6.3) land here too. Default 'Triage'.
   */
  triageState?: string
  /** Ticket state for merged builds. Default 'Done'. */
  doneState?: string
}

export interface TickOpts {
  /**
   * Attempt every actionable, non-terminal build for this repo before the
   * ordinary stale-lease sweep. `ab dispatch` sets this only on its first
   * tick: a process restart is an explicit retry boundary, not an endless
   * reset of the per-phase failure budget on every watch tick.
   */
  resumeCurrent?: boolean
}

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
   * dispatcher never runs agents itself. */
  launchRunner: (slug: string) => Promise<void>
  /**
   * Non-interactive spec authoring for thin-but-groomed tickets (§6.3):
   * returns a candidate spec body, or null when the ticket cannot be
   * expanded. Pragmatism, documented: the seam returns only the body — the
   * dispatcher stamps the authoring agent's session id itself (via `ids`)
   * for the `spec.authored` actor/payload, rather than widening the seam to
   * return session metadata the fake would have to invent.
   */
  authorSpec?: (ticket: Ticket) => Promise<string | null>
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

export class Dispatcher {
  private readonly leaseTtlMs: number
  private readonly triageState: string
  private readonly doneState: string

  constructor(private readonly deps: DispatcherDeps) {
    this.leaseTtlMs = deps.opts?.leaseTtlMs ?? 0
    this.triageState = deps.opts?.triageState ?? 'Triage'
    this.doneState = deps.opts?.doneState ?? 'Done'
  }

  /**
   * One cron-friendly pass (§3.3): janitor → optional startup resume → lease
   * sweep → dispatch. Startup resume is opt-in because the CLI invokes it
   * once per command, while ordinary watch ticks must preserve policy parks.
   */
  async tick(opts: TickOpts = {}): Promise<TickReport> {
    const report = emptyTickReport()
    /** Builds already launched this tick — a janitor/startup re-attach must
     * not be doubled by the sweep, nor a fresh dispatch by anything. */
    const launched = new Set<string>()
    await this.janitor(report, launched)
    if (opts.resumeCurrent === true) await this.resumeCurrent(report, launched)
    await this.leaseSweep(report, launched)
    await this.dispatch(report, launched)
    return report
  }

  private async launch(slug: string, launched: Set<string>): Promise<void> {
    if (launched.has(slug)) return
    launched.add(slug)
    await this.deps.launchRunner(slug)
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
      // Done builds are settled; a merged-PR fixup is a NEW ticket, never a
      // reopened build (D1) — there is nothing for the janitor to do here.
      if (state.status === 'done') continue
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
        report.closed += 1
        return
      }
      case 'open': {
        // mergeable true/null → nothing to do; null means the forge has not
        // computed mergeability yet — never guess (§15.7).
        if (prState.mergeable !== false) return
        // Dedupe: a reduced prState of 'conflicted' means reconcile is
        // already pending (a `reconcile.completed` returns it to 'open').
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
      await this.launch(record.slug, launched)
      report.resumed += 1
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
      await this.launch(record.slug, launched)
      report.swept += 1
    }
  }

  // ── d. Dispatch (SPEC §12, §6.3) ───────────────────────────────────────────

  private async dispatch(report: TickReport, launched: Set<string>): Promise<void> {
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

    const ready = await tickets.listReady({
      labels: config.dispatcher.readyLabels,
      ...(config.dispatcher.readyState !== undefined
        ? { state: config.dispatcher.readyState }
        : {}),
    })
    // One dependency-node cache per tick: blockers are commonly shared across
    // the ready set, and a blocker's resolution must be re-read every tick
    // (never cached across them) so a completion lands on the next pass.
    const nodes = new Map<string, DependencyState>()

    for (const ticket of ready) {
      if (capacity <= 0) break

      // The dependency gate runs FIRST — before the claim, before the spec
      // gate. A blocked ticket must not be claimed, must not be bounced, must
      // create no build or workspace, and must not spend capacity; it is
      // simply not this tick's work. Note this sits *above* readyLabels /
      // readyState in the pipeline: those criteria produced `ready`, and the
      // gate subtracts from it — labels and state can make a ticket a
      // candidate but can never override an unresolved blocker.
      if ((ticket.blockedBy ?? []).length > 0) {
        let verdict: DependencyVerdict
        try {
          await this.loadDependencyGraph(ticket, nodes)
          verdict = analyzeDependencies(ticket.ref.id, nodes)
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

      const slug = await this.uniqueSlug(ticket.title)
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
        payload: { ticket: ticket.ref, repo: this.deps.repo, baseBranch },
      } satisfies EventWrite<'build.created'>)

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
   * The ticket's own node is seeded so a cycle can close back onto it. Its
   * `resolved: false` is never read as a fact about the ticket: the analyzer
   * only ever reads a node's `blockedBy` for the ticket itself.
   */
  private async loadDependencyGraph(
    ticket: Ticket,
    nodes: Map<string, DependencyState>,
  ): Promise<void> {
    nodes.set(ticket.ref.id, {
      id: ticket.ref.id,
      exists: true,
      resolved: false,
      blockedBy: [...(ticket.blockedBy ?? [])],
    })
    const seen = new Set<string>([ticket.ref.id])
    let frontier = [...new Set(ticket.blockedBy ?? [])].filter(
      (id) => !nodes.has(id),
    )
    while (frontier.length > 0) {
      const states = await this.deps.tickets.dependencyStates(frontier)
      for (const state of states) {
        nodes.set(state.id, state)
        seen.add(state.id)
      }
      // A provider-side cycle terminates here: every node is visited once.
      frontier = [
        ...new Set(states.flatMap((state) => state.blockedBy)),
      ].filter((id) => !seen.has(id) && !nodes.has(id))
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

  /** kebab(title), deduped against existing builds with -2/-3/… suffixes. */
  private async uniqueSlug(title: string): Promise<string> {
    const base = kebab(title)
    let slug = base
    for (let n = 2; (await this.deps.store.getBuild(slug)) !== null; n += 1) {
      slug = `${base}-${n}`
    }
    return slug
  }
}
