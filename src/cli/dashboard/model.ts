/**
 * The dashboard's pure projection: `BuildState` → what the operator sees.
 *
 * DISPLAY-ONLY — nothing consults this. The engine decides transitions from
 * `decideNext` (§2.1's determinism half); a progress row is not a transition
 * table and must never become one.
 *
 * But display-only is NOT a licence to disagree with the engine. The display
 * IS the deliverable: a row that says `verify:lint [x]` for code the engine is
 * about to re-verify is a wrong answer, not a cosmetic one. So every row obeys
 * one rule:
 *
 *   >>> A step is `done` iff the engine will not re-run it. <<<
 *
 * Which means every `done` predicate is expressed against a fact the engine
 * ALSO routes on — a seq or a round — never a full-log "latest wins" boolean.
 * `plan.approved`, `codeReviewApproved` and `prState !== undefined` all look
 * like the right answer and all lie across a restart, because `spec.revised`
 * never touches them.
 *
 * `provisional` is a separate, display-only fact: this occurrence produced a
 * terminal output in the current round/cycle, but the engine may still re-run
 * it. It never participates in routing and never changes the `done` rule. The
 * rules this file mirrors, and the code that owns them:
 *
 *   engine.ts:275     the verify cycle boundary (§15.6-A)
 *   engine.ts:347-355 a verify failure reopens the CODE loop
 *   engine.ts:466     a spec restart re-runs both loops (§6.3)
 *   engine.ts:707-708 a spec restart re-runs finalize and its post-steps
 *   engine.ts:221-227 an unlanded revise-spec answer parks the whole pipeline
 *
 * Two display rules live here rather than in the kernel, because the spec asks
 * for them visually and "changing lifecycle semantics" is out of scope:
 * effective status (blocked overrides paused) and the pending-restart boundary.
 * Both are derivations over facts the reducer already retains; neither the
 * reducer nor the engine is touched.
 */
import type { AbEvent } from '../../events/catalog'
import type { Config } from '../../config/schema'
import type { BuildState, PhaseContext, PrLifecycle } from '../../kernel/reducer'
import { verifyPhase } from '../../ontology'
import type { BuildRecord } from '../../store/types'

/** The only statuses a listed build can have — queued/done/aborted are
 * filtered out entirely (they are not active work). */
export type EffectiveStatus = 'running' | 'paused' | 'blocked'

export type StepState = 'done' | 'current' | 'provisional' | 'pending'

/**
 * A step's wall-clock timing, now-INDEPENDENT so the model can be cached and
 * repainted against a moving clock (the elapsed ticks in the renderer, not
 * here). `accumulatedMs` is the cumulative duration of every CLOSED occurrence
 * in scope; `runningSince` is the start epoch-ms of an open occurrence — the
 * renderer adds `now - runningSince` on top of `accumulatedMs`. A frozen build
 * (paused/blocked) has its open occurrence closed into `accumulatedMs`, so
 * `runningSince` is absent and its timer never advances (AC 10).
 */
export interface StepTiming {
  accumulatedMs: number
  runningSince?: number
}

export interface PipelineStep {
  label: string
  state: StepState
  /** A non-load-bearing word — always redundant with `state`. `failed` on a
   * verify/finalize step, `waiting` on merge. Rendered inside the `(…)` note. */
  qualifier?: 'failed' | 'waiting'
  /** Round (plan/implement loops) or attempt (verify/reconcile). Rendered as
   * `/n` riding the elapsed time when > 1 — supersedes the old `r2`/`a2`. */
  count?: number
  /** Absent ⇒ the step has never run in the current spec scope ⇒ no time is
   * shown (AC 6). The renderer composes the elapsed segment from this. */
  timing?: StepTiming
}

export interface DashboardBuild {
  slug: string
  status: EffectiveStatus
  /** True when the build is BOTH paused and blocked: blocked wins the status
   * (the spec's visual override), and this keeps the pause visible so no
   * information is lost. */
  alsoPaused: boolean
  ticketId?: string
  steps: PipelineStep[]
  /** Every unresolved blocker's question. Resolved ones drop out by
   * construction — the reducer moves them to answeredEscalations. */
  blockers: string[]
  pr?: { url: string; state: PrLifecycle }
}

export interface DashboardModel {
  repo: string
  mode: 'watch' | 'once'
  capacity: number
  builds: DashboardBuild[]
}

