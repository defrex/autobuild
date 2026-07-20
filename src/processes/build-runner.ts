/**
 * The build-runner process (SPEC §3.3): one per build, owns one pipeline
 * execution end to end. The kernel's job reduced to a loop (§8): read the
 * event log, ask `decideNext` for the next move, execute it — start sessions,
 * run check commands, append the events execution produces — and ask again.
 * All judgment lives in the skills behind the AgentRunner; everything here is
 * deterministic plumbing (constitution §2.1). That split makes the runner
 * crash-safe by construction: killed mid-phase, a re-attached runner re-reads
 * the log and `decideNext` re-decides the same started-but-unterminated phase
 * from its start (§15.6-C) — resumability is not a feature (§2.2).
 *
 * Ownership: `attach` claims the build's lease (§7.4) so a second sandbox can
 * never execute the same build, and a heartbeat interval keeps it (liveness
 * is mutable columns, never events — §15.2.6). `run` exits when the build
 * parks (§11: a parked build's runner exits; cron re-attaches when
 * actionable). Nothing is released on exit — leases expire on their own and
 * the dispatcher's sweep re-attaches (§15.6-C).
 *
 * Documented pragmatisms (where SPEC forces are in tension, the choice and
 * its reason live here):
 *
 * - Producer session memory (§10) vs per-run transcripts (§7.1). The producer
 *   must *continue* its session across review rounds, but `AgentRunner.end`
 *   destroys continuability in every adapter. A SUCCESSFUL producer run
 *   therefore keeps its runner session live and closes its per-round
 *   session bracket with the turn's own transcript (final text + usage,
 *   straight off the AgentRunner interface — still "through the interface",
 *   §9, never scraped). The handle is truly `end()`ed when the phase later
 *   fails (a rambling session is never continued — fresh start next attempt,
 *   D5) or when `run` exits; the cumulative turn log is discarded then,
 *   because every round already deposited its own transcript.
 * - `finalize.step-completed` and `observation.recorded` admit only agent
 *   actors (§15.3), so the runner records a post-step's outcome on the
 *   session's behalf using the session's own agent actor.
 * - The D5 retry guard also covers agent-verify steps (keyed `verify:<step>`,
 *   round = attempt): a no-terminal or provider-failed verify session would
 *   otherwise re-run forever, since its `verify.completed` never lands.
 * - A throwing Exec in `run-check` propagates: deterministic checks carry no
 *   session to fail (§8.2), and a crashed runner's dangling `verify.started`
 *   simply re-runs the check on re-attach (§15.6-C) — the same crash model
 *   as every phase.
 */
import type { Config } from '../config/schema'
import type { AbEvent, EventWrite } from '../events/catalog'
import { KERNEL, agentActor } from '../events/envelope'
import type { IdSource } from '../ids'
import { decideNext, type Decision } from '../kernel/engine'
import { PHASE_SPECS } from '../kernel/phases'
import { reduceBuild, type BuildState } from '../kernel/reducer'
import { evaluateVerifyApplicability } from '../kernel/verify-applicability'
import {
  verifyPhase,
  verifyReportKind,
  type CorePhase,
  type Feedback,
  type Phase,
} from '../ontology'
import { createRuntimeResolver, type RuntimeResolver } from '../ports/runner/routing'
import type { RuntimeRegistry } from '../ports/runner/runtime'
import { installedSkillName } from '../skills'
import type {
  AgentRunner,
  AgentSessionHandle,
  AgentTurnResult,
} from '../ports/types'
import type { Exec } from '../ports/workspace/git-worktree'
import type { BuildStore, Clock } from '../store/types'

// ── Seams ────────────────────────────────────────────────────────────────────

/**
 * Dev-server lifecycle seam (§16.2, D10): config declares, the kernel owns.
 * The runner depends only on this narrow interface — bin wiring adapts the
 * real server control (src/kernel/server.ts / src/cli/server-control.ts) to
 * it; tests inject a journaling fake.
 */
export interface ServerLifecycle {
  ensureStarted(): Promise<void>
  stop(): Promise<void>
}

/** Another sandbox owns the build (§7.4): its lease is live, so this runner
 * must not execute. The dispatcher retries once the lease expires. */
export class LeaseHeldError extends Error {
  constructor(
    readonly slug: string,
    readonly instance: string,
  ) {
    super(
      `build "${slug}" is leased to another runner — instance "${instance}" ` +
        'cannot attach while the holder is live (§7.4)',
    )
    this.name = 'LeaseHeldError'
  }
}

export interface BuildRunnerOpts {
  /** D5 retry policy: phase.failed count per phase+round before a policy
   * escalation replaces the next run (never loop forever). Default 2. */
  maxPhaseAttempts?: number
  /** Lease keep-alive interval (§15.2.6). Default 15s. */
  heartbeatMs?: number
  /** Lease TTL passed to claimLease (§7.4). Default 60s. */
  leaseTtlMs?: number
}

export interface BuildRunnerDeps {
  store: BuildStore
  config: Config
  /** Runtime registry: name → adapter + compatibility data (§9). The resolver
   * applies `config.roles`, including its reserved `default` entry, to it. */
  runtimes: RuntimeRegistry
  /** Wiring fallback runtime (e.g. `claude`) when neither a phase role nor
   * `[roles.default]` names one (§9). */
  defaultRuntime: string
  workspacePath: string
  branch: string
  slug: string
  /** Shell seam for deterministic checks (§8.2). */
  exec: Exec
  server?: ServerLifecycle
  ids: IdSource
  clock: Clock
  /** Lease holder identity (§7.4) and `runner.attached` payload (§15.3). */
  instance: string
  host: string
  /** Extra AB_* the launcher wants in every session env (e.g. AB_TOKEN,
   * AB_STORE for a remote store) — D8. May override AB_STORE; never the
   * per-session identity keys (AB_BUILD/AB_PHASE/AB_SESSION). */
  sessionEnv?: Record<string, string>
  opts?: BuildRunnerOpts
}

