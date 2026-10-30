import { StoreWriteTooLargeError } from '../store/remote/errors'
import { observeTarget } from '../kernel/target-observation'
import { readBuildRange } from '../store/event-reads'
import { accountRedactor, redactAccountStore } from '../store/account-redaction'
import {
  capturedBuildConfig,
  refreshVerifyCycle,
  type VerifyPipelineReader,
} from './verify-cycle-config'
import {
  publicationRetryGate,
  retryPublicationEffect,
  PublicationRetryPersistenceError,
} from '../kernel/publication-retry'
import { ForgeRequestDeferred } from '../ports/forge-request-context'
import { verifyMemberKey } from '../kernel/verify-stage-state'
import { contextDirectory } from '../context-directory'
import { reportIntegrationFailures } from '../kernel/integration-attention'
import type { RuntimeIdentity } from '../events/runtime'
import { relaunchTarget } from './execution-relaunch'
import { RUNTIME_IDENTITY } from '../runtime-identity'
import { publishExact } from '../kernel/publication'
import {
  deferMixedVersion,
  MixedVersionDeferral,
  withDrainingExecution,
} from '../kernel/mixed-version'
import { hostname } from 'node:os'
import { resumeAgent } from '../ports/runner/native-session'
import type { AgentStartOpts } from '../ports/types'
import { readTerminalGuardBoundary } from '../store/reduced-reads'
import type { OpenSession } from '../kernel/reducer'
import { nativeSessionHandleSchema } from '../ports/runner/native-session'
import type { NativeSessionObserver } from '../ports/types'
import { suspendNativeLanding } from '../kernel/landing-publication'
import { integrationCurrent } from '../kernel/integration-state'
import { replayNodeChange } from '../kernel/node-restack'
import { restoreReplay } from '../kernel/reconcile-restack'
import { completeAutomaticReconcile } from '../kernel/leaf-restack-completion'
import { isRemoteWorkspace } from '../events/workspace-remote'
import { withBuildTrailer } from '../kernel/build-identity'
import {
  prepareRestack,
  publishRestack,
  retainReplay,
  requireRewrite,
} from '../kernel/reconcile-restack'
import { reconcileHead, reconcileRewriteHead } from '../kernel/reconcile-head'
import { readBuildFacts, readBuildSelector, readPhaseFailures } from '../store/reduced-reads'
import { delegateCredential } from '../store/remote/credentials'
import { refreshSummaryBoundary } from '../cli/pr-summary-publication'
/**
 * The build-runner process (SPEC §3.3): one per build, owns one pipeline
 * execution end to end. The kernel's job reduced to a loop (§8): read the
 * event log, ask `decideNext` for the next move, execute it — start sessions,
 * run check commands, append the events execution produces — and ask again.
 * All judgment lives in the skills behind the AgentRunner; everything here is
 * deterministic plumbing (constitution §2.1). That split makes the runner
 * crash-safe by construction: killed mid-phase, a re-attached runner re-reads
 * the log and continues an eligible local native session, or re-decides the
 * same started-but-unterminated phase from durable inputs (§15.6-C).
 *
 * Ownership: `attach` claims or renews the build's execution lease (§7.4) so a
 * second sandbox can never execute the same build. The local supervising kernel
 * reserves that same holder before launch. The runner may then acknowledge a pending pause or
 * abort without preparing the workspace; workspace-backed work starts a
 * heartbeat interval before setup (liveness is mutable columns, never events
 * — §15.2.6). `run` exits when the build
 * parks (§11: a parked build's runner exits; cron re-attaches when
 * actionable). The runner releases nothing on exit: a local execution supervisor
 * releases ownership after full tree teardown, while abrupt loss falls back to
 * expiry and the dispatcher's sweep re-attaches (§15.6-C).
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
 * - Finalize checks are deterministic kernel work with no synthetic session;
 *   finalize agents retain their session actor. Both paths are deliberately
 *   failure-tolerant and drain through the same completion/observation writer.
 * - The D5 retry guard also covers agent-verify steps (keyed `verify:<step>`,
 *   round = attempt): a no-terminal or provider-failed verify session would
 *   otherwise re-run forever, since its `verify.completed` never lands.
 * - A throwing Exec in `run-check` propagates: deterministic checks carry no
 *   session to fail (§8.2), and a crashed runner's dangling `verify.started`
 *   simply re-runs the check on re-attach (§15.6-C) — the same crash model
 *   as every phase.
 */
import type { Config } from '../config/schema'
import type { AbEvent, EventEnvelope, EventWrite } from '../events/catalog'
import type { EventPayload } from '../events/payloads'
import { KERNEL, agentActor, type Actor } from '../events/envelope'
import type { IdSource } from '../ids'
import { decideNextFromFacts, type Decision } from '../kernel/engine'
import { defineReducer } from '../kernel/incremental'
import { PHASE_SPECS } from '../kernel/phases'
import type { BuildState } from '../kernel/reducer'
import { evaluateVerifyApplicability } from '../kernel/verify-applicability'
import {
  verifyPhase,
  verifyReportKind,
  type CorePhase,
  type Feedback,
  type Phase,
} from '../ontology'
import {
  createRuntimeResolver,
  type ResolvedRole,
  type ResolvedRuntime,
  type RuntimeResolver,
} from '../ports/runner/routing'
import { isAlternateEligible, mayRetryPhase } from '../ports/runner/provider-error'
import { sessionPart } from '../ports/runner/stream-parts'
import type { SessionStreamInfo } from '../ports/runner/runtime'
import type { RuntimeRegistry } from '../ports/runner/runtime'
import { createSessionStreamSink } from '../store/streams/session-writer'
import type { StreamOutcome } from '../store/streams/types'
import type {
  AgentRunner,
  AgentSessionHandle,
  AgentTurnFailure,
  AgentTurnResult,
  Forge,
  SessionStreamSink,
} from '../ports/types'
import { BUILD_EXECUTION_LEASE_TTL_MS } from '../ports/workspace/build-execution'
import { phaseScratchRejection, scratchPathsTouchedInRange } from '../ports/workspace/phase-scratch'
import type { Exec } from '../ports/workspace/git-worktree'
import type { BuildScopedStore, Clock } from '../store/types'
import { resetsPhaseFailureBudget, type PhaseFailureResetEscalation } from './phase-failure-budget'

export { publicationPending } from './publication-state'

// ── Seams ────────────────────────────────────────────────────────────────────

class AutomaticRewriteDeferred extends Error {}
class SessionShutdown extends Error {}
class SessionPaused extends Error {}
class RecoveryBoundaryChanged extends Error {}
class FreshSessionRequired extends Error {}

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

/** Recognizable launch failure whose durable detail is already in the build
 * log. Interactive dispatch therefore renders it on the build row rather than
 * duplicating it in process-global warning chrome. */
