import { readBuildRange, isTerminalEventReadError } from '../store/event-reads'
import { ReducerValueIncompatibilityError } from '../store/remote/compatibility'
import { WatchLifetime } from './watch-lifetime'
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { OPERATOR_HEARTBEAT_MS, operatorIdentitySchema } from '../store/operator-presence'
import { consentReady, consentIdentity, type ConsentReady } from './attention'
import { formatReadinessFailure } from '../ports/forge/readiness'
import { abandonedPreparationDiagnostic } from '../kernel/ticket-preparation'
import { readDispatchUpgrade, readBuildDigests } from '../store/reduced-reads'
import { readBuildStreamSeed, readRepositoryAttention } from '../store/reduced-reads'
import { buildStreamSeedReducer, type BuildStreamSeed } from '../kernel/read-facts'
import { historicalBuildState, historicalRepositoryAttention } from './historical-build-state'
import { readDispatcherRunFacts } from '../store/reduced-reads'
import { projectDispatcherLiveness } from '../kernel/dispatcher-liveness'
import type { BuildDigest, BuildStore, RepositoryRecord } from '../store/types'
import { readRepositoryFacts, readPersistedBuildDigests } from '../store/reduced-reads'
import { isWorkDigest } from '../processes/repo-view'
import { creationBuildSlug } from '../kernel/build-creation'
/**
 * `ab watch` — the sessionless streaming half of the status family
 * (§8.2, §7.2). It follows the event logs of one, several, or all active
 * builds in the repository, plus the repository journal by default with no
 * slugs, and emits one record per matching event as it lands, carrying the durable
 * envelope, the build's reduced state after that event, and an opaque cursor
 * so a later `--since` invocation resumes exactly where this one stopped.
 *
 * Like `ab builds` / `ab build status`, the projection is pure and the IO is a
 * thin shell. The command composes the existing read surface — `listBuilds`,
 * `getEvents(since)`, `getRepoEvents(since)`, `getBuild`. Only --operator
 * writes mutable advisory liveness; neither form appends events or claims leases. It
 * deliberately does not reuse `pollingSubscribe` (store/subscribe.ts): that
 * helper is single-stream, fixed-membership, and build-only, while `watch`
 * needs dynamic membership (builds created mid-watch join), the repository
 * journal, per-stream error reporting, and a resumable cursor. Delivery
 * semantics (in-order, exactly once per stream) are reimplemented locally for
 * the same reason.
 *
 * Cadence follows the store kind (AUT-334). Against a local store the loop is
 * the sequential interval tick. Against an `http(s)` store every tracked
 * stream long-polls instead: one held `getEvents`/`getRepoEvents` request per
 * stream is always in flight (tasks run concurrently), an appended event is
 * seen within about a second of its append, and gap-fill keeps request starts
 * at least `--interval` apart, so a quiet stream costs one request per wait
 * window — not one per interval. Discovery keeps its interval cadence. Every
 * stop is prompt: an abort, a tripped --count, an all-terminal named set, or
 * an elapsed --timeout cancels the in-flight held reads instead of waiting
 * out a full hold, and a hold never outlives the --timeout deadline.
 *
 * The cursor is `"v1." + base64url(JSON)` of the per-stream sequence position
 * plus the resolved store reference and repository identity. It is opaque to
 * callers — the format is not part of the contract — and a cursor from a
 * different store or repository is rejected before any read. Non-matching
 * events still advance their stream's position, so a resume never rescans or
 * redelivers them.
 *
 * Output carries no ANSI, ever, in either form (§16).
 */
import type { AbEvent } from '../events/catalog'
import type { EventType } from '../events/payloads'
import type { RepositoryEvent } from '../events/repository'
import {
  mergeDecisionFromFacts,
  mergeIdentity,
  RepositoryAttention,
  repositoryNeedsAttention,
  type MergeDecision,
  type PersistenceObservation,
} from './attention'
import type { BuildState, PrLifecycle } from '../kernel/reducer'
import {
  ticketWaitStatus,
  waitEndedText,
  waitingOnLine,
  waitRefusedText,
  waitRequestedText,
  type TicketWaitStatus,
} from '../kernel/ticket-wait'
import { buildReducer } from '../kernel/reducer'
import type { BuildOutcome, BuildStatus, Phase } from '../ontology'
import type { Exec } from '../ports/workspace/git-worktree'
import { PhaseSessionError } from '../store/phase-session'
import type { BuildRecord } from '../store/types'
import { resolveAmbientReadSession } from './env'
import {
  createRemotePollRunner,
  defaultDelay,
  makeFailureStreak,
  type RemotePollReadOpts,
  type RemotePollRunner,
} from './remote-poll'
import { buildInRepository, isRemoteStoreRef, normalizeGitRemoteUrl } from './repo-state'
import { withAmbientReadStore, type OpenedStoreContext, type StoreOpener } from './store-opening'

export const WATCH_USAGE =
  'usage: ab watch [<slug>...] [--repository] [--operator] [--event <glob>]... [--since <cursor>] ' +
  '[--timeout <duration>] [--interval <duration>] [--count <n>] [--json] [--store <ref>]'

/** Default poll cadence and watch horizon. */
export const DEFAULT_REMOTE_INTERVAL_MS = 5_000
export const DEFAULT_LOCAL_INTERVAL_MS = 1_000
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

/** The repository-journal stream's key in the cursor's per-stream map. */
const REPO_STREAM_KEY = '#repo'

/** Statuses a build can still leave; the others are terminal (§15.5). */
const NONTERMINAL_STATUSES: readonly BuildStatus[] = [
  'queued',
  'running',
  'collecting',
  'paused',
  'blocked',
]
const TERMINAL_STATUSES: readonly BuildStatus[] = ['done', 'aborted']

// ── The default filter: the attention set ────────────────────────────────────

/**
 * The build events an operator or agent must wake up for. With no `--event`,
 * a watch emits exactly these — deciding what to do about a blocker or a
 * merge stays with the caller's skill.
 */
export const BUILD_ATTENTION_EVENTS = [
  'target.rewritten',
  'build.janitor-failing',
  'build.janitor-escalated',
  'build.compatibility-deferred',
  'escalation.raised',
  'phase.deferral-escalated',
  'integration.landed',
  'integration.verification-failed',
  'node.item-conflicted',
  'landing.consent-revoked',
] as const satisfies readonly EventType[]

// ── Glob compilation and matching ────────────────────────────────────────────

/**
 * Compile `--event` globs to anchored matchers: `*` matches any run of
 * characters, `?` exactly one, everything else verbatim (so the dots inside
 * event type names are escaped). Each glob must match at least one type in
 * the build catalog, or the repository catalog with no slugs or explicit
 * `--repository` — otherwise a usage error naming the glob is thrown before any
 * store read. Supplying any glob replaces the attention set entirely.
 *
 * The compiler itself lives in `events/globs.ts`, shared with the
 * explicit session wake validation.
 */
import { compileEventGlobs } from '../events/globs'
export { compileEventGlobs } from '../events/globs'

function matchesBuildFilter(type: EventType, filters: readonly RegExp[]): boolean {
  return filters.length > 0
    ? filters.some((regex) => regex.test(type))
    : (BUILD_ATTENTION_EVENTS as readonly string[]).includes(type)
}

// ── The cursor ───────────────────────────────────────────────────────────────

interface CursorPayload {
  operator?: { id: string; startedAt: string }
  v: 1
  /** The resolved store reference this cursor's positions belong to. */
  store: string
  /** The repository identity (normalized origin or checkout path). */
  repo: string
  /** Per-stream watch position: build slug → seq, `#repo` → seq. */
  deliveredAttention?: string[]
  lostRuns?: string[]
  /** Hook feeds only: build announcements still in preparation at this
   * position, attempt → the slug and creation key `creation-selected` named. */
  preparing?: Record<string, PreparingBuild>
  streams: Record<string, number>
}

/** A selected build creation not yet resolved, as the hook feed tracks it. */
export interface PreparingBuild {
  slug: string
  creationKey?: string
}

/** The cursor fields a hook's status and skip report need; the format stays internal. */
export type WatchCursorPayload = CursorPayload

function validAttentionIdentity(id: unknown): boolean {
  if (typeof id !== 'string') return false
  if (/^(source|tick):[1-9][0-9]*$/.test(id)) return true
  try {
    const value: unknown = JSON.parse(id)
    return (
      Array.isArray(value) &&
      ((value.length === 3 &&
        (value[0] === 'consent' || value[0] === 'target.rewritten') &&
        typeof value[1] === 'string' &&
        value[1].length > 0 &&
        Number.isSafeInteger(value[2]) &&
        value[2] > 0) ||
        (value.length === 2 &&
          typeof value[0] === 'string' &&
          value[0].length > 0 &&
          Number.isSafeInteger(value[1]) &&
          value[1] > 0))
    )
  } catch {
    return false
  }
}

const CURSOR_PREFIX = 'v1.'

/** Opaque to callers; the format is internal, not contract. */
export function encodeCursor(payload: CursorPayload): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

/**
 * Decode and authorize a `--since` cursor against this watch's resolved store
 * and repository — before any store read. Malformed input, and cursors from a
 * different store or repository, each get a distinct rejection naming what
 * mismatched.
 */
