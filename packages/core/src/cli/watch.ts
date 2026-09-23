/**
 * `ab watch` — the sessionless, read-only streaming half of the status family
 * (§8.2, §7.2). It follows the event logs of one, several, or all active
 * builds in the repository — optionally the repository journal — and emits one
 * record per matching event as it lands, each carrying the full durable
 * envelope, the build's reduced state after that event, and an opaque cursor
 * so a later `--since` invocation resumes exactly where this one stopped.
 *
 * Like `ab builds` / `ab build status`, the projection is pure and the IO is a
 * thin shell. The command composes the existing read surface — `listBuilds`,
 * `getEvents(since)`, `getRepoEvents(since)`, `getBuild` — and never widens
 * `BuildStore`: no event is appended, no lease claimed, no record created. It
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
import { EVENT_TYPES, type EventType } from '../events/payloads'
import {
  REPOSITORY_EVENT_TYPES,
  type RepositoryEvent,
  type RepositoryEventType,
} from '../events/repository'
import type { BuildState, PrLifecycle } from '../kernel/reducer'
import { reduceBuild } from '../kernel/reducer'
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
import { withAmbientReadStore, type StoreOpener } from './store-opening'

export const WATCH_USAGE =
  'usage: ab watch [<slug>...] [--repository] [--event <glob>]... [--since <cursor>] ' +
  '[--timeout <duration>] [--interval <duration>] [--count <n>] [--json] [--store <ref>]'

/** Default poll cadence and watch horizon. */
export const DEFAULT_REMOTE_INTERVAL_MS = 5_000
export const DEFAULT_LOCAL_INTERVAL_MS = 1_000
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

/** The repository-journal stream's key in the cursor's per-stream map. */
const REPO_STREAM_KEY = '#repo'

/** Statuses a build can still leave; the others are terminal (§15.5). */
const NONTERMINAL_STATUSES: readonly BuildStatus[] = ['queued', 'running', 'paused', 'blocked']
const TERMINAL_STATUSES: readonly BuildStatus[] = ['done', 'aborted']

// ── The default filter: the attention set ────────────────────────────────────

/**
 * The build events an operator or agent must wake up for. With no `--event`,
 * a watch emits exactly these — deciding what to do about a blocker or a
 * merge stays with the caller's skill.
 */
export const BUILD_ATTENTION_EVENTS = [
  'escalation.raised',
  'phase.failed',
  'infrastructure.failed',
  'runner.setup-failed',
  'dispatch.failed',
  'publication.lost',
  'finalize.completed',
  'pr.conflicted',
  'pr.merged',
  'pr.closed',
  'build.completed',
  'build.aborted',
] as const satisfies readonly EventType[]

/** The repository-journal attention set, followed only under `--repository`. */
export const REPOSITORY_ATTENTION_EVENTS = [
  'harvest.escalated',
  'harvest.failed',
  'dispatcher.tick-failed',
  'dispatcher.config-rejected',
  'dispatcher.harvest-runner-failed',
] as const satisfies readonly RepositoryEventType[]

// ── Glob compilation and matching ────────────────────────────────────────────

/**
 * Compile `--event` globs to anchored matchers: `*` matches any run of
 * characters, `?` exactly one, everything else verbatim (so the dots inside
 * event type names are escaped). Each glob must match at least one type in
 * the build catalog — or, when `--repository` is given, in the repository
 * catalog — otherwise a usage error naming the glob is thrown before any
 * store read. Supplying any glob replaces the attention set entirely.
 */
