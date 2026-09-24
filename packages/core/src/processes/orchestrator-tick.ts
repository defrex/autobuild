/**
 * The dispatcher tick's orchestrator step (AUT-342): resume suspended turns,
 * reap crashed ones, and wake idle sessions from build attention events.
 *
 * Two independent gates keep this inert where it does not belong, and BOTH
 * are required:
 *
 * 1. The step is constructed only in origin mode — the gate lives in
 *    `processes/dispatcher.ts` on `DispatcherDeps.repoOrigin` (set
 *    exclusively by origin mode), so a local `ab dispatch` never constructs
 *    the step at all: an `enabled = true` in a local repository's
 *    autobuild.toml lists no sessions, builds no registry, and calls no
 *    model.
 * 2. In origin mode the step returns immediately unless the repository's
 *    effective config enables the orchestrator — the disabled-repository
 *    no-op.
 *
 * The wake cursor advances only through the recorded trigger (the reducer
 * takes `max`), so a crash between scan and start cannot skip or duplicate a
 * wake; other builds' matching events re-trigger on later ticks. One turn
 * per session per tick, never concurrent.
 */
import { ORCHESTRATOR_MIN_TURN_SECONDS, type Config } from '../config/schema'
import { compileEventGlobs } from '../events/globs'
import type { TicketSource } from '../ports/types'
import { buildRegistry, type OperatorToolRegistry } from '../operator/registry'
import { ticketBackendFromSource } from '../operator/ticket-source-backend'
import { reduceSession } from '../store/session-reducer'
import { reduceBuild } from '../kernel/reducer'
import type { AbEvent } from '../events/catalog'
import type { BuildStore, Clock } from '../store/types'
import type { IdSource } from '../ids'
import type { LanguageModel } from 'ai'
import {
  createOrchestratorTurnRunner,
  type OrchestratorTurnRunner,
} from '../orchestrator/turn-runner'

/** Minutes an open, unsuspended turn's stream may stay silent before the
 * reaper fails it: a crashed invocation leaves the session `running` with an
 * open stream and no runner. Suspended turns are NEVER reaped — a turn
 * suspended for approval is precisely an open stream that goes quiet for
 * however long the operator takes. */
export const ORCHESTRATOR_STALE_TURN_MINUTES = 15

export interface OrchestratorTickOptions {
  store: BuildStore
  repo: string
  config: Config
  clock: Clock
  ids: IdSource
  /** The dispatcher's ticket source, adapted into the registry's ticket
   * backend so wake and resumed turns keep the full ticket surface. */
  tickets: TicketSource
  /** Injected language model; defaults to the configured gateway model. */
  model?: LanguageModel
  /** Remaining tick budget in seconds at step entry; every turn's deadline
   * is recomputed from this against the clock, so N sessions draw down the
   * SAME budget instead of each getting a fresh full slice (f_9c1161ae).
   * Less than ORCHESTRATOR_MIN_TURN_SECONDS skips the whole step
   * (suspension state is durable — skipping is safe). */
  remainingBudgetSeconds?: number
  log?: (message: string) => void
}

export interface OrchestratorTickReport {
  resumed: number
  reaped: number
  woken: number
}

/** The registry the tick's turns run against: the in-process binding over
 * the dispatcher's store, with the ticket source adapted into the backend
 * `buildRegistry`'s ticket tools require (`buildMcpTicketBackend` reads a
 * checkout's autobuild.toml and cannot run in origin mode). */
export function orchestratorTickRegistry(options: OrchestratorTickOptions): OperatorToolRegistry {
  return buildRegistry({
    store: options.store,
    tickets: ticketBackendFromSource({ source: options.tickets, config: options.config }),
    clock: options.clock,
    allowedRepo: options.repo,
  })
}