/**
 * §15.5 sets the reducer's precedence to paused > blocked and documents why:
 * pausing is the operator's explicit instruction, and the escalation is not
 * lost — it stays in `openEscalations`, so resuming reports blocked again. The
 * spec asks for the opposite VISUALLY ("a build with unresolved blockers is
 * treated as blocked even when it is also manually paused"). Both hold at once
 * because the reducer retains both facts: the display overrides, the lifecycle
 * does not. A paused+blocked build still parks on `paused` in `decideNext`,
 * exactly as today.
 */
export function effectiveStatus(state: BuildState): BuildState['status'] {
  return (state.status === 'paused' || state.status === 'blocked') &&
    state.openEscalations.length > 0
    ? 'blocked'
    : state.status
}

function isActive(status: BuildState['status']): status is EffectiveStatus {
  return status === 'running' || status === 'paused' || status === 'blocked'
}

/**
 * One step, built through one helper so the precedence rule cannot be applied
 * inconsistently: **`current > done > provisional > pending`**. In particular,
 * an active occurrence stays current even when an earlier terminal output for
 * that same occurrence exists. `producedOutput` is display-only and means a
 * terminal event exists in the current round/cycle — never merely a start or
 * an open timing interval.
 */
interface StepExtra {
  producedOutput?: boolean
  qualifier?: 'failed' | 'waiting'
  count?: number
  timing?: StepTiming
}

function step(label: string, done: boolean, current: boolean, extra: StepExtra = {}): PipelineStep {
  return {
    label,
    state: current
      ? 'current'
      : done
        ? 'done'
        : extra.producedOutput === true
          ? 'provisional'
          : 'pending',
    ...(extra.qualifier !== undefined ? { qualifier: extra.qualifier } : {}),
    ...(extra.count !== undefined ? { count: extra.count } : {}),
    ...(extra.timing !== undefined ? { timing: extra.timing } : {}),
  }
}

/** One phase occurrence's wall-clock span, keyed by phase. `startSeq` is the
 * seq of the `*.started` event, so callers can scope by the same seq
 * boundaries (`restartSince`/`cycleSince`) the step STATES already use. */
interface PhaseInterval {
  start: number
  end: number
  startSeq: number
}
interface PhaseTiming {
  closed: PhaseInterval[]
  open?: { start: number; startSeq: number }
}

/**
 * Walk the raw event log into per-phase `[start, end]` intervals in epoch-ms
 * (`Date.parse(ev.ts)`), the durations the reducer collapses away. Each
 * `*.started` opens an interval for its phase key and its terminal event
 * (`.completed`/`.verdict`) closes it. A second `*.started` while one is still
 * open REPLACES the open start — a §15.6-C cross-sandbox re-run starts the
 * phase afresh, so the crashed attempt contributes nothing. Finalize post-steps
 * (`finalize.step-completed`) have no `.started` and so no interval.
 */
function phaseIntervals(events: AbEvent[]): Map<string, PhaseTiming> {
  const timings = new Map<string, PhaseTiming>()
  const get = (key: string): PhaseTiming => {
    let t = timings.get(key)
    if (t === undefined) {
      t = { closed: [] }
      timings.set(key, t)
    }
    return t
  }
  for (const ev of events) {
    const ms = Date.parse(ev.ts)
    const open = (key: string): void => {
      get(key).open = { start: ms, startSeq: ev.seq }
    }
    const close = (key: string): void => {
      const t = get(key)
      if (t.open === undefined) return
      t.closed.push({ start: t.open.start, end: ms, startSeq: t.open.startSeq })
      t.open = undefined
    }
    switch (ev.type) {
      case 'plan.started':
        open('plan')
        break
      case 'plan.completed':
        close('plan')
        break
      case 'plan-review.started':
        open('plan-review')
        break
      case 'plan-review.verdict':
        close('plan-review')
        break
      case 'implement.started':
        open('implement')
        break
      case 'implement.completed':
        close('implement')
        break
      case 'code-review.started':
        open('code-review')
        break
      case 'code-review.verdict':
        close('code-review')
        break
      case 'verify.started':
        open(verifyPhase(ev.payload.step))
        break
      case 'verify.completed':
        close(verifyPhase(ev.payload.step))
        break
      case 'finalize.started':
        open('finalize')
        break
      case 'finalize.completed':
        close('finalize')
        break
      case 'reconcile.started':
        open('reconcile')
        break
      case 'reconcile.completed':
        close('reconcile')
        break
      default:
        break
    }
  }
  return timings
}

/**
 * Sum the in-scope occurrences of one phase into a `StepTiming`, or `undefined`
 * when the phase never ran in scope (the step shows no time, AC 6). Scope is
 * `startSeq > sinceSeq` — the SAME boundary the step's `done`/`current` state
 * uses, so durations restart in lockstep with states (AC 12). The open
 * occurrence stays open (`runningSince`) only when the build is running; a
 * frozen build (`frozenNow` given) closes it at that instant so its timer does
 * not advance (AC 10).
 */
