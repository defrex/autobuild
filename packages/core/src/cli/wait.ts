/**
 * `ab wait` — the blocking sibling of `ab watch` (§8.2, §7.2). It follows the
 * event logs of one, several, or all active builds in the repository and
 * blocks until a targeted build satisfies a condition, then prints exactly one
 * record — the `ab watch` record plus a `condition` field — and exits with a
 * code that tells the caller what happened: 0 satisfied, 2 named builds all
 * terminal unsatisfied, 3 timeout, 4 interrupted. Distinct exit codes let a
 * wake-up be self-describing without parsing prose.
 *
 * The command shares `ab watch`'s machinery — target selection, ambient
 * scoping (via the extracted `assertReadScope`), the cursor codec, the record
 * projection, the cadence, and the read-failure policy — but ends on the
 * first satisfied condition instead of streaming. Conditions are derived from
 * the same reducer that produces `ab build status` (`status`, `prState`,
 * `phase`), so "blocked" means an open escalation exactly as it does
 * everywhere else; no new projection is defined. In the manner of `kubectl
 * wait`, a state condition that already holds when the command starts returns
 * immediately with the build's latest event.
 *
 * Cadence follows the store kind, exactly as `ab watch` does since AUT-334
 * (verified and corrected for `ab wait` in AUT-368). Against a local store
 * the loop is the sequential interval tick. Against an `http(s)` store every
 * tracked build long-polls instead: one held `getEvents` request per stream
 * is in flight (tasks run concurrently), `--interval` is the floor between
 * request starts (elapsed request time counts toward the gap), and a hold's
 * window is the remote default (25 s, whole seconds, under the store's
 * ceiling) capped at the remaining `--timeout` budget. Every stop — a
 * satisfied condition, an all-terminal named set, the timeout, an interrupt —
 * cancels the in-flight holds promptly instead of waiting out a full window.
 *
 * Read-only: it appends no event, claims or renews no lease, and creates no
 * build or repository record. Output carries no ANSI, ever, in either form.
 */
import type { AbEvent } from '../events/catalog'
import type { EventType } from '../events/payloads'
import type { BuildState, PrLifecycle } from '../kernel/reducer'
import { reduceBuild } from '../kernel/reducer'
import { isPhase, type BuildStatus, type Phase } from '../ontology'
import type { Exec } from '../ports/workspace/git-worktree'
import {
  createRemotePollRunner,
  defaultDelay,
  makeFailureStreak,
  type RemotePollReadOpts,
} from './remote-poll'
import { buildInRepository, isRemoteStoreRef, normalizeGitRemoteUrl } from './repo-state'
import type { BuildRecord } from '../store/types'
import { withAmbientReadStore, type StoreOpener } from './store-opening'
import {
  assertReadScope,
  BUILD_ATTENTION_EVENTS,
  compileEventGlobs,
  decodeCursor,
  encodeCursor,
  parseDurationMs,
  projectRecord,
  renderWatchLine,
  watchSelection,
} from './watch'

export const WAIT_USAGE =
  'usage: ab wait [<slug>...] (--for <condition> | --event <glob>)... [--since <cursor>] ' +
  '[--timeout <duration>] [--interval <duration>] [--json] [--store <ref>]'

/** Default poll cadence and wait horizon — identical to `ab watch`. */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

const NONTERMINAL_STATUSES: readonly BuildStatus[] = ['queued', 'running', 'paused', 'blocked']
const TERMINAL_STATUSES: readonly BuildStatus[] = ['done', 'aborted']

/** The `--for` condition vocabulary, in the order the help documents it. */
const CONDITION_VOCABULARY =
  'blocked, paused, running, done, aborted, terminal, pr=open, pr=merged, pr=closed, ' +
  'pr=conflicted, phase=<phase> (a core phase or verify:<step>), attention'

// ── Conditions ───────────────────────────────────────────────────────────────

type ConditionBody =
  | { kind: 'status'; status: BuildStatus }
  | { kind: 'terminal' }
  | { kind: 'pr'; prState: PrLifecycle }
  | { kind: 'phase'; phase: Phase }
  | { kind: 'attention' }

interface WaitCondition {
  /** The original `--for` value — what a matching record's `condition` names. */
  text: string
  cond: ConditionBody
}