export function orchestratorTickRunner(options: OrchestratorTickOptions): OrchestratorTurnRunner {
  return createOrchestratorTurnRunner({
    store: options.store,
    registry: orchestratorTickRegistry(options),
    repo: options.repo,
    config: options.config,
    clock: options.clock,
    ids: options.ids,
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.remainingBudgetSeconds !== undefined
      ? { remainingBudgetSeconds: options.remainingBudgetSeconds }
      : {}),
  })
}

/** One pass of the orchestrator step. The caller has already evaluated both
 * gates (origin mode and `enabled`); this function assumes it may run. */
export async function runOrchestratorTickStep(
  options: OrchestratorTickOptions,
): Promise<OrchestratorTickReport> {
  const { store, repo, config, clock } = options
  const report: OrchestratorTickReport = { resumed: 0, reaped: 0, woken: 0 }
  const entry =
    options.remainingBudgetSeconds === undefined
      ? config.orchestrator.invocationBudgetSeconds
      : options.remainingBudgetSeconds
  if (entry < ORCHESTRATOR_MIN_TURN_SECONDS) return report

  // The step's deadline, fixed at entry: every turn's slice is recomputed
  // from the clock against THIS deadline, so the step can only consume the
  // remaining slack no matter how many sessions it serves. (A fixed
  // per-session value handed to each turn would let N sessions run
  // N × remaining seconds past the tick deadline — f_9c1161ae.)
  const deadlineMs = clock().getTime() + entry * 1000
  const remainingNow = (): number =>
    Math.max(0, Math.floor((deadlineMs - clock().getTime()) / 1000))

  const runner = orchestratorTickRunner(options)
  const sessions = await store.listSessions(repo)

  // ── Resume pass ─────────────────────────────────────────────────────────
  for (const record of sessions) {
    const events = await store.getSessionEvents(record.id)
    const state = reduceSession(events)
    if (state.status !== 'suspended' || state.openTurn === undefined) continue
    // Budget suspensions resume always; approval suspensions only once the
    // answer has landed (`pendingApproval` gone — the answered-approval
    // fallback when the resuming operator-route invocation died). An
    // unanswered approval stays put until the operator answers.
    if (state.pendingApproval !== undefined) continue
    // An answered approval resumes with the recorded decision, so the
    // runner recovers the wire approvalId and appends the response part.
    let approval: { decision: 'approve' | 'deny'; toolCallId: string } | undefined
    if (state.suspendedCause === 'approval') {
      for (const event of [...events].reverse()) {
        if (event.type === 'approval.answered' && event.payload.turn === state.openTurn.turn) {
          approval = { decision: event.payload.decision, toolCallId: event.payload.toolCallId }
          break
        }
      }
      if (approval === undefined) continue
    }
    // Draw down the shared deadline: a session is skipped — suspension state
    // is durable, so skipping is always safe — when the step's remaining
    // slack no longer leaves the floor for a meaningful turn slice.
    const remaining = remainingNow() - ORCHESTRATOR_MIN_TURN_SECONDS
    if (remaining < ORCHESTRATOR_MIN_TURN_SECONDS) break
    const resumed = await runner.resumeTurn(record.id, {
      ...(approval !== undefined ? { approval } : {}),
      remainingBudgetSeconds: remaining,
    })
    if (resumed.resumed) {
      report.resumed += 1
      // One turn per session per tick, never concurrent: the loop outcome
      // runs to its suspension/completion before the next session.
      await resumed.outcome
    }
  }

  // ── Crash reaper ────────────────────────────────────────────────────────
  const staleMs = ORCHESTRATOR_STALE_TURN_MINUTES * 60_000
  for (const record of sessions) {
    const events = await store.getSessionEvents(record.id)
    const state = reduceSession(events)
    // Reap only a session whose reduced status is exactly `running` — an
    // open turn with no pending approval and no suspension. A late approve
    // answer must still find its pending approval and its turn.
    if (state.status !== 'running' || state.openTurn === undefined) continue
    const lastChunkTs = await lastStreamActivity(store, state.openTurn.stream)
    if (lastChunkTs === null) continue
    if (clock().getTime() - Date.parse(lastChunkTs) < staleMs) continue
    const lastSeq = events[events.length - 1]?.seq ?? 0
    const reaped = await store
      .appendSessionEventIfCurrent(record.id, lastSeq, {
        actor: { kind: 'agent', role: 'orchestrator', session: state.openTurn.turn },
        type: 'turn.failed',
        payload: {
          turn: state.openTurn.turn,
          kind: 'internal',
          error: `turn invocation ended without an outcome (no stream activity for ${ORCHESTRATOR_STALE_TURN_MINUTES} minutes)`,
        },
      })
      .catch(() => null)
    if (reaped === null) continue // a resume landed first
    await store.closeStream(state.openTurn.stream, 'aborted').catch(() => undefined)
    report.reaped += 1
  }

  // ── Wake pass ───────────────────────────────────────────────────────────
  const builds = (await store.listBuilds()).filter((candidate) => candidate.repo === repo)
  for (const record of sessions) {
    const events = await store.getSessionEvents(record.id)
    const state = reduceSession(events)
    if (state.status !== 'idle') continue
    if (state.wakeGlobs.length === 0) continue
    let filters: RegExp[]
    try {
      filters = compileEventGlobs(state.wakeGlobs, { usage: '[orchestrator].wake' })
    } catch {
      continue // unmatchable settings wake nothing
    }

    // Scan every build's events after this session's per-build wake cursor;
    // select the single newest matching event across all scanned builds.
    let newest: { build: string; event: AbEvent } | undefined
    for (const build of builds) {
      const cursor = state.wakeCursors[build.slug] ?? 0
      const buildEvents = await store.getEvents(build.slug)
      for (const event of buildEvents) {
        if (event.seq <= cursor) continue
        if (!filters.some((regex) => regex.test(event.type))) continue
        if (
          newest === undefined ||
          event.ts > newest.event.ts ||
          (event.ts === newest.event.ts && event.seq > newest.event.seq)
        ) {
          newest = { build: build.slug, event }
        }
      }
    }
    if (newest === undefined) continue

    // Same drawdown for wake turns: one turn per session per tick, bounded
    // by the step's shared deadline; past the floor the wake defers to a
    // later tick.
    const remaining = remainingNow() - ORCHESTRATOR_MIN_TURN_SECONDS
    if (remaining < ORCHESTRATOR_MIN_TURN_SECONDS) break

    const buildEvents = await store.getEvents(newest.build)
    const start = await runner.startTurn(
      record.id,
      {
        kind: 'wake',
        build: newest.build,
        seq: newest.event.seq,
        type: newest.event.type,
      },
      {
        event: {
          seq: newest.event.seq,
          ts: newest.event.ts,
          type: newest.event.type,
          payload: newest.event.payload,
        },
        buildState: reduceBuild(buildEvents) as unknown as Record<string, unknown>,
      },
      { remainingBudgetSeconds: remaining },
    )
    if (start.started) {
      report.woken += 1
      // The cursor advances only through the recorded trigger (the reducer
      // takes `max`), so a crash between scan and start cannot skip or
      // duplicate a wake — and other builds' matching events re-trigger on
      // later ticks.
      await start.outcome
    }
  }

  options.log?.(
    `orchestrator step: resumed=${report.resumed} reaped=${report.reaped} woken=${report.woken}`,
  )
  return report
}

/** The newest chunk timestamp on a stream, or its creation time when the
 * stream has no chunks yet — the liveness signal the reaper reads. */
async function lastStreamActivity(store: BuildStore, streamId: string): Promise<string | null> {
  const read = await store.readStream(streamId).catch(() => null)
  if (read === null) return null
  const last = read.chunks[read.chunks.length - 1]
  if (last !== undefined) return last.ts
  const record = await store.getStream(streamId)
  return record?.createdAt ?? null
}