export function compileEventGlobs(
  globs: readonly string[],
  opts: { repository: boolean; usage: string },
): RegExp[] {
  return globs.map((glob) => {
    const source =
      '^' +
      [...glob]
        .map((char) => {
          if (char === '*') return '.*'
          if (char === '?') return '.'
          return char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        })
        .join('') +
      '$'
    const regex = new RegExp(source)
    const inBuildCatalog = EVENT_TYPES.some((type) => regex.test(type))
    const inRepositoryCatalog =
      opts.repository && REPOSITORY_EVENT_TYPES.some((type) => regex.test(type))
    if (!inBuildCatalog && !inRepositoryCatalog) {
      throw new Error(
        `--event "${glob}" matches no known event type${
          opts.repository ? ' in the build or repository catalogs' : ' in the build event catalog'
        } — ${opts.usage}`,
      )
    }
    return regex
  })
}

function matchesBuildFilter(type: EventType, filters: readonly RegExp[]): boolean {
  return filters.length > 0
    ? filters.some((regex) => regex.test(type))
    : (BUILD_ATTENTION_EVENTS as readonly string[]).includes(type)
}

function matchesRepositoryFilter(type: RepositoryEventType, filters: readonly RegExp[]): boolean {
  return filters.length > 0
    ? filters.some((regex) => regex.test(type))
    : (REPOSITORY_ATTENTION_EVENTS as readonly string[]).includes(type)
}

// ── The cursor ───────────────────────────────────────────────────────────────

interface CursorPayload {
  v: 1
  /** The resolved store reference this cursor's positions belong to. */
  store: string
  /** The repository identity (normalized origin or checkout path). */
  repo: string
  /** Per-stream watch position: build slug → seq, `#repo` → seq. */
  streams: Record<string, number>
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
  const { v, store, repo, streams } = payload as Record<string, unknown>
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
  return { v: 1, store, repo, streams: streams as Record<string, number> }
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
  round: number
  openEscalations: { id: string; question: string }[]
  pr: { number: number; url: string; headSha: string } | null
  prState: PrLifecycle | null
  outcome: BuildOutcome | null
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
  return {
    status: state.status,
    phase: state.phase ?? null,
    round: state.round,
    openEscalations: state.openEscalations.map((escalation) => ({
      id: escalation.id,
      question: escalation.question,
    })),
    pr: state.pr ?? null,
    prState: state.prState ?? null,
    outcome: state.outcome ?? null,
  }
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
    case 'escalation.raised':
      return `${event.payload.id}: ${singleLine(event.payload.question)}`
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
    case 'dispatcher.tick-failed':
      return `dispatcher tick failed: ${singleLine(event.payload.error)}`
    case 'dispatcher.config-rejected':
      return `dispatcher config rejected: ${singleLine(event.payload.error)}`
    case 'dispatcher.harvest-runner-failed':
      return `harvest runner failed: ${singleLine(event.payload.error)}`
    default: {
      const compact = singleLine(JSON.stringify(event.payload))
      return compact.length > SUMMARY_MAX ? `${compact.slice(0, SUMMARY_MAX - 1)}…` : compact
    }
  }
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
  targetRepo: string
  /** Raw process environment: --store > AB_STORE > repository default (D8). */
  env: Record<string, string | undefined>
  exec: Exec
  stdout: (line: string) => void
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
  /** Stop signal; the generic sessionless SIGINT handler aborts it. */
  signal?: AbortSignal
}

interface BuildStream {
  kind: 'build'
  slug: string
  named: boolean
  /** The full prefix, appended in seq order — what `reduceBuild` runs over. */
  events: AbEvent[]
  lastSeq: number
  status: BuildStatus
}

interface RepositoryStream {
  kind: 'repo'
  lastSeq: number
}

type Stream = BuildStream | RepositoryStream

/**
 * `ab watch` — stream matching build and repository events until a timeout, a
 * record count, or (only when slugs were named) terminal status ends the
 * watch. Read-only: it appends no event, takes no lease, and creates no
 * record.
 */
