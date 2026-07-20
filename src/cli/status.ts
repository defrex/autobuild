/**
 * `ab builds` and `ab build status <slug>` — the read-only query surface on
 * build state (SPEC §8.2, §15.5). Both run OUTSIDE build sessions like
 * init/upgrade/ticket/dispatch (§16.3): they take a repo, not a build.
 *
 * The shape is one decision: **the projection is pure, the IO is a thin
 * shell.** The functions below map `(BuildRecord, AbEvent[], now)` to plain
 * data (`BuildSummary`, `BuildDetail`), and the renderers map that data to
 * `string[]`. The command entry points only resolve a store, fetch, project,
 * and print. So `--json` IS the projection object and the human text is a
 * second renderer over the same value — there is no "compute for text" path
 * that can disagree with the JSON.
 *
 * Effective status comes from `reduceBuild` — the authoritative event-derived
 * projection (§15.5, §3.4). This is NOT a second read model: it reduces the
 * log and reads the projection's fields, never re-deriving status from
 * records, worktrees, or OS processes.
 *
 * **Lease health is a separate axis from effective status.** `reduceBuild`
 * reports `running` from `runner.attached`; a build whose runner died reduces
 * to `running` forever, because nothing appends on sandbox death — liveness
 * lives in the mutable `lease`/`heartbeatAt` columns (§15.2.6), not the log.
 * So `lease.health` is its own field and its own column, never folded into
 * the status word.
 *
 * Output carries no ANSI, ever: §16 puts themes and colors out of scope, and
 * "understandable without relying solely on color" plus "--json without ANSI
 * formatting" are both satisfied by emitting none rather than by gating on a
 * TTY check.
 */
import type { AbEvent } from '../events/catalog'
import type { Actor } from '../events/envelope'
import {
  reduceBuild,
  type BuildState,
  type OpenEscalation,
  type OpenSession,
  type PrLifecycle,
} from '../kernel/reducer'
import type {
  BuildOutcome,
  BuildStatus,
  Phase,
  TicketRef,
  VerifyOutcome,
} from '../ontology'
import type { Exec } from '../ports/workspace/git-worktree'
import { RemoteBuildStore } from '../store/remote/client'
import type { BuildRecord, BuildStore } from '../store/types'
import {
  resolveMainRepo,
  resolveRepoStatePaths,
} from './repo-state'
import { resolveStore } from './store-ref'

/** Backward-compatible name for callers/tests; repository resolution is shared. */
export const currentRepo = resolveMainRepo

// ── The projection ───────────────────────────────────────────────────────────

/**
 * Runner liveness, from the mutable lease columns (§15.2.6) — NOT a status.
 * `none` is deliberately its own value rather than a weaker `expired`: a build
 * that has not yet claimed its first lease reads this way, and it is the
 * common case for a freshly launched runner.
 */
export type LeaseHealth = 'held' | 'expired' | 'none'

export interface LeaseInfo {
  health: LeaseHealth
  holder?: string
  expiresAt?: string
  heartbeatAt?: string
}

export interface BuildSummary {
  slug: string
  ticket?: TicketRef
  /** The reducer's effective status (§15.5) — never mixed with lease health. */
  status: BuildStatus
  phase?: Phase
  round?: number
  attempt?: number
  pr?: { number: number; url: string; state?: PrLifecycle }
  updatedAt: string
  lease: LeaseInfo
}

export interface VerifyProgress {
  attempt: number
  /** Current cycle only — earlier attempts' results never count (§15.6-A). */
  steps: { step: string; outcome: VerifyOutcome; reason?: string }[]
  currentStep?: string
}

export interface BuildDetail extends BuildSummary {
  openEscalations: OpenEscalation[]
  openSessions: OpenSession[]
  verify: VerifyProgress
  lastEvent?: { type: string; seq: number; ts: string; actor: Actor }
  /** Present only with `--events <n>`: the newest n, chronological. */
  events?: AbEvent[]
  outcome?: BuildOutcome
}