// ── Internal shapes ──────────────────────────────────────────────────────────

type RunPhaseDecision = Extract<Decision, { kind: 'run-phase' }>
type RunCheckDecision = Extract<Decision, { kind: 'run-check' }>
type RunAgentVerifyDecision = Extract<Decision, { kind: 'run-agent-verify' }>
type EvaluateVerifyDecision = Extract<Decision, { kind: 'evaluate-verify' }>
type RunFinalizeStepDecision = Extract<Decision, { kind: 'run-finalize-step' }>
type RaiseEscalationDecision = Extract<Decision, { kind: 'raise-escalation' }>

/** §10 memory: a producer's live runner session, kept across review rounds. */
interface ProducerSession {
  handle: AgentSessionHandle
  runner: AgentRunner
}

/** One bracketed agent run (§15.3 sessions). */
interface SessionSpec {
  /** Event/AB_PHASE identity: core phase or `verify:<step>`. */
  phase: Phase
  /** Loop round; verify attempt (AB_PHASE uses attempt as round); 1 for
   * finalize. */
  round: number
  role: string
  skill: string
  abPhase: string
  /** Set for producer core phases — §10 session memory applies. */
  producerPhase?: CorePhase
  /** Rendered into the continue message; the CLI context (`ab context`) is
   * the real carrier — the message just names the .ab/ inputs. */
  feedback?: Feedback
  /** phase.failed count for this phase+round at decision time (D5). */
  priorFailures: number
  /** Phase-specific terminal recognizer; the session-scoped `escalation.
   * raised` terminal (§8.4: escalate is always available) is added here. */
  isTerminal: (event: AbEvent) => boolean
}

/** Longest tail of check output preserved in a verify report (§8.2). */
const REPORT_TAIL_CHARS = 10_000
/** Git object ids are 40 hex characters for SHA-1 repositories and 64 for
 * SHA-256 repositories. `rev-parse <ref>^{commit}` supplies the type check. */
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Select the durable tree against which a conditional verifier evaluates the
 * branch's current HEAD. The initial branch-cut SHA is authoritative until a
 * successful reconcile; each completed reconcile promotes the latest start's
 * refreshed base SHA. A dangling start is intentionally ignored.
 */
export function selectVerifyDiffBase(events: readonly AbEvent[]): string {
  const provisioned = events.find((event) => event.type === 'workspace.provisioned')
  if (provisioned === undefined || provisioned.type !== 'workspace.provisioned') {
    throw new Error(
      'conditional verify requires a workspace.provisioned base SHA, but this build has none',
    )
  }

  let baseSha = provisioned.payload.base.sha
  let pendingReconcileBase: string | undefined
  for (const event of events) {
    if (event.type === 'reconcile.started') {
      pendingReconcileBase = event.payload.baseSha
    } else if (event.type === 'reconcile.completed') {
      if (pendingReconcileBase !== undefined) baseSha = pendingReconcileBase
      pendingReconcileBase = undefined
    }
  }
  return baseSha
}

/** Parse `git diff --name-only -z`; malformed output fails closed. */
export function parseNulChangedPaths(output: string): string[] {
  if (output.length === 0) return []
  if (!output.endsWith('\0')) {
    throw new Error('git diff --name-only -z returned non-NUL-terminated output')
  }
  const paths = output.slice(0, -1).split('\0')
  if (paths.some((path) => path.length === 0)) {
    throw new Error('git diff --name-only -z returned an empty path entry')
  }
  return paths
}

/** Terminal events of loop phases carry `round`; finalize.completed and
 * reconcile.completed do not (§15.3). Payloads are schema-validated at
 * append, so the loose read is safe. */
function roundMatches(event: AbEvent, round: number): boolean {
  const r = (event.payload as { round?: unknown }).round
  return typeof r !== 'number' || r === round
}

/**
 * The producer's round-N+1 prompt (§10): assembled deterministically from
 * the feedback, naming the .ab/ inputs `ab context` materializes (§8.3) —
 * the message is a pointer, the CLI context is the real carrier.
 */
function continueMessage(spec: SessionSpec): string {
  const refresh =
    'run `ab context` to refresh .ab/, then finish with your terminal command'
  const { feedback } = spec
  if (feedback === undefined) {
    return `Continue ${spec.phase} (round ${spec.round}): ${refresh}.`
  }
  if ('findings' in feedback) {
    return (
      `Revise ${spec.phase} (round ${spec.round}): address findings ` +
      `${feedback.findings.join(', ')} — materialized in .ab/findings.json; ${refresh}.`
    )
  }
  if ('verify' in feedback) {
    return (
      `verify:${feedback.verify.step} failed — its report ` +
      `(${feedback.verify.report.kind}@${feedback.verify.report.rev}) is in ` +
      `.ab/verify/; fix in ${spec.phase} round ${spec.round}, ${refresh}.`
    )
  }
  return (
    `Human guidance on escalation ${feedback.guidance.escalation} (authoritative, ` +
    `§15.6-B): ${feedback.guidance.answer} — inputs in .ab/; ${refresh}.`
  )
}

// ── The runner ───────────────────────────────────────────────────────────────

export class BuildRunner {
  private readonly maxPhaseAttempts: number
  private readonly heartbeatMs: number
  private readonly leaseTtlMs: number
  private attached = false
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  /** Set when a heartbeat reports the lease lapsed (§7.4): the store never
   * renews an expired lease, so the holder must re-claim before doing any
   * more work — or stop, because the sweep may already have launched a
   * replacement runner (§15.6-C). */
  private leaseLost = false
  /** §10 producer session memory — in-memory by design: a new sandbox resumes
   * with fresh sessions rehydrated from the store (§7.4, §9). */
  private readonly producerSessions = new Map<CorePhase, ProducerSession>()
  /** The role resolver (§9), built EAGERLY: a bad config (unregistered runtime
   * or an incompatible merged runtime/model pair) throws here — the per-build
   * loud-failure site — before any session launches. */
  private readonly resolver: RuntimeResolver