export class SetupFailureError extends Error {
  constructor(
    readonly slug: string,
    readonly failure: EventPayload<'runner.setup-failed'>,
    readonly exhausted: boolean,
  ) {
    const status =
      failure.exitStatus === null ? 'exit status unavailable' : `exited ${failure.exitStatus}`
    super(
      `[commands].setup ${JSON.stringify(failure.command)} ${status} ` +
        `(attempt ${failure.attempt}): ${failure.output || '(no output)'}`,
    )
    this.name = 'SetupFailureError'
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
  /** Test seam for phase-session deadlines. Production uses an unref'ed timer. */
  scheduleSessionBudget?: (expire: () => void, delayMs: number) => () => void
  /** Session streams (SPEC §9): open one stream per session bracket for
   * runtimes that declare the streaming capability. Default true. A failing
   * stream path never fails a turn; disabling reproduces the event log
   * without streams. */
  streamSessions?: boolean
  /** Where stream diagnostics land. Default: a stderr write. */
  onDiagnostic?: (message: string) => void
}

export interface BuildRunnerDeps {
  store: BuildScopedStore
  config: Config
  /** Current dispatcher snapshot. It is sampled once for setup and once for
   * each engine/action boundary; omission preserves static runner callers. */
  getConfig?: () => Config | Promise<Config>
  /** Execution checkout reader; supplied by production composition, omitted by static embeddings. */
  readVerifyPipeline?: VerifyPipelineReader
  /** Runtime registry: name → adapter + compatibility data (§9). The resolver
   * applies `config.roles`, including its reserved `default` entry, to it. */
  runtimes: RuntimeRegistry
  /** Immutable identity of this execution distribution; defaults to the loaded runtime. */
  runtimeIdentity?: RuntimeIdentity
  workspacePath: string
  /** Explicit provider eligibility; never inferred from a matching path. */
  workspaceProvider?: string
  workspaceRemote?: boolean
  shutdownSignal?: AbortSignal
  branch: string
  slug: string
  /** Shell seam for deterministic checks and finalize Git guards (§8.2, D7). */
  exec: Exec
  /** Remote publication stays behind the kernel-owned Forge port (D7). */
  forge: Forge
  ids: IdSource
  clock: Clock
  /** Lease holder identity (§7.4) and `runner.attached` payload (§15.3). */
  instance: string
  host: string
  /** Extra AB_* the launcher wants in every session env (e.g. AB_TOKEN,
   * AB_STORE for a remote store) — D8. May override AB_STORE; never the
   * per-session identity keys (AB_BUILD/AB_PHASE/AB_SESSION). */
  delegateCredential?: typeof delegateCredential
  sessionEnv?: Record<string, string>
  opts?: BuildRunnerOpts
}

// ── Internal shapes ──────────────────────────────────────────────────────────

type RunPhaseDecision = Extract<Decision, { kind: 'run-phase' }>
type RunCheckDecision = Extract<Decision, { kind: 'run-check' }>
type RunAgentVerifyDecision = Extract<Decision, { kind: 'run-agent-verify' }>
type EvaluateVerifyDecision = Extract<Decision, { kind: 'evaluate-verify' }>
type SkipVerifyDecision = Extract<Decision, { kind: 'skip-verify' }>
type RunFinalizeStepDecision = Extract<Decision, { kind: 'run-finalize-step' }>
type CheckReconcileProgressDecision = Extract<Decision, { kind: 'check-reconcile-progress' }>
type RaiseEscalationDecision = Extract<Decision, { kind: 'raise-escalation' }>

/** Lease acquisition can finish either workspace-backed attachment or one
 * engine-selected stop acknowledgement that deliberately needs no workspace. */
export type AttachmentResult =
  | { kind: 'workspace-ready' }
  | { kind: 'compatibility-deferred' }
  | { kind: 'control-acknowledged'; command: 'pause' | 'abort' }

/** §10 memory: a producer's live runner session, kept across review rounds. */
interface ProducerSession {
  handle: AgentSessionHandle
  runner: AgentRunner
  route: string
}

type ProviderAttempt = NonNullable<EventPayload<'phase.failed'>['providerAttempts']>[number]

type TurnSettlement<T> =
  | { kind: 'value'; value: T }
  | { kind: 'error'; error: unknown }
  | { kind: 'expired' }

interface BudgetedTurn<T> {
  settlement: TurnSettlement<T>
  /** The first kernel cancellation cause. A provider result cannot overwrite it. */
  abortCause?: 'operator' | 'budget'
  /** Eventually settles even when the kernel has stopped waiting. */
  pending: Promise<Exclude<TurnSettlement<T>, { kind: 'expired' }>>
}

/** One bracketed agent run (§15.3 sessions). */
interface SessionSpec {
  /** Event/AB_PHASE identity: core phase or `verify:<step>`. */
  phase: Phase
  /** Loop round; verify attempt (AB_PHASE uses attempt as round); 1 for
   * finalize. */
  round: number
  role: string
  /** Deprecated compatibility role keys, consulted in order only when `role`
   * is undeclared (§9 routing). Today: an agent verify step's configured skill
   * name, the key verify used to route by before step names unified the rule. */
  roleAliases?: readonly string[]
  skill: string
  abPhase: string
  /** Set for producer core phases — §10 session memory applies. */
  producerPhase?: CorePhase
  /** Rendered into the continue message; the CLI context (`ab context`) is
   * the real carrier — the message just names the session directory inputs. */
  feedback?: Feedback
  verifyFailure?: import('../kernel/verify-stage-state').VerifyStageFailure
  /** phase.failed count for this phase+round at decision time (D5). */
  priorFailures: number
  /** Phase-specific terminal recognizer; the session-scoped `escalation.
   * raised` terminal (§8.4: escalate is always available) is added here. */
  isTerminal: (event: AbEvent) => boolean
}

/** Longest tail of check output preserved in a verify report (§8.2). */
const REPORT_TAIL_CHARS = 10_000

/** Per-section cap for the finalize preflight's dirty-worktree diff capture:
 * each diff view (working tree, staged) is truncated at this many characters
 * so a large dirty diff cannot bloat the failure record unboundedly — worst
 * case ≈ porcelain + 2 × (cap + header). */
const FINALIZE_DIFF_CAPTURE_CAP = 20_000

/**
 * One session bracket's live stream (SPEC §9): the sink the build-runner
 * opened through the resolved target's streaming capability, the store id it
 * returned, and the identity already emitted as the stream's first part.
 * Undefined ⇒ the runtime declared no capability or the opener declined —
 * the bracket then behaves exactly as before streams existed.
 */
interface SessionBracketStream {
  sink: SessionStreamSink
  streamId: string
  info: SessionStreamInfo
}
/** Git object ids are 40 hex characters for SHA-1 repositories and 64 for
 * SHA-256 repositories. `rev-parse <ref>^{commit}` supplies the type check. */
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Bound one captured diff section: unchanged within the cap, otherwise the
 * first FINALIZE_DIFF_CAPTURE_CAP characters plus an explicit truncation
 * marker, so truncation is visible in the record itself. */
function capDiffOutput(output: string): string {
  if (output.length <= FINALIZE_DIFF_CAPTURE_CAP) return output
  return `${output.slice(0, FINALIZE_DIFF_CAPTURE_CAP)}\n... (truncated at ${FINALIZE_DIFF_CAPTURE_CAP} characters)`
}

function sessionBudgetError(seconds: number): string {
  return `phase session budget expired after ${seconds} seconds`
}

function defaultSessionBudgetScheduler(expire: () => void, delayMs: number): () => void {
  // Node/Bun timers clamp larger delays. Chunk against an absolute deadline so
  // a valid large positive config value can never become an immediate expiry.
  const maxDelayMs = 2_147_483_647
  const deadline = Date.now() + delayMs
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (): void => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      expire()
      return
    }
    timer = setTimeout(arm, Math.min(remaining, maxDelayMs))
    timer.unref?.()
  }
  arm()
  return () => {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function providerAttemptSummary(attempts: readonly ProviderAttempt[] | undefined): string {
  if (attempts === undefined) return ''
  return (
    '; configured provider attempts: ' +
    attempts
      .map(
        (attempt) =>
          `#${attempt.index} ${attempt.runner}` +
          `${attempt.model !== undefined ? `/${attempt.model}` : ''}: ${attempt.error}`,
      )
      .join(' | ')
  )
}

export interface PhaseFailureTally {
  count: number
  lastError?: string
  lastWillRetry?: boolean
  lastProviderAttempts?: readonly ProviderAttempt[]
}

export const PHASE_FAILURES_REDUCER_VERSION = 3

/**
 * phase.failed tally for one phase+round — D5's retry-guard input. A factory
 * because phase and round are parameters of the projection.
 *
 * An answered escalation re-arms this budget only when its semantic class
 * acknowledges phase-runner failures (§15.6-B). Runner-failure causes reset
 * their matching round, the phase-level verify cause resets all rounds, and
 * unrelated policy causes reset nothing. Cause-less historical and
 * non-policy raises retain the legacy round-shaped behavior. Failures after
 * an applicable answer count again, so a still-failing phase re-escalates on
 * new evidence instead of deadlocking before its recovery session starts.
 */
export function phaseFailuresReducer(phase: Phase, round: number) {
  return defineReducer<
    {
      /** id → the raise's reset semantics — answers are matched by id (§15.3). */
      raised: Record<string, PhaseFailureResetEscalation & { session?: string }>
      owners: Record<string, string>
      cancelled: Record<string, boolean>
      count: number
      lastError?: string
      lastWillRetry?: boolean
      lastProviderAttempts?: readonly ProviderAttempt[]
    },
    AbEvent,
    PhaseFailureTally
  >({
    version: PHASE_FAILURES_REDUCER_VERSION,
    initial: () => ({ raised: {}, owners: {}, cancelled: {}, count: 0 }),
    fold(acc, events) {
      for (const event of events) {
        switch (event.type) {
          case 'session.started':
            if (event.payload.phase?.startsWith('verify:') && event.payload.round !== undefined)
              acc.owners[event.payload.session] = verifyMemberKey(
                event.payload.phase.slice(7),
                event.payload.round,
              )
            break
          case 'verify.cancelled':
            acc.cancelled[verifyMemberKey(event.payload.step, event.payload.attempt)] = true
            break
          case 'phase.deferral-escalated':
            acc.raised[event.payload.id] = {
              phase: event.payload.phase,
              round: event.payload.round,
              source: 'policy',
              deferral: 'own-build-read',
            }
            break
          case 'escalation.raised':
            acc.raised[event.payload.id] = {
              phase: event.payload.phase,
              source: event.payload.source,
              ...(event.actor.kind === 'agent' ? { session: event.actor.session } : {}),
              ...(event.payload.policyCause !== undefined
                ? { policyCause: event.payload.policyCause }
                : {}),
              ...(event.payload.round !== undefined ? { round: event.payload.round } : {}),
            }
            break
          case 'escalation.answered': {
            const raise = acc.raised[event.payload.id]
            if (raise?.session && acc.cancelled[acc.owners[raise.session] ?? '']) break
            if (raise !== undefined && resetsPhaseFailureBudget(raise, phase, round)) {
              acc.count = 0
              delete acc.lastError
              delete acc.lastWillRetry
              delete acc.lastProviderAttempts
            }
            break
          }
          case 'phase.failed':
            if (event.payload.phase === phase && event.payload.round === round) {
              acc.count += 1
              acc.lastError = event.payload.error
              acc.lastWillRetry = event.payload.willRetry
              acc.lastProviderAttempts = event.payload.providerAttempts
            }
            break
          default:
            break
        }
      }
    },
    finish: (acc) => ({
      count: acc.count,
      ...(acc.lastError !== undefined ? { lastError: acc.lastError } : {}),
      ...(acc.lastWillRetry !== undefined ? { lastWillRetry: acc.lastWillRetry } : {}),
      ...(acc.lastProviderAttempts !== undefined
        ? { lastProviderAttempts: acc.lastProviderAttempts }
        : {}),
    }),
  })
}

export const SETUP_STREAK_REDUCER_VERSION = 1

/** Consecutive durable setup failures since the latest successful attachment
 * or explicit human answer. The accumulator keeps the boundary seq and the
 * failure seqs, so it is exact for any array order. */
export const setupStreakReducer = defineReducer<
  { escalations: string[]; boundary: number; failures: number[] },
  AbEvent,
  number
>({
  version: SETUP_STREAK_REDUCER_VERSION,
  initial: () => ({ escalations: [], boundary: 0, failures: [] }),
  fold(acc, events) {
    for (const event of events) {
      if (event.type === 'runner.attached') acc.boundary = event.seq
      else if (
        event.type === 'escalation.raised' &&
        event.payload.phase === 'setup' &&
        event.payload.source === 'policy'
      ) {
        if (!acc.escalations.includes(event.payload.id)) acc.escalations.push(event.payload.id)
      } else if (
        event.type === 'escalation.answered' &&
        acc.escalations.includes(event.payload.id)
      ) {
        acc.boundary = event.seq
      } else if (event.type === 'runner.setup-failed') {
        acc.failures.push(event.seq)
      }
    }
  },
  finish: (acc) => acc.failures.filter((seq) => seq > acc.boundary).length,
})

export const PUBLISHED_BRANCH_HEAD_REDUCER_VERSION = 4

/** Latest event-checkpointed branch head that kernel plumbing published;
 * undefined while the build has none. */
export const publishedBranchHeadReducer = defineReducer<
  { head?: string },
  AbEvent,
  string | undefined
>({
  version: PUBLISHED_BRANCH_HEAD_REDUCER_VERSION,
  initial: () => ({}),
  fold(acc, events) {
    for (const event of events) {
      if (event.type === 'implement.completed') {
        acc.head = event.payload.commits.head
      } else if (event.type === 'restack.rewritten' || event.type === 'restack.completed') {
        acc.head =
          event.type === 'restack.rewritten'
            ? (event.payload.observedHead ?? event.payload.headSha)
            : event.payload.headSha
      } else if (event.type === 'reconcile.rewritten') {
        acc.head = reconcileRewriteHead(event.payload)
      } else if (event.type === 'reconcile.completed') {
        acc.head = reconcileHead(event.payload)
      } else if (
        event.type === 'finalize.step-completed' &&
        event.payload.ok &&
        event.payload.headSha !== undefined
      ) {
        acc.head = event.payload.headSha
      }
    }
  },
  finish: (acc) => acc.head,
})

/** Latest event-checkpointed branch head that kernel plumbing published. */
export function selectPublishedBranchHead(events: readonly AbEvent[]): string {
  const head = publishedBranchHeadReducer.reduce(events)
  if (head === undefined) {
    throw new Error(
      'finalize publication requires a prior implement.completed, reconcile.completed, ' +
        'or successful finalize publication head, but this build has none',
    )
  }
  return head
}

export const VERIFY_DIFF_BASE_REDUCER_VERSION = 2

/**
 * The durable tree against which a conditional verifier evaluates the
 * branch's current HEAD, or undefined until a `workspace.provisioned` exists.
 * The accumulator keeps the first provisioned base and the latest promoted
 * reconcile base separately, so the result is exact for any array order (a
 * promotion that precedes the provisioned fact in the array still wins).
 */
export const verifyDiffBaseReducer = defineReducer<
  { provisioned?: string; promoted?: string; pendingReconcileBase?: string },
  AbEvent,
  string | undefined
>({
  version: VERIFY_DIFF_BASE_REDUCER_VERSION,
  initial: () => ({}),
  fold(acc, events) {
    for (const event of events) {
      if (event.type === 'workspace.provisioned') {
        if (acc.provisioned === undefined) acc.provisioned = event.payload.base.sha
      } else if (event.type === 'restack.completed') {
        acc.promoted = event.payload.targetBase
      } else if (event.type === 'reconcile.started') {
        acc.pendingReconcileBase = event.payload.baseSha
      } else if (event.type === 'reconcile.completed') {
        if (acc.pendingReconcileBase !== undefined) acc.promoted = acc.pendingReconcileBase
        delete acc.pendingReconcileBase
      }
    }
  },
  finish: (acc) => (acc.provisioned === undefined ? undefined : (acc.promoted ?? acc.provisioned)),
})

/**
 * Select the durable tree against which a conditional verifier evaluates the
 * branch's current HEAD. The initial branch-cut SHA is authoritative until a
 * successful reconcile; each completed reconcile promotes the latest start's
 * refreshed base SHA. A dangling start is intentionally ignored.
 */
export function selectVerifyDiffBase(events: readonly AbEvent[]): string {
  const base = verifyDiffBaseReducer.reduce(events)
  if (base === undefined) {
    throw new Error(
      'conditional verify requires a workspace.provisioned base SHA, but this build has none',
    )
  }
  return base
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
 * the feedback, naming the session directory inputs `ab context` materializes (§8.3) —
 * the message is a pointer, the CLI context is the real carrier.
 */
function continueMessage(spec: SessionSpec): string {
  const base = continueMessageBase(spec)
  if (!spec.verifyFailure) return base
  return (
    base +
    ' Stage feedback: ' +
    [
      ...spec.verifyFailure.failed.map(
        (f) => `verify:${f.step} failed${f.report ? ` (${f.report.kind}@${f.report.rev})` : ''}`,
      ),
      ...spec.verifyFailure.cancelled.map(
        (c) => `verify:${c.step} not run: cancelled by verify:${c.cause.step}`,
      ),
    ].join('; ') +
    '. Read every report and the cancelled members in $AB_CONTEXT_DIR/context.json.'
  )
}
function continueMessageBase(spec: SessionSpec): string {
  const refresh =
    'run `ab context` to refresh $AB_CONTEXT_DIR/, then finish with your terminal command'
  const { feedback } = spec
  if (feedback === undefined) {
    return `Continue ${spec.phase} (round ${spec.round}): ${refresh}.`
  }
  if ('findings' in feedback) {
    return (
      `Revise ${spec.phase} (round ${spec.round}): address findings ` +
      `${feedback.findings.join(', ')} — materialized in $AB_CONTEXT_DIR/findings.json; ${refresh}.`
    )
  }
  if ('verify' in feedback) {
    return (
      `verify:${feedback.verify.step} failed — its report ` +
      `(${feedback.verify.report.kind}@${feedback.verify.report.rev}) is in ` +
      `$AB_CONTEXT_DIR/verify/; fix in ${spec.phase} round ${spec.round}, ${refresh}.`
    )
  }
  return (
    `Human guidance on escalation ${feedback.guidance.escalation} (authoritative, ` +
    `§15.6-B): ${feedback.guidance.answer} — inputs in $AB_CONTEXT_DIR/; ${refresh}.`
  )
}

// ── The runner ───────────────────────────────────────────────────────────────

function isPublicationBoundary(event: AbEvent, spec: SessionSpec, session: string): boolean {
  if (
    event.type !== 'publication.requested' ||
    event.actor.kind !== 'agent' ||
    event.actor.session !== session
  )
    return false
  if (spec.phase === 'implement')
    return event.payload.operation === 'implement' && event.payload.round === spec.round
  if (spec.phase === 'reconcile') return event.payload.operation === 'reconcile'
  if (spec.phase === 'finalize') return event.payload.operation === 'finalize'
  return false
}

function recoveryMatches(decision: Decision, session: OpenSession): boolean {
  if (decision.kind === 'run-verify-stage')
    return decision.members.some((member) =>
      recoveryMatches(member.kind === 'evaluate-verify' ? member.action : member, session),
    )
  return decision.kind === 'run-phase'
    ? session.phase === decision.phase && session.round === decision.round
    : decision.kind === 'run-agent-verify'
      ? session.phase === verifyPhase(decision.step) && session.round === decision.attempt
      : decision.kind === 'run-finalize-step'
        ? session.phase === 'finalize' && session.role === decision.step
        : false
}

export class BuildRunner {
  private verifyWrites = { tail: Promise.resolve() }
  private async withVerifyWrite<T>(write: () => Promise<T>): Promise<T> {
    const previous = this.verifyWrites.tail
    let release!: () => void
    this.verifyWrites.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await write()
    } finally {
      release()
    }
  }
  private readonly stageRecoveries = new Map<
    string,
    { session: OpenSession; cause: 'shutdown' | 'pause' | 'runner-loss' }
  >()
  private recovery: OpenSession | undefined
  private recoveryBoundaryMs = 0
  private recoveryCause: 'shutdown' | 'pause' | 'runner-loss' = 'runner-loss'
  private readonly continuationIntents = new Map<
    string,
    NonNullable<EventPayload<'session.started'>['continuation']>
  >()
  private readonly interruptionPrompts = new Map<string, string>()
  private readonly bracketStreams = new Map<string, SessionBracketStream>()
  private readonly activeDurations = new Map<string, number>()

  private resolveSessionRole(role: string, ...aliases: string[]): ResolvedRole {
    const resolved = this.boundaryResolver.resolve(role, ...aliases)
    const old = this.recovery
    if (!old || old.role !== role) return resolved
    const registration = this.deps.runtimes[old.runner]
    if (!registration) return resolved
    return {
      ...resolved,
      ...registration,
      runner: registration.runner,
      runtime: old.runner,
      model: old.model,
      args: old.args ?? [],
      account: old.account,
      sessionBudgetSeconds: (old.budgetMs ?? resolved.sessionBudgetSeconds * 1000) / 1000,
    }
  }

  private async startBracket(write: EventWrite<'session.started'>) {
    const { store, slug } = this.deps
    const old = this.recovery
    const budgetMs = this.resolveSessionRole(write.payload.role).sessionBudgetSeconds * 1000
    if (
      old &&
      old.phase === write.payload.phase &&
      old.round === write.payload.round &&
      old.role === write.payload.role &&
      old.nativeHandle
    ) {
      const activeMs =
        (old.continuation?.activeMs ?? 0) +
        (old.suspendedActiveMs ?? Math.max(0, this.recoveryBoundaryMs - Date.parse(old.startedAt)))
      write = {
        ...write,
        payload: {
          ...write.payload,
          budgetMs,
          continuation: {
            predecessor: old.session,
            root: old.continuation?.root ?? old.session,
            handle: old.nativeHandle,
            cause: this.recoveryCause,
            activeMs,
            budgetMs,
          },
        },
      }
    } else write = { ...write, payload: { ...write.payload, budgetMs } }
    let started: EventEnvelope<'session.started'> | null = null
    if (write.payload.continuation) {
      for (;;) {
        const facts = await readBuildFacts(store, slug)
        const decision = decideNextFromFacts(
          facts.value.state,
          facts.value.log,
          this.boundaryConfig,
        )
        const current = [
          ...facts.value.state.sessions.open,
          ...facts.value.state.sessions.suspended,
        ].find((session) => session.session === old!.session)
        if (!current?.nativeHandle || !recoveryMatches(decision, current)) {
          await this.bracketStreams.get(write.payload.session)?.sink.close('aborted')
          throw new RecoveryBoundaryChanged()
        }
        write = {
          ...write,
          payload: {
            ...write.payload,
            continuation: {
              ...write.payload.continuation!,
              handle: current.nativeHandle,
              cause:
                current.suspensionCause ??
                (current.suspendedActiveMs !== undefined ? 'shutdown' : 'runner-loss'),
              activeMs:
                (current.continuation?.activeMs ?? 0) +
                (current.suspendedActiveMs ??
                  Math.max(0, this.recoveryBoundaryMs - Date.parse(current.startedAt))),
            },
          },
        }
        started = await store.appendIfCurrent(slug, facts.cursor, write)
        if (started) break
      }
    } else started = await store.append(slug, write)
    if (write.payload.continuation)
      this.continuationIntents.set(write.payload.session, write.payload.continuation)
    this.recovery = undefined
    return started
  }

  private async startAgent(runner: AgentRunner, opts: AgentStartOpts) {
    if (opts.signal?.aborted) throw opts.signal.reason
    const continuation = this.continuationIntents.get(opts.env.AB_SESSION!)
    this.continuationIntents.delete(opts.env.AB_SESSION!)
    if (!continuation) return runner.start(opts)
    const message = `This session was interrupted (${continuation.cause}). Re-check the worktree and re-run anything that was in flight. Continue the current phase and round; run ab context for its durable inputs.`
    this.interruptionPrompts.set(opts.env.AB_SESSION!, message)
    if (opts.stream)
      opts.stream.append([
        { type: 'text-start', id: 'interruption' },
        { type: 'text-delta', id: 'interruption', delta: message },
        { type: 'text-end', id: 'interruption' },
      ])
    const result = await resumeAgent(runner, continuation.handle, message, opts)
    if (result.kind === 'resumed') return { session: result.session, result: result.result }
    const session = opts.env.AB_SESSION!
    for (;;) {
      const facts = await readBuildFacts(this.deps.store, this.deps.slug)
      const stale =
        opts.signal?.aborted === true ||
        !facts.value.state.sessions.open.some((s) => s.session === session)
      const event = await this.deps.store.appendIfCurrent(this.deps.slug, facts.cursor, {
        actor: KERNEL,
        type: 'session.resume-fallback',
        payload: {
          session,
          reason: `${result.reason}: ${result.message}`,
          ...(stale ? { stale: true } : {}),
        },
      })
      if (!event) continue
      if (stale) throw new Error('Native resume attempt is no longer current')
      break
    }
    // The unavailable native attempt has no fresh turn to account for. Close
    // its evidence and credentials before re-deciding the ordinary phase path.
    // That path resolves today's policy and opens an independent budget/root.
    await this.bracketStreams.get(session)?.sink.close('aborted')
    await this.deps.store.append(this.deps.slug, {
      actor: KERNEL,
      type: 'session.ended',
      payload: {
        session,
        outcome: 'reclaimed',
        reclaimedBy: {
          instance: this.deps.instance,
          resumedFromSeq: (await readBuildFacts(this.deps.store, this.deps.slug)).value.state
            .lastSeq,
        },
      },
    })
    throw new FreshSessionRequired()
  }

  private readonly maxPhaseAttempts: number
  private readonly heartbeatMs: number
  private readonly leaseTtlMs: number
  private readonly streamSessions: boolean
  private readonly onDiagnostic: (message: string) => void
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
  /** Captured only at setup/step boundaries. Async work below a boundary never
   * consults the mutable owner again. */
  private boundaryConfig: Config
  private boundaryResolver: RuntimeResolver

  constructor(private readonly deps: BuildRunnerDeps) {
    const redactor = accountRedactor(
      () => this.boundaryConfig?.accounts ?? deps.config.accounts,
      () => ({
        ...process.env,
        ...deps.sessionEnv,
      }),
    )
    deps.store = redactAccountStore(deps.store, redactor)

    this.deps = {
      ...deps,
      store: withDrainingExecution(
        deps.store,
        deps.instance,
        deps.runtimeIdentity ?? RUNTIME_IDENTITY,
      ),
    }
    this.maxPhaseAttempts = deps.opts?.maxPhaseAttempts ?? 2
    this.heartbeatMs = deps.opts?.heartbeatMs ?? 15_000
    this.leaseTtlMs = deps.opts?.leaseTtlMs ?? BUILD_EXECUTION_LEASE_TTL_MS
    this.streamSessions = deps.opts?.streamSessions ?? true
    this.onDiagnostic = deps.opts?.onDiagnostic ?? ((message) => console.error(message))
    this.boundaryConfig = deps.config
    this.boundaryResolver = createRuntimeResolver(
      deps.runtimes,
      deps.config.roles,
      deps.config.policy.sessionBudgetSeconds,
      deps.config.accounts,
    )
  }

  private async captureConfig(): Promise<Config> {
    const deployment = (await this.deps.getConfig?.()) ?? this.deps.config
    const state = (await readBuildFacts(this.deps.store, this.deps.slug)).value.state
    const config = await capturedBuildConfig(this.deps.store, this.deps.slug, state, deployment)
    this.boundaryConfig = config
    this.boundaryResolver = createRuntimeResolver(
      this.deps.runtimes,
      config.roles,
      config.policy.sessionBudgetSeconds,
      config.accounts,
    )
    return config
  }

  /** Consecutive durable setup failures since the latest successful attachment
   * or explicit human answer. The answer re-arms the budget but deliberately
   * does not erase the current diagnostic while recovery is still running. */

  private setupQuestion(failure: EventPayload<'runner.setup-failed'>): string {
    const status =
      failure.exitStatus === null ? 'exit status unavailable' : `exit status ${failure.exitStatus}`
    return (
      `maxSetupAttempts (${this.boundaryConfig.policy.maxSetupAttempts}) exhausted: ` +
      `[commands].setup ${JSON.stringify(failure.command)} failed with ${status}. ` +
      `Output: ${failure.output || '(no output)'}`
    )
  }

  private async raiseSetupEscalation(failure: EventPayload<'runner.setup-failed'>): Promise<void> {
    await this.deps.store.append(this.deps.slug, {
      actor: KERNEL,
      type: 'escalation.raised',
      payload: {
        id: this.deps.ids('esc'),
        phase: 'setup',
        source: 'policy',
        policyCause: 'setup-failure-limit',
        question: this.setupQuestion(failure),
      },
    } satisfies EventWrite<'escalation.raised'>)
  }

  /** Close every session open in the captured pre-attachment prefix, then
   * announce takeover against that same boundary. If a write is interrupted,
   * no attachment lands; the next runner reduces the newer prefix and closes
   * only sessions that remain open. */
  private async reclaimSessionsAndAttach(
    facts: Awaited<ReturnType<typeof readBuildFacts>>['value'],
  ): Promise<void> {
    const { store, slug, instance, host } = this.deps
    const state = facts.state
    const resumedFromSeq = state.lastSeq
    const decision = decideNextFromFacts(state, facts.log, this.boundaryConfig)
    const candidates = [...state.sessions.suspended, ...state.sessions.open]
      .filter((session) => recoveryMatches(decision, session))
      .sort((a, b) => b.seq - a.seq)
    const retained = new Set<string>()
    for (const candidate of decision.kind === 'run-verify-stage'
      ? candidates.filter(
          (s, i, all) =>
            all.findIndex((other) => other.phase === s.phase && other.round === s.round) === i,
        )
      : candidates.slice(0, 1)) {
      const handle = candidate.nativeHandle
      const reason =
        this.deps.workspaceProvider !== 'git-worktree' || this.deps.workspaceRemote === true
          ? 'workspace-not-local-git-worktree'
          : !handle
            ? 'missing-handle'
            : handle.host !== hostname()
              ? 'wrong-host'
              : handle.workspacePath !== this.deps.workspacePath
                ? 'wrong-workspace'
                : !this.deps.runtimes[candidate.runner]?.runner.resume
                  ? 'unsupported-runtime'
                  : undefined
      if (reason)
        await store.append(slug, {
          actor: KERNEL,
          type: 'session.resume-fallback',
          payload: { session: candidate.session, reason },
        })
      else {
        this.recoveryBoundaryMs = this.deps.clock().getTime()
        retained.add(candidate.session)
        if (decision.kind === 'run-verify-stage')
          this.stageRecoveries.set(verifyMemberKey(candidate.phase!.slice(7), candidate.round!), {
            session: candidate,
            cause: state.sessions.suspended.some((s) => s.session === candidate.session)
              ? (candidate.suspensionCause ?? 'shutdown')
              : 'runner-loss',
          })
        else this.recovery = candidate
        this.recoveryCause = state.sessions.suspended.some((s) => s.session === candidate.session)
          ? (candidate.suspensionCause ?? 'shutdown')
          : 'runner-loss'
      }
    }
    for (const session of [...state.sessions.open, ...state.sessions.suspended]) {
      if (retained.has(session.session)) continue
      await store.append(slug, {
        actor: KERNEL,
        type: 'session.ended',
        payload: {
          session: session.session,
          outcome: 'reclaimed',
          reclaimedBy: { instance, resumedFromSeq },
        },
      } satisfies EventWrite<'session.ended'>)
    }
    const attached = await store.append(slug, {
      actor: KERNEL,
      type: 'runner.attached',
      payload: {
        instance,
        host,
        ...(resumedFromSeq > 0 ? { resumedFromSeq } : {}),
      },
    } satisfies EventWrite<'runner.attached'>)
    await store.append(slug, {
      actor: KERNEL,
      type: 'runner.runtime-recorded',
      payload: {
        instance,
        attachedSeq: attached.seq,
        runtime: this.deps.runtimeIdentity ?? RUNTIME_IDENTITY,
      },
    })
  }

  /**
   * Claim the lease, honor engine-selected stop controls, then run pre-phase
   * setup for workspace-backed work. The first workspace attempt retains the
   * historical successful-path protocol by announcing attachment before setup.
   * Once a setup failure is current, retries delay `runner.attached` until
   * setup succeeds; that fact then proves recovery and clears the projection.
   */
  async attach(): Promise<AttachmentResult> {
    if (await deferMixedVersion(this.deps.store, this.deps.slug, KERNEL))
      return { kind: 'compatibility-deferred' }
    const attaching = (await readBuildFacts(this.deps.store, this.deps.slug)).value.state
    if (
      attaching.kind === 'node' &&
      !attaching.nodeRestack?.conflict &&
      !integrationCurrent(attaching)
    )
      throw new Error('integration runners require a reserved node conflict')
    const config = await this.captureConfig()
    const { store, slug, instance } = this.deps
    const claimed = await store.claimLease(slug, instance, this.leaseTtlMs)
    if (!claimed) throw new LeaseHeldError(slug, instance)

    let facts = (await readBuildFacts(store, slug)).value
    const decision = decideNextFromFacts(facts.state, facts.log, config)
    if (
      decision.kind === 'acknowledge' &&
      (decision.command === 'pause' || decision.command === 'abort')
    ) {
      await this.acknowledge(decision.command)
      return { kind: 'control-acknowledged', command: decision.command }
    }

    if (decision.kind === 'acknowledge' && decision.command === 'resume') {
      await this.acknowledge('resume')
      facts = (await readBuildFacts(store, slug)).value
    }

    const state = facts.state
    if (state.kind === 'node' && state.integration?.cycle && !state.nodeRestack?.conflict) {
      // Local worktree provisioning may create a new branch at its parent;
      // verification consumes the archived cycle commit, never that mutable tip.
      const checkout = await this.deps.exec(
        ['git', 'checkout', '--detach', state.integration.cycle.head],
        { cwd: this.deps.workspacePath },
      )
      if (checkout.exitCode !== 0)
        throw new Error(`cannot check out prepared integration head: ${checkout.stderr}`)
    }
    const currentFailure = state.setupFailure
    const openSetupEscalation = state.openEscalations.some(
      (escalation) => escalation.phase === 'setup' && escalation.source === 'policy',
    )
    const streak = await readBuildSelector(store, slug, 'setupStreak')

    // Crash-safe exhaustion: the final failure and escalation are separate
    // appends. If only the failure landed, raise the blocker before another
    // command execution can buy an extra attempt.
    if (currentFailure !== undefined && streak >= config.policy.maxSetupAttempts) {
      if (!openSetupEscalation) await this.raiseSetupEscalation(currentFailure)
      throw new SetupFailureError(slug, currentFailure, true)
    }
    if (currentFailure !== undefined && openSetupEscalation) {
      throw new SetupFailureError(slug, currentFailure, true)
    }

    const recovering = currentFailure !== undefined
    if (!recovering) await this.reclaimSessionsAndAttach(facts)

    // First beat immediately (liveness visible without waiting an interval),
    // then keep-alive. Setup runs under this heartbeat so a slow install cannot
    // outlive the claimed lease.
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

    const setup = config.commands.setup
    if (setup !== undefined) {
      let failure: EventPayload<'runner.setup-failed'> | undefined
      try {
        const result = await this.deps.exec(['sh', '-c', setup], {
          cwd: this.deps.workspacePath,
        })
        if (result.exitCode !== 0) {
          failure = {
            command: setup,
            attempt: streak + 1,
            exitStatus: result.exitCode,
            output: [result.stderr, result.stdout].filter((text) => text !== '').join('\n'),
          }
        }
      } catch (error) {
        failure = {
          command: setup,
          attempt: streak + 1,
          exitStatus: null,
          output: errorMessage(error),
        }
      }

      if (failure !== undefined) {
        try {
          await store.append(slug, {
            actor: KERNEL,
            type: 'runner.setup-failed',
            payload: failure,
          } satisfies EventWrite<'runner.setup-failed'>)
          const exhausted = failure.attempt >= config.policy.maxSetupAttempts
          if (exhausted) await this.raiseSetupEscalation(failure)
          throw new SetupFailureError(slug, failure, exhausted)
        } finally {
          this.stopHeartbeat()
          this.attached = false
        }
      }
    }

    if (recovering) {
      try {
        facts = (await readBuildFacts(store, slug)).value
        await this.reclaimSessionsAndAttach(facts)
      } catch (error) {
        this.stopHeartbeat()
        this.attached = false
        throw error
      }
    }
    this.attached = true
    return { kind: 'workspace-ready' }
  }

  /**
   * One read→decide→execute cycle (§8): the unit-test surface. Returns the
   * decision it executed; `wait` decisions execute nothing.
   */
  async step(): Promise<Decision> {
    if (await deferMixedVersion(this.deps.store, this.deps.slug, KERNEL))
      return { kind: 'wait', reason: 'mixed-version' }
    const { store, slug } = this.deps
    try {
      await this.settleLocalReconcile()
    } catch (error) {
      if (error instanceof ForgeRequestDeferred)
        return { kind: 'wait', reason: 'publication-retry' }
      throw error
    }
    await completeAutomaticReconcile(store, slug)
    const config = await this.captureConfig()
    const facts = (await readBuildFacts(store, slug)).value
    const decision = decideNextFromFacts(facts.state, facts.log, config)
    if (
      this.deps.readVerifyPipeline &&
      ([
        'run-check',
        'run-agent-verify',
        'evaluate-verify',
        'skip-verify',
        'run-verify-stage',
        'capture-reconcile-policy',
        'record-verify-selection-drift',
      ].includes(decision.kind) ||
        (decision.kind === 'run-phase' && decision.phase === 'finalize') ||
        (decision.kind === 'wait' &&
          decision.reason === 'awaiting-pr' &&
          (facts.state.verify.configPin !== undefined ||
            (facts.state.kind === 'node' && integrationCurrent(facts.state)))))
    ) {
      if (
        await refreshVerifyCycle({
          store,
          slug,
          state: facts.state,
          deployment: config,
          read: this.deps.readVerifyPipeline,
          retainCompletedVerification:
            facts.state.kind !== 'node' &&
            decision.kind === 'wait' &&
            decision.reason === 'awaiting-pr',
          exec: this.deps.exec,
          workspacePath: this.deps.workspacePath,
        })
      )
        return this.step()
    }
    if (await deferMixedVersion(store, slug, KERNEL))
      return { kind: 'wait', reason: 'mixed-version' }
    if (this.recovery) {
      const current = [...facts.state.sessions.open, ...facts.state.sessions.suspended].find(
        (session) => session.session === this.recovery!.session,
      )
      if (
        !current?.nativeHandle ||
        (decision.kind !== 'wait' &&
          decision.kind !== 'acknowledge' &&
          !recoveryMatches(decision, current))
      ) {
        this.recovery = undefined
        if (current)
          await store.append(slug, {
            actor: KERNEL,
            type: 'session.ended',
            payload: {
              session: current.session,
              outcome: 'reclaimed',
              reclaimedBy: { instance: this.deps.instance, resumedFromSeq: facts.state.lastSeq },
            },
          })
      } else this.recovery = current
    }
    try {
      switch (decision.kind) {
        case 'record-verify-selection-drift':
          await store.appendIfCurrent(slug, facts.state.lastSeq, {
            actor: KERNEL,
            type: 'observation.recorded',
            payload: {
              id: this.deps.ids('obs'),
              kind: 'followup',
              summary: decision.summary,
              files: ['autobuild.toml'],
            },
          })
          return decision
        case 'restart-execution':
          return decision
        case 'run-verify-stage':
          await this.runVerifyStage(decision)
          return decision
        case 'cancel-verify-stage':
          await this.cancelVerifyStage(decision)
          await this.endCancelledVerifySessions(decision)
          return decision
        case 'record-verify-stage-failure':
          await store.appendIfCurrent(slug, facts.state.lastSeq, {
            actor: KERNEL,
            type: 'verify.stage-failed',
            payload: decision.failure,
          })
          await reportIntegrationFailures(store, slug)
          return decision
        case 'restack':
          await this.restack(decision)
          return decision
        case 'capture-reconcile-policy':
          await store.append(slug, {
            actor: KERNEL,
            type: 'verify.reconcile-policy-captured',
            payload: {
              ...(facts.state.verify.configPin ? { cycle: facts.state.verify.cycleSince } : {}),
              reconcileSeq: decision.reconcileSeq,
              steps: config.verify.steps.map((step) => {
                const override = config.verify.stepConfigs[step]?.afterReconcile
                return {
                  step,
                  enabled: override ?? config.verify.afterReconcile,
                  source:
                    override === undefined
                      ? 'verify.afterReconcile'
                      : `verify.${step}.afterReconcile`,
                }
              }),
            },
          })
          return decision
        case 'wait':
          return decision
        case 'acknowledge':
          await this.acknowledge(decision.command)
          return decision
        case 'raise-read-deferral':
          await this.raiseReadDeferral(decision)
          return decision
        case 'raise-escalation':
          await this.raiseEscalation(decision)
          return decision
        case 'run-phase':
          await this.runPhase(decision)
          return decision
        case 'run-check':
          await this.runCheck(decision)
          await reportIntegrationFailures(this.deps.store, this.deps.slug)
          return decision
        case 'run-agent-verify':
          await this.runAgentVerify(decision)
          await reportIntegrationFailures(this.deps.store, this.deps.slug)
          return decision
        case 'evaluate-verify':
          await this.evaluateVerify(decision)
          return decision
        case 'skip-verify':
          await this.skipVerify(decision)
          return decision
        case 'run-finalize-step':
          await this.runFinalizeStep(decision)
          return decision
        case 'check-reconcile-progress':
          await this.checkReconcileProgress(decision)
          return decision
      }
    } catch (error) {
      if (error instanceof ForgeRequestDeferred)
        return { kind: 'wait', reason: 'publication-retry' }
      if (error instanceof MixedVersionDeferral) return { kind: 'wait', reason: 'mixed-version' }
      if (error instanceof FreshSessionRequired) return this.step()
      if (error instanceof RecoveryBoundaryChanged) return decision
      throw error
    }
  }

  private async requestRelaunch(
    facts: Awaited<ReturnType<typeof readBuildFacts>>['value'],
  ): Promise<boolean> {
    const request = relaunchTarget(
      facts.state,
      this.deps.instance,
      this.deps.runtimeIdentity ?? RUNTIME_IDENTITY,
    )
    if (!request) return false
    if (
      facts.state.drainingExecutions?.[this.deps.instance]?.relaunch?.correlation ===
      request.correlation
    )
      return true
    const written = await this.deps.store.appendIfCurrent(this.deps.slug, facts.state.lastSeq, {
      actor: KERNEL,
      type: 'execution.relaunch-requested',
      payload: request,
    })
    // A concurrent control or authorization must be re-read before deciding.
    if (!written)
      return this.requestRelaunch((await readBuildFacts(this.deps.store, this.deps.slug)).value)
    return true
  }

  /**
   * The pipeline loop (§8): attach if needed, step until the build parks
   * (`wait/*` — §11), return the final reduced state. Releases nothing on
   * exit (leases expire; the dispatcher re-attaches) but stops the heartbeat,
   * closes any live producer sessions (their per-round transcripts are
   * already deposited — see module doc).
   */
  async run(): Promise<BuildState> {
    const initialFacts = (await readBuildFacts(this.deps.store, this.deps.slug)).value
    if (await this.requestRelaunch(initialFacts)) {
      this.stopHeartbeat()
      await this.closeProducerSessions()
      return (await readBuildFacts(this.deps.store, this.deps.slug)).value.state
    }
    if (await deferMixedVersion(this.deps.store, this.deps.slug, KERNEL))
      return (await readBuildFacts(this.deps.store, this.deps.slug)).value.state
    const initial = initialFacts.state
    if (
      initial.kind === 'node' &&
      !initial.nodeRestack?.conflict &&
      !integrationCurrent(initial) &&
      initialFacts.log.readDeferrals.length === 0
    )
      return initial
    if (!this.attached) {
      const attachment = await this.attach()
      if (
        attachment.kind === 'control-acknowledged' ||
        attachment.kind === 'compatibility-deferred'
      ) {
        return (await readBuildFacts(this.deps.store, this.deps.slug)).value.state
      }
    }
    try {
      await this.settleLocalReconcile()
      for (;;) {
        if (this.deps.shutdownSignal?.aborted) break
        await this.ensureLease()
        await this.settleLocalReconcile()
        const facts = (await readBuildFacts(this.deps.store, this.deps.slug)).value
        if (await this.requestRelaunch(facts)) break
        if (await deferMixedVersion(this.deps.store, this.deps.slug, KERNEL)) break
        if (await this.refreshSummary()) break
        if (facts.publication.pending()) {
          const next = decideNextFromFacts(facts.state, facts.log, await this.captureConfig())
          // Inert controls cannot start more work under unsettled publication.
          // A local paused resolver needs resume acknowledged before this
          // runner can settle its publication; remote guests still park.
          const localResume =
            next.kind === 'acknowledge' &&
            next.command === 'resume' &&
            (facts.workspace === null || !isRemoteWorkspace(facts.workspace))
          if (
            next.kind !== 'acknowledge' ||
            (next.command !== 'pause' && next.command !== 'abort' && !localResume)
          )
            break
        }
        let decision: Decision
        try {
          decision = await this.step()
        } catch (error) {
          if (!(error instanceof SessionPaused)) throw error
          if (await this.settlePauseInterruption()) continue
          break
        }
        if (decision.kind === 'restart-execution') break
        if (decision.kind === 'wait') {
          if (decision.reason === 'mixed-version')
            await this.requestRelaunch(
              (await readBuildFacts(this.deps.store, this.deps.slug)).value,
            )
          break
        }
      }
      return (await readBuildFacts(this.deps.store, this.deps.slug)).value.state
    } catch (error) {
      if (
        !(error instanceof SessionShutdown) &&
        !(error instanceof MixedVersionDeferral) &&
        !(error instanceof ForgeRequestDeferred)
      )
        throw error
      const facts = (await readBuildFacts(this.deps.store, this.deps.slug)).value
      if (error instanceof MixedVersionDeferral) await this.requestRelaunch(facts)
      return facts.state
    } finally {
      this.stopHeartbeat()
      await this.closeProducerSessions()
    }
  }

  /** Cancellation is irreversible, but the latest durable control selects
   * whether to park or recover the suspended bracket in this same runner. */
  private async settlePauseInterruption(): Promise<boolean> {
    for (;;) {
      const facts = await readBuildFacts(this.deps.store, this.deps.slug)
      const decision = decideNextFromFacts(facts.value.state, facts.value.log, this.boundaryConfig)
      if (decision.kind === 'acknowledge') {
        await this.acknowledge(decision.command)
        continue
      }
      if (decision.kind === 'wait') return false
      await this.reclaimSessionsAndAttach(facts.value)
      return true
    }
  }

  private async refreshSummary(): Promise<boolean> {
    if (await deferMixedVersion(this.deps.store, this.deps.slug, KERNEL)) return false
    try {
      await this.ensureLease()
    } catch {
      return false
    }
    return refreshSummaryBoundary({
      store: this.deps.store,
      forge: this.deps.forge,
      slug: this.deps.slug,
      workspacePath: this.deps.workspacePath,
      storeRef: this.deps.sessionEnv?.AB_STORE ?? 'local',
      clock: this.deps.clock,
    })
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
    if (await deferMixedVersion(store, slug, KERNEL)) throw new MixedVersionDeferral()
    const reclaimed = await store.claimLease(slug, instance, this.leaseTtlMs)
    if (!reclaimed) throw new LeaseHeldError(slug, instance)
    this.leaseLost = false
  }

  // ── Decision execution ─────────────────────────────────────────────────────

  /** D2: humans append `*-requested`; the kernel acknowledges with facts. */
  private async acknowledge(command: 'pause' | 'resume' | 'abort'): Promise<void> {
    const { store, slug } = this.deps
    if (command === 'pause') {
      for (;;) {
        const facts = await readBuildFacts(store, slug)
        const decision = decideNextFromFacts(
          facts.value.state,
          facts.value.log,
          this.boundaryConfig,
        )
        if (decision.kind !== 'acknowledge' || decision.command !== 'pause') return
        if (
          await store.appendIfCurrent(slug, facts.cursor, {
            actor: KERNEL,
            type: 'build.paused',
            payload: {},
          })
        )
          return
      }
    } else if (command === 'resume') {
      await store.append(slug, { actor: KERNEL, type: 'build.resumed', payload: {} })
    } else {
      await store.append(slug, { actor: KERNEL, type: 'build.aborted', payload: {} })
      // The execution supervisor retains ownership until the complete process
      // tree is gone; janitor cleanup is gated by that live lease.
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
        ...(decision.source === 'policy' ? { policyCause: decision.policyCause } : {}),
        question: decision.question,
        ...(decision.refs !== undefined ? { refs: decision.refs } : {}),
      },
    } satisfies EventWrite<'escalation.raised'>)
  }

  /**
   * Resolve and persist the authoritative base for one repeat conflict before
   * the engine spends reconcile policy budget. This deliberately does not
   * reuse the snapshot as the merge target: actual phase startup refreshes
   * again, preserving the execution-boundary freshness guarantee.
   */
  private async checkReconcileProgress(decision: CheckReconcileProgressDecision): Promise<void> {
    await this.withKernelPhaseFailure('reconcile', decision.nextAttempt, () =>
      this.checkReconcileProgressOperation(decision),
    )
  }

  private async checkReconcileProgressOperation(
    decision: CheckReconcileProgressDecision,
  ): Promise<void> {
    const { nextAttempt } = decision
    const failures = await readPhaseFailures(
      this.deps.store,
      this.deps.slug,
      'reconcile',
      nextAttempt,
    )
    if (failures.count >= this.maxPhaseAttempts) {
      await this.raisePolicyExhausted('reconcile', nextAttempt, failures)
      return
    }
    if (failures.lastWillRetry === false) {
      await this.raisePolicyNonRetryable('reconcile', nextAttempt, failures)
      return
    }

    let baseSha: string
    try {
      baseSha = await this.refreshReconcileBase()
    } catch (error) {
      await this.failPhase(
        'reconcile',
        nextAttempt,
        failures.count,
        `failed to check reconcile progress: ${errorMessage(error)}`,
        !(error instanceof StoreWriteTooLargeError),
      )
      return
    }

    await this.deps.store.append(this.deps.slug, {
      actor: KERNEL,
      type: 'reconcile.progress-checked',
      payload: {
        conflictSeq: decision.conflictSeq,
        attempt: decision.completedAttempt,
        baseSha,
      },
    } satisfies EventWrite<'reconcile.progress-checked'>)
  }

  /** A core-phase run: retry guard (D5), started event (§15.3), session. */
  private async runPhase(decision: RunPhaseDecision): Promise<void> {
    await this.withKernelPhaseFailure(decision.phase, decision.round, () =>
      this.runPhaseOperation(decision),
    )
  }

  private async runPhaseOperation(decision: RunPhaseDecision): Promise<void> {
    const { store, slug } = this.deps
    const { phase, round } = decision

    const node = (await readBuildFacts(store, slug)).value.state.nodeRestack
    if (node?.conflict && node.active && phase === 'reconcile') {
      await this.runNodeConflict(round)
      return
    }

    // D5 RETRY GUARD first: at the cap, escalate instead of running — a
    // failing phase must never loop forever.
    const failures = await readPhaseFailures(this.deps.store, this.deps.slug, phase, round)
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
    if (phase === 'reconcile' && !this.recovery) {
      try {
        requireRewrite(this.deps.forge)
        const facts = (await readBuildFacts(store, slug)).value
        reconcileBaseSha =
          facts.log.restack.active?.targetBase ??
          (facts.reconcileTransaction?.attempt === round
            ? facts.reconcileTransaction.targetBase
            : await this.refreshReconcileBase())
      } catch (error) {
        await this.failPhase(
          phase,
          round,
          failures.count,
          `failed to refresh reconcile base: ${errorMessage(error)}`,
          !(error instanceof StoreWriteTooLargeError),
        )
        return
      }
    }

    if (phase === 'reconcile' && !this.recovery) {
      const facts = (await readBuildFacts(store, slug)).value
      const active = facts.log.restack.active
      if (active !== undefined && facts.reconcileTransaction?.restackId !== active.id) {
        await store.append(slug, {
          actor: KERNEL,
          type: 'reconcile.started',
          payload: { attempt: round, baseSha: active.targetBase, restackId: active.id },
        })
        const {
          trigger: _trigger,
          cycle: _cycle,
          observation: _observation,
          message: _message,
          ...transaction
        } = active
        await store.append(slug, {
          actor: KERNEL,
          type: 'reconcile.prepared',
          payload: { ...transaction, attempt: round, restackId: active.id },
        })
        await store.append(slug, {
          actor: KERNEL,
          type: 'reconcile.replayed',
          payload: { id: active.id, conflicted: true },
        })
      }
    }
    if (
      !this.recovery &&
      (phase !== 'reconcile' ||
        (await readBuildFacts(store, slug)).value.reconcileTransaction?.attempt !== round)
    )
      await store.append(slug, this.startedWrite(decision, reconcileBaseSha))
    if (phase === 'reconcile' && !this.recovery) {
      try {
        const oldBase = await readBuildSelector(store, slug, 'verifyDiffBase')
        if (oldBase === undefined || reconcileBaseSha === undefined)
          throw new Error('missing reconcile contribution base')
        await prepareRestack(
          { ...this.deps },
          {
            attempt: round,
            restackId: (await readBuildFacts(store, slug)).value.log.restack.active?.id,
            branch: this.deps.branch,
            oldBase,
            targetBase: reconcileBaseSha,
            id: this.deps.ids('rewrite').replaceAll('_', '-'),
          },
        )
      } catch (error) {
        await this.failPhase(
          phase,
          round,
          failures.count,
          `failed to prepare reconcile replay: ${errorMessage(error)}`,
          !(error instanceof StoreWriteTooLargeError),
        )
        return
      }
    }

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
      ...(decision.verifyStageFailure === undefined
        ? {}
        : {
            verifyFailure: (
              await readBuildFacts(store, slug)
            ).value.state.verifyStage.failures.find((f) => f.seq === decision.verifyStageFailure),
          }),
      isTerminal: (event) => event.type === spec.terminalEvent && roundMatches(event, round),
    })
    if (phase === 'reconcile') await this.settleLocalReconcile()
  }

  private async runNodeConflict(round: number): Promise<void> {
    const { store, slug } = this.deps
    const state = (await readBuildFacts(store, slug)).value.state
    const node = state.nodeRestack!
    const active = node.active!
    const conflict = node.conflict!
    const change = active.changes[conflict.index]!
    const failures = await readPhaseFailures(store, slug, 'reconcile', round)
    if (failures.count >= this.maxPhaseAttempts) {
      await this.raisePolicyExhausted('reconcile', round, failures)
      return
    }
    if (failures.lastWillRetry === false) {
      await this.raisePolicyNonRetryable('reconcile', round, failures)
      return
    }
    if (!this.recovery) {
      try {
        for (const sha of [active.expected, active.parent]) {
          const exists = await this.deps.exec(['git', 'cat-file', '-e', `${sha}^{commit}`], {
            cwd: this.deps.workspacePath,
          })
          if (exists.exitCode !== 0) {
            const fetched = await this.deps.exec(
              ['git', 'fetch', '--no-tags', 'origin', `refs/autobuild/archive/${slug}/${sha}`],
              { cwd: this.deps.workspacePath },
            )
            if (fetched.exitCode !== 0) throw new Error(`missing archived node input ${sha}`)
          }
        }
        if (change.build) {
          for (const kind of ['spec', 'plan', 'implement-notes']) {
            if (
              !(await store.getArtifact(slug, `node-source-${active.id}-${conflict.index}-${kind}`))
            )
              throw new Error(`missing ${kind} for source build ${change.build}`)
          }
        } else {
          const result = await this.deps.exec(
            [
              'git',
              'show',
              '--format=fuller',
              ...(change.mainline ? ['-m', '--first-parent'] : []),
              change.sha,
            ],
            {
              cwd: this.deps.workspacePath,
            },
          )
          if (result.exitCode !== 0) throw new Error(`missing foreign commit ${change.sha}`)
          await store.putArtifact(slug, {
            kind: `node-source-${active.id}-${conflict.index}-foreign`,
            content: result.stdout,
          })
        }
        for (const item of node.items) if (!item.dropped) await restoreReplay(this.deps, item.head)
        await this.deps.exec(['git', 'cherry-pick', '--abort'], { cwd: this.deps.workspacePath })
        const reset = await this.deps.exec(['git', 'checkout', '--detach', conflict.base], {
          cwd: this.deps.workspacePath,
        })
        if (reset.exitCode !== 0) throw new Error(reset.stderr)
        const result = await replayNodeChange(
          this.deps,
          { ...active, oldHead: active.expected },
          conflict.index,
          conflict.base,
        )
        if (result.kind !== 'conflict')
          throw new Error('reserved conflict no longer reproduces from frozen inputs')
      } catch (error) {
        if (error instanceof StoreWriteTooLargeError) throw error
        await store.append(slug, {
          actor: KERNEL,
          type: 'escalation.raised',
          payload: {
            id: this.deps.ids('esc'),
            phase: 'reconcile',
            source: 'agent',
            question: `Cannot prepare node change ${change.sha}: ${errorMessage(error)}`,
          },
        })
        return
      }
      await store.append(slug, {
        actor: KERNEL,
        type: 'reconcile.started',
        payload: { attempt: round, baseSha: conflict.base },
      })
    }
    await this.executeSession({
      phase: 'reconcile',
      round,
      role: 'reconcile',
      skill: PHASE_SPECS.reconcile.skill,
      abPhase: `reconcile@${round}`,
      producerPhase: 'reconcile',
      priorFailures: failures.count,
      isTerminal: (event) => event.type === 'reconcile.completed',
    })
  }

  /** Re-read durable ownership and controls at the actual rewrite boundary. */
  private async assertAutomaticRewriteOwnership(allowPublication = false) {
    const { store, slug, instance, clock } = this.deps
    if (await deferMixedVersion(store, slug, KERNEL)) throw new MixedVersionDeferral()
    const record = await store.getBuild(slug)
    if (record?.lease?.holder !== instance) throw new LeaseHeldError(slug, instance)
    if (
      new Date(record.lease.expiresAt).getTime() <= clock().getTime() &&
      !(await store.claimLease(slug, instance, this.leaseTtlMs))
    )
      throw new LeaseHeldError(slug, instance)
    const facts = (await readBuildFacts(store, slug)).value
    if (facts.open !== null && facts.open.instance !== instance)
      throw new LeaseHeldError(slug, instance)
    if (
      facts.state.sessions.open.length > 0 ||
      facts.state.status === 'paused' ||
      facts.state.status === 'blocked' ||
      facts.state.status === 'done' ||
      facts.state.status === 'aborted' ||
      facts.state.pendingCommands.some(
        (command) =>
          (!allowPublication && command.command === 'pause') || command.command === 'abort',
      ) ||
      (!allowPublication && facts.publication.pending())
    )
      throw new AutomaticRewriteDeferred(
        'automatic rewrite deferred until execution, control and publication settlement',
      )
  }

  /** A resolver deposits intent while its turn is live. Publish after it ends. */
  private async settleLocalReconcile() {
    if (await deferMixedVersion(this.deps.store, this.deps.slug, KERNEL)) return
    const { store, slug } = this.deps
    const facts = (await readBuildFacts(store, slug)).value
    if (facts.workspace !== null && isRemoteWorkspace(facts.workspace)) return
    const request = facts.publication.latestUncompletedRequest()
    if (
      request?.payload.operation !== 'reconcile' ||
      request.payload.rewrite === undefined ||
      facts.publication.requestSettled(request)
    )
      return
    if (
      facts.state.sessions.open.length > 0 ||
      facts.state.status === 'paused' ||
      facts.state.status === 'blocked' ||
      facts.state.status === 'aborted' ||
      facts.state.status === 'done' ||
      facts.state.pendingCommands.some(
        (command) => command.command === 'abort' || command.command === 'pause',
      )
    )
      return
    await this.closeProducerSessions()
    const rewriteId = request.payload.rewrite.id
    const intent = facts.reconcileHistory.findLast(
      (e) => e.type === 'reconcile.publish-intended' && e.payload.id === rewriteId,
    )
    if (
      intent?.type !== 'reconcile.publish-intended' ||
      intent.payload.headSha !== request.payload.sha
    )
      throw new Error('local reconcile request does not match durable intent')
    const retryDeps = { ...this.deps, actor: KERNEL }
    await publicationRetryGate(retryDeps, 'reconcile', rewriteId)
    const publicationDeps = {
      ...this.deps,
      beforeRewrite: () => this.assertAutomaticRewriteOwnership(true),
    }
    // A replacement workspace may still be checked out at the old branch tip.
    // Restore the frozen resolved intent before the guarded branch update.
    await prepareRestack(publicationDeps, {
      attempt: intent.payload.attempt,
      branch: intent.payload.branch,
      oldBase: intent.payload.oldBase,
      targetBase: intent.payload.targetBase,
      id: intent.payload.id,
      restackId: intent.payload.restackId,
    })
    const result = await retryPublicationEffect(
      retryDeps,
      'reconcile',
      rewriteId,
      intent.payload.attempt,
      () => publishRestack(publicationDeps, intent.payload),
    )
    if (result.kind === 'lease-mismatch') {
      await store.append(slug, {
        actor: KERNEL,
        type: 'reconcile.contended',
        payload: { id: intent.payload.id, request: request.seq, actual: result.actual },
      })
      return
    }
    await store.append(slug, {
      actor: KERNEL,
      type: 'reconcile.completed',
      payload: {
        headSha: request.payload.sha,
        rewriteId: intent.payload.id,
        artifact: request.payload.artifact,
      },
    })
    await completeAutomaticReconcile(store, slug)
  }

  private async restack(decision: Extract<Decision, { kind: 'restack' }>): Promise<void> {
    const { store, slug } = this.deps
    let facts = (await readBuildFacts(store, slug)).value
    if (facts.state.sessions.open.length > 0 || facts.publication.pending())
      throw new Error('automatic restack deferred until session and publication settlement')
    await this.closeProducerSessions()
    const round = facts.state.reconcileAttempts + 1
    const failures = await readPhaseFailures(store, slug, 'reconcile', round)
    if (failures.count >= this.maxPhaseAttempts) {
      await this.raisePolicyExhausted('reconcile', round, failures)
      return
    }
    if (failures.lastWillRetry === false) {
      await this.raisePolicyNonRetryable('reconcile', round, failures)
      return
    }
    try {
      await this.assertAutomaticRewriteOwnership()
      if (facts.log.restack.intent)
        await publicationRetryGate(
          { ...this.deps, actor: KERNEL },
          'restack',
          facts.log.restack.intent.id,
        )
      let transaction = facts.log.restack.active
      let automatic: Pick<
        EventPayload<'restack.prepared'>,
        'trigger' | 'cycle' | 'observation' | 'message'
      >
      let id: string
      let targetBase: string
      if (transaction === undefined) {
        targetBase = await this.refreshReconcileBase(true)
        const branch = facts.lastCreated?.payload.baseBranch
        if (branch === undefined) throw new Error('missing frozen target')
        // refreshReconcileBase admits the remote snapshot before any replay.
        facts = (await readBuildFacts(store, slug)).value
        const description = await store.getArtifact(slug, 'pr-description')
        const title =
          facts.lastCreated?.payload.ticket.title ?? facts.lastCreated?.payload.ticket.id ?? slug
        const message = withBuildTrailer(
          description === null ? title : new TextDecoder().decode(description.content),
          slug,
          { includesSubject: true },
        )
        automatic = {
          trigger: decision.trigger,
          cycle: decision.cycle,
          observation: facts.log.restack.target!.seq,
          message,
        }
        id = this.deps.ids('restack').replaceAll('_', '-')
      } else {
        automatic = {
          trigger: transaction.trigger,
          cycle: transaction.cycle,
          observation: transaction.observation,
          message: transaction.message,
        }
        targetBase = transaction.targetBase
        id = transaction.id
      }
      const oldBase = await readBuildSelector(store, slug, 'verifyDiffBase')
      if (oldBase === undefined) throw new Error('missing contribution base')
      // A resolver already published one canonical change on this exact base.
      // Reuse it only while no later finalize publication has extended it.
      const canonical = facts.reconcileTransaction
      const completed = facts.log.lastReconcileCompleted
      if (
        transaction === undefined &&
        canonical !== undefined &&
        completed?.completedSeq === decision.cycle &&
        (facts.log.restack.postStepAt ?? 0) <= completed.completedSeq &&
        canonical.targetBase === targetBase
      ) {
        const { attempt: _attempt, restackId: _restackId, ...replay } = canonical
        const headSha = await readBuildSelector(store, slug, 'publishedBranchHead')
        if (headSha === undefined) throw new Error('missing canonical reconcile head')
        await store.append(slug, {
          actor: KERNEL,
          type: 'restack.completed',
          payload: { ...replay, ...automatic, headSha },
        })
        return
      }
      await this.assertAutomaticRewriteOwnership()
      const deps = {
        ...this.deps,
        automatic,
        beforeRewrite: () => this.assertAutomaticRewriteOwnership(),
      }
      const prepared = await prepareRestack(deps, {
        attempt: 1,
        branch: this.deps.branch,
        oldBase,
        targetBase,
        id,
      })
      facts = (await readBuildFacts(store, slug)).value
      transaction = facts.log.restack.active
      if (transaction === undefined) throw new Error('missing prepared automatic restack')
      if (facts.log.restack.replay?.conflicted) return
      const result = await this.deps.exec(['git', 'rev-parse', 'HEAD'], {
        cwd: this.deps.workspacePath,
      })
      if (result.exitCode !== 0) throw new Error(result.stderr)
      const headSha = result.stdout.trim()
      if (facts.log.restack.intent !== undefined && facts.log.restack.intent.headSha !== headSha)
        throw new Error('recovered automatic replay differs from its frozen publication intent')
      await retainReplay(deps, headSha, transaction.targetBase)
      const intent = { ...transaction, headSha }
      if (facts.log.restack.intent === undefined)
        await store.append(slug, {
          actor: KERNEL,
          type: 'restack.publish-intended',
          payload: intent,
        })
      if (facts.workspace !== null && isRemoteWorkspace(facts.workspace)) {
        await store.append(slug, {
          actor: KERNEL,
          type: 'publication.requested',
          payload: {
            operation: 'restack',
            branch: transaction.branch,
            sha: headSha,
            rewrite: intent,
          },
        })
        return
      }
      const published = await retryPublicationEffect(
        { ...this.deps, actor: KERNEL },
        'restack',
        intent.id,
        round,
        () =>
          publishRestack(deps, {
            ...prepared,
            headSha,
            conflicted: false,
            artifact: { kind: 'restack', rev: 0 },
          }),
      )
      if (published.kind === 'lease-mismatch') {
        await store.append(slug, {
          actor: KERNEL,
          type: 'restack.contended',
          payload: {
            id: transaction.id,
            request: facts.restackHistory.at(-1)!.seq,
            actual: published.actual,
          },
        })
        throw new Error(
          `automatic restack publication contended at ${published.actual ?? '(deleted)'}`,
        )
      }
      await store.append(slug, { actor: KERNEL, type: 'restack.completed', payload: intent })
    } catch (error) {
      if (error instanceof LeaseHeldError || error instanceof MixedVersionDeferral) throw error
      if (
        error instanceof ForgeRequestDeferred ||
        error instanceof PublicationRetryPersistenceError
      )
        throw error
      if (error instanceof AutomaticRewriteDeferred) return
      await this.failPhase(
        'reconcile',
        round,
        failures.count,
        `automatic restack failed: ${errorMessage(error)}`,
        !(error instanceof StoreWriteTooLargeError),
      )
    }
  }

  /** Snapshot the frozen target in a build-private ref without tracking-ref updates. */
  private async refreshReconcileBase(recordAccepted = false): Promise<string> {
    const baseBranch = await readBuildSelector(this.deps.store, this.deps.slug, 'baseBranch')
    if (baseBranch === undefined) {
      throw new Error(
        'this build has no build.created event — cannot resolve its frozen baseBranch (§15.3)',
      )
    }

    const sourceRef = `refs/heads/${baseBranch}`
    const targetRef = `refs/autobuild/reconcile/${this.deps.slug}/base`
    if (this.deps.forge.snapshotBase !== undefined) {
      const sha = await this.deps.forge.snapshotBase({
        workspacePath: this.deps.workspacePath,
        base: baseBranch,
        destinationRef: targetRef,
      })
      if (!GIT_OBJECT_ID.test(sha)) {
        throw new Error(
          `${this.deps.forge.name} base snapshot did not return a commit SHA: ${JSON.stringify(sha)}`,
        )
      }
      await this.admitReconcileBase(baseBranch, sha, recordAccepted)
      return sha
    }

    const fetchArgs = [
      'git',
      'fetch',
      '--no-tags',
      '--no-write-fetch-head',
      '--refmap=',
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
    await this.admitReconcileBase(baseBranch, sha, recordAccepted)
    return sha
  }

  private async admitReconcileBase(
    branch: string,
    sha: string,
    recordAccepted: boolean,
  ): Promise<void> {
    const result = await observeTarget({
      store: this.deps.store,
      forge: this.deps.forge,
      slug: this.deps.slug,
      branch,
      sha,
      enforceUsedBaseline: true,
      recordAccepted,
      actor: KERNEL,
    })
    if (result === 'rejected') throw new Error(`upstream target rewrite on ${branch}: ${sha}`)
  }

  /**
   * Resolve a conditional verifier against the live branch diff. Exclusion is
   * a canonical kernel-authored skip and launches no command or session.
   * Inclusion delegates to the existing verifier path unchanged.
   */
  private async resolveVerify(
    decision: EvaluateVerifyDecision,
  ): Promise<
    Exclude<import('../kernel/engine').VerifyMemberDecision, { kind: 'evaluate-verify' }>
  > {
    const { exec, workspacePath } = this.deps
    const state = (await readBuildFacts(this.deps.store, this.deps.slug)).value.state
    const baseSha =
      state.kind === 'node'
        ? state.integration?.cycle?.parent
        : await readBuildSelector(this.deps.store, this.deps.slug, 'verifyDiffBase')
    if (baseSha === undefined)
      throw new Error(
        'conditional verify requires a workspace.provisioned base SHA, but this build has none',
      )
    const args = ['git', 'diff', '--no-renames', '--name-only', '-z', baseSha, 'HEAD', '--']
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
    if (applicability.applies === false) {
      return {
        kind: 'skip-verify',
        step: decision.step,
        attempt: decision.attempt,
        reason: applicability.reason,
      }
    }

    return decision.action
  }

  private async evaluateVerify(decision: EvaluateVerifyDecision): Promise<void> {
    const resolved = await this.resolveVerify(decision)
    if (resolved.kind === 'skip-verify') await this.skipVerify(resolved)
    else if (resolved.kind === 'run-check') await this.runCheck(resolved)
    else if (resolved.kind === 'run-agent-verify') await this.runAgentVerify(resolved)
    await reportIntegrationFailures(this.deps.store, this.deps.slug)
  }

  private async cancelVerifyStage(
    decision: Extract<Decision, { kind: 'cancel-verify-stage' }>,
  ): Promise<void> {
    const { store, slug } = this.deps
    await this.withVerifyWrite(async () => {
      for (const step of decision.steps) {
        for (;;) {
          const latest = (await readBuildFacts(store, slug)).value
          const key = verifyMemberKey(step, decision.attempt)
          if (latest.state.verifyStage.outcomes[key] || latest.state.verifyStage.cancellations[key])
            break
          if (
            await store.appendIfCurrent(slug, latest.state.lastSeq, {
              actor: KERNEL,
              type: 'verify.cancelled',
              payload: {
                ...(await this.verifyEvidence()),
                step,
                attempt: decision.attempt,
                cause: { step: decision.cause },
              },
            })
          )
            break
        }
      }
    })
  }

  private async endCancelledVerifySessions(
    decision: Extract<Decision, { kind: 'cancel-verify-stage' }>,
  ): Promise<void> {
    const { store, slug } = this.deps
    for (;;) {
      const { state } = (await readBuildFacts(store, slug)).value
      const session = [...state.sessions.open, ...state.sessions.suspended].find((session) => {
        const key = state.verifyStage.owners[session.session]
        const cancelled = key === undefined ? undefined : state.verifyStage.cancellations[key]
        return cancelled?.attempt === decision.attempt && decision.steps.includes(cancelled.step)
      })
      if (!session) return
      await store.appendIfCurrent(slug, state.lastSeq, {
        actor: KERNEL,
        type: 'session.ended',
        payload: {
          session: session.session,
          outcome: 'reclaimed',
          reclaimedBy: { instance: this.deps.instance, resumedFromSeq: state.lastSeq },
        },
      })
    }
  }

  /** Handles live only here; every scheduling and barrier decision is read
   * from durable facts. A child runner isolates each occurrence's recovery,
   * provider fallback, stream and retry state without another workspace. */
  private async runVerifyStage(
    initial: Extract<Decision, { kind: 'run-verify-stage' }>,
  ): Promise<void> {
    const { store, slug } = this.deps
    type MemberExecution = {
      runner: BuildRunner
      done: boolean
      agent: boolean
      pending?: Promise<void>
      error?: unknown
    }
    const inFlight = new Map<string, MemberExecution>()
    const interrupted = new AbortController()
    let revision = 0
    const onShutdown = () => {
      revision += 1
      wake?.()
    }
    this.deps.shutdownSignal?.addEventListener('abort', onShutdown, { once: true })
    let wake: (() => void) | undefined
    const unsubscribe = store.subscribe(
      slug,
      { fromSeq: (await readBuildFacts(store, slug)).value.state.lastSeq, pollMs: 25 },
      () => {
        revision += 1
        wake?.()
      },
    )
    let decision: Decision = initial
    try {
      for (;;) {
        const observed = revision
        if (this.deps.shutdownSignal?.aborted) return
        if (decision.kind !== 'run-verify-stage') {
          if (decision.kind === 'cancel-verify-stage') {
            await this.cancelVerifyStage(decision)
            await this.endCancelledVerifySessions(decision)
          }
          return
        }
        if (
          decision.members.some(
            (member) => !initial.members.some((first) => first.step === member.step),
          )
        )
          return
        const members = await Promise.all(
          decision.members.map((member) =>
            member.kind === 'evaluate-verify' ? this.resolveVerify(member) : member,
          ),
        )
        for (const member of members) {
          const key = verifyMemberKey(member.step, member.attempt)
          const active = inFlight.get(key)
          if (active && !active.done) continue
          if (active?.error) throw active.error
          const child = new BuildRunner({
            ...this.deps,
            config: this.boundaryConfig,
            shutdownSignal: this.deps.shutdownSignal
              ? AbortSignal.any([this.deps.shutdownSignal, interrupted.signal])
              : interrupted.signal,
          })
          child.verifyWrites = this.verifyWrites
          const recovery = this.stageRecoveries.get(key)
          child.recovery = recovery?.session
          child.recoveryBoundaryMs = this.recoveryBoundaryMs
          child.recoveryCause = recovery?.cause ?? 'runner-loss'
          this.stageRecoveries.delete(key)
          const entry: MemberExecution = {
            runner: child,
            done: false,
            agent: member.kind === 'run-agent-verify',
          }
          inFlight.set(key, entry)
          const work =
            member.kind === 'run-check'
              ? child.runCheck(member)
              : member.kind === 'run-agent-verify'
                ? child.runAgentVerify(member)
                : member.kind === 'skip-verify'
                  ? child.skipVerify(member)
                  : Promise.resolve()
          entry.pending = work.then(
            () => {
              entry.done = true
              revision += 1
              wake?.()
            },
            (error) => {
              entry.done = true
              entry.error = error
              revision += 1
              wake?.()
            },
          )
        }
        if (revision === observed)
          await new Promise<void>((resolve) => {
            wake = resolve
            if (revision !== observed) resolve()
          })
        wake = undefined
        const facts = (await readBuildFacts(store, slug)).value
        decision = decideNextFromFacts(facts.state, facts.log, await this.captureConfig())
        for (const entry of inFlight.values()) if (entry.error) throw entry.error
      }
    } finally {
      unsubscribe()
      this.deps.shutdownSignal?.removeEventListener('abort', onShutdown)
      interrupted.abort()
      for (const entry of inFlight.values()) {
        // Fail-fast must reach whole-execution teardown even when an adapter
        // ignores abort. Its cancelled brackets are already durably ended;
        // the supervisor, rather than a per-member reaper, owns descendants.
        if (entry.agent && decision.kind !== 'cancel-verify-stage') await entry.pending
        for (const stream of entry.runner.bracketStreams.values())
          entry.runner.closeBracketStream(stream, 'aborted')
        await entry.runner.closeProducerSessions()
      }
    }
  }

  /** Shared writer for every deterministic exclusion mechanism. A skip is a
   * queryable two-fact phase occurrence and launches no command or session. */
  private async verifyEvidence() {
    const facts = (await readBuildFacts(this.deps.store, this.deps.slug)).value
    if (facts.state.kind === 'node') {
      const cycle = facts.state.integration?.cycle
      if (!cycle) throw new Error('missing prepared integration verification')
      const head = await this.deps.exec(['git', 'rev-parse', 'HEAD'], {
        cwd: this.deps.workspacePath,
      })
      if (head.exitCode !== 0 || head.stdout.trim() !== cycle.head)
        throw new Error('integration checkout differs from prepared head')
      return { baseSha: cycle.parent, headSha: cycle.head, restackId: cycle.id }
    }
    const cycle = Math.max(facts.log.code.latestApproveSeq, facts.log.lastReconcileCompletedSeq)
    const gate = facts.log.restack.gates[String(cycle)]
    if (gate !== undefined)
      return { baseSha: gate.targetBase, headSha: gate.headSha, restackId: gate.id }
    return {}
  }

  private async skipVerify(decision: SkipVerifyDecision): Promise<void> {
    const { store, slug } = this.deps
    await this.withVerifyWrite(async () => {
      const { state } = (await readBuildFacts(store, slug)).value
      const key = verifyMemberKey(decision.step, decision.attempt)
      if (state.verifyStage.cancellations[key] || state.verifyStage.outcomes[key]) return
      const evidence = await this.verifyEvidence()
      await store.append(slug, {
        actor: KERNEL,
        type: 'verify.started',
        payload: { ...evidence, step: decision.step, attempt: decision.attempt },
      } satisfies EventWrite<'verify.started'>)
      await store.append(slug, {
        actor: KERNEL,
        type: 'verify.completed',
        payload: {
          step: decision.step,
          attempt: decision.attempt,
          ...evidence,
          outcome: 'skipped',
          reason: decision.reason,
          ...(decision.skipCause !== undefined ? { skipCause: decision.skipCause } : {}),
        },
      } satisfies EventWrite<'verify.completed'>)
    })
  }

  /** Deterministic check (§8.2): NO session, NO CLI — the kernel runs the
   * command directly; a failure deposits the output tail as the report. */
  private async runCheck(decision: RunCheckDecision): Promise<void> {
    await this.withKernelPhaseFailure(verifyPhase(decision.step), decision.attempt, () =>
      this.runCheckOperation(decision),
    )
  }

  private async runCheckOperation(decision: RunCheckDecision): Promise<void> {
    const { store, slug, exec, workspacePath } = this.deps
    const { step, command, attempt } = decision
    const current = (await readBuildFacts(store, slug)).value.state
    const memberKey = verifyMemberKey(step, attempt)
    if (current.verifyStage.outcomes[memberKey] || current.verifyStage.cancellations[memberKey])
      return
    const failures = await readPhaseFailures(store, slug, verifyPhase(step), attempt)
    if (failures.count >= this.maxPhaseAttempts) {
      await this.raisePolicyExhausted(verifyPhase(step), attempt, failures)
      return
    }
    if (failures.lastWillRetry === false) {
      await this.raisePolicyNonRetryable(verifyPhase(step), attempt, failures)
      return
    }
    const evidence = await this.verifyEvidence()
    if (!this.recovery)
      await store.append(slug, {
        actor: KERNEL,
        type: 'verify.started',
        payload: { ...evidence, step, attempt },
      } satisfies EventWrite<'verify.started'>)

    const result = await exec(['sh', '-c', command], {
      cwd: workspacePath,
      ...(this.deps.shutdownSignal ? { signal: this.deps.shutdownSignal } : {}),
    })
    if (this.deps.shutdownSignal?.aborted) return
    await this.withVerifyWrite(async () => {
      const state = (await readBuildFacts(store, slug)).value.state
      const key = verifyMemberKey(step, attempt)
      if (state.verifyStage.cancellations[key] || state.verifyStage.outcomes[key]) return
      if (result.exitCode === 0) {
        await store.append(slug, {
          actor: KERNEL,
          type: 'verify.completed',
          payload: { ...evidence, step, attempt, outcome: 'pass' },
        } satisfies EventWrite<'verify.completed'>)
        return
      }

      const output = [result.stdout, result.stderr].filter((s) => s !== '').join('\n')
      const content = output.length > REPORT_TAIL_CHARS ? output.slice(-REPORT_TAIL_CHARS) : output
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
              ...evidence,
              outcome: 'fail',
              report: { kind: meta.kind, rev: meta.revision },
            },
          } satisfies EventWrite<'verify.completed'>
        },
      )
    })
  }

  /** Agent-verify step (§5): a session with a pass/fail/skip verdict. */
  private async runAgentVerify(decision: RunAgentVerifyDecision): Promise<void> {
    await this.withKernelPhaseFailure(verifyPhase(decision.step), decision.attempt, () =>
      this.runAgentVerifyOperation(decision),
    )
  }

  private async runAgentVerifyOperation(decision: RunAgentVerifyDecision): Promise<void> {
    const { store, slug } = this.deps
    const { step, skill, attempt, feedback } = decision
    const evidence = await this.verifyEvidence()
    const phase = verifyPhase(step)

    // D5 guard, extended to agent-verify (see module doc): keyed by
    // verify:<step> with the verify attempt as the round.
    const failures = await readPhaseFailures(this.deps.store, this.deps.slug, phase, attempt)
    if (failures.count >= this.maxPhaseAttempts) {
      await this.raisePolicyExhausted(phase, attempt, failures)
      return
    }
    if (failures.lastWillRetry === false) {
      await this.raisePolicyNonRetryable(phase, attempt, failures)
      return
    }

    await store.append(slug, {
      actor: KERNEL,
      type: 'verify.started',
      payload: { ...evidence, step, attempt, ...(feedback !== undefined ? { feedback } : {}) },
    } satisfies EventWrite<'verify.started'>)

    await this.executeSession({
      phase,
      round: attempt,
      role: step, // role name = the verify step's logical name (§9 routing)
      // The deprecated skill-name key, still honoured for existing configs.
      roleAliases: [skill],
      skill,
      abPhase: `verify:${step}@${attempt}`,
      priorFailures: failures.count,
      ...(feedback ? { feedback } : {}),
      isTerminal: (event) =>
        (event.type === 'verify.completed' || event.type === 'verify.cancelled') &&
        event.payload.step === step &&
        event.payload.attempt === attempt,
    })
  }

  /**
   * Failure-tolerant post-step (§5). Checks run directly and agents run their
   * exact configured skill, but either kind may commit selected repository
   * content locally. Only this kernel boundary may publish it (D7): a clean
   * descendant HEAD is regular-pushed and checkpointed before completion.
   * Step, Git, and Forge failures become the ordinary failed outcome plus an
   * observation and never route a green build backward.
   */
  private async runFinalizeStep(decision: RunFinalizeStepDecision): Promise<void> {
    if (await deferMixedVersion(this.deps.store, this.deps.slug, KERNEL)) return
    const { step, action } = decision
    if (!this.recovery)
      await this.deps.store.append(this.deps.slug, {
        actor: KERNEL,
        type: 'finalize.step-started',
        payload: { step },
      })
    let actor: Actor = KERNEL
    let durableHead: string | undefined
    let failureNote: string | undefined

    try {
      if (!this.recovery) await this.requireFinalizeWorktreeClean('before the post-step starts')
      durableHead = await readBuildSelector(this.deps.store, this.deps.slug, 'publishedBranchHead')
      if (durableHead === undefined)
        throw new Error(
          'finalize publication requires a prior implement.completed, reconcile.completed, ' +
            'or successful finalize publication head, but this build has none',
        )
    } catch (error) {
      failureNote = `finalize publication preflight failed: ${errorMessage(error)}`
    }

    if (failureNote === undefined) {
      if (action.kind === 'check') {
        failureNote = await this.runFinalizeCheck(action.command)
      } else {
        const outcome = await this.runFinalizeAgent(step, action.skill)
        if (outcome.cancelled) return
        actor = outcome.actor
        failureNote = outcome.failureNote
      }
    }

    let pushedHead: string | undefined
    if (failureNote === undefined && durableHead !== undefined) {
      try {
        await this.requireFinalizeWorktreeClean('after the post-step finishes')
        const head = await this.resolveFinalizeHead()
        if (head !== durableHead) {
          await this.requirePublishedHeadAncestor(durableHead, head)
          const scratchPaths = await scratchPathsTouchedInRange(
            this.deps.exec,
            this.deps.workspacePath,
            durableHead,
            head,
          )
          if (scratchPaths.length > 0) throw phaseScratchRejection(scratchPaths)
          const remote = (await readBuildFacts(this.deps.store, this.deps.slug)).value
            .remoteWorkspace
          if (remote) {
            await this.deps.store.append(this.deps.slug, {
              actor,
              type: 'publication.requested',
              payload: {
                operation: 'finalize-step',
                branch: this.deps.branch,
                sha: head,
                step,
              },
            })
            return
          }
          await suspendNativeLanding(this.deps, `finalize-step:${step}`)
          await publishExact(this.deps.forge, this.deps.workspacePath, this.deps.branch, head)
          pushedHead = head
        }
      } catch (error) {
        if (error instanceof MixedVersionDeferral) throw error
        failureNote = `finalize publication failed: ${errorMessage(error)}`
      }
    }

    await this.recordFinalizeOutcome(step, actor, failureNote, pushedHead)
  }

  /** A finalize check is direct kernel plumbing: no agent session is created. */
  private async runFinalizeCheck(command: string): Promise<string | undefined> {
    try {
      const result = await this.deps.exec(['sh', '-c', command], {
        cwd: this.deps.workspacePath,
      })
      return result.exitCode === 0 ? undefined : `command exited ${result.exitCode}`
    } catch (error) {
      return `command execution failed: ${errorMessage(error)}`
    }
  }

  /** A finalize agent uses the configured skill verbatim and the logical step
   * name for role routing. Provider/launch failures remain post-step failures,
   * not build failures. */
  private async runFinalizeAgent(
    step: string,
    skill: string,
  ): Promise<{ actor: Actor; failureNote: string | undefined; cancelled: boolean }> {
    const resolved = this.resolveSessionRole(step)
    if (resolved.alternates.length === 0) return this.runFinalizeAgentSingle(step, skill)

    const { slug, ids, workspacePath } = this.deps
    const targets: readonly ResolvedRuntime[] = [resolved, ...resolved.alternates]
    let substitution: ProviderAttempt | undefined
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index]!
      const session = ids('s')
      const finalizeBracket = {
        phase: 'finalize' as const,
        round: 1,
        role: step,
        runnerName: target.runtime,
      }
      const streamBracket = await this.openSessionStream(target, {
        session,
        role: step,
        runner: target.runtime,
        ...(target.account === undefined ? {} : { account: target.account }),
        ...(target.model !== undefined ? { model: target.model } : {}),
        phase: 'finalize',
        round: 1,
      })
      const stream = streamBracket?.sink
      const started = await this.startBracket({
        actor: KERNEL,
        type: 'session.started',
        payload: {
          session,
          role: step,
          runner: target.runtime,
          ...(target.account === undefined ? {} : { account: target.account }),
          ...(target.model !== undefined ? { model: target.model } : {}),
          args: [...target.args],
          phase: 'finalize',
          round: 1,
          ...(streamBracket !== undefined ? { stream: streamBracket.streamId } : {}),
          ...(substitution !== undefined
            ? { substitution: { failed: substitution, selectedIndex: index } }
            : {}),
        },
      } satisfies EventWrite<'session.started'>)
      let handle: AgentSessionHandle | undefined
      let result: AgentTurnResult | undefined
      let turnError: unknown
      const turn = await this.runBudgetedTurn(
        started,
        resolved.sessionBudgetSeconds,
        async (signal, onNativeSession) =>
          this.startAgent(target.runner, {
            onNativeSession,
            skill,
            invocation: slug,
            buildSlug: slug,
            workspacePath,
            ...(target.account === undefined ? {} : { account: target.account }),
            ...(target.model !== undefined ? { model: target.model } : {}),
            ...(target.args !== undefined ? { args: target.args } : {}),
            env: await this.sessionEnvFor('finalize@1', session, step),
            signal,
            ...(stream !== undefined ? { stream } : {}),
          }),
      )
      if (turn.settlement.kind === 'value') {
        handle = turn.settlement.value.session
        result = turn.settlement.value.result
      } else if (turn.settlement.kind === 'error') {
        turnError = turn.settlement.error
      } else {
        this.releaseLateStart(turn.pending, target.runner)
      }
      if (turn.abortCause === 'budget') {
        if (handle !== undefined) {
          this.releaseExpiredSession(
            target.runner,
            handle,
            session,
            finalizeBracket,
            target.model,
            streamBracket,
          )
        } else {
          this.closeBracketStream(streamBracket, 'aborted')
        }
        return {
          actor: agentActor(step, session),
          failureNote: sessionBudgetError(resolved.sessionBudgetSeconds),
          cancelled: await this.settleReadDeferral(session),
        }
      }
      if (handle !== undefined) {
        try {
          const transcript = await target.runner.end(handle)
          const outcome: StreamOutcome =
            turnError === undefined && result?.kind !== 'failed' ? 'completed' : 'aborted'
          await this.depositTranscriptAndEnd(
            session,
            finalizeBracket,
            transcript.content,
            transcript.metadata.usage,
            transcript.metadata.model ?? target.model,
            streamBracket !== undefined ? { stream: streamBracket, outcome } : undefined,
          )
        } catch {
          // The failure-tolerant post-step still records its outcome below.
        }
      }
      if (await this.settleReadDeferral(session)) {
        this.closeBracketStream(streamBracket, 'aborted')
        return { actor: agentActor(step, session), failureNote: undefined, cancelled: true }
      }
      if (turn.abortCause === 'operator') {
        this.closeBracketStream(streamBracket, 'aborted')
        return { actor: agentActor(step, session), failureNote: undefined, cancelled: true }
      }
      if (turnError === undefined && result?.kind !== 'failed') {
        this.closeBracketStream(streamBracket, 'completed')
        return { actor: agentActor(step, session), failureNote: undefined, cancelled: false }
      }
      this.closeBracketStream(streamBracket, 'aborted')
      const failure: AgentTurnFailure =
        turnError !== undefined
          ? { message: errorMessage(turnError), permanent: false, cause: 'availability' }
          : result?.kind === 'failed'
            ? result.failure
            : {
                message: 'agent session returned no result',
                permanent: false,
                cause: 'availability',
              }
      const attempt: ProviderAttempt = {
        index,
        session,
        runner: target.runtime,
        ...(target.account === undefined ? {} : { account: target.account }),
        ...(target.model !== undefined ? { model: target.model } : {}),
        error: failure.message,
        ...(failure.cause !== undefined ? { cause: failure.cause } : {}),
      }
      if (index + 1 < targets.length && isAlternateEligible(failure)) {
        substitution = attempt
        continue
      }
      return {
        actor: agentActor(step, session),
        failureNote:
          `${turnError !== undefined ? 'agent session failed' : 'agent turn failed'}: ` +
          failure.message,
        cancelled: false,
      }
    }
    throw new Error('finalize alternate chain had no execution target')
  }

  private async runFinalizeAgentSingle(
    step: string,
    skill: string,
  ): Promise<{ actor: Actor; failureNote: string | undefined; cancelled: boolean }> {
    const { slug, ids, workspacePath } = this.deps
    const session = ids('s')
    const resolved = this.resolveSessionRole(step)
    const { runner, runtime: runnerName, model, args, sessionBudgetSeconds } = resolved
    const finalizeBracket = {
      phase: 'finalize' as const,
      round: 1,
      role: step,
      runnerName,
    }
    const streamBracket = await this.openSessionStream(resolved, {
      session,
      role: step,
      runner: runnerName,
      ...(resolved.account === undefined ? {} : { account: resolved.account }),
      ...(model !== undefined ? { model } : {}),
      phase: 'finalize',
      round: 1,
    })
    const stream = streamBracket?.sink

    const started = await this.startBracket({
      actor: KERNEL,
      type: 'session.started',
      payload: {
        session,
        role: step,
        runner: runnerName,
        ...(resolved.account === undefined ? {} : { account: resolved.account }),
        ...(model !== undefined ? { model } : {}),
        args: [...args],
        phase: 'finalize',
        round: 1,
        ...(streamBracket !== undefined ? { stream: streamBracket.streamId } : {}),
      },
    } satisfies EventWrite<'session.started'>)

    let handle: AgentSessionHandle | undefined
    let failureNote: string | undefined
    const turn = await this.runBudgetedTurn(
      started,
      sessionBudgetSeconds,
      async (signal, onNativeSession) =>
        this.startAgent(runner, {
          onNativeSession,
          skill,
          invocation: slug,
          buildSlug: slug,
          workspacePath,
          ...(resolved.account === undefined ? {} : { account: resolved.account }),
          ...(model !== undefined ? { model } : {}),
          ...(args !== undefined ? { args } : {}),
          env: await this.sessionEnvFor('finalize@1', session, step),
          signal,
          ...(stream !== undefined ? { stream } : {}),
        }),
    )
    if (turn.settlement.kind === 'value') {
      handle = turn.settlement.value.session
      if (turn.settlement.value.result.kind === 'failed') {
        failureNote = `agent turn failed: ${turn.settlement.value.result.failure.message}`
      }
    } else if (turn.settlement.kind === 'error') {
      failureNote = `agent session failed: ${errorMessage(turn.settlement.error)}`
    } else {
      this.releaseLateStart(turn.pending, runner)
    }
    if (turn.abortCause === 'budget') {
      if (handle !== undefined) {
        this.releaseExpiredSession(runner, handle, session, finalizeBracket, model, streamBracket)
      } else {
        this.closeBracketStream(streamBracket, 'aborted')
      }
      return {
        actor: agentActor(step, session),
        failureNote: sessionBudgetError(sessionBudgetSeconds),
        cancelled: await this.settleReadDeferral(session),
      }
    }

    if (handle !== undefined) {
      try {
        const transcript = await runner.end(handle)
        await this.depositTranscriptAndEnd(
          session,
          finalizeBracket,
          transcript.content,
          transcript.metadata.usage,
          transcript.metadata.model ?? model,
          streamBracket !== undefined
            ? {
                stream: streamBracket,
                outcome: failureNote === undefined ? 'completed' : 'aborted',
              }
            : undefined,
        )
      } catch {
        // Best-effort: the step outcome below is still recorded.
      }
    }
    this.closeBracketStream(
      streamBracket,
      failureNote === undefined && turn.abortCause !== 'operator' ? 'completed' : 'aborted',
    )

    const deferred = await this.settleReadDeferral(session)
    return {
      actor: agentActor(step, session),
      failureNote,
      cancelled: deferred || turn.abortCause === 'operator',
    }
  }

  /** Both finalize kinds append the same facts and always let the engine
   * advance. Durable-write failures still propagate; only step/publication
   * work is failure-tolerant. */
  private async recordFinalizeOutcome(
    step: string,
    actor: Actor,
    failureNote: string | undefined,
    pushedHead: string | undefined,
  ): Promise<void> {
    const { store, slug, ids } = this.deps
    if (failureNote === undefined) {
      await store.append(slug, {
        actor,
        type: 'finalize.step-completed',
        payload: {
          step,
          ok: true,
          ...(pushedHead !== undefined ? { headSha: pushedHead } : {}),
        },
      } satisfies EventWrite<'finalize.step-completed'>)
      return
    }

    await store.append(slug, {
      actor,
      type: 'finalize.step-completed',
      payload: { step, ok: false, note: failureNote },
    } satisfies EventWrite<'finalize.step-completed'>)
    // §5: a failed post-step files an observation; it never kills a green
    // build. Store-write failures intentionally propagate: no durable fact is
    // claimed when its append did not land.
    await store.append(slug, {
      actor,
      type: 'observation.recorded',
      payload: {
        id: ids('o'),
        kind: 'followup',
        summary: `finalize step "${step}" failed — needs manual follow-up: ${failureNote}`,
      },
    } satisfies EventWrite<'observation.recorded'>)
  }

  private async requireFinalizeWorktreeClean(when: string): Promise<void> {
    const args = ['git', 'status', '--porcelain']
    const result = await this.deps.exec(args, { cwd: this.deps.workspacePath })
    if (result.exitCode !== 0) {
      throw new Error(
        `${args.join(' ')} exited ${result.exitCode}: ` +
          `${result.stderr.trim() || result.stdout.trim() || '(no output)'}`,
      )
    }
    if (result.stdout.length > 0) {
      // The failure record must characterize the dirtiness on its own: the
      // build workspace is disposable, and porcelain lists paths and status
      // codes only — a mode-only flip (AUT-439) is indistinguishable from a
      // content modification once the workspace is gone. Append both diff
      // views so the record shows what actually changed.
      throw new Error(
        `workspace must be clean ${when}; commit intended files and remove ` +
          `temporary files before finishing:\n${result.stdout.trimEnd()}\n\n` +
          (await this.collectWorktreeDiffSections()),
      )
    }
  }

  /** Labeled working-tree and staged diff sections for a dirty finalize
   * preflight record. Runs only on the dirty branch (a clean worktree or a
   * failed status command never executes a diff), caps each section at
   * FINALIZE_DIFF_CAPTURE_CAP characters, and is best-effort: a failing `git
   * diff` command annotates its own section instead of masking the
   * dirty-worktree failure it is annotating. */
  private async collectWorktreeDiffSections(): Promise<string> {
    const views = [
      { args: ['git', 'diff'], header: '--- git diff (working tree) ---' },
      { args: ['git', 'diff', '--cached'], header: '--- git diff --cached (staged) ---' },
    ] as const
    const sections: string[] = []
    for (const { args, header } of views) {
      const command = args.join(' ')
      let body: string
      try {
        const result = await this.deps.exec([...args], { cwd: this.deps.workspacePath })
        if (result.exitCode !== 0) {
          const detail = result.stderr.trim() || result.stdout.trim() || '(no output)'
          body = `(${command} failed: exit ${result.exitCode}: ${capDiffOutput(detail)})`
        } else {
          body = capDiffOutput(result.stdout) || '(no output)'
        }
      } catch (error) {
        body = `(${command} failed: ${capDiffOutput(errorMessage(error))})`
      }
      sections.push(`${header}\n${body}`)
    }
    return sections.join('\n\n')
  }

  private async resolveFinalizeHead(): Promise<string> {
    const args = ['git', 'rev-parse', 'HEAD']
    const result = await this.deps.exec(args, { cwd: this.deps.workspacePath })
    const head = result.stdout.trim()
    if (result.exitCode !== 0 || head.length === 0 || /\s/.test(head)) {
      throw new Error(
        `${args.join(' ')} did not resolve one commit: ` +
          `${result.stderr.trim() || head || '(no output)'}`,
      )
    }
    return head
  }

  private async requirePublishedHeadAncestor(
    publishedHead: string,
    currentHead: string,
  ): Promise<void> {
    const args = ['git', 'merge-base', '--is-ancestor', publishedHead, currentHead]
    const result = await this.deps.exec(args, { cwd: this.deps.workspacePath })
    if (result.exitCode === 0) return
    if (result.exitCode === 1) {
      throw new Error(
        `finalize step rewrote branch history: published head ${publishedHead} ` +
          `is not an ancestor of current HEAD ${currentHead}`,
      )
    }
    throw new Error(
      `${args.join(' ')} exited ${result.exitCode}: ` +
        `${result.stderr.trim() || result.stdout.trim() || '(no output)'}`,
    )
  }

  // ── The session bracket (§15.3) ────────────────────────────────────────────

  /** Run one adapter turn under the logical role's wall-clock budget. The
   * expiry promise is resolved one microtask after the deadline so a conforming
   * adapter can return its endable handle first. An earlier operator abort owns
   * classification, but does not disarm this backstop for an adapter that
   * ignores cancellation. */
  private async runBudgetedTurn<T>(
    started: AbEvent,
    budgetSeconds: number,
    run: (signal: AbortSignal, onNativeSession: NativeSessionObserver) => Promise<T>,
  ): Promise<BudgetedTurn<T>> {
    const { store, slug } = this.deps
    const controller = new AbortController()
    const preSeq = started.seq
    if (started.type !== 'session.started')
      throw new Error('Native observation requires an open session bracket')
    if (this.deps.shutdownSignal?.aborted) throw new SessionShutdown()
    const turnStarted = performance.now()
    const continuation = started.payload.continuation
    const remainingMs = Math.max(
      0,
      (started.payload.budgetMs ?? budgetSeconds * 1000) - (continuation?.activeMs ?? 0),
    )
    let closed = false
    let recorded: string | undefined
    let recording = Promise.resolve()
    const onNativeSession: NativeSessionObserver = (handle) => {
      if ((closed || controller.signal.aborted) && !continuation) return Promise.resolve()
      recording = recording.then(async () => {
        if ((closed || controller.signal.aborted) && !continuation) return
        const validated = nativeSessionHandleSchema.parse(handle)
        if (validated.host !== hostname() || validated.workspacePath !== this.deps.workspacePath)
          throw new Error('Native identity execution location mismatch')
        const bytes = JSON.stringify(validated)
        if (recorded === bytes) return
        if (recorded !== undefined)
          throw new Error('Conflicting native identities in session bracket')
        if (continuation) {
          for (;;) {
            const facts = await readBuildFacts(store, slug)
            const current = facts.value.state.sessions.open.some(
              (s) => s.session === started.payload.session,
            )
            const accepted = await store.appendIfCurrent(slug, facts.cursor, {
              actor: KERNEL,
              type: 'session.resumed',
              payload: {
                session: started.payload.session,
                predecessor: continuation.predecessor,
                root: continuation.root,
                cause: continuation.cause,
                handle: validated,
                stale: !current,
              },
            })
            if (accepted) break
          }
        }
        await store.append(slug, {
          actor: KERNEL,
          type: 'session.native-handle-recorded',
          payload: {
            session: started.payload.session,
            phase: started.payload.phase,
            round: started.payload.round,
            handle: validated,
          },
        } satisfies EventWrite<'session.native-handle-recorded'>)
        recorded = bytes
      })

      // Observe the rejection even if a nonconforming adapter discards its callback promise.
      void recording.catch(() => {})
      return recording
    }
    let pauseInterrupted = false
    let abortCause: 'operator' | 'budget' | undefined
    let resolveExpiry!: (settlement: { kind: 'expired' }) => void
    const expiry = new Promise<{ kind: 'expired' }>((resolve) => {
      resolveExpiry = resolve
    })
    const shutdown = () => {
      if (!controller.signal.aborted) controller.abort(new Error('dispatcher shutdown'))
    }
    this.deps.shutdownSignal?.addEventListener('abort', shutdown, { once: true })
    if (this.deps.shutdownSignal?.aborted) shutdown()
    if (remainingMs <= 0) {
      abortCause = 'budget'
      controller.abort(new Error(sessionBudgetError(budgetSeconds)))
    }
    const pending = Promise.resolve()
      .then(() => {
        if (remainingMs <= 0) throw new Error(sessionBudgetError(budgetSeconds))
        return run(controller.signal, onNativeSession)
      })
      .then(
        (value): { kind: 'value'; value: T } => ({ kind: 'value', value }),
        (error): { kind: 'error'; error: unknown } => ({ kind: 'error', error }),
      )
    const pauseRetries = new Set<ReturnType<typeof setTimeout>>()
    const interruptForPause = () => {
      if (closed || controller.signal.aborted) return
      void readBuildFacts(store, slug)
        .then((facts) => {
          if (closed || controller.signal.aborted) return
          const next = decideNextFromFacts(facts.value.state, facts.value.log, this.boundaryConfig)
          if (next.kind !== 'acknowledge' || next.command !== 'pause') return
          pauseInterrupted = true
          controller.abort(new Error('build paused by operator'))
        })
        .catch(() => {
          // Retry the authoritative read so one transient failure cannot lose
          // a stop, including a request preceding the subscription boundary.
          if (closed || controller.signal.aborted) return
          const timer = setTimeout(() => {
            pauseRetries.delete(timer)
            interruptForPause()
          }, 25)
          pauseRetries.add(timer)
        })
    }
    const unsubscribe = store.subscribe(slug, { fromSeq: preSeq, pollMs: 25 }, (event) => {
      if (event.type === 'build.pause-requested') interruptForPause()
      if (event.type === 'build.abort-requested') {
        abortCause = 'operator'
        controller.abort(new Error(`build ${slug} aborted by operator`))
      }
    })
    // A pause may have landed after phase selection but before this bracket.
    // Arm future delivery first, then check the current durable command too.
    interruptForPause()
    const schedule = this.deps.opts?.scheduleSessionBudget ?? defaultSessionBudgetScheduler
    const cancelTimer = schedule(() => {
      if (!controller.signal.aborted) {
        abortCause = 'budget'
        controller.abort(new Error(sessionBudgetError(budgetSeconds)))
      }
      queueMicrotask(() => resolveExpiry({ kind: 'expired' }))
    }, remainingMs)

    try {
      const settlement = await Promise.race([pending, expiry])
      await recording
      if (settlement.kind === 'error' && settlement.error instanceof FreshSessionRequired)
        throw settlement.error
      this.activeDurations.set(
        started.payload.session,
        Math.max(0, performance.now() - turnStarted),
      )
      if (pauseInterrupted && abortCause !== 'operator') {
        await this.suspendTurn(
          started,
          settlement,
          Math.max(0, performance.now() - turnStarted),
          'pause',
        )
        throw new SessionPaused()
      }
      if (this.deps.shutdownSignal?.aborted && abortCause === undefined) {
        await this.suspendTurn(
          started,
          settlement,
          Math.max(0, performance.now() - turnStarted),
          'shutdown',
        )
        throw new SessionShutdown()
      }
      return {
        settlement,
        ...(abortCause !== undefined ? { abortCause } : {}),
        pending,
      }
    } finally {
      closed = true
      for (const timer of pauseRetries) clearTimeout(timer)
      this.deps.shutdownSignal?.removeEventListener('abort', shutdown)
      cancelTimer()
      unsubscribe()
    }
  }

  /** Cleanup cannot delay acknowledgement indefinitely after the adapter stopped. */
  private async boundedCleanup<T>(cleanup: Promise<T>): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        cleanup,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), 1000)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private async suspendTurn<T>(
    started: Extract<AbEvent, { type: 'session.started' }>,
    settlement: TurnSettlement<T>,
    activeMs: number,
    cause: 'shutdown' | 'pause',
  ): Promise<void> {
    if (
      cause === 'shutdown' &&
      (this.deps.workspaceProvider !== 'git-worktree' || this.deps.workspaceRemote === true)
    )
      return
    const { store, slug } = this.deps
    const session = started.payload.session
    const state = (await readBuildFacts(store, slug)).value.state
    const native = state.sessions.open.find((s) => s.session === session)?.nativeHandle
    const producer = [...this.producerSessions.entries()].find(
      ([phase]) => phase === started.payload.phase,
    )
    if (producer) this.producerSessions.delete(producer[0])
    let content: string | undefined
    let usage: { inputTokens: number; outputTokens: number; turns: number } | undefined
    const value =
      settlement.kind === 'value'
        ? (settlement.value as { session?: AgentSessionHandle; result?: AgentTurnResult })
        : undefined
    const handle = value?.session ?? producer?.[1].handle
    if (handle) {
      try {
        const owner = producer?.[1].runner ?? this.deps.runtimes[started.payload.runner]!.runner
        const transcript =
          cause === 'shutdown'
            ? await owner.end(handle)
            : await this.boundedCleanup(owner.end(handle))
        content = transcript?.content
        usage = value?.result?.usage ?? (producer ? undefined : transcript?.metadata.usage)
      } catch {
        /* Preserve the structured stream if provider cleanup fails. */
      }
    }
    await this.bracketStreams.get(session)?.sink.close('aborted')
    if (!content && started.payload.stream)
      content = JSON.stringify(await store.readStream(started.payload.stream))
    content ??= JSON.stringify({ session, interrupted: true })
    for (;;) {
      const guard = await readTerminalGuardBoundary(
        store,
        slug,
        started.payload.phase,
        started.payload.round ?? 1,
        session,
      )
      const facts = await readBuildFacts(store, slug)
      if (facts.cursor !== guard.cursor) continue
      const postStep = started.payload.phase === 'finalize' && started.payload.role !== 'finalize'
      if (
        postStep
          ? facts.value.log.finalizeStepsDone.has(started.payload.role)
          : guard.value.diagnostic !== undefined
      ) {
        if (usage)
          await this.depositTranscriptAndEnd(
            session,
            {
              phase: started.payload.phase,
              round: started.payload.round ?? 1,
              role: started.payload.role,
              runnerName: started.payload.runner,
            },
            content,
            usage,
            started.payload.model,
          )
        return
      }
      if (!facts.value.state.sessions.open.some((s) => s.session === session)) return
      const suspended = await store.appendWithArtifactsIfCurrent(
        slug,
        guard.cursor,
        [
          {
            kind: 'transcript',
            content,
            metadata: { ...started.payload, usage, activeMs, interrupted: true },
          },
        ],
        (deposited) => ({
          actor: KERNEL,
          type: 'session.suspended',
          payload: {
            session,
            phase: started.payload.phase,
            round: started.payload.round,
            handle: native,
            cause,
            activeMs,
            transcript: { kind: deposited[0]!.kind, rev: deposited[0]!.revision },
            ...(usage ? { usage } : {}),
          },
        }),
      )
      if (suspended) {
        if (started.payload.stream) await store.closeStream(started.payload.stream, 'aborted')
        return
      }
    }
  }

  /** Start resource cleanup without allowing a stuck `end()` or transcript
   * deposit to extend an already-expired phase. Conforming adapters still end
   * immediately; every cleanup/deposit failure remains best-effort. The
   * bracket's stream closes `aborted` (budget cancellation) before the
   * deposit, preserving the close-before-`session.ended` ordering. */
  private releaseExpiredSession(
    runner: AgentRunner,
    handle: AgentSessionHandle,
    session: string,
    bracket: { phase: Phase; round: number; role: string; runnerName: string },
    model?: string,
    stream?: SessionBracketStream,
  ): void {
    void (async () => {
      try {
        const transcript = await runner.end(handle)
        await this.depositTranscriptAndEnd(
          session,
          bracket,
          transcript.content,
          transcript.metadata.usage,
          transcript.metadata.model ?? model,
          stream !== undefined ? { stream, outcome: 'aborted' } : undefined,
        )
      } catch {
        // The expiry failure must remain bounded even when cleanup is not.
      } finally {
        // Belt and braces: idempotent close covers a failed deposit path.
        if (stream !== undefined) void stream.sink.close('aborted')
      }
    })()
  }

  /** A start call can ignore cancellation and return a handle after the kernel
   * has advanced. End that late handle in the background so it never becomes
   * reusable continuation state. The stale durable bracket is intentionally
   * left for the existing recovery model; complete descendant reaping remains
   * the execution supervisor's exit boundary. */
  private releaseLateStart(
    pending: Promise<Exclude<TurnSettlement<{ session: AgentSessionHandle }>, { kind: 'expired' }>>,
    runner: AgentRunner,
  ): void {
    void pending.then(async (settlement) => {
      if (settlement.kind !== 'value') return
      try {
        await runner.end(settlement.value.session)
      } catch {
        // Best-effort resource release after a non-conforming late return.
      }
    })
  }

  /**
   * One bracketed agent run: `session.started` → turn → terminal check →
   * crash-gap repair → `session.ended` (with transcript) or `phase.failed`.
   * Producer phases with a live handle continue it (§10); reviewers always
   * start fresh (fresh skeptic).
   */
  private async executeSession(spec: SessionSpec): Promise<void> {
    const resolved = this.resolveSessionRole(spec.role, ...(spec.roleAliases ?? []))
    // Preserve the historical single-target path byte-for-byte when no chain
    // is configured. Besides compatibility, this keeps its crash-gap and
    // producer-continuation behavior independently well exercised.
    if (resolved.alternates.length === 0) return this.executeSingleSession(spec)
    return this.executeSessionChain(spec, resolved, resolved.alternates)
  }

  /** Execute all configured targets inside one phase attempt. Every target has
   * its own durable session bracket; only exhaustion writes phase.failed. */
  private async executeSessionChain(
    spec: SessionSpec,
    primary: ResolvedRole,
    alternates: readonly ResolvedRuntime[],
  ): Promise<void> {
    const { store, slug, ids, workspacePath } = this.deps
    const targets = [primary, ...alternates]
    const attempts: ProviderAttempt[] = []
    let substitution: ProviderAttempt | undefined
    const primaryRoute = JSON.stringify({
      runtime: primary.runtime,
      model: primary.model,
      args: primary.args,
      account: primary.account,
    })
    let primaryLive =
      spec.producerPhase !== undefined ? this.producerSessions.get(spec.producerPhase) : undefined
    if (
      primaryLive !== undefined &&
      (primaryLive.runner !== primary.runner || primaryLive.route !== primaryRoute)
    ) {
      try {
        await primaryLive.runner.end(primaryLive.handle)
      } catch {
        // Best-effort cleanup after the previous round reached its boundary.
      }
      if (spec.producerPhase !== undefined) this.producerSessions.delete(spec.producerPhase)
      primaryLive = undefined
    }

    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index]!
      const session = ids('s')
      // SPEC §9: each chain target gets its own durable bracket and its own
      // stream, opened before the bracket's first turn.
      const streamBracket = await this.openSessionStream(target, {
        session,
        role: spec.role,
        runner: target.runtime,
        ...(target.account === undefined ? {} : { account: target.account }),
        ...(target.model !== undefined ? { model: target.model } : {}),
        phase: spec.phase,
        round: spec.round,
      })
      const stream = streamBracket?.sink
      const startedEnvelope = await this.startBracket({
        actor: KERNEL,
        type: 'session.started',
        payload: {
          session,
          role: spec.role,
          runner: target.runtime,
          ...(target.account === undefined ? {} : { account: target.account }),
          ...(target.model !== undefined ? { model: target.model } : {}),
          args: [...target.args],
          phase: spec.phase,
          round: spec.round,
          ...(streamBracket !== undefined ? { stream: streamBracket.streamId } : {}),
          ...(substitution !== undefined
            ? { substitution: { failed: substitution, selectedIndex: index } }
            : {}),
        },
      } satisfies EventWrite<'session.started'>)
      const preSeq = startedEnvelope.seq
      const live = index === 0 ? primaryLive : undefined

      let handle: AgentSessionHandle | undefined = live?.handle
      let result: AgentTurnResult | undefined
      let turnError: unknown
      const turn = await this.runBudgetedTurn(
        startedEnvelope,
        primary.sessionBudgetSeconds,
        async (signal, onNativeSession) =>
          live !== undefined
            ? live.runner
                .continue(live.handle, continueMessage(spec), {
                  onNativeSession,
                  env: await this.sessionEnvFor(spec.abPhase, session),
                  signal,
                  ...(stream !== undefined ? { stream } : {}),
                })
                .then((continued) => ({ session: live.handle, result: continued }))
            : this.startAgent(target.runner, {
                onNativeSession,
                skill: spec.skill,
                invocation: slug,
                buildSlug: slug,
                workspacePath,
                ...(target.account === undefined ? {} : { account: target.account }),
                ...(target.model !== undefined ? { model: target.model } : {}),
                ...(target.args !== undefined ? { args: target.args } : {}),
                env: await this.sessionEnvFor(spec.abPhase, session),
                signal,
                ...(stream !== undefined ? { stream } : {}),
              }),
      )
      if (turn.settlement.kind === 'value') {
        handle = turn.settlement.value.session
        result = turn.settlement.value.result
      } else if (turn.settlement.kind === 'error') {
        turnError = turn.settlement.error
      } else if (live === undefined) {
        this.releaseLateStart(turn.pending, target.runner)
      }

      const since = await readBuildRange(store, slug, preSeq)
      const terminal = since.some(
        (event) =>
          spec.isTerminal(event) ||
          isPublicationBoundary(event, spec, session) ||
          (event.type === 'escalation.raised' &&
            event.actor.kind === 'agent' &&
            event.actor.session === session),
      )
      if (spec.phase === 'plan-review' || spec.phase === 'code-review') {
        await this.repairEscalateGap(since, spec.phase, spec.round)
      }

      const bracket = {
        phase: spec.phase,
        round: spec.round,
        role: spec.role,
        runnerName: target.runtime,
      }
      const owner = live?.runner ?? target.runner

      if (turn.abortCause === 'operator') {
        if (handle !== undefined) {
          try {
            const transcript = await owner.end(handle)
            await this.depositTranscriptAndEnd(
              session,
              bracket,
              transcript.content,
              transcript.metadata.usage,
              transcript.metadata.model ?? target.model,
              streamBracket !== undefined
                ? { stream: streamBracket, outcome: 'aborted' }
                : undefined,
            )
          } catch {
            // Cancellation remains a control boundary, never phase failure.
          }
        }
        this.closeBracketStream(streamBracket, 'aborted')
        if (spec.producerPhase !== undefined) this.producerSessions.delete(spec.producerPhase)
        return
      }

      // A typed terminal deposited at the deadline remains authoritative even
      // when the adapter has not yet returned its handle/result.
      if (terminal && turn.abortCause === 'budget') {
        if (handle !== undefined) {
          this.releaseExpiredSession(owner, handle, session, bracket, target.model, streamBracket)
        } else {
          this.closeBracketStream(streamBracket, 'aborted')
        }
        if (spec.producerPhase !== undefined) this.producerSessions.delete(spec.producerPhase)
        return
      }

      if (terminal && handle !== undefined && result !== undefined) {
        try {
          if (spec.producerPhase !== undefined && index === 0) {
            this.producerSessions.set(spec.producerPhase, {
              handle,
              runner: owner,
              route: primaryRoute,
            })
            const content = JSON.stringify(
              {
                session,
                phase: spec.phase,
                round: spec.round,
                note: 'producer session kept live for §10 continuation; per-round turn transcript',
                turn: {
                  text: result.text,
                  usage: result.usage,
                  prompt: this.interruptionPrompts.get(session),
                },
              },
              null,
              2,
            )
            await this.depositTranscriptAndEnd(
              session,
              bracket,
              content,
              result.usage,
              target.model,
              streamBracket !== undefined
                ? { stream: streamBracket, outcome: 'completed' }
                : undefined,
            )
          } else {
            // An alternate producer must not become sticky across the review
            // boundary. End it like any fresh session; the next round begins on
            // the primary and rehydrates context from durable artifacts.
            const transcript = await owner.end(handle)
            await this.depositTranscriptAndEnd(
              session,
              bracket,
              transcript.content,
              transcript.metadata.usage,
              transcript.metadata.model ?? target.model,
              streamBracket !== undefined
                ? { stream: streamBracket, outcome: 'completed' }
                : undefined,
            )
            if (spec.producerPhase !== undefined) this.producerSessions.delete(spec.producerPhase)
          }
        } catch (error) {
          if (!(error instanceof StoreWriteTooLargeError)) throw error
          // The durable terminal remains authoritative over optional cleanup.
        }
        return
      }

      if (terminal) {
        if (handle !== undefined) {
          try {
            const transcript = await owner.end(handle)
            await this.depositTranscriptAndEnd(
              session,
              bracket,
              transcript.content,
              transcript.metadata.usage,
              transcript.metadata.model ?? target.model,
              streamBracket !== undefined
                ? { stream: streamBracket, outcome: 'completed' }
                : undefined,
            )
          } catch {
            // The durable terminal remains authoritative over adapter failure
            // and best-effort transcript cleanup.
          }
        }
        this.closeBracketStream(streamBracket, 'completed')
        if (spec.producerPhase !== undefined) this.producerSessions.delete(spec.producerPhase)
        return
      }

      if (turn.abortCause === 'budget') {
        if (handle !== undefined) {
          this.releaseExpiredSession(owner, handle, session, bracket, target.model, streamBracket)
        } else {
          this.closeBracketStream(streamBracket, 'aborted')
        }
        if (spec.producerPhase !== undefined) this.producerSessions.delete(spec.producerPhase)
        await this.failPhase(
          spec.phase,
          spec.round,
          spec.priorFailures,
          sessionBudgetError(primary.sessionBudgetSeconds),
          true,
        )
        return
      }

      if (handle !== undefined) {
        try {
          const transcript = await owner.end(handle)
          await this.depositTranscriptAndEnd(
            session,
            bracket,
            transcript.content,
            transcript.metadata.usage,
            transcript.metadata.model ?? target.model,
            streamBracket !== undefined ? { stream: streamBracket, outcome: 'aborted' } : undefined,
          )
        } catch (error) {
          if (error instanceof StoreWriteTooLargeError) turnError = error
          // A dead provider may leave no recoverable transcript.
        }
      }
      this.closeBracketStream(streamBracket, 'aborted')
      if (spec.producerPhase !== undefined) this.producerSessions.delete(spec.producerPhase)

      if (turnError instanceof StoreWriteTooLargeError) throw turnError

      const failure: AgentTurnFailure =
        turnError !== undefined
          ? { message: errorMessage(turnError), permanent: false, cause: 'availability' }
          : result?.kind === 'failed'
            ? result.failure
            : { message: 'no-terminal', permanent: false }
      const attempt: ProviderAttempt = {
        index,
        session,
        runner: target.runtime,
        ...(target.account === undefined ? {} : { account: target.account }),
        ...(target.model !== undefined ? { model: target.model } : {}),
        error: failure.message,
        ...(failure.cause !== undefined ? { cause: failure.cause } : {}),
      }
      attempts.push(attempt)

      if (await this.settleReadDeferral(session)) return

      const eligibleForAlternate =
        turnError !== undefined ||
        (result?.kind === 'failed' && isAlternateEligible(result.failure))
      if (index + 1 < targets.length && eligibleForAlternate) {
        substitution = attempt
        continue
      }

      await this.failPhase(
        spec.phase,
        spec.round,
        spec.priorFailures,
        failure.message,
        mayRetryPhase(failure),
        attempts,
      )
      return
    }
  }

  /** Historical single-target bracket, retained unchanged for repositories
   * that declare no alternates. */
  private async executeSingleSession(spec: SessionSpec): Promise<void> {
    const { store, slug, ids, workspacePath } = this.deps
    const session = ids('s')
    // `session.started.role` records the LOGICAL name the pipeline dispatched
    // in every case, including when a deprecated alias answered the lookup —
    // the runtime/model on the same payload say what was resolved.
    const resolved = this.resolveSessionRole(spec.role, ...(spec.roleAliases ?? []))
    const { runner, runtime: runnerName, model, args, sessionBudgetSeconds } = resolved
    const route = JSON.stringify({ runtime: runnerName, model, args, account: resolved.account })
    // SPEC §9: the stream opens before the bracket's first turn — its id is
    // already known when `session.started` appends.
    const streamBracket = await this.openSessionStream(resolved, {
      session,
      role: spec.role,
      runner: runnerName,
      ...(resolved.account === undefined ? {} : { account: resolved.account }),
      ...(model !== undefined ? { model } : {}),
      phase: spec.phase,
      round: spec.round,
    })
    let live =
      spec.producerPhase !== undefined ? this.producerSessions.get(spec.producerPhase) : undefined
    if (live !== undefined && (live.runner !== runner || live.route !== route)) {
      // A completed old round may keep provider continuation state, but a new
      // route must begin a new provider session. The old round itself was not
      // interrupted; it reached this boundary before being closed.
      try {
        await live.runner.end(live.handle)
      } catch {
        // Best-effort provider cleanup; route adoption must still proceed.
      }
      if (spec.producerPhase !== undefined) this.producerSessions.delete(spec.producerPhase)
      live = undefined
    }

    const startedEnvelope = await this.startBracket({
      actor: KERNEL,
      type: 'session.started',
      payload: {
        session,
        role: spec.role,
        runner: runnerName,
        ...(resolved.account === undefined ? {} : { account: resolved.account }),
        ...(model !== undefined ? { model } : {}),
        args: [...args],
        phase: spec.phase,
        round: spec.round,
        ...(streamBracket !== undefined ? { stream: streamBracket.streamId } : {}),
      },
    } satisfies EventWrite<'session.started'>)
    const preSeq = startedEnvelope.seq
    const stream = streamBracket?.sink

    let handle: AgentSessionHandle | undefined = live?.handle
    let result: AgentTurnResult | undefined
    let turnError: unknown
    const turn = await this.runBudgetedTurn(
      startedEnvelope,
      sessionBudgetSeconds,
      async (signal, onNativeSession) => {
        if (live !== undefined) {
          // §10: the producer continues its session; the feedback message
          // points at the session directory inputs — `ab context` is the real carrier. The
          // turn re-issues ambient auth (D8) for the NEW bracket — AB_PHASE at
          // this round, AB_SESSION = this bracket's id — so the CLI's terminal
          // lands on the continued round instead of being rejected as round
          // 1's second terminal (§8.4 D5).
          return live.runner
            .continue(live.handle, continueMessage(spec), {
              onNativeSession,
              env: await this.sessionEnvFor(spec.abPhase, session),
              signal,
              ...(stream !== undefined ? { stream } : {}),
            })
            .then((continued) => ({ session: live.handle, result: continued }))
        }
        return this.startAgent(runner, {
          onNativeSession,
          skill: spec.skill,
          invocation: slug,
          buildSlug: slug,
          workspacePath,
          ...(resolved.account === undefined ? {} : { account: resolved.account }),
          ...(model !== undefined ? { model } : {}),
          ...(args !== undefined ? { args } : {}),
          env: await this.sessionEnvFor(spec.abPhase, session),
          signal,
          ...(stream !== undefined ? { stream } : {}),
        })
      },
    )
    if (turn.settlement.kind === 'value') {
      handle = turn.settlement.value.session
      result = turn.settlement.value.result
    } else if (turn.settlement.kind === 'error') {
      turnError = turn.settlement.error
    } else if (live === undefined) {
      this.releaseLateStart(turn.pending, runner)
    }

    // The turn is over: what did the CLI leave in the log? Terminal = the
    // phase's terminal event for this round, or an `ab escalate` from this
    // session (§8.4: escalate is always an allowed terminal).
    const since = await readBuildRange(store, slug, preSeq)
    const terminal = since.some(
      (event) =>
        spec.isTerminal(event) ||
        isPublicationBoundary(event, spec, session) ||
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

    // Operator cancellation is not an infrastructure failure. Close whatever
    // handle the adapter created, retain its transcript, and return to the
    // engine loop; the pending durable command is acknowledged there.
    if (turn.abortCause === 'operator') {
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
            streamBracket !== undefined ? { stream: streamBracket, outcome: 'aborted' } : undefined,
          )
        } catch {
          // A provider that died before yielding an endable handle leaves the
          // open session for stale-runner recovery, but never a phase failure.
        }
      }
      this.closeBracketStream(streamBracket, 'aborted')
      if (spec.producerPhase !== undefined) this.producerSessions.delete(spec.producerPhase)
      return
    }

    // The typed terminal is the phase authority even when it lands on the
    // same boundary tick as the kernel deadline.
    if (terminal && turn.abortCause === 'budget') {
      if (handle !== undefined) {
        const owner = live?.runner ?? runner
        this.releaseExpiredSession(owner, handle, session, bracket, model, streamBracket)
      } else {
        this.closeBracketStream(streamBracket, 'aborted')
      }
      if (spec.producerPhase !== undefined) this.producerSessions.delete(spec.producerPhase)
      return
    }

    if (terminal && handle !== undefined && result !== undefined) {
      try {
        if (spec.producerPhase !== undefined) {
          // §10 memory: keep the handle live for the next round; the bracket
          // closes with THIS turn's transcript (see module doc — ending the
          // runner session would destroy the continuation every adapter needs).
          this.producerSessions.set(spec.producerPhase, {
            handle,
            runner: live?.runner ?? runner,
            route,
          })
          const content = JSON.stringify(
            {
              session,
              phase: spec.phase,
              round: spec.round,
              note:
                'producer session kept live for §10 continuation; ' + 'per-round turn transcript',
              turn: {
                text: result.text,
                usage: result.usage,
                prompt: this.interruptionPrompts.get(session),
              },
            },
            null,
            2,
          )
          await this.depositTranscriptAndEnd(
            session,
            bracket,
            content,
            result.usage,
            model,
            streamBracket !== undefined
              ? { stream: streamBracket, outcome: 'completed' }
              : undefined,
          )
        } else {
          // Reviewer / agent-verify: single-run session, real transcript.
          const transcript = await runner.end(handle)
          await this.depositTranscriptAndEnd(
            session,
            bracket,
            transcript.content,
            transcript.metadata.usage,
            transcript.metadata.model ?? model,
            streamBracket !== undefined
              ? { stream: streamBracket, outcome: 'completed' }
              : undefined,
          )
        }
      } catch (error) {
        if (!(error instanceof StoreWriteTooLargeError)) throw error
        // The durable terminal remains authoritative over optional cleanup.
      }
      return
    }

    if (terminal) {
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
            streamBracket !== undefined
              ? { stream: streamBracket, outcome: 'completed' }
              : undefined,
          )
        } catch {
          // The durable terminal remains authoritative over adapter failure
          // and best-effort transcript cleanup.
        }
      }
      this.closeBracketStream(streamBracket, 'completed')
      if (spec.producerPhase !== undefined) this.producerSessions.delete(spec.producerPhase)
      return
    }

    if (turn.abortCause === 'budget') {
      if (handle !== undefined) {
        const owner = live?.runner ?? runner
        this.releaseExpiredSession(owner, handle, session, bracket, model, streamBracket)
      } else {
        this.closeBracketStream(streamBracket, 'aborted')
      }
      if (spec.producerPhase !== undefined) this.producerSessions.delete(spec.producerPhase)
      await this.failPhase(
        spec.phase,
        spec.round,
        spec.priorFailures,
        sessionBudgetError(sessionBudgetSeconds),
        true,
      )
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
          streamBracket !== undefined ? { stream: streamBracket, outcome: 'aborted' } : undefined,
        )
      } catch (error) {
        if (error instanceof StoreWriteTooLargeError) turnError = error
        // Transcript deposition can still fail. A later recovering runner
        // explicitly reclaims this open session before announcing attachment.
      }
    }
    this.closeBracketStream(streamBracket, 'aborted')
    if (spec.producerPhase !== undefined) {
      this.producerSessions.delete(spec.producerPhase)
    }
    if (turnError instanceof StoreWriteTooLargeError) throw turnError
    const failure =
      turnError !== undefined
        ? { message: errorMessage(turnError), mayRetry: true }
        : result?.kind === 'failed'
          ? {
              message: result.failure.message,
              mayRetry: !result.failure.permanent,
            }
          : { message: 'no-terminal', mayRetry: true }
    if (await this.settleReadDeferral(session)) return
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
   * model, session, usage. When the bracket carried a stream, it closes
   * here — before the `session.ended` append lands — so a reader never sees
   * a closed session with an open stream. */
  private async depositTranscriptAndEnd(
    session: string,
    bracket: { phase: Phase; round: number; role: string; runnerName: string },
    content: string,
    usage: { inputTokens: number; outputTokens: number; turns: number },
    model?: string,
    close?: { stream: SessionBracketStream; outcome: StreamOutcome },
  ): Promise<void> {
    const { store, slug } = this.deps
    if (close !== undefined) {
      // Close must land no later than `session.ended`; this makes the
      // ordering structural rather than call-site discipline.
      await close.stream.sink.close(close.outcome)
    }
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
            interruptionPrompt: this.interruptionPrompts.get(session),
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
            activeMs: this.activeDurations.get(session),
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
      verdict = {
        seq: event.seq,
        ...(event.payload.reason !== undefined ? { reason: event.payload.reason } : {}),
      }
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

  // ── Session streams (SPEC §9) ────────────────────────────────────────────

  /**
   * Open one stream for this session bracket through the resolved target's
   * streaming capability: create the store-backed sink, call the capability,
   * and — once it returns an id — emit the bracket's `data-ab-session` part.
   * Returns undefined (and reports once) when streaming is disabled, the
   * runtime declared no capability, or the opener declined/failed; the
   * bracket then proceeds exactly as without streams.
   */
  private async openSessionStream(
    target: ResolvedRuntime,
    info: SessionStreamInfo,
  ): Promise<SessionBracketStream | undefined> {
    if (!this.streamSessions) return undefined
    const open = target.openSessionStream
    if (open === undefined) return undefined
    const sink = createSessionStreamSink({
      store: this.deps.store,
      scope: { kind: 'build', build: this.deps.slug },
      onDiagnostic: this.onDiagnostic,
    })
    try {
      const streamId = await open(sink, info)
      if (streamId === undefined) return undefined
      sink.append([sessionPart(info)])
      const bracket = { sink, streamId, info }
      this.bracketStreams.set(info.session, bracket)
      return bracket
    } catch (error) {
      this.onDiagnostic(
        `session stream for "${info.session}" failed to open: ${errorMessage(error)}`,
      )
      return undefined
    }
  }

  /** Best-effort belt-and-braces close; idempotency makes repeated calls
   * harmless and lets the deposit path own the close-then-append ordering. */
  private closeBracketStream(
    stream: SessionBracketStream | undefined,
    outcome: StreamOutcome,
  ): void {
    if (stream === undefined) return
    void stream.sink.close(outcome)
  }

  /** D8 ambient auth: sessionEnv may override AB_STORE (remote stores) and
   * add AB_TOKEN, but never the per-session identity keys. */
  private async sessionEnvFor(
    abPhase: string,
    session: string,
    finalizeStep?: string,
  ): Promise<Record<string, string>> {
    const parent = this.deps.sessionEnv
    const token =
      parent?.AB_STORE && /^https?:/i.test(parent.AB_STORE)
        ? await (this.deps.delegateCredential ?? delegateCredential)(
            parent.AB_STORE,
            parent.AB_TOKEN,
            { kind: 'build-phase', id: this.deps.slug, session },
          )
        : undefined
    return {
      AB_ACCOUNT_CREDENTIAL_ENVS: JSON.stringify(
        Object.values(this.boundaryConfig.accounts).map((account) => account.credentialEnv),
      ),
      AB_STORE: 'local',
      ...this.deps.sessionEnv,
      ...(token ? { AB_TOKEN: token } : {}),
      AB_BUILD: this.deps.slug,
      AB_PHASE: abPhase,
      AB_CONTEXT_DIR: contextDirectory(abPhase, finalizeStep),
      AB_SESSION: session,
    }
  }

  /**
   * phase.failed tally for one phase+round — D5's retry-guard input.
   *
   * An answered escalation re-arms this budget only when its semantic class
   * acknowledges phase-runner failures (§15.6-B). Runner-failure causes reset
   * their matching round, the phase-level verify cause resets all rounds, and
   * unrelated policy causes reset nothing. Cause-less historical and
   * non-policy raises retain the legacy round-shaped behavior. Failures after
   * an applicable answer count again, so a still-failing phase re-escalates on
   * new evidence instead of deadlocking before its recovery session starts.
   */

  private async settleReadDeferral(session: string): Promise<boolean> {
    const { store, slug } = this.deps
    const item = (await readBuildFacts(store, slug)).value.log.readDeferrals.find(
      (item) => item.session === session,
    )
    if (!item) return false
    if (!item.ended) {
      await store.append(slug, {
        actor: KERNEL,
        type: 'session.ended',
        payload: {
          session,
          outcome: 'reclaimed',
          reclaimedBy: {
            instance: this.deps.instance,
            resumedFromSeq: (await readBuildFacts(store, slug)).value.state.lastSeq,
          },
        },
      })
    }
    await this.raiseReadDeferral(item)
    return true
  }

  private async raiseReadDeferral(
    item: import('../kernel/read-deferrals').ReadDeferral,
  ): Promise<void> {
    const { store, slug } = this.deps
    if (!item.settled)
      await store.append(slug, {
        actor: KERNEL,
        type: 'phase.deferred',
        payload: {
          session: item.session,
          phase: item.phase,
          round: item.round,
          reason: 'own-build-read',
          diagnostic: item.diagnostic,
        },
      })
    const state = (await readBuildFacts(store, slug)).value.state
    const ref = `own-build-read:${item.evidenceSeq}`
    if (
      [...state.openEscalations, ...state.answeredEscalations].some((raise) =>
        raise.refs?.includes(ref),
      )
    )
      return
    await store.append(slug, {
      actor: KERNEL,
      type: 'phase.deferral-escalated',
      payload: {
        id: this.deps.ids('esc'),
        session: item.session,
        phase: item.phase,
        round: item.round,
        evidenceSeq: item.evidenceSeq,
        refs: [ref, item.phase, String(item.round)],
        question: `${item.phase} round ${item.round} could not read its own build: ${item.diagnostic}. Repair CLI/store access, then answer retry or guidance to authorize a fresh session.`,
      },
    })
  }

  /** Only typed kernel write failures change disposition; persistence errors escape. */
  private async withKernelPhaseFailure(
    phase: Phase,
    round: number,
    operation: () => Promise<void>,
  ): Promise<void> {
    try {
      await operation()
    } catch (error) {
      if (!(error instanceof StoreWriteTooLargeError) || this.failurePersistenceErrors.has(error))
        throw error
      const failures = await readPhaseFailures(this.deps.store, this.deps.slug, phase, round)
      await this.failPhase(phase, round, failures.count, error.message, false)
    }
  }

  private readonly failurePersistenceErrors = new WeakSet<Error>()

  private async failPhase(...args: Parameters<BuildRunner['persistPhaseFailure']>): Promise<void> {
    try {
      await this.persistPhaseFailure(...args)
    } catch (error) {
      if (error instanceof Error) this.failurePersistenceErrors.add(error)
      throw error
    }
  }

  private async persistPhaseFailure(
    phase: Phase,
    round: number,
    priorFailures: number,
    error: string,
    mayRetry = true,
    providerAttempts?: readonly ProviderAttempt[],
  ): Promise<void> {
    // A decisive fact may arrive while the agent is live (including while
    // its terminal is refused). Do not turn deferral into a consumed retry.
    if (await deferMixedVersion(this.deps.store, this.deps.slug, KERNEL))
      throw new MixedVersionDeferral()
    const facts = (await readBuildFacts(this.deps.store, this.deps.slug)).value
    const member = phase.startsWith('verify:') ? verifyMemberKey(phase.slice(7), round) : undefined
    if (
      member !== undefined &&
      (facts.state.verifyStage.cancellations[member] || facts.state.verifyStage.outcomes[member])
    )
      return
    const deferred = facts.log.readDeferrals.find(
      (item) => item.phase === phase && item.round === round,
    )
    if (deferred) {
      await this.settleReadDeferral(deferred.session)
      return
    }
    const attempt = priorFailures + 1
    const write = {
      actor: KERNEL,
      type: 'phase.failed',
      payload: {
        phase,
        round,
        attempt,
        error,
        willRetry: mayRetry && attempt < this.maxPhaseAttempts,
        ...(providerAttempts !== undefined ? { providerAttempts: [...providerAttempts] } : {}),
      },
    } satisfies EventWrite<'phase.failed'>
    if (member === undefined) {
      await this.deps.store.append(this.deps.slug, write)
      return
    }
    for (;;) {
      const { state } = (await readBuildFacts(this.deps.store, this.deps.slug)).value
      if (state.verifyStage.cancellations[member] || state.verifyStage.outcomes[member]) return
      if (await this.deps.store.appendIfCurrent(this.deps.slug, state.lastSeq, write)) return
    }
  }

  /** A permanent failure parks immediately. The fact
   * comes from the latest durable `phase.failed {willRetry:false}`, so a crash
   * between that write and this escalation resumes safely without attempt 2. */
  private async raisePolicyNonRetryable(
    phase: Phase,
    round: number,
    failures: {
      count: number
      lastError?: string
      lastProviderAttempts?: readonly ProviderAttempt[]
    },
  ): Promise<void> {
    await this.deps.store.append(this.deps.slug, {
      actor: KERNEL,
      type: 'escalation.raised',
      payload: {
        id: this.deps.ids('esc'),
        phase,
        round,
        source: 'policy',
        policyCause: 'non-retryable-phase-failure',
        question:
          `${phase} round ${round} stopped after a non-retryable ` +
          `failure on attempt ${failures.count}; last error: ` +
          `${failures.lastError ?? 'unknown'}` +
          providerAttemptSummary(failures.lastProviderAttempts),
      },
    } satisfies EventWrite<'escalation.raised'>)
  }

  /** D5: the retry cap escalates (source 'policy') instead of running,
   * naming the phase, round, and last error. */
  private async raisePolicyExhausted(
    phase: Phase,
    round: number,
    failures: {
      count: number
      lastError?: string
      lastProviderAttempts?: readonly ProviderAttempt[]
    },
  ): Promise<void> {
    await this.deps.store.append(this.deps.slug, {
      actor: KERNEL,
      type: 'escalation.raised',
      payload: {
        id: this.deps.ids('esc'),
        phase,
        round,
        source: 'policy',
        policyCause: 'phase-attempt-limit',
        question:
          `${phase} round ${round} failed ${failures.count} times ` +
          `(maxPhaseAttempts ${this.maxPhaseAttempts}); last error: ` +
          `${failures.lastError ?? 'unknown'}` +
          providerAttemptSummary(failures.lastProviderAttempts),
      },
    } satisfies EventWrite<'escalation.raised'>)
  }

  /** The phase's started event, payload per the catalog (§15.3). */
  private startedWrite(decision: RunPhaseDecision, reconcileBaseSha?: string): EventWrite {
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
            ...(decision.verifyStageFailure === undefined
              ? {}
              : { verifyStageFailure: decision.verifyStageFailure }),
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
          throw new Error('run-phase reconcile start requires an attempt and refreshed base SHA')
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
        await this.boundedCleanup(entry.runner.end(entry.handle))
      } catch {
        // Already dead — nothing to release.
      }
    }
    this.producerSessions.clear()
  }
}