export async function abWatch(opts: AbWatchOpts): Promise<void> {
  const now = opts.now ?? (() => new Date())
  const sleep = opts.delay ?? defaultDelay
  const slugs = [...(opts.slugs ?? [])]
  const repository = opts.repository === true

  const timeoutMs =
    opts.timeout !== undefined
      ? parseDurationMs(opts.timeout, { flag: '--timeout', usage: WATCH_USAGE, allowZero: true })
      : DEFAULT_TIMEOUT_MS
  const intervalMs =
    opts.interval !== undefined
      ? parseDurationMs(opts.interval, { flag: '--interval', usage: WATCH_USAGE })
      : undefined

  // Ambient scope, before any store access.
  assertReadScope(slugs, { repository, env: opts.env })

  // Glob validation needs only the catalogs — before any store access.
  const filters = compileEventGlobs(opts.events ?? [], { repository, usage: WATCH_USAGE })

  await withAmbientReadStore(
    {
      targetRepo: opts.targetRepo,
      env: opts.env,
      exec: opts.exec,
      ...(opts.storeRef !== undefined ? { storeRef: opts.storeRef } : {}),
      ...(opts.openStore !== undefined ? { openStore: opts.openStore } : {}),
    },
    async (context) => {
      const { store, repo, storeRef, checkout } = context
      const { exec } = opts
      const interval = intervalMs ?? watchSelection(storeRef).intervalMs

      // Decode --since before any read: a foreign cursor is rejected outright.
      const sinceStreams =
        opts.since !== undefined ? decodeCursor(opts.since, { store: storeRef, repo }).streams : {}

      const identity = normalizeGitRemoteUrl(repo)
      const mine = (record: BuildRecord): boolean =>
        record.repo === identity ||
        (record.repoOrigin !== undefined && normalizeGitRemoteUrl(record.repoOrigin) === identity)

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

      const encodeCurrent = (): string =>
        encodeCursor({ v: 1, store: storeRef, repo, streams: { ...positions } })

      /** One record, flushed the moment it is projected. `cursor` is the watch
       * position AFTER this event. */
      const emit = (event: AbEvent | RepositoryEvent, state: BuildState | null): void => {
        const cursor = encodeCurrent()
        if (opts.json === true) {
          opts.stdout(JSON.stringify(projectRecord(event, state, cursor)))
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

      /** Record one event. `prefix` is the event prefix ENDING at `event` —
       * the record's state is the reduction after THIS event, never a
       * reduction over events that landed after it. The poll path passes the
       * stream's just-extended array; the resume path replays the backlog
       * into a scratch prefix so a resumed record never leaks state from
       * events that landed after it. */
      const processBuildEvent = (stream: BuildStream, event: AbEvent, prefix: AbEvent[]): void => {
        stream.lastSeq = event.seq
        positions[stream.slug] = event.seq
        if (!matchesBuildFilter(event.type, filters)) return
        emit(event, reduceBuild(prefix))
      }

      const processRepositoryEvent = (stream: RepositoryStream, event: RepositoryEvent): void => {
        stream.lastSeq = event.seq
        positions[REPO_STREAM_KEY] = event.seq
        if (!matchesRepositoryFilter(event.type, filters)) return
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
        const events = await store.getEvents(slug)
        const stream: BuildStream = {
          kind: 'build',
          slug,
          named: slugs.includes(slug),
          events,
          lastSeq: events.at(-1)?.seq ?? 0,
          status: reduceBuild(events).status,
        }
        streams.set(slug, stream)
        positions[slug] = stream.lastSeq
        if (resumeSeq === undefined) return true
        stream.lastSeq = resumeSeq
        // Replay the backlog into a scratch prefix: each record's state is
        // the reduction of the prefix ENDING at that event, never the
        // reduction of the full loaded prefix, which would leak state from
        // events that landed after the one being recorded.
        const replay: AbEvent[] = events.filter((event) => event.seq <= resumeSeq)
        for (const event of events) {
          if (event.seq <= resumeSeq) continue
          replay.push(event)
          processBuildEvent(stream, event, replay)
          if (stop) break
        }
        return true
      }

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
        for (const record of (await store.listBuilds()).filter(mine)) {
          if (streams.has(record.slug)) continue
          const events = await store.getEvents(record.slug)
          const status = reduceBuild(events).status
          if (!NONTERMINAL_STATUSES.includes(status)) continue
          const stream: BuildStream = {
            kind: 'build',
            slug: record.slug,
            named: false,
            events,
            lastSeq: events.at(-1)?.seq ?? 0,
            status,
          }
          streams.set(record.slug, stream)
          positions[record.slug] = stream.lastSeq
        }
      }

      const trackRepository = async (): Promise<boolean> => {
        const resumeSeq = sinceStreams[REPO_STREAM_KEY]
        const stream: RepositoryStream = { kind: 'repo', lastSeq: resumeSeq ?? 0 }
        streams.set(REPO_STREAM_KEY, stream)
        positions[REPO_STREAM_KEY] = stream.lastSeq
        try {
          // A fresh store has no repository row; do not create one.
          if (resumeSeq === undefined && (await store.getRepo(repo)) !== null) {
            const events = await store.getRepoEvents(repo)
            stream.lastSeq = events.at(-1)?.seq ?? 0
            positions[REPO_STREAM_KEY] = stream.lastSeq
          }
          return true
        } catch {
          return false
        }
      }

      const pollBuild = async (
        stream: BuildStream,
        readOpts?: RemotePollReadOpts,
      ): Promise<boolean> => {
        const fresh = await store.getEvents(stream.slug, stream.lastSeq, readOpts)
        for (const event of fresh) {
          stream.events.push(event)
          processBuildEvent(stream, event, stream.events)
          if (stop) break
        }
        if (fresh.length > 0 && !stop) {
          stream.status = reduceBuild(stream.events).status
        }
        return true
      }

      const pollRepository = async (
        stream: RepositoryStream,
        readOpts?: RemotePollReadOpts,
      ): Promise<boolean> => {
        // A repository row may be created mid-watch by the first dispatch.
        if ((await store.getRepo(repo)) === null) return true
        const fresh = await store.getRepoEvents(repo, stream.lastSeq, readOpts)
        for (const event of fresh) {
          processRepositoryEvent(stream, event)
          if (stop) break
        }
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

      const tick = async (): Promise<void> => {
        let allReadsOk = true
        if (slugs.length === 0) {
          try {
            await discoverBuilds()
          } catch (error) {
            allReadsOk = false
            tickStreak.onFailure(error)
          }
        }
        for (const stream of [...streams.values()]) {
          if (stop) return
          try {
            if (stream.kind === 'build') await pollBuild(stream)
            else await pollRepository(stream)
          } catch (error) {
            allReadsOk = false
            tickStreak.onFailure(error)
          }
        }
        if (allReadsOk) tickStreak.onSuccess()
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
      for (const key of Object.keys(sinceStreams)) {
        if (key === REPO_STREAM_KEY) continue
        await trackBuild(key, sinceStreams[key])
        if (stop) break
      }
      if (repository) {
        if (!(await trackRepository())) {
          makeFailureStreak('watch', opts.stderr).onFailure(
            new Error(`could not read the repository journal for "${repo}"`),
          )
        }
      } else if (slugs.length === 0) {
        // Membership discovery also baselines the default watch; a failed
        // discovery here is fatal — nothing has started yet.
        try {
          await discoverBuilds()
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          throw new Error(`could not list builds in this store (${message})`)
        }
      }

      // ── The poll loop ──
      const deadline = timeoutMs === 0 ? Number.POSITIVE_INFINITY : now().getTime() + timeoutMs
      const aborted = (): boolean => opts.signal?.aborted === true

      if (!isRemoteStoreRef(storeRef)) {
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
          drain: 'snapshot',
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

        if (slugs.length === 0 && !shouldStop) {
          void remoteRunner.runDiscovery({
            step: async (): Promise<void> => {
              await discoverBuilds()
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
      if (opts.json === true) {
        opts.stdout(JSON.stringify({ cursor: finalCursor }))
      }
    },
  )
}