  constructor(private readonly deps: BuildRunnerDeps) {
    this.maxPhaseAttempts = deps.opts?.maxPhaseAttempts ?? 2
    this.heartbeatMs = deps.opts?.heartbeatMs ?? 15_000
    this.leaseTtlMs = deps.opts?.leaseTtlMs ?? 60_000
    this.resolver = createRuntimeResolver(
      deps.runtimes,
      deps.config.roles,
      deps.defaultRuntime,
    )
  }

  /**
   * Claim the lease (§7.4), announce the attachment (§15.3 `runner.attached`,
   * with `resumedFromSeq` when resuming a non-empty log), start the
   * heartbeat, and run `[commands].setup` (§16.1: after workspace provision
   * and after sandbox rehydrate — §15.6-C) so dependencies exist before any
   * phase or check touches the worktree. Throws LeaseHeldError when another
   * sandbox owns the build; throws on a failing setup (an infra failure —
   * the lease expires and the sweep retries, never a bogus verify report).
   */
  async attach(): Promise<void> {
    const { store, slug, instance, host } = this.deps
    const claimed = await store.claimLease(slug, instance, this.leaseTtlMs)
    if (!claimed) throw new LeaseHeldError(slug, instance)

    const events = await store.getEvents(slug)
    const lastSeq = events.at(-1)?.seq ?? 0
    await store.append(slug, {
      actor: KERNEL,
      type: 'runner.attached',
      payload: {
        instance,
        host,
        ...(lastSeq > 0 ? { resumedFromSeq: lastSeq } : {}),
      },
    } satisfies EventWrite<'runner.attached'>)

    // First beat immediately (liveness visible without waiting an interval),
    // then keep-alive; unref'd so a forgotten timer never pins the process.
    // A false beat is a LAPSED lease, not an outage: the store only renews
    // live leases the caller holds (§15.2.6), so the flag stops this runner
    // before it executes alongside the sweep's replacement (§7.4).
    await store.heartbeat(slug, instance)
    this.heartbeatTimer = setInterval(() => {
      store.heartbeat(slug, instance).then(
        (alive) => {
          if (!alive) this.leaseLost = true
        },
        () => {
          // Store unreachable — the next beat retries; the lease TTL is the
          // real liveness contract (§15.2.6).
        },
      )
    }, this.heartbeatMs)
    this.heartbeatTimer.unref?.()
    this.attached = true

    // §16.1 [D9]: `setup` (e.g. "bun install") runs after provision and after
    // every rehydrate — a fresh worktree/sandbox has no dependencies, and
    // running verify without them routes a bogus infra report into the code
    // loop (§15.6-A). Idempotent by convention, so re-attach re-runs it.
    // After the heartbeat starts, so a slow install cannot outlive the lease.
    const setup = this.deps.config.commands['setup']
    if (setup !== undefined) {
      try {
        const result = await this.deps.exec(['sh', '-c', setup], {
          cwd: this.deps.workspacePath,
        })
        if (result.exitCode !== 0) {
          const output = [result.stderr, result.stdout].filter((s) => s !== '').join('\n')
          throw new Error(
            `[commands].setup "${setup}" exited ${result.exitCode} (§16.1): ` +
              `${output.trim() || '(no output)'}`,
          )
        }
      } catch (error) {
        this.stopHeartbeat()
        this.attached = false
        throw error
      }
    }
  }

  /**
   * One read→decide→execute cycle (§8): the unit-test surface. Returns the
   * decision it executed; `wait` decisions execute nothing.
   */
  async step(): Promise<Decision> {
    const { store, config, slug } = this.deps
    const events = await store.getEvents(slug)
    const decision = decideNext(events, config)
    switch (decision.kind) {
      case 'wait':
        return decision
      case 'acknowledge':
        await this.acknowledge(decision.command)
        return decision
      case 'raise-escalation':
        await this.raiseEscalation(decision)
        return decision
      case 'run-phase':
        await this.runPhase(decision, events)
        return decision
      case 'run-check':
        await this.runCheck(decision)
        return decision
      case 'run-agent-verify':
        await this.runAgentVerify(decision, events)
        return decision
      case 'evaluate-verify':
        await this.evaluateVerify(decision, events)
        return decision
      case 'run-finalize-step':
        await this.runFinalizeStep(decision)
        return decision
    }
  }

  /**
   * The pipeline loop (§8): attach if needed, step until the build parks
   * (`wait/*` — §11), return the final reduced state. Releases nothing on
   * exit (leases expire; the dispatcher re-attaches) but stops the heartbeat,
   * closes any live producer sessions (their per-round transcripts are
   * already deposited — see module doc), and stops the dev server
   * best-effort.
   */
  async run(): Promise<BuildState> {
    if (!this.attached) await this.attach()
    try {
      for (;;) {
        await this.ensureLease()
        const decision = await this.step()
        if (decision.kind === 'wait') break
      }
      return reduceBuild(await this.deps.store.getEvents(this.deps.slug))
    } finally {
      this.stopHeartbeat()
      await this.closeProducerSessions()
      if (this.deps.server !== undefined) {
        try {
          await this.deps.server.stop()
        } catch {
          // Best-effort teardown; D10's per-phase finally already ran.
        }
      }
    }
  }

