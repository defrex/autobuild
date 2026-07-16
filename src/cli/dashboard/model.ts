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
 * never touches them. The rules this file mirrors, and the code that owns them:
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
import type { Config } from '../../config/schema'
import type { BuildState, PrLifecycle } from '../../kernel/reducer'
import { verifyPhase } from '../../ontology'
import type { BuildRecord } from '../../store/types'

/** The only statuses a listed build can have — queued/done/aborted are
 * filtered out entirely (they are not active work). */
export type EffectiveStatus = 'running' | 'paused' | 'blocked'

export type StepState = 'done' | 'current' | 'pending'

export interface PipelineStep {
  label: string
  state: StepState
  /** Short qualifier: `r2` (loop round), `a2` (verify attempt), `failed`,
   * `waiting`. Never load-bearing — always redundant with `state`. */
  note?: string
}

export interface DashboardBuild {
  slug: string
  status: EffectiveStatus
  /** True when the build is BOTH paused and blocked: blocked wins the status
   * (the spec's visual override), and this keeps the pause visible so no
   * information is lost. */
  alsoPaused: boolean
  ticketId?: string
  phase?: string
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
 * inconsistently: **`current` wins when both `done` and `current` hold**. This
 * makes "no step is both done and current" true by construction rather than an
 * invariant every row has to remember.
 */
function step(label: string, done: boolean, current: boolean, note?: string): PipelineStep {
  return {
    label,
    state: current ? 'current' : done ? 'done' : 'pending',
    ...(note !== undefined ? { note } : {}),
  }
}

/**
 * `record` + `state` → one dashboard row, or `null` when the build is not
 * active (queued / done / aborted) — this IS the list filter.
 */
export function projectBuild(
  record: BuildRecord,
  state: BuildState,
  config: Config,
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

  // Finalize ran for the CURRENT spec — NOT `prState !== undefined`, which a
  // spec restart never resets while the engine re-runs finalize from scratch.
  const finalizeDone = state.finalizeCompletedSeq > restartSince
  const postStepsDrained = config.finalize.steps.every((s) =>
    finalizeSteps.some((f) => f.step === s),
  )

  const at = (phase: string): boolean => state.currentPhase?.phase === phase
  const planNote = state.plan.round > 1 ? `r${state.plan.round}` : undefined
  const codeNote = state.implement.round > 1 ? `r${state.implement.round}` : undefined

  const steps: PipelineStep[] = [
    step('plan', planDone, at('plan'), planNote),
    step('plan-review', planDone, at('plan-review'), planNote),
    step('implement', codeDone, at('implement'), codeNote),
    step('code-review', codeDone, at('code-review'), codeNote),
  ]

  for (const s of config.verify.steps) {
    const phase = verifyPhase(s)
    const current = at(phase)
    // The attempt note comes from `currentPhase.attempt` — the attempt
    // ACTUALLY running (`verify.started` populates it directly), never
    // `verify.attempt`, which is the max attempt SEEN and names the previous
    // cycle in the window after a boundary move. Rendered only on the running
    // step, so it can never be stale.
    const attempt = state.currentPhase?.attempt
    const note = cycle.some((r) => r.step === s && !r.pass)
      ? 'failed'
      : current && attempt !== undefined && attempt > 1
        ? `a${attempt}`
        : undefined
    // `!cycleFailed &&`: §15.6-A re-runs the cycle FROM THE FIRST STEP, so
    // once any step in the cycle has failed, an earlier step's pass in that
    // same cycle is not durably done either. The failing step keeps a `failed`
    // note so the operator does not lose the information; its STATE is pending
    // because it is genuinely going to re-run.
    steps.push(step(phase, !cycleFailed && verifyPassed(s), current, note))
  }

  steps.push(step('finalize', finalizeDone, at('finalize')))
  for (const s of config.finalize.steps) {
    const done = finalizeSteps.find((f) => f.step === s)
    steps.push(step(s, done !== undefined, false, done?.ok === false ? 'failed' : undefined))
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
        state.reconcileAttempts > 1 ? `a${state.reconcileAttempts}` : undefined,
      ),
    )
  }

  // Merge is never `done` for a LISTED build — a merged build is `done` and
  // filtered out above. It is `current` exactly when the engine would return
  // `wait{awaiting-pr}`: the PR is open and every piece of work behind it has
  // drained. `prState === 'open'` alone is not enough — it is set at
  // `finalize.completed` AND again at `reconcile.completed`, both with real
  // work outstanding.
  steps.push(
    step(
      'merge',
      false,
      finalizeDone &&
        state.prState === 'open' &&
        verifyDrained &&
        postStepsDrained &&
        state.currentPhase === undefined,
      'waiting',
    ),
  )

  const phase = state.currentPhase?.phase ?? state.phase

  return {
    slug: record.slug,
    status,
    alsoPaused: state.status === 'paused' && status === 'blocked',
    ...(record.ticket?.id !== undefined ? { ticketId: record.ticket.id } : {}),
    ...(phase !== undefined ? { phase } : {}),
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
  entries: { record: BuildRecord; state: BuildState }[],
  config: Config,
  header: { repo: string; mode: 'watch' | 'once'; capacity: number },
): DashboardModel {
  const builds = entries
    .map(({ record, state }) => projectBuild(record, state, config))
    .filter((build): build is DashboardBuild => build !== null)
    .sort((a, b) => a.slug.localeCompare(b.slug))
  return { ...header, builds }
}