export function decodeCursor(
  cursor: string,
  expected: { store: string; repo: string },
  opts: { verb: string; usage: string } = { verb: 'watch', usage: WATCH_USAGE },
): CursorPayload {
  const malformed = (): Error =>
    new Error(
      'invalid --since cursor: malformed — a cursor is an opaque string emitted by a ' +
        `previous 'ab ${opts.verb}' run — ${opts.usage}`,
    )
  if (!cursor.startsWith(CURSOR_PREFIX)) throw malformed()
  let payload: unknown
  try {
    payload = JSON.parse(
      Buffer.from(cursor.slice(CURSOR_PREFIX.length), 'base64url').toString('utf8'),
    )
  } catch {
    throw malformed()
  }
  if (typeof payload !== 'object' || payload === null) throw malformed()
  const { v, store, repo, streams, lostRuns, deliveredAttention, operator, preparing } =
    payload as Record<string, unknown>
  if (
    lostRuns !== undefined &&
    (!Array.isArray(lostRuns) ||
      lostRuns.some((run) => typeof run !== 'string' || run.length === 0))
  )
    throw malformed()
  if (
    deliveredAttention !== undefined &&
    (!Array.isArray(deliveredAttention) ||
      deliveredAttention.some((id) => !validAttentionIdentity(id)))
  )
    throw malformed()
  if (
    preparing !== undefined &&
    (typeof preparing !== 'object' ||
      preparing === null ||
      Array.isArray(preparing) ||
      Object.values(preparing).some(
        (entry: unknown) =>
          typeof entry !== 'object' ||
          entry === null ||
          typeof (entry as PreparingBuild).slug !== 'string' ||
          (entry as PreparingBuild).slug.trim().length === 0 ||
          ((entry as PreparingBuild).creationKey !== undefined &&
            typeof (entry as PreparingBuild).creationKey !== 'string'),
      ))
  )
    throw malformed()
  if (operator !== undefined) {
    if (
      typeof operator !== 'object' ||
      operator === null ||
      !operatorIdentitySchema.pick({ id: true, startedAt: true }).safeParse(operator).success
    )
      throw malformed()
  }
  if (v !== 1 || typeof store !== 'string' || typeof repo !== 'string') throw malformed()
  if (typeof streams !== 'object' || streams === null || Array.isArray(streams)) throw malformed()
  for (const seq of Object.values(streams)) {
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) throw malformed()
  }
  if (store !== expected.store) {
    throw new Error(
      `invalid --since cursor: it was created against store "${store}", but this watch ` +
        `reads store "${expected.store}" — resume from the same --store the cursor came from`,
    )
  }
  if (repo !== expected.repo) {
    throw new Error(
      `invalid --since cursor: it was created for repository "${repo}", but this watch reads ` +
        `repository "${expected.repo}" — run from the repository the cursor came from`,
    )
  }
  return {
    v: 1,
    store,
    repo,
    streams: streams as Record<string, number>,
    ...(operator === undefined ? {} : { operator: operator as { id: string; startedAt: string } }),
    ...(deliveredAttention === undefined
      ? {}
      : { deliveredAttention: deliveredAttention as string[] }),
    ...(lostRuns === undefined ? {} : { lostRuns: lostRuns as string[] }),
    ...(preparing === undefined ? {} : { preparing: preparing as Record<string, PreparingBuild> }),
  }
}

// ── Durations and cadence ────────────────────────────────────────────────────

/**
 * `30`, `45s`, `5m`, `1h` — a positive number of seconds with an optional
 * unit suffix; a bare number means seconds (the `ab dispatch --interval`
 * convention). `0` is accepted only where the caller says so (`--timeout 0`
 * means unbounded; `--interval 0` is a usage error).
 */
export function parseDurationMs(
  text: string,
  opts: { flag: string; usage: string; allowZero?: boolean },
): number {
  const match = /^(\d+)([smh]?)$/.exec(text)
  const invalid = (): Error =>
    new Error(
      `${opts.flag} requires a duration — a positive number of seconds, optionally suffixed ` +
        `s, m, or h (for example 30, 45s, 5m, 1h)${
          opts.allowZero === true ? '; 0 means unbounded' : ''
        } — ${opts.usage}`,
    )
  if (match === null) throw invalid()
  const amount = Number(match[1])
  if (amount === 0 && opts.allowZero !== true) throw invalid()
  const unitMs = match[2] === 'm' ? 60_000 : match[2] === 'h' ? 3_600_000 : 1_000 // '' and 's' both mean seconds
  return amount * unitMs
}

/** Default poll interval by store kind: patient remotely, prompt locally. */
export function watchSelection(storeRef: string): { intervalMs: number } {
  return {
    intervalMs: isRemoteStoreRef(storeRef) ? DEFAULT_REMOTE_INTERVAL_MS : DEFAULT_LOCAL_INTERVAL_MS,
  }
}

// ── The record projection ────────────────────────────────────────────────────

/** The reduction after one event — the exact fields the spec names. */
export interface WatchRecordState {
  status: BuildStatus
  phase: Phase | null
  runningVerifySteps?: string[]
  cancelledVerifySteps?: { step: string; cause: { step: string } }[]
  round: number
  openEscalations: { id: string; question: string }[]
  pr: { number: number; url: string; headSha: string } | null
  prState: PrLifecycle | null
  outcome: BuildOutcome | null
  /** The ticket wait while requested, open, or ended and not yet resumed. */
  wait?: TicketWaitStatus
}

/** Lease-expiry evidence is an observation, never a fabricated journal event. */
export interface WatchObservationRecord {
  id: string
  repo: string
  build: null
  state: null
  observation: {
    type: 'dispatcher.lost'
    run: string
    observedAt: string
    leaseExpiresAt: string
    pid?: number | null
    host?: string | null
    startedAt?: string | null
    heartbeatAt?: string | null
    heartbeatAgeMs?: number | null
  }
  cursor: string
}

export interface AttentionObservationRecord {
  repo?: string
  build: string | null
  state: WatchRecordState | null
  observation: MergeDecision | PersistenceObservation | ConsentReady
  cursor: string
}

export function projectAttentionRecord(
  observation: MergeDecision | PersistenceObservation | ConsentReady,
  state: BuildState | null,
  cursor: string,
  scope: { build: string } | { repo: string },
): AttentionObservationRecord {
  return {
    ...scope,
    build: 'build' in scope ? scope.build : null,
    state: state ? projectState(state) : null,
    observation,
    cursor,
  }
}

export function renderAttentionLine(
  observation: MergeDecision | PersistenceObservation | ConsentReady,
  label: string,
): string {
  return `${observation.observedAt}  ${singleLine(label)}  ${observation.type}  ${singleLine(JSON.stringify(observation))}`
}

export interface WatchRecord {
  /** The build slug, or null for a repository-journal event. */
  build: string | null
  /** The repository identity — present only for repository events. */
  repo?: string
  /** The complete durable envelope, passed through unchanged. */
  event: AbEvent | RepositoryEvent
  /** For build events, the reduction after this event; null for repository events. */
  state: WatchRecordState | null
  /** The watch position after this event — resume here with --since. */
  cursor: string
}

function projectState(state: BuildState): WatchRecordState {
  const wait = ticketWaitStatus(state)
  return {
    status: state.status,
    phase: state.phase ?? null,
    ...((state.verify.running?.length ?? 0) > 1
      ? { runningVerifySteps: state.verify.running }
      : {}),
    ...(Object.values(state.verifyStage.cancellations).some((c) => c.seq > state.verify.cycleSince)
      ? {
          cancelledVerifySteps: Object.values(state.verifyStage.cancellations)
            .filter((c) => c.seq > state.verify.cycleSince)
            .map((c) => ({ step: c.step, cause: c.cause })),
        }
      : {}),
    round: state.round,
    openEscalations: state.openEscalations.map((escalation) => ({
      id: escalation.id,
      question: escalation.question,
    })),
    pr: state.pr ?? null,
    prState: state.prState ?? null,
    outcome: state.outcome ?? null,
    ...(wait !== undefined ? { wait } : {}),
  }
}

/** Every `ab watch --json` record line: the projection plus its stable `id`. */
export type WatchJsonRecord =
  | (WatchRecord & { id: string })
  | (AttentionObservationRecord & { id: string })
  | WatchObservationRecord

/**
 * The record identity `ab watch --json` and configured hooks carry. It is
 * derived only from durable facts — a journal seq or an attention dedupe
 * identity — so a regenerated or redelivered record has the same `id`.
 */
export function watchRecordId(
  source:
    | { event: AbEvent | RepositoryEvent }
    | { observation: string; identity: string }
    | { lost: string },
): string {
  if ('event' in source)
    return 'build' in source.event
      ? `build:${source.event.build}:${source.event.seq}`
      : `repo:${source.event.seq}`
  if ('lost' in source) return `dispatcher.lost:${source.lost}`
  return `${source.observation}:${source.identity}`
}

/** `--json` form: exactly one object per matching event. */
export function projectRecord(
  event: AbEvent | RepositoryEvent,
  state: BuildState | null,
  cursor: string,
): WatchRecord {
  if ('build' in event) {
    return {
      build: event.build,
      event,
      state: state === null ? null : projectState(state),
      cursor,
    }
  }
  return { build: null, repo: event.repo, event, state: null, cursor }
}