/**
 * `none` when there is no lease; `expired` when it has run out; else `held`.
 *
 * The boundary matches `Dispatcher.leaseSweep` (src/processes/dispatcher.ts),
 * whose has-lease branch is `if (expiresAt > now) continue // healthy` — so
 * `expiresAt === now` is expired in both places and the sweep and this report
 * agree.
 *
 * That agreement is on the has-lease branch only. `leaseSweep` also grants an
 * ABSENT lease a first-claim grace window (`updatedAt` within `leaseTtlMs`)
 * before it acts, while this reports `none` regardless. The divergence is
 * intended: `none` is a distinct word from `expired`, and teaching this
 * function the grace window would put a dispatcher policy knob (`leaseTtlMs`)
 * into a read-only reporter. It is documented in the guide instead.
 */
export function leaseHealth(record: BuildRecord, now: Date): LeaseHealth {
  if (record.lease === undefined) return 'none'
  return new Date(record.lease.expiresAt).getTime() <= now.getTime() ? 'expired' : 'held'
}

function leaseInfo(record: BuildRecord, now: Date): LeaseInfo {
  return {
    health: leaseHealth(record, now),
    ...(record.lease !== undefined
      ? { holder: record.lease.holder, expiresAt: record.lease.expiresAt }
      : {}),
    ...(record.heartbeatAt !== undefined ? { heartbeatAt: record.heartbeatAt } : {}),
  }
}

/**
 * The summary over an ALREADY-reduced state — so `detail` reduces the log
 * once and builds both projections from it, rather than reducing twice.
 */