export interface EventGlob {
  regex: RegExp
  /** The original `--event` glob — what a matching record's `condition` names. */
  text: string
}

function isAttentionEvent(type: EventType): boolean {
  return (BUILD_ATTENTION_EVENTS as readonly string[]).includes(type)
}

/**
 * Parse and validate `--for` values and `--event` globs into the closed
 * discriminated union — before any store access. `phase=<p>` validity is
 * `isPhase`: the core phases plus the open `verify:<step>` form (steps are
 * config-defined, so no catalog check). An unknown value, or an empty
 * `phase=`, is a usage error naming the value, the full vocabulary, and the
 * usage line.
 */
export function parseConditions(
  forValues: readonly string[],
  eventGlobs: readonly string[],
): { conditions: WaitCondition[]; globs: EventGlob[] } {
  const unknown = (value: string): Error =>
    new Error(
      `unknown --for condition "${value}" — the condition vocabulary is: ${CONDITION_VOCABULARY}` +
        ` — ${WAIT_USAGE}`,
    )
  const conditions = forValues.map((value): WaitCondition => {
    if (value === 'terminal') return { text: value, cond: { kind: 'terminal' } }
    if (value === 'attention') return { text: value, cond: { kind: 'attention' } }
    if (value.startsWith('pr=')) {
      const prState = value.slice('pr='.length)
      if (
        prState === 'open' ||
        prState === 'merged' ||
        prState === 'closed' ||
        prState === 'conflicted'
      ) {
        return { text: value, cond: { kind: 'pr', prState } }
      }
      throw unknown(value)
    }
    if (value.startsWith('phase=')) {
      const phase = value.slice('phase='.length)
      if (isPhase(phase)) return { text: value, cond: { kind: 'phase', phase } }
      throw unknown(value)
    }
    const status = value as BuildStatus
    if (
      status === 'blocked' ||
      status === 'paused' ||
      status === 'running' ||
      status === 'done' ||
      status === 'aborted'
    ) {
      return { text: value, cond: { kind: 'status', status } }
    }
    throw unknown(value)
  })
  // Glob validation needs only the event catalog — before any store access.
  const regexes = compileEventGlobs(eventGlobs, { repository: false, usage: WAIT_USAGE })
  const globs = regexes.map((regex, index) => ({ regex, text: eventGlobs[index]! }))
  return { conditions, globs }
}

/** Does one condition body hold over a reduction? Attention is event-only. */
function stateSatisfies(cond: ConditionBody, state: BuildState): boolean {
  switch (cond.kind) {
    case 'status':
      return state.status === cond.status
    case 'terminal':
      return TERMINAL_STATUSES.includes(state.status)
    case 'pr':
      return state.prState === cond.prState
    case 'phase':
      return (state.phase ?? null) === cond.phase
    case 'attention':
      return false
  }
}

/**
 * The first state-satisfying `--for` value in supply order, or null. Used for
 * the start-of-command and start-of-registration checks — never during a
 * backlog replay, where only event conditions may fire.
 */
export function matchState(conditions: readonly WaitCondition[], state: BuildState): string | null {
  for (const { text, cond } of conditions) {
    if (stateSatisfies(cond, state)) return text
  }
  return null
}

/** The first event-satisfying condition: attention per supply order, then
 * globs in supply order. Used on a cursor-resumed backlog, where state
 * conditions must not fire. */
export function matchEvent(
  event: Pick<AbEvent, 'type'>,
  conditions: readonly WaitCondition[],
  globs: readonly EventGlob[],
): string | null {
  for (const { text, cond } of conditions) {
    if (cond.kind === 'attention' && isAttentionEvent(event.type)) return text
  }
  for (const { regex, text } of globs) {
    if (regex.test(event.type)) return text
  }
  return null
}

/**
 * One event and the reduction after it: all `--for` values in supply order —
 * each checked against the state first and the event's attention membership
 * second — then all `--event` globs in supply order. The matched condition's
 * original string becomes the record's `condition` field.
 */
function matchFirst(
  event: Pick<AbEvent, 'type'>,
  state: BuildState,
  conditions: readonly WaitCondition[],
  globs: readonly EventGlob[],
): string | null {
  for (const { text, cond } of conditions) {
    if (stateSatisfies(cond, state)) return text
    if (cond.kind === 'attention' && isAttentionEvent(event.type)) return text
  }
  for (const { regex, text } of globs) {
    if (regex.test(event.type)) return text
  }
  return null
}