/** Preserve printable text while making control bytes (and ANSI) inert. */
function singleLine(value: string): string {
  let displayed = ''
  for (const char of value) {
    const code = char.codePointAt(0)!
    displayed += code >= 0x20 && code !== 0x7f ? char : `\\u{${code.toString(16)}}`
  }
  return displayed
}

const SUMMARY_MAX = 200

/**
 * A payload-derived one-liner per attention type; unknown types (custom
 * `--event` globs) get a compact single-line payload.
 */
export function summarizeEvent(event: AbEvent | RepositoryEvent, state: BuildState | null): string {
  switch (event.type) {
    case 'landing.consent-revoked': {
      const p = event.payload
      const more = p.paths.total - p.paths.preview.length
      return singleLine(
        `Merge consent revoked for ${event.build}: reconcile edited files protected by merge[${p.rule.index}] (${p.paths.preview.join(', ')}${more > 0 ? `, +${more} more` : ''}); head ${p.previousHead} → ${p.head}; re-review and run ab merge ${event.build}`,
      )
    }
    case 'target.rewritten':
      return `Upstream rewrite on ${event.payload.branch}: ${event.payload.previousSha} → ${event.payload.sha}; automatic adoption withheld`
    case 'verify.cancelled':
      return `verify:${event.payload.step} not run: cancelled by verify:${event.payload.cause.step} (attempt ${event.payload.attempt})`
    case 'verify.stage-failed':
      return `verify stage failed (attempt ${event.payload.attempt}): ${event.payload.failed.map((f) => f.step).join(', ')}; ${event.payload.cancelled.map((c) => `${c.step} cancelled by ${c.cause.step}`).join(', ')}`
    case 'integration.verification-failed':
      return `verification failed: ${event.payload.steps.join(', ')}; head ${event.payload.head}; parent ${event.payload.parent}; ${event.payload.guidance}`
    case 'build.janitor-failing':
      return `Janitor failing: ${singleLine(event.payload.message)}`
    case 'dispatcher.forge-degraded':
      return `Forge degraded: ${singleLine(event.payload.message)}; reset ${event.payload.resetAt}`
    case 'account.credentials-unavailable':
      return `Missing credentials: ${singleLine(event.payload.remedy)} [${event.payload.source}]`
    case 'account.credentials-recovered':
      return `Account credentials recovered: ${JSON.stringify(event.payload.name)}`
    case 'dispatcher.forge-recovered':
      return `Forge recovered: ${event.payload.forge}`
    case 'forge.credential-limited':
      return `Forge request limited for ${event.payload.process} (${event.payload.credential}${event.payload.missingCredential ? `: ${singleLine(event.payload.missingCredential)}` : ''}); reset ${event.payload.resetAt}; dispatcher forge work continues`
    case 'ticket.handed-back': {
      const p = event.payload
      const details = [
        `${p.cause}${p.build !== undefined ? ` of build ${p.build}` : ''}`,
        ...(p.requested !== undefined ? [`requested ${p.requested}`] : []),
        ...(p.missing !== undefined ? [`missing: ${p.missing.join('; ')}`] : []),
        ...(p.reason !== undefined ? [`reason: ${p.reason}`] : []),
      ]
      return singleLine(`ticket ${p.ticket.id} handed back to ${p.state} (${details.join('; ')})`)
    }
    case 'dispatcher.kernel-git-unavailable':
      return `Kernel Git unavailable (${event.payload.executable}): ${singleLine(event.payload.detail)}`
    case 'dispatcher.kernel-git-recovered':
      return `Kernel Git recovered (${event.payload.executable})`
    case 'hook.failing':
      return singleLine(
        `hook ${event.payload.hook} failing since ${event.payload.since} (${event.payload.attempts} attempts): ${event.payload.error}`,
      )
    case 'hook.recovered':
      return `hook ${event.payload.hook} recovered`
    case 'hook.skipped':
      return singleLine(
        `hook ${event.payload.hook} skipped ${event.payload.ranges.length} unavailable range(s): ${event.payload.reason}`,
      )
    case 'phase.deferral-escalated':
    case 'build.janitor-escalated':
    case 'escalation.raised':
      return `${event.payload.id}: ${singleLine(event.payload.question)}`
    case 'build.compatibility-deferred':
      return event.payload.diagnostic
    case 'wait.requested':
      return singleLine(waitRequestedText(event.payload.tickets, event.payload.reason))
    case 'wait.refused':
      return singleLine(
        waitRefusedText(event.payload.tickets, event.payload.cause, event.payload.message),
      )
    case 'wait.entered':
      return singleLine(
        waitingOnLine(
          event.payload.tickets.map((ticket) => ticket.id),
          event.payload.reason,
        ),
      )
    case 'wait.ended':
      return singleLine(
        waitEndedText(
          {
            id: event.payload.id,
            tickets:
              state?.wait?.id === event.payload.id
                ? state.wait.tickets.map((ticket) => ticket.id)
                : undefined,
          },
          event.payload.cause,
          event.payload.message,
        ),
      )
    case 'escalation.answered': {
      // An operator answer to a wait's escalation is how that wait usually
      // ends; the post-event state says whether this answer ended it.
      const wait = state?.wait
      if (wait?.escalation === event.payload.id && wait.ended?.seq === event.seq)
        return singleLine(
          waitEndedText(
            { id: wait.id, tickets: wait.tickets.map((ticket) => ticket.id) },
            'operator',
            event.payload.answer,
          ),
        )
      return summarizePayload(event.payload)
    }
    case 'phase.failed':
      return `${event.payload.phase}${
        event.payload.round !== undefined ? ` r${event.payload.round}` : ''
      } attempt ${event.payload.attempt} failed${
        event.payload.willRetry ? ' (will retry)' : ''
      }: ${singleLine(event.payload.error)}`
    case 'infrastructure.failed':
      return `${event.payload.operation} failed on ${event.payload.provider} (attempt ${
        event.payload.attempt
      }, ${event.payload.retryable ? 'retryable' : 'not retryable'}): ${singleLine(
        event.payload.error,
      )}`
    case 'runner.setup-failed':
      return `setup attempt ${event.payload.attempt} failed: ${singleLine(event.payload.command)}`
    case 'dispatch.failed':
      return `${event.payload.stage} attempt ${event.payload.attempt} failed: ${singleLine(
        event.payload.error,
      )}`
    case 'publication.lost':
      return `${event.payload.operation} publication lost: ${singleLine(event.payload.reason)}`
    case 'finalize.completed':
      return `PR #${event.payload.pr.number} opened ${event.payload.pr.url}`
    case 'pr.conflicted':
      return state?.pr !== undefined
        ? `PR #${state.pr.number} conflicts with its base`
        : 'PR conflicts with its base'
    case 'pr.merged':
      return state?.pr !== undefined ? `PR #${state.pr.number} merged` : 'PR merged'
    case 'pr.closed':
      return state?.pr !== undefined ? `PR #${state.pr.number} closed` : 'PR closed'
    case 'build.completed':
      return `build completed (${event.payload.outcome})`
    case 'build.aborted':
      return 'build aborted'
    case 'harvest.escalated':
      return `harvest run ${event.payload.run} escalated: ${singleLine(event.payload.reason)}`
    case 'harvest.failed':
      return `harvest run ${event.payload.run} failed at ${event.payload.step} (attempt ${event.payload.attempt}): ${singleLine(event.payload.error)}`
    case 'dispatcher.ticket-source-degraded':
      return `ticket source ${event.payload.source} degraded: ${event.payload.cause} (${event.payload.operation}) — ${singleLine(event.payload.message)}${'resetAt' in event.payload ? `; reset ${event.payload.resetAt}` : ''}`
    case 'dispatcher.ticket-source-recovered':
      return `ticket source ${event.payload.source} recovered: ${event.payload.cause} (${event.payload.operation})`
    case 'dispatcher.tick-failed':
      return `dispatcher tick failed: ${singleLine(event.payload.error)}`
    case 'dispatcher.forge-readiness-failed':
      return singleLine(formatReadinessFailure(event.payload))
    case 'dispatcher.runtime-rolled-back':
      return `dispatcher runtime rolled back ${event.payload.failed.version} → ${event.payload.restored.version}: ${singleLine(event.payload.reason)}`
    case 'dispatcher.upgrade-failed':
      return `dispatcher upgrade failed (${event.payload.target.mode} ${event.payload.target.version ?? event.payload.target.source}): ${singleLine(event.payload.reason)}`
    case 'dispatcher.config-rejected':
      return `dispatcher config rejected: ${singleLine(event.payload.error)}`
    case 'dispatcher.harvest-runner-failed':
      return `harvest runner failed: ${singleLine(event.payload.error)}`
    case 'ticket-preparation.resolved':
      if (event.payload.outcome === 'abandoned') {
        return singleLine(abandonedPreparationDiagnostic(event.payload, event.payload.reason))
      }
      return summarizePayload(event.payload)
    default:
      return summarizePayload(event.payload)
  }
}

function summarizePayload(payload: unknown): string {
  const compact = singleLine(JSON.stringify(payload))
  return compact.length > SUMMARY_MAX ? `${compact.slice(0, SUMMARY_MAX - 1)}…` : compact
}