  /**
   * §7.4 exclusivity, holder side: a lapsed lease means the sweep may already
   * have launched a replacement, so this runner must re-claim before doing
   * any more work. claimLease succeeds when the lease is expired or unheld
   * (nobody took over — carry on) and fails when a live replacement holds it
   * (stop: LeaseHeldError, mirroring attach). Checked at every loop boundary;
   * work already in flight when the lapse happened cannot be interrupted, but
   * nothing further executes without the lease.
   */
  private async ensureLease(): Promise<void> {
    if (!this.leaseLost) return
    const { store, slug, instance } = this.deps
    const reclaimed = await store.claimLease(slug, instance, this.leaseTtlMs)
    if (!reclaimed) throw new LeaseHeldError(slug, instance)
    this.leaseLost = false
  }

  // ── Decision execution ─────────────────────────────────────────────────────

  /** D2: humans append `*-requested`; the kernel acknowledges with facts. */
  private async acknowledge(command: 'pause' | 'resume' | 'abort'): Promise<void> {
    const { store, slug } = this.deps
    if (command === 'pause') {
      await store.append(slug, { actor: KERNEL, type: 'build.paused', payload: {} })
    } else if (command === 'resume') {
      await store.append(slug, { actor: KERNEL, type: 'build.resumed', payload: {} })
    } else {
      await store.append(slug, { actor: KERNEL, type: 'build.aborted', payload: {} })
    }
  }

  /** Stall/policy thresholds live in the engine (§15.4); the runner stamps
   * the id (§15.4: ids are kernel-assigned) and appends the fact. */
  private async raiseEscalation(decision: RaiseEscalationDecision): Promise<void> {
    const { store, slug, ids } = this.deps
    await store.append(slug, {
      actor: KERNEL,
      type: 'escalation.raised',
      payload: {
        id: ids('esc'),
        phase: decision.phase,
        ...(decision.round !== undefined ? { round: decision.round } : {}),
        source: decision.source,
        question: decision.question,
        ...(decision.refs !== undefined ? { refs: decision.refs } : {}),
      },
    } satisfies EventWrite<'escalation.raised'>)
  }

  /** A core-phase run: retry guard (D5), started event (§15.3), session. */
  private async runPhase(decision: RunPhaseDecision, events: AbEvent[]): Promise<void> {
    const { store, slug } = this.deps
    const { phase, round } = decision

    // D5 RETRY GUARD first: at the cap, escalate instead of running — a
    // failing phase must never loop forever.
    const failures = this.phaseFailures(events, phase, round)
    if (failures.count >= this.maxPhaseAttempts) {
      await this.raisePolicyExhausted(phase, round, failures)
      return
    }
    if (failures.lastWillRetry === false) {
      await this.raisePolicyNonRetryable(phase, round, failures)
      return
    }

    // A conflict's recorded baseSha is an observation-time snapshot. Resolve
    // the build's frozen base branch again at the actual execution boundary,
    // after the retry guard but before reconcile.started/the agent session.
    // A crash re-enters this path at the same attempt and refreshes again.
    let reconcileBaseSha: string | undefined
    if (phase === 'reconcile') {
      try {
        reconcileBaseSha = await this.refreshReconcileBase(events)
      } catch (error) {
        await this.failPhase(
          phase,
          round,
          failures.count,
          `failed to refresh reconcile base: ${errorMessage(error)}`,
        )
        return
      }
    }

    await store.append(slug, this.startedWrite(decision, reconcileBaseSha))

    const spec = PHASE_SPECS[phase]
    await this.executeSession({
      phase,
      round,
      role: phase, // role name = core phase name (§9 routing)
      skill: spec.skill,
      abPhase: `${phase}@${round}`, // reconcile: decision.round IS the attempt
      ...(spec.kind === 'producer' ? { producerPhase: phase } : {}),
      ...(decision.feedback !== undefined ? { feedback: decision.feedback } : {}),
      priorFailures: failures.count,
      isTerminal: (event) =>
        event.type === spec.terminalEvent && roundMatches(event, round),
    })
  }

  /**
   * Resolve the current remote tip of this build's immutable base branch.
   *
   * The fetch target is build-scoped and internal: concurrent worktrees share
   * one Git common directory, so FETCH_HEAD or a shared remote-tracking ref
   * would let another build overwrite the object this attempt resolves. The
   * explicit ref also makes the fetched remote-only commit available locally.
   */
  private async refreshReconcileBase(events: AbEvent[]): Promise<string> {
    const created = events.find((event) => event.type === 'build.created')
    if (created === undefined || created.type !== 'build.created') {
      throw new Error(
        'this build has no build.created event — cannot resolve its frozen baseBranch (§15.3)',
      )
    }

    const sourceRef = `refs/heads/${created.payload.baseBranch}`
    const targetRef = `refs/autobuild/reconcile/${this.deps.slug}/base`
    const fetchArgs = [
      'git',
      'fetch',
      '--no-tags',
      '--no-write-fetch-head',
      'origin',
      `+${sourceRef}:${targetRef}`,
    ]
    const fetched = await this.deps.exec(fetchArgs, { cwd: this.deps.workspacePath })
    if (fetched.exitCode !== 0) {
      throw new Error(
        `${fetchArgs.join(' ')} exited ${fetched.exitCode}: ` +
          `${fetched.stderr.trim() || fetched.stdout.trim() || '(no output)'}`,
      )
    }

    const resolveArgs = ['git', 'rev-parse', '--verify', `${targetRef}^{commit}`]
    const resolved = await this.deps.exec(resolveArgs, { cwd: this.deps.workspacePath })
    const sha = resolved.stdout.trim()
    if (resolved.exitCode !== 0 || !GIT_OBJECT_ID.test(sha)) {
      throw new Error(
        `${resolveArgs.join(' ')} did not resolve a commit SHA: ` +
          `${resolved.stderr.trim() || sha || '(no output)'}`,
      )
    }
    return sha
  }