function summarizeFrom(record: BuildRecord, state: BuildState, now: Date): BuildSummary {
  // `phase`, `round`, and `attempt` describe ONE phase occurrence, so they come
  // from ONE source: the in-flight phase, else the last completed one — the
  // same `currentPhase ?? lastCompletedPhase` the reducer uses to derive
  // `state.phase`. Reading `phase` from that pair while reading round/attempt
  // from `currentPhase` alone made the three disagree the moment a phase
  // completed: `verify.completed` clears `currentPhase`, so between two verify
  // steps a build on attempt 3 reported `verify:unit r1` — the attempt gone and
  // the loop round stamped onto a phase that carries none. That reads as "first
  // pass through verify" while verify is actually thrashing on its third.
  //
  // PhaseContext is authoritative about which axis a phase HAS (§15.3): loop
  // phases carry `round`, verify and reconcile carry `attempt`, finalize
  // carries neither. Taking both straight from it is what makes "current round
  // or attempt WHEN APPLICABLE" fall out, instead of being re-decided here.
  const active = state.currentPhase ?? state.lastCompletedPhase
  const round = active?.round
  const attempt = active?.attempt
  return {
    slug: record.slug,
    // record.ticket is a TicketRef already carrying id/title/url — no artifact
    // read and no ticket-provider call (live ticket state is out of scope).
    ...(record.ticket !== undefined ? { ticket: record.ticket } : {}),
    status: state.status,
    ...(active?.phase !== undefined ? { phase: active.phase } : {}),
    ...(round !== undefined ? { round } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(state.pr !== undefined
      ? {
          pr: {
            number: state.pr.number,
            url: state.pr.url,
            ...(state.prState !== undefined ? { state: state.prState } : {}),
          },
        }
      : {}),
    updatedAt: record.updatedAt,
    lease: leaseInfo(record, now),
  }
}

/**
 * One build's summary. `round`/`attempt` come from the in-flight phase when
 * there is one, so "current round or attempt when applicable" reflects what is
 * happening now rather than the last thing that finished.
 */
export function summarize(record: BuildRecord, events: AbEvent[], now: Date): BuildSummary {
  return summarizeFrom(record, reduceBuild(events), now)
}

/** Summary plus the detail fields; `eventCount` appends the newest n events. */
export function detail(
  record: BuildRecord,
  events: AbEvent[],
  now: Date,
  eventCount?: number,
): BuildDetail {
  const state = reduceBuild(events)
  const summary = summarizeFrom(record, state, now)
  // §15.6-A: only the CURRENT cycle's results describe the current code.
  // Without this filter an earlier cycle's passes read as current — wrong, and
  // wrong in the reassuring direction.
  //
  // The cycle test is `seq > verify.cycleSince`, NOT `attempt ===
  // verify.attempt`: the latter is stale for the whole window between a verify
  // failure and the next `verify.started`, where `verify.attempt` still names
  // the failed cycle. `cycleSince` is the authoritative boundary the reducer
  // and engine.ts already agree on (max of restart, code-review approve, and
  // reconcile) — reading it here is what keeps this command's report equal to
  // the projection used elsewhere rather than a second, drifting opinion.
  const steps = state.verify.results
    .filter((result) => result.seq > state.verify.cycleSince)
    .map((result) => ({
      step: result.step,
      outcome: result.outcome,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
    }))
  return {
    ...summary,
    openEscalations: state.openEscalations,
    openSessions: state.sessions.open,
    verify: {
      attempt: state.verify.attempt,
      steps,
      ...(state.verify.currentStep !== undefined
        ? { currentStep: state.verify.currentStep }
        : {}),
    },
    ...(state.lastEvent !== undefined
      ? {
          lastEvent: {
            type: state.lastEvent.type,
            seq: state.lastEvent.seq,
            ts: state.lastEvent.ts,
            actor: state.lastEvent.actor,
          },
        }
      : {}),
    // getEvents returns seq-ordered events, so the newest n slice out already
    // chronological — which is what the AC asks for.
    ...(eventCount !== undefined ? { events: events.slice(-eventCount) } : {}),
    ...(state.outcome !== undefined ? { outcome: state.outcome } : {}),
  }
}

// ── Renderers ────────────────────────────────────────────────────────────────

/** Lease health as a literal word — never a color (§16: colors out of scope). */
function healthWord(health: LeaseHealth): string {
  return health === 'none' ? 'no-lease' : health
}

/** `r<round>` / `a<attempt>` suffixed onto the phase — the loop vs verify axis. */
function phaseCell(summary: BuildSummary): string {
  if (summary.phase === undefined) return '—'
  if (summary.attempt !== undefined) return `${summary.phase} a${summary.attempt}`
  if (summary.round !== undefined) return `${summary.phase} r${summary.round}`
  return summary.phase
}

/** `#7 open https://…` — state AND link, per the summary's required fields. */
function prCell(summary: BuildSummary): string {
  if (summary.pr === undefined) return '—'
  const state = summary.pr.state !== undefined ? ` ${summary.pr.state}` : ''
  return `#${summary.pr.number}${state} ${summary.pr.url}`
}

/** Long enough to recognize the ticket, short enough to keep rows scannable. */
const TITLE_WIDTH = 40

/** `AUT-6 Interactive build dashboard…` — id AND title, per the same list. */
function ticketCell(summary: BuildSummary): string {
  const ticket = summary.ticket
  if (ticket === undefined) return '—'
  if (ticket.title === undefined || ticket.title === '') return ticket.id
  const title =
    ticket.title.length > TITLE_WIDTH ? `${ticket.title.slice(0, TITLE_WIDTH - 1)}…` : ticket.title
  return `${ticket.id} ${title}`
}

/** Coarse relative age — a status read wants "how stale", not a timestamp. */
export function relativeTime(iso: string, now: Date): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return iso
  const seconds = Math.round((now.getTime() - then) / 1000)
  if (seconds < 0) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function padColumns(rows: string[][]): string[] {
  const widths: number[] = []
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length)
    })
  }
  return rows.map((row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd(),
  )
}

/**
 * One aligned row per build. `emptyNote` names the filter in effect when there
 * is nothing to show, so an empty result is an honest answer rather than a
 * blank that reads like a bug.
 */
export function renderSummaries(
  summaries: BuildSummary[],
  now: Date,
  emptyNote: string,
): string[] {
  if (summaries.length === 0) return [emptyNote]
  // The two free-text columns (ticket title, PR link) go last, where their
  // width costs no alignment on the scannable columns to their left.
  const rows: string[][] = [['BUILD', 'STATUS', 'PHASE', 'LEASE', 'UPDATED', 'TICKET', 'PR']]
  for (const summary of summaries) {
    rows.push([
      summary.slug,
      summary.status,
      phaseCell(summary),
      healthWord(summary.lease.health),
      relativeTime(summary.updatedAt, now),
      ticketCell(summary),
      prCell(summary),
    ])
  }
  return padColumns(rows)
}