/** The human form: one line, timestamp first, no ANSI anywhere. */
export function renderWatchLine(
  event: AbEvent | RepositoryEvent,
  state: BuildState | null,
): string {
  const label = 'build' in event ? event.build : '(repository)'
  return `${event.ts}  ${label}  ${event.type}  ${summarizeEvent(event, state)}`
}

// ── The ambient-scope preflight ─────────────────────────────────────────────

/**
 * Ambient scope, before any store access: inside a phase with a complete
 * build identity, only the ambient build may be read. The errors are the same
 * PhaseSessionError shapes the scoped store handle produces for `ab builds` /
 * `ab build status`, so the message matches exactly. Shared by `ab watch` and
 * `ab wait`; `repository` is true only for watch's `--repository` form.
 */
export function assertReadScope(
  slugs: readonly string[],
  opts: { repository: boolean; env: Record<string, string | undefined> },
): void {
  const ambient = resolveAmbientReadSession(opts.env)
  if (ambient !== undefined && 'build' in ambient) {
    const scope = { kind: 'build' as const, id: ambient.build, session: ambient.session }
    if (slugs.length === 0 || opts.repository) {
      throw new PhaseSessionError(scope, 'listBuilds', { kind: 'admin' })
    }
    for (const slug of slugs) {
      if (slug !== ambient.build) {
        throw new PhaseSessionError(scope, 'getEvents', { kind: 'build', id: slug })
      }
    }
  }
}

// ── The command shell ────────────────────────────────────────────────────────

export interface AbWatchOpts {
  operator?: boolean
  operatorIdentity?: { host: string; pid: number; newId: () => string }
  heartbeatDelay?: (ms: number, signal?: AbortSignal) => Promise<void>
  targetRepo: string
  /** Raw process environment: --store > AB_STORE > repository default (D8). */
  env: Record<string, string | undefined>
  exec: Exec
  stdout: (line: string) => void
  flushStdout?: () => Promise<void>
  stderr: (line: string) => void
  /** Positional build slugs; none means every nonterminal build in the repo. */
  slugs?: readonly string[]
  /** Also follow the repository journal (dispatcher and harvest events). */
  repository?: boolean
  /** Repeatable `--event` globs; replaces the attention set. */
  events?: readonly string[]
  /** A cursor from an earlier record: resume exactly where that watch stopped. */
  since?: string
  /** `--timeout` duration text; default 30 minutes, `0` unbounded. */
  timeout?: string
  /** `--interval` duration text; default 5s remote, 1s local. */
  interval?: string
  /** `--count`, validated as a positive integer by the route. */
  count?: number
  json?: boolean
  storeRef?: string
  openStore?: StoreOpener
  /** Injectable clock; defaults to the wall clock. */
  now?: () => Date
  /** Injectable tick-gap sleep so tests drive ticks deterministically. */
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Termination signal from SIGINT/TERM/HUP or stdout EPIPE; ordinary completion does not abort it. */
  signal?: AbortSignal
  /** In-process consumer (configured hooks); never set by the CLI route. */
  feed?: WatchFeed
}

/**
 * The in-process form of `ab watch` that configured hooks run: the same
 * records, filters, identities and cursors, delivered to a structured sink.
 * A feed never lists the build population on a pass: builds join through
 * their announcement in the repository journal (`ticket-preparation`
 * `creation-selected` then `resolved` `owned`, which brackets every
 * `createBuild`), and settled terminal builds retire from the cursor, so
 * each changed pass and each resume costs the active builds' new rows.
 */
export interface WatchFeed {
  /** Already-open store; abWatch neither resolves, scopes, nor closes it. */
  context: { store: BuildStore; repo: string; storeRef: string; checkout: string }
  /** Structured sink replacing stdout; no trailing {"cursor"} line is emitted. */
  record: (record: WatchJsonRecord) => void
  /** First-ever initialization only (no `since`): the pre-emission baseline
   * cursor. Awaited before anything is tracked or emitted; a rejection fails
   * initialization with nothing emitted. */
  baseline?: (cursor: string) => Promise<void>
  /** The position after each pass. A candidate only: every record emitted
   * before it must succeed before the consumer may persist it. */
  position?: (cursor: string) => void
  /** Local-tick gate: false runs only in-memory timer checks this interval. */
  changed: () => Promise<boolean>
  /** Backpressure: true stops processing further events this pass. */
  saturated: () => boolean
  /** A build announcement that resolves to no single build. Awaited before
   * the repository stream advances past the announcement. */
  unresolved: (reason: string) => Promise<void>
}

/** Repository attention identities a feed cursor retains (build-scoped ones
 * leave with their build's retirement). */
const FEED_REPOSITORY_IDENTITY_CAP = 256

/**
 * The pre-emission baseline of a brand-new feed: the cursor a resume would
 * start from if the feed had been running since this moment. Reads, in this
 * fixed order — reordering them reopens a gap:
 *
 * 1. repository facts `P0` (open preparations) at cursor `Cf0`;
 * 2. the repository's build digests `D` — the one population read, once per
 *    feed lifetime;
 * 3. the stream seed `S` of every work build in `D`, whose cursor is that
 *    build's position;
 * 4. the journal high-water `J0`, the load boundary (`Cf0 <= J0`, since
 *    values are served at the tail and the journal only grows). Every
 *    existing build's position was sampled before it, so no event appended
 *    to an existing build after the boundary is taken as history;
 * 5. repository attention `A` at cursor `B`, the `#repo` baseline;
 * 6. the journal window `(Cf0, B]`, walked in order so the open-attempt map
 *    is exact before every resolution.
 *
 * Builds resolved `owned` in the window after `J0`, or absent from `D`
 * (created after the population read), form set `R` and start at seq 0;
 * other sampled builds start at their seed; preparations still open at `B`
 * are carried in `preparing` for the journal rule.
 */
async function feedBaselineCursor(context: WatchFeed['context'], feed: WatchFeed): Promise<string> {
  const { store, repo, storeRef } = context
  for (;;) {
    const facts = await readRepositoryFacts(store, repo)
    const cf0 = facts.cursor
    const digests = await readBuildDigests(store, repo)
    const sampled = new Map<string, { cursor: number; merges: string[] }>()
    for (const [slug, digest] of digests) {
      if (!hasWork(digest)) continue
      const seed = await readBuildStreamSeed(store, slug)
      sampled.set(slug, {
        cursor: seed.cursor,
        merges: seed.value.mergeAttentionPrs.map((pr) => mergeIdentity(slug, pr)),
      })
    }
    const j0 = (await store.getRepo(repo)) === null ? 0 : await store.getRepoHighWater(repo)
    if (cf0 > j0) continue
    const attention =
      (await store.getRepo(repo)) === null
        ? { cursor: 0 }
        : await readRepositoryAttention(store, repo)
    const b = attention.cursor
    if (b < j0) continue
    const preparing = new Map<string, PreparingBuild>()
    for (const [attempt, held] of Object.entries(facts.value.preparation))
      if (held.slug !== undefined)
        preparing.set(attempt, {
          slug: held.slug,
          ...(held.creationKey !== undefined ? { creationKey: held.creationKey } : {}),
        })
    const announced = new Set<string>()
    const window = b > cf0 ? await store.getRepoEvents(repo, cf0) : []
    for (const event of window) {
      if (event.seq > b) break
      if (event.type === 'ticket-preparation.creation-selected') {
        preparing.set(event.payload.attempt, {
          slug: event.payload.slug,
          ...(event.payload.creationKey !== undefined
            ? { creationKey: event.payload.creationKey }
            : {}),
        })
      } else if (event.type === 'ticket-preparation.resolved') {
        const entry = preparing.get(event.payload.attempt)
        if (event.payload.outcome === 'owned') {
          const slug =
            entry === undefined ? undefined : await resolveAnnouncedBuild(store, repo, entry)
          if (slug === undefined)
            await feed.unresolved(unresolvedAnnouncement(event.payload.attempt))
          // After the boundary, or created after the population read and so
          // never sampled: replayed from its first event.
          else if (event.seq > j0 || !digests.has(slug)) announced.add(slug)
        }
        preparing.delete(event.payload.attempt)
      }
    }
    const streams: Record<string, number> = { [REPO_STREAM_KEY]: b }
    const deliveredAttention: string[] = []
    for (const [slug, { cursor, merges }] of sampled) {
      if (announced.has(slug)) continue
      streams[slug] = cursor
      deliveredAttention.push(...merges)
    }
    for (const slug of announced) streams[slug] = 0
    return encodeCursor({
      v: 1,
      store: storeRef,
      repo,
      streams,
      lostRuns: [],
      deliveredAttention,
      preparing: Object.fromEntries(preparing),
    })
  }
}

/** A build with work left — the dispatcher's own rule: nonterminal, aborted
 * awaiting cleanup, unreclaimed, an open execution, or a pending integration
 * audit. A feed tracks these; a settled terminal build retires. */
function hasWork(digest: Omit<BuildDigest, 'slug'>): boolean {
  return isWorkDigest(digest) || digest.integrationAuditPending === true
}