// ── The command shell ────────────────────────────────────────────────────────

export interface AbWaitOpts {
  targetRepo: string
  /** Raw process environment: --store > AB_STORE > repository default (D8). */
  env: Record<string, string | undefined>
  exec: Exec
  stdout: (line: string) => void
  stderr: (line: string) => void
  /** Positional build slugs; none means every nonterminal build in the repo. */
  slugs?: readonly string[]
  /** Repeatable `--for` conditions, in supply order. */
  forValues?: readonly string[]
  /** Repeatable `--event` globs, in supply order. */
  events?: readonly string[]
  /** A cursor from an earlier record: event conditions may fire on the
   * backlog after it; state conditions never do. */
  since?: string
  /** `--timeout` duration text; default 30 minutes, `0` unbounded. */
  timeout?: string
  /** `--interval` duration text; default 5s remote, 1s local. */
  interval?: string
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

interface WaitStream {
  slug: string
  named: boolean
  /** The full prefix, appended in seq order — what `reduceBuild` runs over. */
  events: AbEvent[]
  lastSeq: number
  status: BuildStatus
}

/**
 * `ab wait` — block until a targeted build satisfies a condition, then print
 * one record and exit 0; exit 2 when every named build went terminal without
 * satisfying anything, 3 on timeout, 4 when interrupted. Read-only: it
 * appends no event, takes no lease, and creates no record.
 */
export async function abWait(opts: AbWaitOpts): Promise<number> {
  const now = opts.now ?? (() => new Date())
  const sleep = opts.delay ?? defaultDelay
  const slugs = [...(opts.slugs ?? [])]
  const json = opts.json === true

  const timeoutMs =
    opts.timeout !== undefined
      ? parseDurationMs(opts.timeout, { flag: '--timeout', usage: WAIT_USAGE, allowZero: true })
      : DEFAULT_TIMEOUT_MS
  const intervalMs =
    opts.interval !== undefined
      ? parseDurationMs(opts.interval, { flag: '--interval', usage: WAIT_USAGE })
      : undefined

  // Condition validation, before any store access.
  const { conditions, globs } = parseConditions(opts.forValues ?? [], opts.events ?? [])
  if (conditions.length === 0 && globs.length === 0) throw new Error(WAIT_USAGE)

  // Ambient scope, before any store access — the same preflight as watch
  // (wait never follows the repository journal, so `repository` is false).
  assertReadScope(slugs, { repository: false, env: opts.env })

  return await withAmbientReadStore(
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
        opts.since !== undefined
          ? decodeCursor(opts.since, { store: storeRef, repo }, { verb: 'wait', usage: WAIT_USAGE })
              .streams
          : {}

      const identity = normalizeGitRemoteUrl(repo)
      const mine = (record: BuildRecord): boolean =>
        record.repo === identity ||
        (record.repoOrigin !== undefined && normalizeGitRemoteUrl(record.repoOrigin) === identity)

      const streams = new Map<string, WaitStream>()
      // Every stream's position — matching or not, delivered or baselined —
      // lives here, so the returned cursor never rescans or redelivers.
      const positions: Record<string, number> = { ...sinceStreams }

      const encodeCurrent = (): string =>
        encodeCursor({ v: 1, store: storeRef, repo, streams: { ...positions } })

      /** The one success/terminal record. Exit 0 is contractually tied to
       * exactly one condition-satisfying record; the exit-2 record carries
       * `condition` null so the caller can see how the build ended. */
      const finish = (condition: string | null, event: AbEvent, state: BuildState): number => {
        const record = { ...projectRecord(event, state, encodeCurrent()), condition }
        if (json) {
          opts.stdout(JSON.stringify(record))
        } else {
          const line = renderWatchLine(event, state)
          opts.stdout(condition === null ? line : `${line} (${condition})`)
        }
        return condition === null ? 2 : 0
      }

      let satisfied: { event: AbEvent; state: BuildState; condition: string } | null = null
      // Read through these: `satisfied` is mutated inside closures (match,
      // trackBuild, pollBuild, tick), and control-flow narrowing would
      // otherwise collapse it to `never` at the loop exit.
      const hasMatch = (): boolean => satisfied !== null
      const theMatch = (): { event: AbEvent; state: BuildState; condition: string } =>
        satisfied as { event: AbEvent; state: BuildState; condition: string }

      /** Record the first match only: whichever condition wins, wins. */
      const match = (event: AbEvent, state: BuildState, condition: string): void => {
        if (satisfied === null) satisfied = { event, state, condition }
      }

      const registerStream = (slug: string, events: AbEvent[], named: boolean): WaitStream => {
        const state = reduceBuild(events)
        const stream: WaitStream = {
          slug,
          named,
          events,
          lastSeq: events.at(-1)?.seq ?? 0,
          status: state.status,
        }
        streams.set(slug, stream)
        positions[slug] = stream.lastSeq
        return stream
      }

      /** The start-of-registration state check (decision 4): a build that is
       * already satisfying when it becomes targeted ends the wait with its
       * latest event. Not cursor-relative — `--since` does not suppress it. */
      const checkRegistrationState = (stream: WaitStream): void => {
        const state = reduceBuild(stream.events)
        const condition = matchState(conditions, state)
        if (condition !== null && stream.events.length > 0) {
          match(stream.events.at(-1)!, state, condition)
        }
      }
      /**
       * Track one build over the full event prefix. `resumeSeq` (a cursor
       * position) additionally replays every event after it, evaluating only
       * event conditions (decision 3): state conditions are satisfied by the
       * first post-start event, and the registration state check below runs
       * over the full reduction either way. A baseline replays nothing.
       */
      const trackBuild = async (slug: string, resumeSeq?: number): Promise<void> => {
        if (streams.has(slug)) return
        const record = await store.getBuild(slug)
        if (record === null) return
        // AUT-545: this full-log read is deliberate, accepted growth — the
        // retained prefix is consumed at full replay depth by every later
        // reduction (approvals, findings, answered escalations, PR facts,
        // observations), so bounding it would need reducer-partition store
        // machinery out of AUT-545's scope. Required for `--since` replay and
        // the registration state check over the full reduction.
        const events = await store.getEvents(slug)
        const stream = registerStream(slug, events, slugs.includes(slug))
        if (resumeSeq !== undefined) {
          stream.lastSeq = resumeSeq
          positions[slug] = resumeSeq
          // Replay the backlog into a scratch prefix: each evaluated state is
          // the reduction of the prefix ENDING at that event, never the
          // reduction of the full loaded prefix.
          const replay: AbEvent[] = events.filter((event) => event.seq <= resumeSeq)
          for (const event of events) {
            if (event.seq <= resumeSeq) continue
            replay.push(event)
            stream.lastSeq = event.seq
            positions[slug] = event.seq
            const condition = matchEvent(event, conditions, globs)
            if (condition !== null) {
              match(event, reduceBuild(replay), condition)
              break
            }
          }
        }
        if (satisfied === null) checkRegistrationState(stream)
      }

      /**
       * No-slug membership: every nonterminal build of this repository joins
       * the wait, baselined at its current maximum so no history replays, and
       * each gets the start-of-registration state check — a build discovered
       * already satisfying ends the wait. Terminal builds are never targeted
       * without being named, so an entirely terminal set keeps waiting for a
       * build to appear.
       */
      const discoverBuilds = async (): Promise<void> => {
        // AUT-545: the terminal filter is the AUT-487 digest, not a full-log read —
        // one flat batch read replaces a full getEvents per candidate build, per
        // discovery pass; `terminal` is reduceBuild's exact terminal rule
        // (store/digest.ts, pinned by contract). The per-build full read below
        // remains deliberate for builds the digest cannot retire: its retained
        // prefix is consumed at full replay depth by every later reduction
        // (approvals, findings, answered escalations, PR facts, observations), so
        // bounding it would need reducer-partition store machinery out of
        // AUT-545's scope. The reduceBuild re-check stays: it is the
        // legacy-record fallback (a record whose `repo` predates origin
        // normalization is in `mine` via `repoOrigin` but absent from the digest
        // map, which keys on `record.repo`) and it keeps this filter unable to
        // diverge from reduceBuild.
        const digests = await store.getRepoBuildDigests(repo)
        for (const record of (await store.listBuilds()).filter(mine)) {
          if (streams.has(record.slug)) continue
          const digest = digests.get(record.slug)
          if (digest !== undefined && digest.terminal !== undefined) continue
          const events = await store.getEvents(record.slug)
          const status = reduceBuild(events).status
          if (!NONTERMINAL_STATUSES.includes(status)) continue
          const stream = registerStream(record.slug, events, false)
          if (satisfied === null) checkRegistrationState(stream)
        }
      }

      const pollBuild = async (
        stream: WaitStream,
        readOpts?: RemotePollReadOpts,
      ): Promise<void> => {
        const fresh = await store.getEvents(stream.slug, stream.lastSeq, readOpts)
        for (const event of fresh) {
          stream.events.push(event)
          stream.lastSeq = event.seq
          positions[stream.slug] = event.seq
          const state = reduceBuild(stream.events)
          stream.status = state.status
          const condition = matchFirst(event, state, conditions, globs)
          if (condition !== null) {
            match(event, state, condition)
            return
          }
        }
      }

      const namedAllTerminal = (): boolean => {
        if (slugs.length === 0) return false
        for (const slug of slugs) {
          const stream = streams.get(slug)
          if (stream === undefined || !TERMINAL_STATUSES.includes(stream.status)) return false
        }
        return true
      }

      /** The exit-2 record: among the named builds' terminal events, the one
       * with the latest `ts` (ties broken by slug order) — the event that made
       * the final named build terminal. */
      const pickTerminalRecord = (): { event: AbEvent; state: BuildState } => {
        let best: { event: AbEvent; state: BuildState; slug: string } | null = null
        for (const slug of slugs) {
          const stream = streams.get(slug)
          if (stream === undefined) continue
          const terminalEvent = [...stream.events]
            .reverse()
            .find((event) => event.type === 'build.completed' || event.type === 'build.aborted')
          if (terminalEvent === undefined) continue
          if (
            best === null ||
            terminalEvent.ts > best.event.ts ||
            (terminalEvent.ts === best.event.ts && slug < best.slug)
          ) {
            best = { event: terminalEvent, state: reduceBuild(stream.events), slug }
          }
        }
        // A named build is terminal only through its terminal event, so
        // `best` is always set by the time this runs.
        return { event: best!.event, state: best!.state }
      }

      /** One poll cycle: discovery, then per-stream reads. A failed read is
       * reported once per failure streak, advances nothing, and is retried at
       * the next interval; a fully successful cycle re-arms the report. */
      const tickStreak = makeFailureStreak('wait', opts.stderr)

      const tick = async (): Promise<void> => {
        let allReadsOk = true
        if (slugs.length === 0 && satisfied === null) {
          try {
            await discoverBuilds()
          } catch (error) {
            allReadsOk = false
            tickStreak.onFailure(error)
          }
        }
        for (const stream of [...streams.values()]) {
          if (satisfied !== null) break
          try {
            await pollBuild(stream)
          } catch (error) {
            allReadsOk = false
            tickStreak.onFailure(error)
          }
        }
        if (allReadsOk) tickStreak.onSuccess()
      }

      const finishSatisfied = (): number =>
        finish(theMatch().condition, theMatch().event, theMatch().state)

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
      for (const slug of slugs) {
        await trackBuild(slug, sinceStreams[slug])
        if (hasMatch()) return finishSatisfied()
      }
      // Cursor streams that are no longer named resume anyway: finishing
      // their backlog is what makes a resumed wait lossless.
      for (const key of Object.keys(sinceStreams)) {
        await trackBuild(key, sinceStreams[key])
        if (hasMatch()) return finishSatisfied()
      }
      if (slugs.length === 0) {
        // Membership discovery also baselines the default wait; a failed
        // discovery here is fatal — nothing has started yet.
        try {
          await discoverBuilds()
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          throw new Error(`could not list builds in this store (${message})`)
        }
        if (hasMatch()) return finishSatisfied()
      } else if (namedAllTerminal()) {
        // Decision 5, start form: every named build is already terminal and
        // no condition held — show how the build ended.
        const terminal = pickTerminalRecord()
        return finish(null, terminal.event, terminal.state)
      }

      // ── The poll loop ──
      const timeoutText = opts.timeout ?? '30m'
      const deadline = timeoutMs === 0 ? Number.POSITIVE_INFINITY : now().getTime() + timeoutMs
      const aborted = (): boolean => opts.signal?.aborted === true

      if (!isRemoteStoreRef(storeRef)) {
        // Local cadence: one sequential tick per interval.
        while (!hasMatch()) {
          if (aborted() || now().getTime() >= deadline) break
          await sleep(interval, opts.signal)
          if (aborted()) break
          await tick()
          if (!hasMatch() && namedAllTerminal()) {
            const terminal = pickTerminalRecord()
            return finish(null, terminal.event, terminal.state)
          }
        }
      } else {
        // Remote cadence (AUT-334, verified and corrected in AUT-368): one
        // long-poll task per tracked stream, running concurrently — a quiet
        // stream keeps one held `getEvents` request in flight, so an appended
        // event is seen within about a second of its append instead of at the
        // next interval tick. Gap-fill spaces each stream's request starts at
        // least `interval` apart (elapsed request time counts toward the
        // gap), so a server that answers immediately still sees today's
        // request rate. Discovery keeps its interval cadence. The pre-launch
        // guard mirrors the local loop's top-of-cycle checks: a satisfied
        // match, an abort, an elapsed deadline, or an all-terminal named set
        // ends the wait before any held request (an already-satisfied wait
        // issues zero held reads).
        // Every stop is prompt: a satisfied condition, an all-terminal named
        // set, an external abort, or an elapsed --timeout cancels the
        // in-flight held reads (via `requestStop`) and wakes the gap sleeps
        // (via the runner's stop controller) instead of waiting out a full
        // hold. The held read's own bound is additionally capped at the
        // wait's remaining time budget, so a hold can never outlive the
        // deadline.
        const shouldStop =
          hasMatch() || aborted() || now().getTime() >= deadline || namedAllTerminal()
        const remoteRunner = createRemotePollRunner({
          command: 'wait',
          stderr: opts.stderr,
          now,
          sleep,
          intervalMs: interval,
          deadlineMs: deadline,
          aborted,
          shouldStop: () =>
            hasMatch() || aborted() || now().getTime() >= deadline || namedAllTerminal(),
          drain: 'quiesce',
        })
        const requestStop = (): void => remoteRunner.requestStop()

        const launch = (stream: WaitStream): void => {
          remoteRunner.launch(
            stream.slug,
            (readOpts) => pollBuild(stream, readOpts),
            () => hasMatch() || namedAllTerminal(),
          )
        }

        // An external abort (SIGINT) is a stop like any other: it cancels
        // the in-flight held reads and wakes the gap sleeps.
        opts.signal?.addEventListener('abort', requestStop, { once: true })

        if (!shouldStop) {
          for (const stream of streams.values()) launch(stream)

          if (slugs.length === 0) {
            // Discovery keeps its interval cadence, launching a new per-
            // stream task for each newly discovered nonterminal build. A
            // discovered build that already satisfies ends the wait. The
            // launch loop stays unconditional, after the catch — exactly
            // where the inline loop ran: streams registered before a
            // mid-discovery throw still get tasks whose polls then run
            // independently.
            void remoteRunner.runDiscovery({
              step: async (): Promise<void> => {
                await discoverBuilds()
              },
              launchPending: (): void => {
                for (const stream of streams.values()) launch(stream)
              },
              endCheck: () => hasMatch(),
            })
          }
        }

        await remoteRunner.drain()
        opts.signal?.removeEventListener('abort', requestStop)
      }

      if (hasMatch()) return finishSatisfied()
      if (namedAllTerminal()) {
        // Decision 5, loop form: every named build went terminal without
        // satisfying anything. The local loop checks this after each tick;
        // on the remote path the runner records only that a stop was
        // requested — its `shouldStop`/`endCheck` callbacks re-derive the
        // conditions live — so after the quiesce drain this decision re-reads
        // the same live predicates (`hasMatch`, `namedAllTerminal`, `aborted`,
        // the deadline) to pick the exit.
        const terminal = pickTerminalRecord()
        return finish(null, terminal.event, terminal.state)
      }
      if (aborted()) {
        opts.stderr('ab wait: interrupted — no condition was satisfied before the signal')
        if (json) opts.stdout(JSON.stringify({ cursor: encodeCurrent() }))
        return 4
      }
      opts.stderr(
        `ab wait: timed out after ${timeoutText} — no targeted build satisfied any condition`,
      )
      if (json) opts.stdout(JSON.stringify({ cursor: encodeCurrent() }))
      return 3
    },
  )
}