/** Labeled sections, each omitted when absent ("when each is available"). */
export function renderDetail(d: BuildDetail, now: Date): string[] {
  const lines: string[] = [`build ${d.slug}`]
  if (d.ticket !== undefined) {
    const title = d.ticket.title !== undefined ? ` — ${d.ticket.title}` : ''
    lines.push(`  ticket:   ${d.ticket.id}${title}`)
    if (d.ticket.url !== undefined) lines.push(`  ticket url: ${d.ticket.url}`)
  }
  lines.push(`  status:   ${d.status}${d.outcome !== undefined ? ` (${d.outcome})` : ''}`)
  lines.push(`  phase:    ${phaseCell(d)}`)
  lines.push(`  updated:  ${d.updatedAt} (${relativeTime(d.updatedAt, now)})`)

  // Its own line, never folded into status: a running build with an expired
  // lease is the case this exists to make visible.
  const lease = [`  lease:    ${healthWord(d.lease.health)}`]
  if (d.lease.holder !== undefined) lease.push(`holder ${d.lease.holder}`)
  if (d.lease.expiresAt !== undefined) lease.push(`expires ${d.lease.expiresAt}`)
  lines.push(lease.join('  '))
  if (d.lease.heartbeatAt !== undefined) {
    lines.push(`  heartbeat: ${d.lease.heartbeatAt} (${relativeTime(d.lease.heartbeatAt, now)})`)
  }
  if (d.status === 'running' && d.lease.health === 'expired') {
    lines.push('  note:     running with an expired lease — the runner is gone; the lease sweep will re-attach it')
  }

  if (d.pr !== undefined) {
    lines.push(`  pr:       #${d.pr.number}${d.pr.state !== undefined ? ` (${d.pr.state})` : ''} ${d.pr.url}`)
  }

  if (d.openEscalations.length > 0) {
    lines.push(`  escalations (${d.openEscalations.length} unresolved):`)
    for (const escalation of d.openEscalations) {
      lines.push(`    [${escalation.id}] ${escalation.phase}: ${escalation.question}`)
    }
  }

  if (d.openSessions.length > 0) {
    lines.push(`  open sessions (${d.openSessions.length}):`)
    for (const session of d.openSessions) {
      lines.push(`    ${session.session} — ${session.role} on ${session.phase} (runner ${session.runner})`)
    }
  }

  if (d.verify.attempt > 0) {
    lines.push(`  verify:   attempt ${d.verify.attempt}`)
    for (const step of d.verify.steps) {
      if (step.outcome === 'skipped') {
        lines.push(`    SKIP  ${step.step} — ${step.reason ?? '(reason unavailable)'}`)
      } else {
        lines.push(`    ${step.outcome === 'pass' ? 'pass' : 'FAIL'}  ${step.step}`)
      }
    }
    if (d.verify.currentStep !== undefined) {
      lines.push(`    running  ${d.verify.currentStep}`)
    }
  }

  if (d.lastEvent !== undefined) {
    lines.push(
      `  last event: ${d.lastEvent.type} (seq ${d.lastEvent.seq}) ${d.lastEvent.ts} by ${d.lastEvent.actor.kind}`,
    )
  }

  if (d.events !== undefined) {
    lines.push(`  events (newest ${d.events.length}, chronological):`)
    const rows = d.events.map((event) => [
      `    ${event.seq}`,
      event.ts,
      event.type,
      event.actor.kind,
    ])
    for (const line of padColumns(rows)) lines.push(line)
  }

  return lines
}

// ── The command shells ───────────────────────────────────────────────────────

export interface StatusOpts {
  /** The cwd — resolved to the main repo root before matching (see currentRepo). */
  targetRepo: string
  /** Process environment: AB_STORE / AB_TOKEN (D8). */
  env: Record<string, string | undefined>
  exec: Exec
  stdout: (line: string) => void
  json?: boolean
  /** `--store <ref>`; same reference behavior dispatch has (§7.2). */
  storeRef?: string
  /** Injectable store seam — mirrors dispatch.ts's `wire`, keeps tests off the
   * real filesystem. */
  openStore?: (ref: string, token?: string) => BuildStore
  /** Injectable clock; defaults to the wall clock. */
  now?: () => Date
}