function timingFor(
  intervals: Map<string, PhaseTiming>,
  key: string,
  sinceSeq: number,
  frozenNow: number | undefined,
): StepTiming | undefined {
  const t = intervals.get(key)
  if (t === undefined) return undefined
  let accumulatedMs = 0
  let inScope = false
  for (const iv of t.closed) {
    if (iv.startSeq > sinceSeq) {
      accumulatedMs += iv.end - iv.start
      inScope = true
    }
  }
  let runningSince: number | undefined
  if (t.open !== undefined && t.open.startSeq > sinceSeq) {
    inScope = true
    if (frozenNow !== undefined) accumulatedMs += Math.max(0, frozenNow - t.open.start)
    else runningSince = t.open.start
  }
  if (!inScope) return undefined
  return { accumulatedMs, ...(runningSince !== undefined ? { runningSince } : {}) }
}

/**
 * `record` + `state` → one dashboard row, or `null` when the build is not
 * active (queued / done / aborted) — this IS the list filter.
 */
export function projectBuild(
  record: BuildRecord,
  state: BuildState,
  config: Config,
  events: AbEvent[],
): DashboardBuild | null {
  const status = effectiveStatus(state)
  if (!isActive(status)) return null

  // ── Boundaries ────────────────────────────────────────────────────────────
  //
  // A revise-spec answer whose `spec.revised` has not landed yet (§6.3,
  // engine.ts:221-227): the engine is parked on `wait{awaiting-spec}` and will
  // restart the build from plan the instant the revision arrives. This window
  // is HUMAN-paced — the operator is off rewriting the spec — so it is exactly
  // the durable state this dashboard exists to render, and rendering
  // `finalize [x] merge [>] waiting` in it would be a wrong answer: every one
  // of those steps is about to re-run. A pending restart therefore raises the
  // boundary the same way the landed one will. (`decideNext` returns `wait`
  // here, naming no phase, so the engine oracle in the tests is blind to this
  // state — it is asserted by hand.)
  const pendingRestart = state.answeredEscalations.some(
    (e) => e.resolution === 'revise-spec' && e.answeredSeq > state.restartSince,
  )
  const restartSince = pendingRestart ? state.lastSeq : state.restartSince
  const cycleSince = Math.max(state.verify.cycleSince, restartSince)
  // Post-steps re-run after a restart too (engine.ts:710-712); the reducer
  // already drops them at `spec.revised`, so only the pending case is left.
  const finalizeSteps = pendingRestart ? [] : state.finalizeSteps

  /**
   * The current phase, scoped to the current spec.
   *
   * `currentPhase` is latest-wins over the FULL log — the same shape as
   * `plan.approved` and `prState`, and stale for the same reason. `start()`
   * sets `currentPhase` and only that phase's OWN terminal event clears it
   * (`reducer.ts`); `escalation.raised` deliberately does not
   * (the phase still needs re-running), and `spec.revised` resets
   * `restartSince`, `cycleSince` and `finalizeSteps` but not these. So a phase
   * that was in flight when a restart landed still reads as running.
   *
   * That is the plan's own defect class in the one predicate its rule never
   * quantified over — `current`, not `done` — so it gets the same treatment:
   * across a restart (landed OR pending) nothing is current until a new
   * `*.started` lands. That is exactly what the engine does; it re-runs the
   * loops from plan (engine.ts:466) rather than resuming the interrupted
   * phase, and during a pending restart it runs nothing at all
   * (engine.ts:221-227).
   *
   * `reconcile` is included deliberately. The epilogue is restart-orthogonal
   * in the facts it routes on (engine.ts:161-162) — but rule 3 preempts it
   * while a restart is pending, and once one lands the engine goes to plan and
   * only re-reaches the epilogue after a full rebuild re-opens the PR. A
   * pre-restart `reconcile.started` is not "reconcile is running now".
   */
  const scoped = (ctx: PhaseContext | undefined): PhaseContext | undefined =>
    ctx !== undefined && ctx.seq > restartSince ? ctx : undefined
  const activePhase = scoped(state.currentPhase)

  // ── Timing ────────────────────────────────────────────────────────────────
  // Per-occurrence durations from the raw log — the reducer collapses them
  // away, so they are derived here (display-only, at the one call site that
  // already has the log in hand). A running build keeps its open interval live
  // (the renderer ticks it against `now`); a paused/blocked build freezes every
  // open interval at the log's last-event ts, so its timers do not advance
  // (AC 10). Each step scopes by the SAME seq boundary its state uses, so
  // durations and states restart in lockstep (AC 12).
  const intervals = phaseIntervals(events)
  const frozenNow =
    status === 'running'
      ? undefined
      : state.lastEvent !== undefined
        ? Date.parse(state.lastEvent.ts)
        : undefined

  // ── Shared derivations ────────────────────────────────────────────────────
  // ORDER MATTERS: `cycleFailed` must be defined before `codeDone` reads it.
  const cycle = state.verify.results.filter((r) => r.seq > cycleSince)
  const cycleFailed = cycle.some((r) => !r.pass)
  const verifyPassed = (s: string): boolean => cycle.some((r) => r.step === s && r.pass)
  const verifyDrained = !cycleFailed && config.verify.steps.every(verifyPassed)

  // A loop is settled only if its standing approval survived the last restart
  // AND no later producer round reopened it. `approved` alone is a full-log
  // boolean and lies in both cases.
  const loopDone = (
    approval: { seq: number; round: number } | undefined,
    producerRound: number,
  ): boolean =>
    approval !== undefined && approval.seq > restartSince && approval.round === producerRound

  const planDone = loopDone(state.plan.approval, state.plan.round)
  // `&& !cycleFailed`: a verify failure reopens the CODE loop (§15.6-A) the
  // MOMENT it lands — long before `implement.started` moves `implement.round`,
  // and under default policy that start may never come (see below).
  const codeDone = loopDone(state.codeReviewApproval, state.implement.round) && !cycleFailed

  // A loop row is provisional only when ITS terminal output belongs to the
  // reducer's currently tracked round and landed after the effective restart
  // boundary. Starts and timing intervals are deliberately insufficient: a
  // crashed phase has run, but has produced no output. Matching the round also
  // drops a review verdict as soon as the next producer round starts.
  const planProduced = events.some(
    (ev) =>
      ev.seq > restartSince &&
      ev.type === 'plan.completed' &&
      ev.payload.round === state.plan.round,
  )
  const planReviewProduced = events.some(
    (ev) =>
      ev.seq > restartSince &&
      ev.type === 'plan-review.verdict' &&
      ev.payload.round === state.plan.round,
  )
  const implementProduced = events.some(
    (ev) =>
      ev.seq > restartSince &&
      ev.type === 'implement.completed' &&
      ev.payload.round === state.implement.round,
  )
  const codeReviewProduced = events.some(
    (ev) =>
      ev.seq > restartSince &&
      ev.type === 'code-review.verdict' &&
      ev.payload.round === state.implement.round,
  )

  // Finalize ran for the CURRENT spec — NOT `prState !== undefined`, which a
  // spec restart never resets while the engine re-runs finalize from scratch.
  const finalizeDone = state.finalizeCompletedSeq > restartSince
  const postStepsDrained = config.finalize.steps.every((s) =>
    finalizeSteps.some((f) => f.step === s),
  )

  const at = (phase: string): boolean => activePhase?.phase === phase
  const planCount = state.plan.round > 1 ? state.plan.round : undefined
  const codeCount = state.implement.round > 1 ? state.implement.round : undefined

  const steps: PipelineStep[] = [
    step('plan', planDone, at('plan'), {
      producedOutput: planProduced,
      count: planCount,
      timing: timingFor(intervals, 'plan', restartSince, frozenNow),
    }),
    step('plan-review', planDone, at('plan-review'), {
      producedOutput: planReviewProduced,
      count: planCount,
      timing: timingFor(intervals, 'plan-review', restartSince, frozenNow),
    }),
    step('implement', codeDone, at('implement'), {
      producedOutput: implementProduced,
      count: codeCount,
      timing: timingFor(intervals, 'implement', restartSince, frozenNow),
    }),
    step('code-review', codeDone, at('code-review'), {
      producedOutput: codeReviewProduced,
      count: codeCount,
      timing: timingFor(intervals, 'code-review', restartSince, frozenNow),
    }),
  ]

  for (const s of config.verify.steps) {
    const phase = verifyPhase(s)
    const current = at(phase)
    const stepResults = cycle.filter((r) => r.step === s)
    // The attempt COUNT comes from `currentPhase.attempt` for the running step
    // — the attempt ACTUALLY running (`verify.started` populates it directly),
    // never `verify.attempt`, which is the max attempt SEEN and names the
    // previous cycle in the window after a boundary move. A non-running step
    // takes the max attempt among its results IN THE CURRENT CYCLE, so a past
    // cycle's attempt can never leak. Rendered as `/n` only when > 1.
    const maxAttempt =
      current && activePhase?.attempt !== undefined
        ? activePhase.attempt
        : stepResults.length > 0
          ? Math.max(...stepResults.map((r) => r.attempt))
          : undefined
    const count = maxAttempt !== undefined && maxAttempt > 1 ? maxAttempt : undefined
    // `!cycleFailed &&`: §15.6-A re-runs the cycle FROM THE FIRST STEP, so
    // once any step in the cycle has failed, an earlier step's pass in that
    // same cycle is not durably done either. The failing step keeps a `failed`
    // qualifier so the operator does not lose the information; completed rows
    // are provisional because they produced output but will genuinely re-run.
    steps.push(
      step(phase, !cycleFailed && verifyPassed(s), current, {
        producedOutput: stepResults.length > 0,
        qualifier: stepResults.some((r) => !r.pass) ? 'failed' : undefined,
        count,
        timing: timingFor(intervals, phase, cycleSince, frozenNow),
      }),
    )
  }

  steps.push(
    step('finalize', finalizeDone, at('finalize'), {
      timing: timingFor(intervals, 'finalize', restartSince, frozenNow),
    }),
  )
  for (const s of config.finalize.steps) {
    // Post-steps have no `.started` event, so they carry no timing.
    const done = finalizeSteps.find((f) => f.step === s)
    steps.push(
      step(s, done !== undefined, false, { qualifier: done?.ok === false ? 'failed' : undefined }),
    )
  }

  // Conditional (§15.7): the epilogue is not guaranteed future work, so the
  // row appears only once a conflict activates it. `reconcileAttempts` is
  // full-log — legitimately, per the rule above: the engine routes the
  // epilogue on the same full-log values (engine.ts:402,:416), so a restart
  // genuinely does not re-run reconcile and the display agrees.
  if (state.prState === 'conflicted' || state.reconcileAttempts > 0) {
    steps.push(
      step(
        'reconcile',
        state.reconcileAttempts > 0 && state.prState !== 'conflicted',
        at('reconcile'),
        {
          count: state.reconcileAttempts > 1 ? state.reconcileAttempts : undefined,
          // Full-log scope (sinceSeq 0), matching reconcile's full-log
          // done/current predicate: the epilogue is restart-orthogonal.
          timing: timingFor(intervals, 'reconcile', 0, frozenNow),
        },
      ),
    )
  }

  // Merge is never `done` for a LISTED build — a merged build is `done` and
  // filtered out above. It is `current` exactly when the engine would return
  // `wait{awaiting-pr}`: the PR is open and every piece of work behind it has
  // drained. `prState === 'open'` alone is not enough — it is set at
  // `finalize.completed` AND again at `reconcile.completed`, both with real
  // work outstanding.
  const mergeCurrent =
    finalizeDone &&
    state.prState === 'open' &&
    verifyDrained &&
    postStepsDrained &&
    activePhase === undefined
  // Merge-ready start = the log's last-event ts: once the build drains the
  // engine parks on `wait{awaiting-pr}` and appends nothing, so `lastEvent.ts`
  // is exactly when it became merge-ready, ticking like a running phase (AC 9).
  // Frozen at that same ts when the build is not running.
  const lastMs = state.lastEvent !== undefined ? Date.parse(state.lastEvent.ts) : 0
  const mergeTiming: StepTiming | undefined = !mergeCurrent
    ? undefined
    : frozenNow !== undefined
      ? { accumulatedMs: Math.max(0, frozenNow - lastMs) }
      : { accumulatedMs: 0, runningSince: lastMs }
  steps.push(step('merge', false, mergeCurrent, { qualifier: 'waiting', timing: mergeTiming }))

  return {
    slug: record.slug,
    status,
    alsoPaused: state.status === 'paused' && status === 'blocked',
    ...(record.ticket?.id !== undefined ? { ticketId: record.ticket.id } : {}),
    steps,
    blockers: state.openEscalations.map((e) => e.question),
    ...(state.pr !== undefined && state.prState !== undefined
      ? { pr: { url: state.pr.url, state: state.prState } }
      : {}),
  }
}

/** Every active build, sorted by slug — a stable frame, so a redraw never
 * reorders rows under the operator's eyes. */
export function buildDashboard(
  entries: { record: BuildRecord; state: BuildState; events: AbEvent[] }[],
  config: Config,
  header: { repo: string; mode: 'watch' | 'once'; capacity: number },
): DashboardModel {
  const builds = entries
    .map(({ record, state, events }) => projectBuild(record, state, config, events))
    .filter((build): build is DashboardBuild => build !== null)
    .sort((a, b) => a.slug.localeCompare(b.slug))
  return { ...header, builds }
}