  /**
   * Resolve a conditional verifier against the live branch diff. Exclusion is
   * a canonical kernel-authored skip and launches no command, session, or
   * server. Inclusion delegates to the existing verifier path unchanged.
   */
  private async evaluateVerify(
    decision: EvaluateVerifyDecision,
    events: AbEvent[],
  ): Promise<void> {
    const { exec, workspacePath, store, slug } = this.deps
    const baseSha = selectVerifyDiffBase(events)
    const args = [
      'git',
      'diff',
      '--no-renames',
      '--name-only',
      '-z',
      baseSha,
      'HEAD',
      '--',
    ]
    const result = await exec(args, { cwd: workspacePath })
    if (result.exitCode !== 0) {
      throw new Error(
        `${args.join(' ')} exited ${result.exitCode}: ` +
          `${result.stderr.trim() || result.stdout.trim() || '(no output)'}`,
      )
    }
    const changedPaths = parseNulChangedPaths(result.stdout)
    const applicability = evaluateVerifyApplicability(
      { kind: 'paths', step: decision.step, paths: decision.paths },
      changedPaths,
    )
    if (!applicability.applies) {
      await store.append(slug, {
        actor: KERNEL,
        type: 'verify.started',
        payload: { step: decision.step, attempt: decision.attempt },
      } satisfies EventWrite<'verify.started'>)
      await store.append(slug, {
        actor: KERNEL,
        type: 'verify.completed',
        payload: {
          step: decision.step,
          attempt: decision.attempt,
          outcome: 'skipped',
          reason: applicability.reason,
        },
      } satisfies EventWrite<'verify.completed'>)
      return
    }

    if (decision.action.kind === 'run-check') {
      await this.runCheck(decision.action)
    } else {
      await this.runAgentVerify(decision.action, events)
    }
  }

  /** Deterministic check (§8.2): NO session, NO CLI — the kernel runs the
   * command directly; a failure deposits the output tail as the report. */
  private async runCheck(decision: RunCheckDecision): Promise<void> {
    const { store, slug, exec, workspacePath } = this.deps
    const { step, command, attempt } = decision
    await store.append(slug, {
      actor: KERNEL,
      type: 'verify.started',
      payload: { step, attempt },
    } satisfies EventWrite<'verify.started'>)

    const result = await exec(['sh', '-c', command], { cwd: workspacePath })
    if (result.exitCode === 0) {
      await store.append(slug, {
        actor: KERNEL,
        type: 'verify.completed',
        payload: { step, attempt, outcome: 'pass' },
      } satisfies EventWrite<'verify.completed'>)
      return
    }

    const output = [result.stdout, result.stderr].filter((s) => s !== '').join('\n')
    const content =
      output.length > REPORT_TAIL_CHARS ? output.slice(-REPORT_TAIL_CHARS) : output
    // Atomic deposit (D6): report artifact + verify.completed in one bundle;
    // the report routes back to implement via the engine (§15.6-A).
    await store.appendWithArtifacts(
      slug,
      [
        {
          kind: verifyReportKind(step),
          content: content || '(no output)',
          metadata: { step, attempt, command, exitCode: result.exitCode },
        },
      ],
      (deposited) => {
        const meta = deposited[0]
        if (!meta) throw new Error('verify report deposit returned no metadata')
        return {
          actor: KERNEL,
          type: 'verify.completed',
          payload: {
            step,
            attempt,
            outcome: 'fail',
            report: { kind: meta.kind, rev: meta.revision },
          },
        } satisfies EventWrite<'verify.completed'>
      },
    )
  }

  /** Agent-verify step (§5): a session with a pass/fail/skip verdict; the kernel
   * owns the dev server around it (D10). */
  private async runAgentVerify(
    decision: RunAgentVerifyDecision,
    events: AbEvent[],
  ): Promise<void> {
    const { store, slug, server } = this.deps
    const { step, skill, needsServer, attempt } = decision
    const phase = verifyPhase(step)

    // D5 guard, extended to agent-verify (see module doc): keyed by
    // verify:<step> with the verify attempt as the round.
    const failures = this.phaseFailures(events, phase, attempt)
    if (failures.count >= this.maxPhaseAttempts) {
      await this.raisePolicyExhausted(phase, attempt, failures)
      return
    }
    if (failures.lastWillRetry === false) {
      await this.raisePolicyNonRetryable(phase, attempt, failures)
      return
    }
    if (needsServer && server === undefined) {
      // D10: needsServer without a configured server dep is an infra failure
      // with a clear error, not a mystery hang.
      await this.failPhase(
        phase,
        attempt,
        failures.count,
        `verify:${step} has needsServer = true but no server lifecycle is ` +
          'configured — wire a ServerLifecycle into the build-runner or set ' +
          'needsServer = false (SPEC §16.2, D10)',
      )
      return
    }

    await store.append(slug, {
      actor: KERNEL,
      type: 'verify.started',
      payload: { step, attempt },
    } satisfies EventWrite<'verify.started'>)

    try {
      if (needsServer && server !== undefined) {
        try {
          await server.ensureStarted()
        } catch (error) {
          await this.failPhase(
            phase,
            attempt,
            failures.count,
            `dev server failed to start: ${errorMessage(error)}`,
          )
          return
        }
      }
      await this.executeSession({
        phase,
        round: attempt,
        role: skill, // role name = the verify step's skill (§9 routing)
        skill,
        abPhase: `verify:${step}@${attempt}`,
        priorFailures: failures.count,
        isTerminal: (event) =>
          event.type === 'verify.completed' &&
          event.payload.step === step &&
          event.payload.attempt === attempt,
      })
    } finally {
      // D10: the kernel guarantees teardown at phase end, even when the
      // session threw — a dead session can never orphan a server.
      if (needsServer && server !== undefined) {
        try {
          await server.stop()
        } catch {
          // Best-effort.
        }
      }
    }
  }