function unresolvedAnnouncement(attempt: string): string {
  return `build announced by attempt ${attempt} could not be resolved to one build`
}

/** The canonical slug of an announced build, resolved exactly as preparation
 * recovery does: the selected slug, or the slug a recorded creation key
 * derives — at most two point reads, never a listing. */
async function resolveAnnouncedBuild(
  store: BuildStore,
  repo: string,
  entry: PreparingBuild,
): Promise<string | undefined> {
  const candidates =
    entry.creationKey === undefined
      ? [entry.slug]
      : [entry.slug, creationBuildSlug(repo, entry.slug, entry.creationKey)]
  const found: string[] = []
  for (const slug of candidates) if ((await store.getBuild(slug)) !== null) found.push(slug)
  return found.length === 1 ? found[0] : undefined
}

interface BuildStream {
  kind: 'build'
  slug: string
  named: boolean
  /** The full prefix, appended in seq order — what `reduceBuild` runs over. */
  seed: BuildStreamSeed
  lastSeq: number
  status: BuildStatus
  /** Feed only: events read but not yet processed when backpressure ended a pass. */
  backlog: AbEvent[]
  /** The record read at tracking time, for the feed's one-build retirement read. */
  record?: BuildRecord
}

interface RepositoryStream {
  kind: 'repo'
  lastSeq: number
  backlog: RepositoryEvent[]
}

type Stream = BuildStream | RepositoryStream

/**
 * `ab watch` — stream matching build and repository events until a timeout, a
 * record count, or (only when slugs were named) terminal status ends the
 * watch. Unflagged watches are read-only; --operator adds advisory liveness.
 */