/** Statuses a bare `ab builds` shows: the ones an operator can still act on. */
const ACTIVE_STATUSES: BuildStatus[] = ['running', 'paused', 'blocked']

export function statusFilter(all?: boolean, queued?: boolean): BuildStatus[] {
  if (all === true) return ['queued', 'running', 'paused', 'blocked', 'done', 'aborted']
  return queued === true ? [...ACTIVE_STATUSES, 'queued'] : ACTIVE_STATUSES
}

/**
 * Open the shared selection: `--store` > non-blank `AB_STORE` > the main
 * repository's `.autobuild/`. Local references are already absolute here;
 * HTTP(S) references remain unchanged for the remote adapter.
 */
function openStoreFor(opts: StatusOpts, repo: string): BuildStore {
  const ref = resolveRepoStatePaths({
    repo,
    ...(opts.storeRef !== undefined ? { storeRef: opts.storeRef } : {}),
    ...(opts.env['AB_STORE'] !== undefined ? { envStore: opts.env['AB_STORE'] } : {}),
  }).storeRef
  const token = opts.env['AB_TOKEN']
  const open =
    opts.openStore ??
    ((r: string, tok?: string) =>
      resolveStore(r, {
        remoteFactory: (url, t) => new RemoteBuildStore({ url, token: t }),
        ...(tok !== undefined && tok !== '' ? { token: tok } : {}),
      }))
  return open(ref, token !== undefined && token !== '' ? token : undefined)
}

export interface AbBuildsOpts extends StatusOpts {
  queued?: boolean
  all?: boolean
}

/** `ab builds` — this repo's builds, active by default. Read-only. */
export async function abBuilds(opts: AbBuildsOpts): Promise<void> {
  const now = (opts.now ?? (() => new Date()))()
  const repo = await resolveMainRepo(opts.targetRepo, opts.exec)
  const store = openStoreFor(opts, repo)
  try {
    const wanted = new Set(statusFilter(opts.all, opts.queued))
    // Cross-repo aggregation is out of scope (§12: one dispatcher per repo,
    // one repo's builds per answer).
    const records = (await store.listBuilds()).filter((record) => record.repo === repo)
    const summaries: BuildSummary[] = []
    for (const record of records) {
      const summary = summarize(record, await store.getEvents(record.slug), now)
      if (wanted.has(summary.status)) summaries.push(summary)
    }
    summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

    if (opts.json === true) {
      opts.stdout(JSON.stringify(summaries, null, 2))
      return
    }
    // The empty line names the filter that matched nothing and suggests only
    // the flags that would actually widen it — telling a caller who passed
    // --queued to "try --queued" reads as a broken command.
    const scope =
      opts.all === true ? 'builds' : opts.queued === true ? 'active or queued builds' : 'active builds'
    const hint =
      opts.all === true ? '' : opts.queued === true ? ' — try --all' : ' — try --queued or --all'
    for (const line of renderSummaries(summaries, now, `no ${scope} for ${repo}${hint}`)) {
      opts.stdout(line)
    }
  } finally {
    // Not optional: a leaked SQLite handle can hang the caller.
    await store.close()
  }
}

export interface AbBuildStatusOpts extends StatusOpts {
  slug: string
  events?: number
}

/** `ab build status <slug>` — one build in detail. Read-only. */
export async function abBuildStatus(opts: AbBuildStatusOpts): Promise<void> {
  const now = (opts.now ?? (() => new Date()))()
  const repo = await resolveMainRepo(opts.targetRepo, opts.exec)
  const store = openStoreFor(opts, repo)
  try {
    const record = await store.getBuild(opts.slug)
    if (record === null) {
      throw new Error(
        `no build "${opts.slug}" in this store — run 'ab builds --all' to list ` +
          'this repo\'s builds, or pass --store <ref> if it lives in another store',
      )
    }
    const d = detail(record, await store.getEvents(opts.slug), now, opts.events)
    if (opts.json === true) {
      opts.stdout(JSON.stringify(d, null, 2))
      return
    }
    for (const line of renderDetail(d, now)) opts.stdout(line)
  } finally {
    await store.close()
  }
}