  /**
   * Failure-tolerant post-step (§5): the outcome is "did the turn complete
   * without throwing or reporting a structured failure". The runner records
   * `finalize.step-completed`
   * (and, on failure, the follow-up observation) on the session's behalf
   * with the session's agent actor — those event types only admit agents
   * (§15.3); pragmatism, documented. Never fails the build.
   */
  private async runFinalizeStep(decision: RunFinalizeStepDecision): Promise<void> {
    const { store, slug, ids, workspacePath } = this.deps
    const { step } = decision
    const session = ids('s')
    const { runner, runtime: runnerName, model, extensions } = this.resolver.resolve(step)

    await store.append(slug, {
      actor: KERNEL,
      type: 'session.started',
      payload: {
        session,
        role: step,
        runner: runnerName,
        ...(model !== undefined ? { model } : {}),
        phase: 'finalize',
        round: 1,
      },
    } satisfies EventWrite<'session.started'>)

    let handle: AgentSessionHandle | undefined
    let ok = true
    try {
      const turn = await runner.start({
        skill: installedSkillName(step), // installed names carry `ab-` (§4)
        invocation: slug,
        buildSlug: slug,
        workspacePath,
        ...(model !== undefined ? { model } : {}),
        ...(extensions !== undefined ? { extensions } : {}),
        env: this.sessionEnvFor('finalize@1', session),
      })
      handle = turn.session
      if (turn.result.kind === 'failed') ok = false
    } catch {
      ok = false
    }

    if (handle !== undefined) {
      try {
        const transcript = await runner.end(handle)
        await this.depositTranscriptAndEnd(
          session,
          { phase: 'finalize', round: 1, role: step, runnerName },
          transcript.content,
          transcript.metadata.usage,
          transcript.metadata.model ?? model,
        )
      } catch {
        // Best-effort: the step outcome below is still recorded.
      }
    }

    const actor = agentActor(step, session)
    await store.append(slug, {
      actor,
      type: 'finalize.step-completed',
      payload: { step, ok },
    } satisfies EventWrite<'finalize.step-completed'>)
    if (!ok) {
      // §5: a failed post-step files an observation; it never kills a green
      // build.
      await store.append(slug, {
        actor,
        type: 'observation.recorded',
        payload: {
          id: ids('o'),
          kind: 'followup',
          summary: `finalize step "${step}" failed — needs manual follow-up`,
        },
      } satisfies EventWrite<'observation.recorded'>)
    }
  }

  // ── The session bracket (§15.3) ────────────────────────────────────────────

  /**
   * One bracketed agent run: `session.started` → turn → terminal check →
   * crash-gap repair → `session.ended` (with transcript) or `phase.failed`.
   * Producer phases with a live handle continue it (§10); reviewers always
   * start fresh (fresh skeptic).
   */
  private async executeSession(spec: SessionSpec): Promise<void> {
    const { store, slug, ids, workspacePath } = this.deps
    const session = ids('s')
    const { runner, runtime: runnerName, model, extensions } = this.resolver.resolve(spec.role)

    const startedEnvelope = await store.append(slug, {
      actor: KERNEL,
      type: 'session.started',
      payload: {
        session,
        role: spec.role,
        runner: runnerName,
        ...(model !== undefined ? { model } : {}),
        phase: spec.phase,
        round: spec.round,
      },
    } satisfies EventWrite<'session.started'>)
    const preSeq = startedEnvelope.seq

    const live =
      spec.producerPhase !== undefined
        ? this.producerSessions.get(spec.producerPhase)
        : undefined

    let handle: AgentSessionHandle | undefined
    let result: AgentTurnResult | undefined
    let turnError: unknown
    try {
      if (live !== undefined) {
        // §10: the producer continues its session; the feedback message
        // points at the .ab/ inputs — `ab context` is the real carrier. The
        // turn re-issues ambient auth (D8) for the NEW bracket — AB_PHASE at
        // this round, AB_SESSION = this bracket's id — so the CLI's terminal
        // lands on the continued round instead of being rejected as round
        // 1's second terminal (§8.4 D5).
        handle = live.handle
        result = await live.runner.continue(handle, continueMessage(spec), {
          env: this.sessionEnvFor(spec.abPhase, session),
        })
      } else {
        const turn = await runner.start({
          skill: spec.skill,
          invocation: slug,
          buildSlug: slug,
          workspacePath,
          ...(model !== undefined ? { model } : {}),
          ...(extensions !== undefined ? { extensions } : {}),
          env: this.sessionEnvFor(spec.abPhase, session),
        })
        handle = turn.session
        result = turn.result
      }
    } catch (error) {
      turnError = error
    }

    // The turn is over: what did the CLI leave in the log? Terminal = the
    // phase's terminal event for this round, or an `ab escalate` from this
    // session (§8.4: escalate is always an allowed terminal).
    const since = await store.getEvents(slug, preSeq)
    const terminal =
      turnError === undefined &&
      since.some(
        (event) =>
          spec.isTerminal(event) ||
          (event.type === 'escalation.raised' &&
            event.actor.kind === 'agent' &&
            event.actor.session === session),
      )

    // CRASH-GAP REPAIR (§8.5 makes verdict+escalation near-atomic; this keeps
    // the log routable when the CLI died between the two).
    if (spec.phase === 'plan-review' || spec.phase === 'code-review') {
      await this.repairEscalateGap(since, spec.phase, spec.round)
    }

    const bracket = {
      phase: spec.phase,
      round: spec.round,
      role: spec.role,
      runnerName,
    }

    if (terminal && handle !== undefined && result !== undefined) {
      if (spec.producerPhase !== undefined) {
        // §10 memory: keep the handle live for the next round; the bracket
        // closes with THIS turn's transcript (see module doc — ending the
        // runner session would destroy the continuation every adapter needs).
        this.producerSessions.set(spec.producerPhase, {
          handle,
          runner: live?.runner ?? runner,
        })
        const content = JSON.stringify(
          {
            session,
            phase: spec.phase,
            round: spec.round,
            note:
              'producer session kept live for §10 continuation; ' +
              'per-round turn transcript',
            turn: { text: result.text, usage: result.usage },
          },
          null,
          2,
        )
        await this.depositTranscriptAndEnd(session, bracket, content, result.usage, model)
      } else {
        // Reviewer / agent-verify: single-run session, real transcript.
        const transcript = await runner.end(handle)
        await this.depositTranscriptAndEnd(
          session,
          bracket,
          transcript.content,
          transcript.metadata.usage,
          transcript.metadata.model ?? model,
        )
      }
      return
    }

    // No terminal, a structured failed turn, or a throw: an infra failure,
    // not a verdict (§8.4). End whatever session exists — the transcript still
    // joins the corpus —
    // then record the failure and drop the producer handle: a rambling
    // session is not continued; the next attempt starts fresh (D5).
    if (handle !== undefined) {
      const owner = live?.runner ?? runner
      try {
        const transcript = await owner.end(handle)
        await this.depositTranscriptAndEnd(
          session,
          bracket,
          transcript.content,
          transcript.metadata.usage,
          transcript.metadata.model ?? model,
        )
      } catch {
        // A dead session's `session.ended` never arrives (§15.6-C).
      }
    }
    if (spec.producerPhase !== undefined) {
      this.producerSessions.delete(spec.producerPhase)
    }
    const failure =
      turnError !== undefined
        ? { message: errorMessage(turnError), mayRetry: true }
        : result?.kind === 'failed'
          ? {
              message: result.failure.message,
              mayRetry: !result.failure.permanent,
            }
          : { message: 'no-terminal', mayRetry: true }
    await this.failPhase(
      spec.phase,
      spec.round,
      spec.priorFailures,
      failure.message,
      failure.mayRetry,
    )
  }