export async function abWatch(opts: AbWatchOpts): Promise<void> {
  const feed = opts.feed
  if (feed !== undefined) {
    if (opts.since === undefined) {
      // First-ever initialization persists its baseline before anything is
      // emitted, then shares the resume path: a crash or failed first
      // delivery regenerates the same records from the same saved cursor.
      const cursor = await feedBaselineCursor(feed.context, feed)
      await feed.baseline?.(cursor)
      return abWatch({ ...opts, since: cursor })
    }
    opts = { ...opts, operator: false, json: true, slugs: [], repository: false, count: undefined }
  }
  const now = opts.now ?? (() => new Date())
  const sleep = opts.delay ?? defaultDelay
  const slugs = [...(opts.slugs ?? [])]
  const repository = opts.repository === true
  const followRepository = repository || slugs.length === 0

  const timeoutMs =
    opts.timeout !== undefined
      ? parseDurationMs(opts.timeout, { flag: '--timeout', usage: WATCH_USAGE, allowZero: true })
      : DEFAULT_TIMEOUT_MS
  const intervalMs =
    opts.interval !== undefined
      ? parseDurationMs(opts.interval, { flag: '--interval', usage: WATCH_USAGE })
      : undefined

  if (
    opts.operator &&
    (slugs.length > 0 ||
      ['AB_BUILD', 'AB_SESSION', 'AB_PHASE', 'AB_ROUND', 'AB_HARVEST', 'AB_REPO'].some((key) =>
        opts.env[key]?.trim(),
      ))
  ) {
    throw new Error(
      `--operator requires a repository-wide watch outside any build or scoped session — ${WATCH_USAGE}`,
    )
  }
  if (opts.count !== undefined && (!Number.isSafeInteger(opts.count) || opts.count <= 0))
    throw new Error(`--count requires a positive integer — ${WATCH_USAGE}`)

  // Ambient scope, before any store access. A feed runs on the dispatcher's
  // own already-scoped store.
  if (feed === undefined) assertReadScope(slugs, { repository: followRepository, env: opts.env })

  // Glob validation needs only the catalogs — before any store access.
  const filters = compileEventGlobs(opts.events ?? [], {
    repository: followRepository,
    additionalCatalog: followRepository ? ['dispatcher.lost'] : [],
    usage: WATCH_USAGE,
  })

  const lifetime = new WatchLifetime(opts.signal, opts.stderr)
  const body = async (context: WatchFeed['context']): Promise<void> => {
    const { store, repo, storeRef, checkout } = context
    const { exec } = opts
    const interval = intervalMs ?? watchSelection(storeRef).intervalMs

    // Decode --since before any read: a foreign cursor is rejected outright.
    const sinceStreams =
      opts.since !== undefined ? decodeCursor(opts.since, { store: storeRef, repo }).streams : {}

    // Verified (AUT-574): this is the full normalized-identity rule of
    // AUT-567 — the same `mine` predicate as status.ts and wait.ts, with
    // buildInRepository's semantics. `identity` is resolveRepoState's
    // `origin ?? resolved checkout`, already normalized (re-normalizing is
    // a no-op); the first arm is the whole test for new records, whose
    // `record.repo` IS the normalized origin, and the second arm forgives
    // legacy path-keyed records via their normalized `repoOrigin`. A
    // foreign origin, or an origin-less legacy record, is excluded.
    const identity = normalizeGitRemoteUrl(repo)
    const mine = (record: BuildRecord): boolean =>
      record.repo === identity ||
      (record.repoOrigin !== undefined && normalizeGitRemoteUrl(record.repoOrigin) === identity)

    const lostRuns = new Set(
      opts.since ? (decodeCursor(opts.since, { store: storeRef, repo }).lostRuns ?? []) : [],
    )
    const resumedCursor = opts.since
      ? decodeCursor(opts.since, { store: storeRef, repo })
      : undefined
    const operator = opts.operator
      ? operatorIdentitySchema.parse({
          id: resumedCursor?.operator?.id ?? (opts.operatorIdentity?.newId ?? randomUUID)(),
          startedAt: resumedCursor?.operator?.startedAt ?? now().toISOString(),
          host: opts.operatorIdentity?.host ?? hostname(),
          pid: opts.operatorIdentity?.pid ?? process.pid,
        })
      : undefined
    const heartbeatStop = new AbortController()
    let heartbeatTask: Promise<void> | undefined
    if (operator) {
      try {
        await lifetime.register(store, repo, operator)
      } catch (error) {
        if (isTerminalEventReadError(error)) throw error
        if (!lifetime.terminated) throw error
      }
      heartbeatTask = (async () => {
        let reported = false
        let nextHeartbeatAt = now().getTime() + OPERATOR_HEARTBEAT_MS
        while (!heartbeatStop.signal.aborted && !lifetime.terminated) {
          await (opts.heartbeatDelay ?? defaultDelay)(
            Math.max(0, nextHeartbeatAt - now().getTime()),
            AbortSignal.any([heartbeatStop.signal, lifetime.writes.signal]),
          )
          if (heartbeatStop.signal.aborted || lifetime.terminated) break
          nextHeartbeatAt = now().getTime() + OPERATOR_HEARTBEAT_MS
          try {
            await lifetime.renew()
            reported = false
          } catch (error) {
            if (isTerminalEventReadError(error)) throw error
            if (!reported && !lifetime.terminated)
              opts.stderr(
                `ab watch: operator heartbeat failed (${String(error)}); retrying at next heartbeat`,
              )
            reported = true
          }
        }
      })()
    }
    try {
      const deliveredAttention = new Set(resumedCursor?.deliveredAttention ?? [])
      let repositoryAttention = new RepositoryAttention()
      let attentionInitialized = false
      const observedOwners = new Map<string, RepositoryRecord>()
      const streams = new Map<string, Stream>()
      // Every stream's position — matching or not, delivered or baselined —
      // lives here, so a resume never rescans or redelivers a filtered event.
      const positions: Record<string, number> = { ...sinceStreams }
      let emitted = 0
      let countCursor: string | undefined
      let stop = false
      // On the remote path this is the shared long-poll runner (the held
      // reads, their cancellation, and the gap sleeps it owns); on the local
      // path it stays undefined and a stop trips the `stop` flag alone.
      let runner: RemotePollRunner | undefined
      const requestStop = (): void => {
        stop = true
        runner?.requestStop()
      }

      // Feed only: selected creations not yet resolved, so an announcement
      // whose selection lies behind a resumed position still resolves.
      const preparing = new Map<string, PreparingBuild>(
        Object.entries(resumedCursor?.preparing ?? {}),
      )
      const encodeCurrent = (): string =>
        encodeCursor({
          v: 1,
          store: storeRef,
          repo,
          streams: { ...positions },
          ...(operator ? { operator: { id: operator.id, startedAt: operator.startedAt } } : {}),
          lostRuns: [...lostRuns],
          deliveredAttention: [...deliveredAttention],
          ...(feed !== undefined ? { preparing: Object.fromEntries(preparing) } : {}),
        })
      /** Feed backpressure: a full consumer queue ends this pass early; the
       * unprocessed events stay in their stream's backlog for the next one. */
      let yieldedLastPass = false
      const halted = (): boolean => {
        if (stop) return true
        if (feed?.saturated() !== true) return false
        yieldedLastPass = true
        return true
      }

      /** One record, flushed the moment it is projected. `cursor` is the watch
       * position AFTER this event. */
      const emit = (event: AbEvent | RepositoryEvent, state: BuildState | null): void => {
        const cursor = encodeCurrent()
        if (feed !== undefined) {
          feed.record({ id: watchRecordId({ event }), ...projectRecord(event, state, cursor) })
        } else if (opts.json === true) {
          opts.stdout(
            JSON.stringify({
              id: watchRecordId({ event }),
              ...projectRecord(event, state, cursor),
            }),
          )
        } else {
          opts.stdout(renderWatchLine(event, state))
        }
        emitted += 1
        if (opts.count !== undefined && emitted >= opts.count) {
          // Events read but not delivered because the count tripped stay
          // unprocessed: the next run resumes from THIS record's cursor.
          countCursor = cursor
          requestStop()
        }
      }

      const emitObservation = (
        observation: MergeDecision | PersistenceObservation | ConsentReady,
        state: BuildState | null,
        scope: { build: string } | { repo: string },
        identity: string,
      ): void => {
        if (stop || deliveredAttention.has(identity)) return
        deliveredAttention.add(identity)
        const cursor = encodeCurrent()
        const record = {
          id: watchRecordId({ observation: observation.type, identity }),
          ...projectAttentionRecord(observation, state, cursor, scope),
        }
        if (feed !== undefined) feed.record(record)
        else
          opts.stdout(
            opts.json
              ? JSON.stringify(record)
              : renderAttentionLine(observation, 'build' in scope ? scope.build : '(repository)'),
          )
        emitted += 1
        if (opts.count !== undefined && emitted >= opts.count) {
          countCursor = cursor
          requestStop()
        }
      }
      const checkConsent = (stream: BuildStream): void => {
        if (filters.length || stop) return
        const currentState = buildReducer.finish(stream.seed.build)
        const rewrite = currentState.targetRewrite
        if (rewrite) {
          const identity = JSON.stringify(['target.rewritten', stream.slug, rewrite.seq])
          if (!deliveredAttention.has(identity)) {
            deliveredAttention.add(identity)
            emit(rewrite, currentState)
            if (stop) return
          }
        }
        const observation = consentReady(stream.seed, now())
        if (observation)
          emitObservation(
            observation,
            buildReducer.finish(stream.seed.build),
            { build: stream.slug },
            consentIdentity(stream.slug, observation.position),
          )
      }
      const checkPersistence = (): void => {
        if (filters.length || !attentionInitialized || stop) return
        for (const { identity, observation } of repositoryAttention.pending(now())) {
          emitObservation(observation, null, { repo }, identity)
          if (stop) return
        }
      }
      const checkMergeDecision = (stream: BuildStream, state: BuildState): void => {
        if (filters.length || stop) return
        const observation = mergeDecisionFromFacts(state, stream.seed.deferral, now())
        if (observation)
          emitObservation(
            observation,
            state,
            { build: stream.slug },
            mergeIdentity(stream.slug, observation.pr.number),
          )
      }
      const baselineMerge = (slug: string, seed: BuildStreamSeed): void => {
        for (const pr of seed.mergeAttentionPrs) deliveredAttention.add(mergeIdentity(slug, pr))
      }

      const checkLiveness = async (): Promise<void> => {
        if (!followRepository || stop) return
        if ((await store.getRepo(repo)) === null) return
        // Sample metadata after the journal. Recheck both immediately before
        // reporting: a failed read is infrastructure, never evidence of death.
        const record = await store.getRepo(repo)
        if (record?.lease) observedOwners.set(record.lease.holder, record)
        let upgrade: Awaited<ReturnType<typeof readDispatchUpgrade>> | undefined
        for (const [id, owner] of observedOwners) {
          if (
            stop ||
            lostRuns.has(id) ||
            !owner.lease ||
            Date.parse(owner.lease.expiresAt) > now().getTime()
          )
            continue
          const current = await store.getRepo(repo)
          if (current?.lease?.holder === id) {
            observedOwners.set(id, current)
            if (Date.parse(current.lease.expiresAt) > now().getTime()) continue
          }
          const facts = (await readDispatcherRunFacts(store, repo, id)).value
          if (facts.stop) {
            observedOwners.delete(id)
            continue
          }
          const evidence = projectDispatcherLiveness(
            current?.lease?.holder === id ? current : owner,
            [facts.start, facts.latestStart, facts.stop, facts.tick, facts.runtime].filter(
              (event): event is RepositoryEvent => event !== undefined,
            ),
            now(),
          )
          // Only a validated takeover proves transfer; intent or release alone
          // must still report a predecessor whose successor never arrives.
          upgrade ??= await readDispatchUpgrade(store, repo)
          if (upgrade.value.runs[id]?.takeover) {
            observedOwners.delete(id)
            continue
          }
          if (!(filters.length ? filters.some((f) => f.test('dispatcher.lost')) : true)) continue
          if (stop) return
          lostRuns.add(id)
          const cursor = encodeCurrent()
          const observation = {
            ...evidence.expiredHolder,
            type: 'dispatcher.lost' as const,
            run: id,
            observedAt: now().toISOString(),
            leaseExpiresAt: (current?.lease?.holder === id ? current : owner).lease!.expiresAt,
          }
          const record = {
            id: watchRecordId({ lost: id }),
            repo,
            build: null,
            state: null,
            observation,
            cursor,
          }
          if (feed !== undefined) feed.record(record)
          else
            opts.stdout(
              opts.json
                ? JSON.stringify(record)
                : `dispatcher.lost ${id} — lease expired ${observation.leaseExpiresAt}`,
            )
          emitted += 1
          if (opts.count !== undefined && emitted >= opts.count) {
            countCursor = cursor
            requestStop()
          }
        }
      }

      /** Record one event. `prefix` is the event prefix ENDING at `event` —
       * the record's state is the reduction after THIS event, never a
       * reduction over events that landed after it. The poll path passes the
       * stream's just-extended array; the resume path replays the backlog
       * into a scratch prefix so a resumed record never leaks state from
       * events that landed after it. */
      const processBuildEvent = (stream: BuildStream, event: AbEvent): void => {
        if (stop) return
        stream.lastSeq = event.seq
        positions[stream.slug] = event.seq
        stream.seed = buildStreamSeedReducer.advance(stream.seed, [event])
        const state = buildReducer.finish(stream.seed.build)
        stream.status = state.status
        if (
          matchesBuildFilter(event.type, filters) ||
          (!filters.length && event.type === 'restack.replayed' && event.payload.conflicted)
        )
          emit(event, state)
        if (event.type === 'target.rewritten')
          deliveredAttention.add(JSON.stringify(['target.rewritten', stream.slug, event.seq]))
        checkConsent(stream)
        checkMergeDecision(stream, state)
      }

      const processRepositoryEvent = (stream: RepositoryStream, event: RepositoryEvent): void => {
        if (stop) return
        stream.lastSeq = event.seq
        positions[REPO_STREAM_KEY] = event.seq
        repositoryAttention.fold(event)
        if (
          filters.length
            ? filters.some((regex) => regex.test(event.type))
            : repositoryNeedsAttention(event)
        )
          emit(event, null)
      }

      /**
       * Register a build stream over the full event prefix. `resumeSeq` (a
       * cursor position) additionally emits every matching event after it —
       * the backlog that landed while no watch was running. A baseline (the
       * default) replays nothing: the position starts at the current maximum.
       */
      const trackBuild = async (slug: string, resumeSeq?: number): Promise<boolean> => {
        if (streams.has(slug)) return true
        const record = await store.getBuild(slug)
        if (record === null) return false
        if (resumeSeq !== undefined && store.getStreamSeed)
          await store.getStreamSeed({ kind: 'build', slug }, resumeSeq)
        const current = await readBuildStreamSeed(store, slug)
        const seed =
          resumeSeq === undefined
            ? current.value
            : await historicalBuildState(store, slug, resumeSeq, current)
        const stream: BuildStream = {
          kind: 'build',
          slug,
          named: slugs.includes(slug),
          seed,
          lastSeq: resumeSeq ?? current.cursor,
          status: buildReducer.finish(current.value.build).status,
          backlog: [],
          record,
        }
        streams.set(slug, stream)
        positions[slug] = stream.lastSeq
        if (resumeSeq === undefined || resumedCursor?.deliveredAttention === undefined)
          baselineMerge(slug, seed)
        if (resumeSeq !== undefined) {
          const backlog = await readBuildRange(store, slug, resumeSeq)
          for (const [index, event] of backlog.entries()) {
            if (halted()) {
              if (!stop) stream.backlog = backlog.slice(index)
              break
            }
            processBuildEvent(stream, event)
          }
        }
        checkConsent(stream)
        // A restart between an event record and its merge-gate observation
        // must not lose the observation; the identity deduplicates it.
        if (feed !== undefined && resumeSeq !== undefined)
          checkMergeDecision(stream, buildReducer.finish(stream.seed.build))
        return true
      }

      /** Builds discovery read in full and found terminal; never re-read. */
      const retired = new Set<string>()

      /**
       * No-slug membership: every nonterminal build of this repository joins
       * the watch, baselined at its current maximum so no history replays. A
       * build discovered while nonterminal stays tracked even after it turns
       * terminal. Cursor-resumed and named streams are never re-baselined.
       *
       * Throws on a failed read — never swallows it: the poll loop's tick
       * catches and reports the failure once on stderr, and the initial scan
       * turns it into the friendly startup error. Streams discovered before
       * the throw stay tracked, so the retry neither duplicates nor skips.
       */
      const discoverBuilds = async (): Promise<void> => {
        const digests = await readBuildDigests(store, repo)
        for (const record of (await store.listBuilds()).filter(mine)) {
          if (streams.has(record.slug) || retired.has(record.slug)) continue
          const digest = digests.get(record.slug)
          if (digest !== undefined && digest.terminal !== undefined) continue
          const current = await readBuildStreamSeed(store, record.slug)
          const status = buildReducer.finish(current.value.build).status
          if (!NONTERMINAL_STATUSES.includes(status)) {
            // Terminal is permanent (reduceBuild never clears it): a legacy
            // record the digest cannot retire is read once, not every pass.
            retired.add(record.slug)
            continue
          }
          const stream: BuildStream = {
            kind: 'build',
            slug: record.slug,
            named: false,
            seed: current.value,
            lastSeq: current.cursor,
            status,
            backlog: [],
          }
          streams.set(record.slug, stream)
          baselineMerge(record.slug, current.value)
          positions[record.slug] = stream.lastSeq
          checkConsent(stream)
          if (stop) break
        }
      }

      /**
       * Feed discovery, run for every repository event before it is
       * processed, so the journal position passes an announcement only once
       * its build is tracked. A build resolved `owned` after this feed's
       * position replays from seq 0 whatever its status now; one announced
       * before it is in the cursor already or was drained and retired.
       * Depends on ticket preparation journaling around every createBuild.
       */
      const announce = async (event: RepositoryEvent): Promise<void> => {
        if (feed === undefined) return
        if (event.type === 'ticket-preparation.creation-selected') {
          preparing.set(event.payload.attempt, {
            slug: event.payload.slug,
            ...(event.payload.creationKey !== undefined
              ? { creationKey: event.payload.creationKey }
              : {}),
          })
          return
        }
        if (event.type !== 'ticket-preparation.resolved') return
        const { attempt } = event.payload
        if (event.payload.outcome === 'owned') {
          const entry = preparing.get(attempt)
          const slug =
            entry === undefined ? undefined : await resolveAnnouncedBuild(store, repo, entry)
          if (slug === undefined) await feed.unresolved(unresolvedAnnouncement(attempt))
          else if (!streams.has(slug) && !retired.has(slug)) {
            if (!(await trackBuild(slug, 0))) await feed.unresolved(unresolvedAnnouncement(attempt))
          }
        }
        preparing.delete(attempt)
      }

      /** The build a build-scoped attention identity belongs to, if any. */
      const identityBuild = (identity: string): string | undefined => {
        if (!identity.startsWith('[')) return undefined
        const value = JSON.parse(identity) as unknown[]
        return value.length === 2 ? String(value[0]) : String(value[1])
      }

      /** Feed only: a terminal build whose execution has settled leaves the
       * cursor, so cursor size and pass cost follow active builds. */
      const retireSettled = async (): Promise<void> => {
        for (const stream of [...streams.values()]) {
          if (stop) return
          if (stream.kind !== 'build' || stream.named || stream.backlog.length > 0) continue
          if (!TERMINAL_STATUSES.includes(stream.status)) continue
          const record = stream.record ?? (await store.getBuild(stream.slug))
          if (record !== null) {
            const digest = (
              await readPersistedBuildDigests(store, repo, [{ ...record, repo }])
            ).get(stream.slug)
            if (digest === undefined || hasWork(digest)) continue
          }
          streams.delete(stream.slug)
          delete positions[stream.slug]
          retired.add(stream.slug)
          for (const identity of [...deliveredAttention])
            if (identityBuild(identity) === stream.slug) deliveredAttention.delete(identity)
        }
        const repositoryIdentities = [...deliveredAttention].filter(
          (identity) => identityBuild(identity) === undefined,
        )
        for (const identity of repositoryIdentities.slice(
          0,
          Math.max(0, repositoryIdentities.length - FEED_REPOSITORY_IDENTITY_CAP),
        ))
          deliveredAttention.delete(identity)
        for (const run of [...lostRuns].slice(
          0,
          Math.max(0, lostRuns.size - FEED_REPOSITORY_IDENTITY_CAP),
        ))
          lostRuns.delete(run)
      }

      const trackRepository = async (): Promise<boolean> => {
        const resumeSeq = sinceStreams[REPO_STREAM_KEY]
        const stream: RepositoryStream = { kind: 'repo', lastSeq: resumeSeq ?? 0, backlog: [] }
        streams.set(REPO_STREAM_KEY, stream)
        positions[REPO_STREAM_KEY] = stream.lastSeq
        try {
          if ((await store.getRepo(repo)) !== null) {
            if (resumeSeq !== undefined && store.getStreamSeed)
              await store.getStreamSeed({ kind: 'repo', repo }, resumeSeq)
            const current = await readRepositoryAttention(store, repo)
            const baseline = resumeSeq ?? current.cursor
            const seed =
              resumeSeq === undefined
                ? current.value
                : await historicalRepositoryAttention(store, repo, resumeSeq, current)
            repositoryAttention = new RepositoryAttention(seed)
            attentionInitialized = true
            stream.lastSeq = baseline
            positions[REPO_STREAM_KEY] = baseline
            if (resumeSeq !== undefined) {
              const backlog = await store.getRepoEvents(repo, baseline)
              for (const [index, event] of backlog.entries()) {
                if (halted()) {
                  if (!stop) stream.backlog = backlog.slice(index)
                  break
                }
                if (feed !== undefined) await announce(event)
                processRepositoryEvent(stream, event)
              }
            }
            if (!stop) checkPersistence()
          } else attentionInitialized = true
          return true
        } catch (error) {
          if (isTerminalEventReadError(error)) throw error
          if (error instanceof ReducerValueIncompatibilityError) throw error
          return false
        }
      }

      const pollBuild = async (
        stream: BuildStream,
        readOpts?: RemotePollReadOpts,
      ): Promise<boolean> => {
        const fresh =
          stream.backlog.length > 0
            ? stream.backlog
            : await readBuildRange(store, stream.slug, stream.lastSeq, readOpts)
        stream.backlog = []
        for (const [index, event] of fresh.entries()) {
          if (halted()) {
            if (!stop) stream.backlog = fresh.slice(index)
            break
          }
          processBuildEvent(stream, event)
          if (stop) break
        }
        if (fresh.length > 0 && !stop) {
          stream.status = buildReducer.finish(stream.seed.build).status
        }
        return true
      }

      let repositoryQueue = Promise.resolve()
      let repositoryInitialization: Promise<void> | undefined
      const pollRepository = async (
        stream: RepositoryStream,
        readOpts?: RemotePollReadOpts,
      ): Promise<boolean> => {
        // A repository row may be created mid-watch by the first dispatch.
        if ((await store.getRepo(repo)) === null) return true
        if (!attentionInitialized) {
          repositoryInitialization ??= (async () => {
            const resumeSeq = sinceStreams[REPO_STREAM_KEY]
            if (resumeSeq !== undefined && store.getStreamSeed)
              await store.getStreamSeed({ kind: 'repo', repo }, resumeSeq)
            const current = await readRepositoryAttention(store, repo)
            const baseline = resumeSeq ?? current.cursor
            const seed =
              resumeSeq === undefined
                ? current.value
                : await historicalRepositoryAttention(store, repo, resumeSeq, current)
            repositoryAttention = new RepositoryAttention(seed)
            stream.lastSeq = baseline
            positions[REPO_STREAM_KEY] = baseline
            attentionInitialized = true
          })()
          try {
            await repositoryInitialization
          } catch (error) {
            if (isTerminalEventReadError(error)) throw error
            repositoryInitialization = undefined
            throw error
          }
        }
        const fresh =
          stream.backlog.length > 0
            ? stream.backlog
            : await store.getRepoEvents(repo, stream.lastSeq, readOpts)
        stream.backlog = []
        const apply = repositoryQueue.then(async () => {
          for (const [index, event] of fresh.entries()) {
            if (halted()) {
              if (!stop) stream.backlog = fresh.slice(index)
              break
            }
            if (event.seq <= stream.lastSeq) continue
            if (feed !== undefined) await announce(event)
            processRepositoryEvent(stream, event)
          }
          if (!stop) checkPersistence()
        })
        repositoryQueue = apply.catch(() => {})
        await apply
        return true
      }

      const namedAllTerminal = (): boolean => {
        if (slugs.length === 0) return false
        for (const slug of slugs) {
          const stream = streams.get(slug)
          if (stream === undefined || stream.kind !== 'build') return false
          if (!TERMINAL_STATUSES.includes(stream.status)) return false
        }
        return true
      }

      // One streak for the whole local loop — the same lifetime the shared
      // reported flag had before per-source streaks: a persistent read
      // failure is reported once, and a fully-successful cycle re-arms it.
      const tickStreak = makeFailureStreak('watch', opts.stderr)

      const tick = async (): Promise<boolean> => {
        let allReadsOk = true
        if (slugs.length === 0 && feed === undefined) {
          try {
            await discoverBuilds()
          } catch (error) {
            if (isTerminalEventReadError(error)) throw error
            allReadsOk = false
            tickStreak.onFailure(error)
          }
        }
        for (const stream of [...streams.values()]) {
          if (stop) return allReadsOk
          if (feed !== undefined && halted()) break
          try {
            if (stream.kind === 'build') await pollBuild(stream)
            else await pollRepository(stream)
          } catch (error) {
            if (isTerminalEventReadError(error)) throw error
            allReadsOk = false
            tickStreak.onFailure(error)
          }
        }
        if (feed !== undefined && allReadsOk) {
          try {
            await retireSettled()
          } catch (error) {
            if (isTerminalEventReadError(error)) throw error
            allReadsOk = false
            tickStreak.onFailure(error)
          }
        }
        if (allReadsOk) {
          try {
            await checkLiveness()
            tickStreak.onSuccess()
          } catch (error) {
            if (isTerminalEventReadError(error)) throw error
            allReadsOk = false
            tickStreak.onFailure(error)
          }
        }
        return allReadsOk
      }

      // ── Initial scan ──
      // Named slugs are validated (and must belong to this repository) before
      // any record is emitted: an unknown slug is an error, full stop.
      for (const slug of slugs) {
        const record = await store.getBuild(slug)
        if (record === null) {
          throw new Error(
            `no build "${slug}" in this store — run 'ab builds --all' to list ` +
              "this repo's builds, or pass --store <ref> if it lives in another store",
          )
        }
        if (!(await buildInRepository(record, checkout, exec))) {
          throw new Error(`build "${slug}" belongs to repository "${record.repo}", not "${repo}"`)
        }
      }
      for (const slug of slugs) await trackBuild(slug, sinceStreams[slug])
      // Cursor streams that are no longer named resume anyway: finishing
      // their backlog is what makes a resumed watch lossless.
      // A feed retries a failed read on the next pass even when nothing
      // moved the change position.
      let retryFull = false
      for (const key of Object.keys(sinceStreams)) {
        if (key === REPO_STREAM_KEY) continue
        if (!(await trackBuild(key, sinceStreams[key])) && feed !== undefined) delete positions[key]
        if (stop) break
      }
      if (followRepository) {
        if (!(await trackRepository())) {
          retryFull = true
          makeFailureStreak('watch', opts.stderr).onFailure(
            new Error(`could not read the repository journal for "${repo}"`),
          )
        }
      }
      if (!repository && slugs.length === 0 && feed === undefined) {
        // Membership discovery also baselines the default watch; a failed
        // discovery here is fatal — nothing has started yet.
        try {
          await discoverBuilds()
        } catch (error) {
          if (isTerminalEventReadError(error)) throw error
          const message = error instanceof Error ? error.message : String(error)
          throw new Error(`could not list builds in this store (${message})`)
        }
      }

      if (followRepository && !stop) {
        try {
          await checkLiveness()
        } catch (error) {
          if (isTerminalEventReadError(error)) throw error
          tickStreak.onFailure(error)
        }
      }
      // ── The poll loop ──
      const deadline = timeoutMs === 0 ? Number.POSITIVE_INFINITY : now().getTime() + timeoutMs
      const aborted = (): boolean => opts.signal?.aborted === true

      if (feed !== undefined) {
        // Feed cadence: a full pass only when the shared change gate moved,
        // the last pass yielded to backpressure, or a read failed; otherwise
        // only the in-memory repository timers run. Zero reads while idle.
        if (!stop) feed.position?.(encodeCurrent())
        while (!stop) {
          if (aborted() || now().getTime() >= deadline) break
          await sleep(interval, opts.signal)
          if (aborted()) break
          const full = yieldedLastPass || retryFull || (await feed.changed())
          yieldedLastPass = false
          retryFull = false
          if (full) retryFull = !(await tick())
          else checkPersistence()
          if (!stop) feed.position?.(encodeCurrent())
        }
      } else if (!isRemoteStoreRef(storeRef)) {
        // Local cadence: one sequential tick per interval.
        while (!stop) {
          if (aborted() || now().getTime() >= deadline || namedAllTerminal()) break
          await sleep(interval, opts.signal)
          if (aborted()) break
          await tick()
        }
      } else {
        // Remote cadence (AUT-334): one long-poll task per tracked stream,
        // running concurrently — a quiet stream keeps one held request in
        // flight, so an appended event arrives within about a second instead
        // of at the next interval tick. Gap-fill spaces each stream's request
        // starts at least `interval` apart (elapsed request time counts
        // toward the gap), so a server that answers immediately still sees
        // today's request rate. Discovery keeps its interval cadence.
        // Pre-launch guard mirrors the local loop's top-of-cycle checks: an
        // already-terminal named set, an elapsed deadline, or an abort ends
        // the watch before any request.
        // Every stop is prompt: an external abort, a tripped --count, an
        // all-terminal named set, or an elapsed --timeout cancels the
        // in-flight held reads (via `requestStop`) and wakes the gap sleeps
        // (via the runner's stop controller) instead of waiting out a full
        // hold. The held read's own bound is additionally capped at the
        // watch's remaining time budget, so a hold can never outlive the
        // deadline.
        const shouldStop = stop || aborted() || now().getTime() >= deadline || namedAllTerminal()
        const remoteRunner = createRemotePollRunner({
          command: 'watch',
          stderr: opts.stderr,
          now,
          sleep,
          intervalMs: interval,
          deadlineMs: deadline,
          aborted,
          shouldStop: () => aborted() || now().getTime() >= deadline || namedAllTerminal(),
          // A task's terminal endCheck stops the runner from the inside; the
          // command's `stop` flag must trip with it — pollBuild and
          // pollRepository gate their batch loops on that flag
          // (`if (stop) break`), so a sibling task whose held read has
          // already resolved stops delivering its batch instead of draining
          // it, exactly as the pre-extraction command-scoped `requestStop`
          // (which set `stop` on every path) made it do (f_42263f38).
          onStop: (): void => {
            stop = true
          },
          // Quiesce, not the runner's one-shot snapshot: a stream the
          // discovery task registers while drain is awaiting must have its
          // first held read awaited before the final cursor is encoded, or a
          // mid-discovery registration's emission lands after the cursor and
          // the next run replays it (the gap widened from a scheduling race
          // to a deterministic miss when discovery's digest read added one
          // await before the per-build reads — AUT-545). The snapshot
          // semantics the runner documents remain covered by its own tests.
          drain: 'quiesce',
        })
        runner = remoteRunner

        const launch = (stream: Stream): void => {
          const key = stream.kind === 'build' ? stream.slug : REPO_STREAM_KEY
          remoteRunner.launch(
            key,
            (readOpts) =>
              stream.kind === 'build'
                ? pollBuild(stream, readOpts)
                : pollRepository(stream, readOpts),
            () => namedAllTerminal(),
          )
        }

        // An external abort (SIGINT) is a stop like any other: it cancels
        // the in-flight held reads and wakes the gap sleeps.
        opts.signal?.addEventListener('abort', requestStop, { once: true })

        for (const stream of streams.values()) if (!shouldStop) launch(stream)

        if ((slugs.length === 0 || followRepository) && !shouldStop) {
          void remoteRunner.runDiscovery({
            step: async (): Promise<void> => {
              if (slugs.length === 0) await discoverBuilds()
              const repositoryStream = streams.get(REPO_STREAM_KEY)
              if (repositoryStream?.kind === 'repo' && !stop) await pollRepository(repositoryStream)
              await checkLiveness()
            },
            // Unconditional, after the catch — exactly where the inline
            // launch loop ran: streams registered before a mid-discovery
            // throw still get tasks whose polls then run independently.
            launchPending: (): void => {
              for (const stream of streams.values()) launch(stream)
            },
          })
        }

        await remoteRunner.drain()
        opts.signal?.removeEventListener('abort', requestStop)
      }

      const finalCursor = countCursor ?? encodeCurrent()
      // SIGTERM/HUP previously used the process default and could not emit a
      // final cursor. SIGINT retains its existing orderly cursor output.
      const outputClosed =
        opts.signal?.aborted && ['SIGTERM', 'SIGHUP', 'EPIPE'].includes(String(opts.signal.reason))
      if (opts.json === true && !outputClosed && feed === undefined) {
        opts.stdout(JSON.stringify({ cursor: finalCursor }))
      }
      await opts.flushStdout?.()
    } finally {
      heartbeatStop.abort()
      await lifetime.limit(heartbeatTask ?? Promise.resolve())
      if (operator && !lifetime.terminated) {
        try {
          await lifetime.renew()
        } catch (error) {
          if (!lifetime.terminated)
            opts.stderr(`ab watch: final operator heartbeat failed (${String(error)})`)
        }
      }
      await lifetime.finish()
    }
  }
  if (feed !== undefined) {
    try {
      await body(feed.context)
    } finally {
      await lifetime.finish()
      lifetime.close()
    }
    return
  }
  await withAmbientReadStore(
    {
      closeDeadline: lifetime.deadline.signal,
      targetRepo: opts.targetRepo,
      env: opts.env,
      exec: opts.exec,
      ...(opts.storeRef !== undefined ? { storeRef: opts.storeRef } : {}),
      ...(opts.openStore !== undefined ? { openStore: opts.openStore } : {}),
    },
    lifetime.limitCallback((context: OpenedStoreContext) => body(context)),
  ).finally(async () => {
    await lifetime.finish()
    lifetime.close()
  })
}