  /** Transcript artifact + `session.ended` in one atomic bundle (D6). The
   * metadata IS the analysis corpus (§7.1): phase, round, role, runner,
   * model, session, usage. */
  private async depositTranscriptAndEnd(
    session: string,
    bracket: { phase: Phase; round: number; role: string; runnerName: string },
    content: string,
    usage: { inputTokens: number; outputTokens: number; turns: number },
    model?: string,
  ): Promise<void> {
    const { store, slug } = this.deps
    await store.appendWithArtifacts(
      slug,
      [
        {
          kind: 'transcript',
          content,
          metadata: {
            phase: bracket.phase,
            round: bracket.round,
            role: bracket.role,
            runner: bracket.runnerName,
            ...(model !== undefined ? { model } : {}),
            session,
            usage,
          },
        },
      ],
      (deposited) => {
        const meta = deposited[0]
        if (!meta) throw new Error('transcript deposit returned no metadata')
        return {
          actor: KERNEL,
          type: 'session.ended',
          payload: {
            session,
            transcript: { kind: meta.kind, rev: meta.revision },
            usage,
          },
        } satisfies EventWrite<'session.ended'>
      },
    )
  }

  /** A review verdict 'escalate' whose `escalation.raised` never landed →
   * append it (kernel actor, source 'agent', question from the reason). */
  private async repairEscalateGap(
    since: AbEvent[],
    phase: 'plan-review' | 'code-review',
    round: number,
  ): Promise<void> {
    let verdict: { seq: number; reason?: string } | undefined
    for (const event of since) {
      if (event.type !== 'plan-review.verdict' && event.type !== 'code-review.verdict') {
        continue
      }
      const expected = phase === 'plan-review' ? 'plan-review.verdict' : 'code-review.verdict'
      if (event.type !== expected) continue
      if (event.payload.round !== round || event.payload.verdict !== 'escalate') continue
      verdict = { seq: event.seq, ...(event.payload.reason !== undefined ? { reason: event.payload.reason } : {}) }
    }
    if (verdict === undefined) return
    const raisedSeq = verdict.seq
    if (since.some((e) => e.type === 'escalation.raised' && e.seq > raisedSeq)) return
    await this.deps.store.append(this.deps.slug, {
      actor: KERNEL,
      type: 'escalation.raised',
      payload: {
        id: this.deps.ids('esc'),
        phase,
        round,
        source: 'agent',
        question: verdict.reason ?? `${phase} escalated without a recorded reason`,
      },
    } satisfies EventWrite<'escalation.raised'>)
  }

  // ── Small helpers ──────────────────────────────────────────────────────────

  /** D8 ambient auth: sessionEnv may override AB_STORE (remote stores) and
   * add AB_TOKEN, but never the per-session identity keys. */
  private sessionEnvFor(abPhase: string, session: string): Record<string, string> {
    return {
      AB_STORE: 'local',
      ...this.deps.sessionEnv,
      AB_BUILD: this.deps.slug,
      AB_PHASE: abPhase,
      AB_SESSION: session,
    }
  }

  /**
   * phase.failed tally for one phase+round — D5's retry-guard input.
   *
   * An answered escalation for this phase RE-ARMS the budget (§15.6-B): the
   * count restarts at the answer, so the next run actually executes with the
   * human's guidance as feedback. Without the reset, a maxPhaseAttempts raise
   * would re-raise on every answer forever — the count never changes, the
   * guard fires before the session starts, and the designed recovery channel
   * (answer → next producer round) deadlocks. Failures AFTER the answer count
   * again, so a still-failing phase re-escalates on new evidence — the same
   * dedupe-and-re-arm shape as the engine's `raisedAfter` policy raises.
   */
  private phaseFailures(
    events: AbEvent[],
    phase: Phase,
    round: number,
  ): { count: number; lastError?: string; lastWillRetry?: boolean } {
    /** id → the raise's {phase, round} — answers are matched by id (§15.3). */
    const raised = new Map<string, { phase: Phase; round?: number }>()
    let count = 0
    let lastError: string | undefined
    let lastWillRetry: boolean | undefined
    for (const event of events) {
      switch (event.type) {
        case 'escalation.raised':
          raised.set(event.payload.id, {
            phase: event.payload.phase,
            ...(event.payload.round !== undefined ? { round: event.payload.round } : {}),
          })
          break
        case 'escalation.answered': {
          const raise = raised.get(event.payload.id)
          // Round-less raises (e.g. the engine's verify-policy raises) reset
          // every round of the phase; the human unblocked the phase itself.
          if (raise?.phase === phase && (raise.round === undefined || raise.round === round)) {
            count = 0
            lastError = undefined
            lastWillRetry = undefined
          }
          break
        }
        case 'phase.failed':
          if (event.payload.phase === phase && event.payload.round === round) {
            count += 1
            lastError = event.payload.error
            lastWillRetry = event.payload.willRetry
          }
          break
        default:
          break
      }
    }
    return {
      count,
      ...(lastError !== undefined ? { lastError } : {}),
      ...(lastWillRetry !== undefined ? { lastWillRetry } : {}),
    }
  }

  private async failPhase(
    phase: Phase,
    round: number,
    priorFailures: number,
    error: string,
    mayRetry = true,
  ): Promise<void> {
    const attempt = priorFailures + 1
    await this.deps.store.append(this.deps.slug, {
      actor: KERNEL,
      type: 'phase.failed',
      payload: {
        phase,
        round,
        attempt,
        error,
        willRetry: mayRetry && attempt < this.maxPhaseAttempts,
      },
    } satisfies EventWrite<'phase.failed'>)
  }

  /** A provider/runner-declared permanent failure parks immediately. The fact
   * comes from the latest durable `phase.failed {willRetry:false}`, so a crash
   * between that write and this escalation resumes safely without attempt 2. */
  private async raisePolicyNonRetryable(
    phase: Phase,
    round: number,
    failures: { count: number; lastError?: string },
  ): Promise<void> {
    await this.deps.store.append(this.deps.slug, {
      actor: KERNEL,
      type: 'escalation.raised',
      payload: {
        id: this.deps.ids('esc'),
        phase,
        round,
        source: 'policy',
        question:
          `${phase} round ${round} stopped after a non-retryable ` +
          `provider/runner failure on attempt ${failures.count}; last error: ` +
          `${failures.lastError ?? 'unknown'}`,
      },
    } satisfies EventWrite<'escalation.raised'>)
  }

  /** D5: the retry cap escalates (source 'policy') instead of running,
   * naming the phase, round, and last error. */
  private async raisePolicyExhausted(
    phase: Phase,
    round: number,
    failures: { count: number; lastError?: string },
  ): Promise<void> {
    await this.deps.store.append(this.deps.slug, {
      actor: KERNEL,
      type: 'escalation.raised',
      payload: {
        id: this.deps.ids('esc'),
        phase,
        round,
        source: 'policy',
        question:
          `${phase} round ${round} failed ${failures.count} times ` +
          `(maxPhaseAttempts ${this.maxPhaseAttempts}); last error: ` +
          `${failures.lastError ?? 'unknown'}`,
      },
    } satisfies EventWrite<'escalation.raised'>)
  }

  /** The phase's started event, payload per the catalog (§15.3). */
  private startedWrite(
    decision: RunPhaseDecision,
    reconcileBaseSha?: string,
  ): EventWrite {
    const { phase, round } = decision
    switch (phase) {
      case 'plan':
        // Feedback rides the started payload exactly like implement (§15.3
        // symmetric by design): a parked plan loop re-attaches with a FRESH
        // session, so `ab context` — not the continue message — is what
        // delivers an answered guidance escalation to the producer (§15.6-B).
        return {
          actor: KERNEL,
          type: 'plan.started',
          payload: {
            round,
            ...(decision.feedback !== undefined ? { feedback: decision.feedback } : {}),
          },
        } satisfies EventWrite<'plan.started'>
      case 'plan-review':
        return {
          actor: KERNEL,
          type: 'plan-review.started',
          payload: { round },
        } satisfies EventWrite<'plan-review.started'>
      case 'implement':
        return {
          actor: KERNEL,
          type: 'implement.started',
          payload: {
            round,
            ...(decision.feedback !== undefined ? { feedback: decision.feedback } : {}),
          },
        } satisfies EventWrite<'implement.started'>
      case 'code-review':
        return {
          actor: KERNEL,
          type: 'code-review.started',
          payload: { round },
        } satisfies EventWrite<'code-review.started'>
      case 'finalize':
        return {
          actor: KERNEL,
          type: 'finalize.started',
          payload: {},
        } satisfies EventWrite<'finalize.started'>
      case 'reconcile': {
        const reconcile = decision.reconcile
        if (reconcile === undefined || reconcileBaseSha === undefined) {
          // The engine supplies the attempt; runPhase resolves the current
          // base before calling this helper. Keep the runner total anyway.
          throw new Error(
            'run-phase reconcile start requires an attempt and refreshed base SHA',
          )
        }
        return {
          actor: KERNEL,
          type: 'reconcile.started',
          payload: { attempt: reconcile.attempt, baseSha: reconcileBaseSha },
        } satisfies EventWrite<'reconcile.started'>
      }
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
  }

  /** End live producer sessions best-effort on exit: every round already
   * deposited its transcript, so the cumulative turn log is discarded; no
   * events are appended (the brackets are already closed). */
  private async closeProducerSessions(): Promise<void> {
    for (const entry of this.producerSessions.values()) {
      try {
        await entry.runner.end(entry.handle)
      } catch {
        // Already dead — nothing to release.
      }
    }
    this.producerSessions.clear()
  }
}
