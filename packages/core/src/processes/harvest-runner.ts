import { accountRedactor, redactAccountStore } from '../store/account-redaction'
import {
  guardNativeHandle,
  nativeSessionHandleSchema,
  resumeAgent,
} from '../ports/runner/native-session'
import type { NativeSessionHandle, AgentStartOpts } from '../ports/types'
import { readRepositoryFacts } from '../store/reduced-reads'
import { issueTicketGrant } from '../ports/tickets/grants'
import { delegateCredential } from '../store/remote/credentials'
/**
 * Crash-safe repository-scoped harvest workflow:
 * scan -> synthesize <-> review -> file. It reuses `converge` for adversarial
 * review semantics while every durable boundary lives in the repository
 * journal, so a replacement process resumes the claimed snapshot rather than
 * starting a duplicate run.
 */
import { HARVEST_REVIEW_ROLE, HARVEST_ROLE } from '../config/roles'
import type { Config } from '../config/schema'
import type { HarvestEventPayload, RepositoryEvent } from '../events/repository'
import { KERNEL } from '../events/envelope'
import type { IdSource, UuidSource } from '../ids'
import { occurrenceKey, type HarvestDisposition } from '../harvest/schema'
import { converge } from '../kernel/converge'
import { stalledChains } from '../kernel/stall'
import {
  DEFAULT_MAX_HARVEST_RECOVERY_ATTEMPTS,
  actionableHarvestRun,
  decideHarvestControl,
  openHarvestRun,
  proposalArtifactForRound,
  type HarvestRunState,
} from '../kernel/harvest'
import type { ArtifactRef, Feedback, Verdict } from '../ontology'
import {
  createRuntimeResolver,
  type ResolvedRuntime,
  type RuntimeResolver,
} from '../ports/runner/routing'
import { isAlternateEligible, mayRetryPhase } from '../ports/runner/provider-error'
import { sessionPart } from '../ports/runner/stream-parts'
import type { SessionStreamInfo, RuntimeRegistry } from '../ports/runner/runtime'
import { createSessionStreamSink } from '../store/streams/session-writer'
import type { StreamOutcome } from '../store/streams/types'
import type {
  AgentRunner,
  AgentSessionHandle,
  AgentTurnFailure,
  AgentTurnResult,
  SessionStreamSink,
  TicketSource,
} from '../ports/types'
import { installedSkillName } from '../skills'
import { defaultProposalState } from './dispatcher'
import {
  artifactRef,
  evaluateHarvestPressure,
  evaluateHarvestPressureFromDigests,
  HARVEST_REPORT_ARTIFACT,
  HARVEST_SCAN_ARTIFACT,
  HARVEST_TRANSCRIPT_ARTIFACT,
  harvestProposalKey,
  loadScanPacket,
  makeHarvestScanPacket,
  parseApprovedProposalSet,
  partitionHarvestExhaustion,
  renderHarvestProposal,
  resolveHarvestCreateBlockers,
  scanUnclaimedObservations,
} from './harvest'
import type { BuildStore, Clock } from '../store/types'

/** Reserved provenance marker for deterministic harvest-created proposals. */
export const HARVEST_PROPOSAL_LABEL = 'autobuild:proposal'

export interface HarvestRunnerOpts {
  leaseTtlMs?: number
  heartbeatMs?: number
  /** Retry budget inside one synthesize/review/file occurrence. */
  maxSessionAttempts?: number
  /** Durable outer reopen budget for a stopped run. */
  maxRecoveryAttempts?: number
  /** Stream each agent session bracket as AI SDK UI message parts (SPEC §9,
   * the same wiring the build runners use). Default true. */
  streamSessions?: boolean
  /** Diagnostics hook for contained stream failures. Default console.error. */
  onDiagnostic?: (message: string) => void
}

export interface HarvestRunnerDeps {
  store: BuildStore
  tickets: TicketSource
  config: Config
  /** Current dispatcher snapshot, sampled only at workflow/session boundaries. */
  getConfig?: () => Config
  runtimes: RuntimeRegistry
  repo: string
  workspacePath: string
  ids: IdSource
  uuids: UuidSource
  clock: Clock
  instance: string
  /** Repository-lease holder adopted from the owning DispatchLoop: when
   * present, the runner skips its own claim, heartbeats with that holder, and
   * never releases at the end — the owning loop holds the lease for its
   * lifetime. Absent keeps the standalone self-claiming behavior. */
  leaseHolder?: string
  /** Provider-native identity of the disposable environment this run
   * executes in (hosted harvest). Stamped into the run's harvest.started
   * payload so the journal records where it ran; absent on local runs. */
  environment?: { provider: string; environmentId: string; sessionId?: string }
  preparedRun?: { run: string }
  sessionEnv?: Record<string, string>
  shutdownSignal?: AbortSignal
  shutdownCause?: () => 'shutdown' | 'cutover'
  opts?: HarvestRunnerOpts
}

export type HarvestRunnerResult =
  | { outcome: 'prepared'; run: string; launch: 'started' | 'resumed' }
  | { outcome: 'idle' }
  | { outcome: 'held' }
  | { outcome: 'parked'; run?: string }
  | { outcome: 'suspended'; run?: string }
  | {
      outcome: 'completed' | 'escalated' | 'failed'
      launch: 'started' | 'resumed'
      run: string
    }

interface ProducerSession {
  handle: AgentSessionHandle
  runner: AgentRunner
  route: string
  nativeHandle?: NativeSessionHandle
}

type HarvestProviderAttempt = NonNullable<
  HarvestEventPayload<'harvest.failed'>['providerAttempts']
>[number]

/** One session bracket's live stream (SPEC §9): the sink the harvest runner
 * opened through the resolved target's streaming capability and the store id
 * it returned. Undefined ⇒ the runtime declared no capability or the opener
 * declined — the bracket then behaves exactly as before streams existed. */
interface SessionBracketStream {
  sink: SessionStreamSink
  streamId: string
}

class HarvestSuspendedSignal extends Error {}
class HarvestPersistenceError extends Error {}

class SessionFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HarvestSessionFailure'
  }
}

/** Internal, non-error unwind from a durable control boundary. It must never
 * consume failure budget or emit harvest.failed. */
class HarvestParkedSignal extends Error {
  constructor(readonly run?: string) {
    super('harvest parked by operator')
    this.name = 'HarvestParkedSignal'
  }
}

/** A heartbeat proved this process no longer owns the repository lease and a
 * replacement claimed it before we could re-acquire. This is not workflow
 * failure: the replacement resumes the same journal at the next boundary. */
class HarvestLeaseLostError extends Error {
  constructor(repo: string, instance: string) {
    super(`harvest lease for ${repo} is held by another runner ` + `(former holder ${instance})`)
    this.name = 'HarvestLeaseLostError'
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function verdictFromEvent(
  event: Extract<RepositoryEvent, { type: 'harvest.review.verdict' }>,
): Verdict {
  if (event.payload.verdict === 'approve') return { verdict: 'approve' }
  if (event.payload.verdict === 'revise') {
    return { verdict: 'revise', findings: event.payload.findings }
  }
  return {
    verdict: 'escalate',
    reason: event.payload.reason ?? 'harvest reviewer escalated',
  }
}

export class HarvestRunner {
  private readonly leaseTtlMs: number
  private readonly heartbeatMs: number
  private readonly maxSessionAttempts: number
  private readonly maxRecoveryAttempts: number
  private readonly streamSessions: boolean
  private readonly onDiagnostic: (message: string) => void
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  /** Set only when the store positively reports a lapsed/stolen lease. A
   * rejected heartbeat is an outage; later beats retry until one can decide. */
  private leaseLost = false
  private producer: ProducerSession | undefined

  constructor(private readonly deps: HarvestRunnerDeps) {
    const redactor = accountRedactor(
      () => (deps.getConfig?.() ?? deps.config).accounts,
      () => ({
        ...process.env,
        ...deps.sessionEnv,
      }),
    )
    deps.store = redactAccountStore(deps.store, redactor)

    this.leaseTtlMs = deps.opts?.leaseTtlMs ?? 60_000
    this.heartbeatMs = deps.opts?.heartbeatMs ?? 15_000
    this.maxSessionAttempts = deps.opts?.maxSessionAttempts ?? 2
    this.maxRecoveryAttempts =
      deps.opts?.maxRecoveryAttempts ?? DEFAULT_MAX_HARVEST_RECOVERY_ATTEMPTS
    this.streamSessions = deps.opts?.streamSessions ?? true
    this.onDiagnostic = deps.opts?.onDiagnostic ?? ((message) => console.error(message))
    if (!Number.isInteger(this.maxRecoveryAttempts) || this.maxRecoveryAttempts <= 0) {
      throw new Error('maxRecoveryAttempts must be a positive integer')
    }
    // Preserve eager validation for static callers and startup failures.
    createRuntimeResolver(
      deps.runtimes,
      deps.config.roles,
      deps.config.policy.sessionBudgetSeconds,
      deps.config.accounts,
    )
  }

  private currentConfig(): Config {
    return this.deps.getConfig?.() ?? this.deps.config
  }

  private currentResolver(): RuntimeResolver {
    const config = this.currentConfig()
    return createRuntimeResolver(
      this.deps.runtimes,
      config.roles,
      config.policy.sessionBudgetSeconds,
      config.accounts,
    )
  }

  async run(preparationOnly = false): Promise<HarvestRunnerResult> {
    const { store, repo, instance } = this.deps
    if (!this.deps.preparedRun) await store.ensureRepo(repo)
    if (
      this.deps.leaseHolder === undefined &&
      !(await store.claimRepoLease(repo, instance, this.leaseTtlMs))
    ) {
      return { outcome: 'held' }
    }
    let initial: 'started' | 'resumed' = 'resumed'
    let run: HarvestRunState | undefined
    try {
      this.shutdownBoundary()
      await this.startHeartbeat()
      await this.ensureLease()
      // Bounded read (AUT-489): reduceHarvest and the verdict/failure filters
      // below consume durable types only, so the subset is replay-equivalent.
      if (this.deps.preparedRun) {
        const events = (await readRepositoryFacts(store, repo)).value
        const authorization = events.harvestAuthorizations[JSON.stringify(instance)]
        if (authorization?.type !== 'harvest.execution.authorized')
          throw new Error('prepared harvest execution unavailable')
        run = events.harvest.runs.find((run) => run.run === this.deps.preparedRun!.run)
        initial = authorization.payload.launch
      } else {
        let events = (await readRepositoryFacts(store, repo)).value
        let state = events.harvest
        run = actionableHarvestRun(state)

        // An open bracket after process loss is a real interrupted attempt.
        // Orderly shutdown leaves a suspended bracket instead.
        if (run?.sessions.at(-1)?.status === 'open') {
          const session = run.sessions.at(-1)!
          const terminal =
            session.step === 'synthesize'
              ? run.proposals.some((p) => p.round === session.round)
              : run.reviews.some((r) => r.round === session.round)
          const runId = run.run
          const failureAlreadyRecorded = Object.values(events.harvestFailures).some(
            ({ latest }) => latest.payload.run === runId && latest.seq > session.startedSeq,
          )
          if (!terminal && !failureAlreadyRecorded) {
            await this.recordWorkflowFailure(
              run.run,
              new Error('harvest agent interrupted by runner loss'),
              true,
            )
          }
        }
        // Settle durable operator control before scanning or resuming work. The
        // selected run comes from the full journal, so a shadowed failure or
        // exhaustion barrier is recovered/reported before any later open run.
        await this.controlBoundary(run?.run)
        events = (await readRepositoryFacts(store, repo)).value
        state = events.harvest
        run = openHarvestRun(state)

        if (!run) {
          await this.controlBoundary()
          // Flat-cost gate (AUT-521): the pressure trigger is evaluated from
          // the journal and one repo-scoped digest batch read — no per-build
          // history reads — so the idle evaluation no longer grows with
          // accumulated finished builds. Only a tripped gate pays for the full
          // unclaimed-observation scan, because the packet artifact needs the
          // observation payloads no bounded source carries.
          // Bounded read (AUT-489): the gate's journal input is consumed only
          // through reduceHarvest, so the subset is replay-equivalent here too.
          const [gateEvents, digests] = await Promise.all([
            readRepositoryFacts(store, repo).then((result) => result.value.harvest),
            store.getRepoBuildDigests(repo),
          ])
          const pressure = evaluateHarvestPressureFromDigests({
            digests,
            harvestEvents: gateEvents,
            policy: this.currentConfig().policy,
          })
          if (pressure.trigger === undefined) {
            // Treat the read's completion as a boundary even when the gate did
            // not trip, so a request arriving during the read is acknowledged
            // before this runner returns idle.
            await this.controlBoundary()
            return { outcome: 'idle' }
          }
          await this.controlBoundary()
          const scan = await scanUnclaimedObservations(store, repo)
          // The trigger came from an earlier read than this scan, and a claim
          // may have landed in the window. Re-confirm the gate against the
          // fresh scan (pure, free): an emptied window returns idle exactly as
          // if the gate had not tripped, so a packet is only ever built from a
          // scan that itself triggered.
          const confirmed = evaluateHarvestPressure(scan, this.currentConfig().policy)
          if (confirmed.trigger === undefined) {
            await this.controlBoundary()
            return { outcome: 'idle' }
          }
          const runId = this.deps.ids('harvest')
          const packet = await makeHarvestScanPacket({
            store,
            tickets: this.deps.tickets,
            repo,
            run: runId,
            observations: scan.observations,
            state: scan.state,
          })
          // Scan preparation is not a claim. Re-read operator control immediately
          // before atomically committing the immutable snapshot.
          await this.controlBoundary()
          initial = 'started'
          await store.appendRepoWithArtifacts(
            repo,
            [
              {
                kind: HARVEST_SCAN_ARTIFACT,
                content: `${JSON.stringify(packet, null, 2)}\n`,
                metadata: { run: runId, observations: packet.observations.length },
              },
            ],
            (deposited) => ({
              actor: KERNEL,
              type: 'harvest.started',
              payload: {
                run: runId,
                observations: packet.observations.map((item) => item.occurrence),
                scan: artifactRef(deposited[0]!),
                trigger: confirmed.trigger,
                ...(this.deps.environment !== undefined
                  ? { environment: this.deps.environment }
                  : {}),
              },
            }),
          )
          // Bounded read (AUT-489): reduceHarvest consumes durable types only.
          events = (await readRepositoryFacts(store, repo)).value
          run = events.harvest.runs.find((candidate) => candidate.run === runId)
          if (!run) throw new Error(`harvest.started did not reduce run "${runId}"`)
          // A request racing the claim parks this exact run; its snapshot stays
          // open and is resumed rather than scanned again.
          await this.controlBoundary(run.run)
        }
      }
      if (!run) throw new Error('prepared harvest run unavailable')
      if (preparationOnly) return { outcome: 'prepared', run: run.run, launch: initial }
      try {
        await this.ensureScanStep(run)
        await this.controlBoundary(run.run)
        const outcome = await this.executeWorkflow(run)
        return { outcome, launch: initial, run: run.run }
      } catch (error) {
        if (
          error instanceof HarvestLeaseLostError ||
          error instanceof HarvestParkedSignal ||
          error instanceof HarvestSuspendedSignal ||
          error instanceof HarvestPersistenceError
        ) {
          throw error
        }
        if (error instanceof SessionFailure) {
          await this.settleRecoveryExhaustion(run.run)
          return { outcome: 'failed', launch: initial, run: run.run }
        }
        await this.recordWorkflowFailure(run.run, error)
        await this.settleRecoveryExhaustion(run.run)
        return { outcome: 'failed', launch: initial, run: run.run }
      }
    } catch (error) {
      if (error instanceof HarvestSuspendedSignal)
        return { outcome: 'suspended', ...(run ? { run: run.run } : {}) }
      if (error instanceof HarvestParkedSignal) {
        const parkedRun = error.run ?? run?.run
        return parkedRun === undefined
          ? { outcome: 'parked' }
          : { outcome: 'parked', run: parkedRun }
      }
      if (error instanceof HarvestLeaseLostError) return { outcome: 'held' }
      throw error
    } finally {
      this.stopHeartbeat()
      if (this.producer !== undefined) {
        try {
          await this.producer.runner.end(this.producer.handle)
        } catch {
          // Every successful turn already has its own transcript artifact.
        }
        this.producer = undefined
      }
      // An adopted holder is released by the owning DispatchLoop, never here.
      if (this.deps.leaseHolder === undefined) await store.releaseRepoLease(repo, instance)
    }
  }

  private async executeWorkflow(
    initialRun: HarvestRunState,
  ): Promise<'completed' | 'escalated' | 'failed'> {
    let run = await this.refreshRun(initialRun.run)
    // Repair any process-death gap between a typed agent terminal and the
    // kernel-authored step result before deciding where to resume.
    for (const proposal of run.proposals) {
      await this.ensureStepCompleted(
        run.run,
        'synthesize',
        proposal.round,
        'completed',
        proposal.artifact,
      )
    }
    run = await this.refreshRun(run.run)
    for (const review of run.reviews) {
      await this.ensureStepCompleted(
        run.run,
        'review',
        review.round,
        review.verdict,
        review.artifact,
      )
    }
    run = await this.refreshRun(run.run)
    await this.controlBoundary(run.run)
    const existingApproval = [...run.reviews]
      .reverse()
      .find((review) => review.verdict === 'approve')
    if (existingApproval !== undefined) {
      const approved = proposalArtifactForRound(run, existingApproval.round)
      if (!approved) {
        throw new Error(
          `harvest ${run.run} approval r${existingApproval.round} has no proposal artifact`,
        )
      }
      await this.file(run, approved)
      return 'completed'
    }
    const existingEscalation = [...run.reviews]
      .reverse()
      .find((review) => review.verdict === 'escalate')
    if (existingEscalation !== undefined) {
      await this.escalate(
        run,
        'agent',
        existingEscalation.reason ?? 'harvest reviewer escalated',
        existingEscalation.round,
      )
      return 'escalated'
    }

    const reviseRounds = run.reviews
      .filter((review) => review.verdict === 'revise')
      .sort((a, b) => a.round - b.round)
    const stalled = stalledChains(
      reviseRounds.map((review) => review.findings),
      this.currentConfig().policy.stallRounds,
    )
    if (stalled.length > 0) {
      const chain = stalled.reduce((deepest, candidate) =>
        candidate.rounds > deepest.rounds ? candidate : deepest,
      )
      await this.escalate(
        run,
        'stall',
        `finding chain persisted ${chain.rounds} rounds: ${chain.ids.join(' -> ')}`,
        reviseRounds.at(-1)?.round,
      )
      return 'escalated'
    }

    const startRound = (reviseRounds.at(-1)?.round ?? 0) + 1
    const initialFeedback: Feedback | null =
      reviseRounds.length === 0
        ? null
        : {
            findings: reviseRounds.at(-1)!.findings.map((finding) => finding.id),
          }

    const outcome = await converge<ArtifactRef>({
      startRound,
      priorRounds: reviseRounds.map((review) => review.findings),
      initialFeedback,
      policy: () => {
        const policy = this.currentConfig().policy
        return { maxRounds: policy.maxReviewRounds, stallRounds: policy.stallRounds }
      },
      produce: async (_feedback, round) => {
        run = await this.refreshRun(run.run)
        await this.controlBoundary(run.run)
        const existing = proposalArtifactForRound(run, round)
        if (existing !== undefined) {
          await this.ensureStepCompleted(run.run, 'synthesize', round, 'completed', existing)
          await this.controlBoundary(run.run)
          return existing
        }
        return this.synthesize(run, round)
      },
      review: async (_artifact, round) => {
        run = await this.refreshRun(run.run)
        await this.controlBoundary(run.run)
        const existing = [...run.reviews].reverse().find((review) => review.round === round)
        if (existing !== undefined) {
          await this.ensureStepCompleted(
            run.run,
            'review',
            round,
            existing.verdict,
            existing.artifact,
          )
          // Bounded read (AUT-489): only harvest.review.verdict facts are
          // filtered here, and those are durable.
          const event = (await readRepositoryFacts(this.deps.store, this.deps.repo)).value
            .harvestVerdicts[JSON.stringify([run.run, round])]?.first
          if (!event) throw new Error('review reducer/event mismatch')
          await this.controlBoundary(run.run)
          return verdictFromEvent(event)
        }
        return this.review(run, round)
      },
    })

    run = await this.refreshRun(run.run)
    if (outcome.outcome === 'approved') {
      await this.file(run, outcome.artifact)
      return 'completed'
    }
    await this.escalate(run, outcome.source, outcome.reason, outcome.rounds)
    return 'escalated'
  }

  private async synthesize(run: HarvestRunState, round: number): Promise<ArtifactRef> {
    await this.controlBoundary(run.run)
    await this.startStep(run.run, 'synthesize', round)
    await this.executeSession({
      run: run.run,
      role: HARVEST_ROLE,
      skill: installedSkillName('harvest'),
      step: 'synthesize',
      round,
      producer: true,
      terminal: (event, session) =>
        event.type === 'harvest.proposals.submitted' &&
        event.payload.run === run.run &&
        event.payload.round === round &&
        event.actor.kind === 'agent' &&
        event.actor.session === session,
    })
    const refreshed = await this.refreshRun(run.run)
    const artifact = proposalArtifactForRound(refreshed, round)
    if (!artifact) throw new Error(`synthesize@${round} terminal has no artifact`)
    await this.completeStep(run.run, 'synthesize', round, 'completed', artifact)
    await this.controlBoundary(run.run)
    return artifact
  }

  private async review(run: HarvestRunState, round: number): Promise<Verdict> {
    await this.controlBoundary(run.run)
    await this.startStep(run.run, 'review', round)
    await this.executeSession({
      run: run.run,
      role: HARVEST_REVIEW_ROLE,
      skill: installedSkillName('harvest-review'),
      step: 'review',
      round,
      producer: false,
      terminal: (event, session) =>
        event.type === 'harvest.review.verdict' &&
        event.payload.run === run.run &&
        event.payload.round === round &&
        event.actor.kind === 'agent' &&
        event.actor.session === session,
    })
    // Bounded read (AUT-489): only harvest.review.verdict facts are filtered
    // here, and those are durable.
    const events = (await readRepositoryFacts(this.deps.store, this.deps.repo)).value
    const verdict = events.harvestVerdicts[JSON.stringify([run.run, round])]?.latest
    if (!verdict) throw new Error(`review@${round} terminal is missing`)
    await this.completeStep(
      run.run,
      'review',
      round,
      verdict.payload.verdict,
      verdict.payload.artifact,
    )
    await this.controlBoundary(run.run)
    return verdictFromEvent(verdict)
  }

  private async executeSession(spec: {
    run: string
    role: 'harvest' | 'harvest-review'
    skill: string
    step: 'synthesize' | 'review'
    round: number
    producer: boolean
    terminal: (event: RepositoryEvent, session: string) => boolean
  }): Promise<void> {
    const resolved = this.currentResolver().resolve(spec.role)
    return this.executeSessionChain(spec, resolved, resolved.alternates)
  }

  private async executeSessionChain(
    spec: {
      run: string
      role: 'harvest' | 'harvest-review'
      skill: string
      step: 'synthesize' | 'review'
      round: number
      producer: boolean
      terminal: (event: RepositoryEvent, session: string) => boolean
    },
    primary: ResolvedRuntime,
    alternates: readonly ResolvedRuntime[],
  ): Promise<void> {
    const { store, repo, ids, workspacePath } = this.deps
    this.shutdownBoundary()
    await this.ensureLease()
    // Bounded read (AUT-489): reduceHarvest and the harvest.failed filter
    // consume durable types only.
    const events = (await readRepositoryFacts(store, repo)).value
    const failureFacts = events.harvestFailures[JSON.stringify([spec.run, spec.step, spec.round])]
    const failures = failureFacts?.count ?? 0
    const latestFailure = failureFacts?.latest
    const current = events.harvest.runs.find((candidate) => candidate.run === spec.run)
    const resumedAfterTerminalFailure =
      latestFailure?.payload.willRetry === false &&
      current?.status === 'running' &&
      current.failure === undefined &&
      events.latestHarvestResumedSeq > latestFailure.seq
    if (failures >= this.maxSessionAttempts && !resumedAfterTerminalFailure) {
      throw new SessionFailure(`${spec.step}@${spec.round} exhausted retries`)
    }

    const prior = current?.sessions.findLast(
      (s) => s.step === spec.step && s.round === spec.round && s.status !== 'ended',
    )
    const candidates = [primary, ...alternates].map((target, index) => ({ target, index }))
    const selected = prior
      ? candidates.find(
          ({ target: t }) =>
            t.runtime === prior.runner &&
            t.model === prior.model &&
            JSON.stringify(t.args) === JSON.stringify(prior.args ?? []),
        )
      : undefined
    const frozen =
      prior && this.deps.runtimes[prior.runner]
        ? {
            target: {
              ...primary,
              ...this.deps.runtimes[prior.runner],
              runner: this.deps.runtimes[prior.runner]!.runner,
              runtime: prior.runner,
              model: prior.model,
              args: prior.args ?? [],
              account: prior.account,
            },
            index: selected?.index ?? 0,
          }
        : undefined
    const targets = frozen ? [frozen, ...candidates.filter((t) => t !== selected)] : candidates
    const attempts: HarvestProviderAttempt[] = []
    let substitution: HarvestProviderAttempt | undefined
    const primaryRoute = JSON.stringify({
      runtime: primary.runtime,
      model: primary.model,
      args: primary.args,
      account: primary.account,
    })
    let primaryLive = spec.producer ? this.producer : undefined
    if (
      primaryLive !== undefined &&
      (primaryLive.runner !== primary.runner || primaryLive.route !== primaryRoute)
    ) {
      try {
        await primaryLive.runner.end(primaryLive.handle)
      } catch {
        // Best-effort cleanup after the previous round reached its boundary.
      }
      this.producer = undefined
      primaryLive = undefined
    }
    for (let position = 0; position < targets.length; position += 1) {
      const { target, index } = targets[position]!
      this.shutdownBoundary()
      const session = ids('hs')
      const continuation =
        position === 0 && prior
          ? {
              predecessor: prior.session,
              root: prior.continuation?.root ?? prior.session,
              ...(prior.nativeHandle ? { handle: prior.nativeHandle } : {}),
              cause: prior.cause ?? ('runner-loss' as const),
            }
          : undefined
      // A pause requested while a provider failed is honored before another
      // provider starts; the incomplete step safely restarts at the primary.
      if (position > 0) await this.controlBoundary(spec.run)
      else await this.ensureLease()
      const streamBracket = await this.openSessionStream(target, {
        session,
        role: spec.role,
        runner: target.runtime,
        ...(target.account === undefined ? {} : { account: target.account }),
        ...(target.model !== undefined ? { model: target.model } : {}),
        phase: `harvest:${spec.step}`,
        round: spec.round,
      })
      const stream = streamBracket?.sink
      await this.ensureLease()
      const started = await store.appendRepo(repo, {
        actor: KERNEL,
        type: 'harvest.session.started',
        payload: {
          run: spec.run,
          session,
          ...(continuation ? { continuation } : {}),
          role: spec.role,
          runner: target.runtime,
          ...(target.account === undefined ? {} : { account: target.account }),
          ...(target.model !== undefined ? { model: target.model } : {}),
          args: [...target.args],
          step: spec.step,
          round: spec.round,
          ...(streamBracket !== undefined ? { stream: streamBracket.streamId } : {}),
          ...(substitution !== undefined
            ? { substitution: { failed: substitution, selectedIndex: index } }
            : {}),
        },
      })

      let handle: AgentSessionHandle | undefined
      let result: AgentTurnResult | undefined
      let turnError: unknown
      const live = index === 0 ? primaryLive : undefined
      let nativeHandle = live?.nativeHandle
      let observationFailure: unknown
      let accepted = false
      let recorded = false
      const onNativeSession = async (value: NativeSessionHandle) => {
        try {
          await this.ensureLease()
          const validated = nativeSessionHandleSchema.parse(value)
          const expected =
            nativeHandle ?? (continuation && !fallback ? continuation.handle : undefined)
          if (expected && JSON.stringify(expected) !== JSON.stringify(validated))
            throw new Error('Conflicting harvest native identity')
          if (!recorded) {
            await store.appendRepo(repo, {
              actor: KERNEL,
              type: 'harvest.session.native-handle-recorded',
              payload: { run: spec.run, session, handle: validated },
            })
            nativeHandle = validated
            recorded = true
          }
          if (continuation && !fallback && !accepted) {
            await store.appendRepo(repo, {
              actor: KERNEL,
              type: 'harvest.session.resumed',
              payload: {
                run: spec.run,
                session,
                predecessor: continuation.predecessor,
                root: continuation.root,
                handle: validated,
              },
            })
            accepted = true
          }
        } catch (error) {
          observationFailure = error
          throw error
        }
      }
      let fallback = false
      const recordFallback = async (
        reason: HarvestEventPayload<'harvest.session.resume-fallback'>['reason'],
        message: string,
      ) => {
        await this.ensureLease()
        await store.appendRepo(repo, {
          actor: KERNEL,
          type: 'harvest.session.resume-fallback',
          payload: { run: spec.run, session, reason, message },
        })
        fallback = true
        nativeHandle = undefined
        recorded = false
      }
      try {
        const opts: AgentStartOpts = {
          skill: spec.skill,
          invocation: spec.run,
          workspacePath,
          ...(target.account === undefined ? {} : { account: target.account }),
          ...(target.model !== undefined ? { model: target.model } : {}),
          args: target.args,
          env: await this.sessionEnv(spec.run, spec.step, spec.round, session),
          signal: this.deps.shutdownSignal,
          onNativeSession,
          ...(stream !== undefined ? { stream } : {}),
        }
        if (!this.deps.shutdownSignal?.aborted) {
          if (continuation) {
            if (!selected)
              await recordFallback(
                'changed-route',
                'Original harvest runtime route is no longer configured',
              )
            else if (!continuation.handle)
              await recordFallback(
                'missing-handle',
                'No native identity was recorded before suspension',
              )
            else {
              const resumed =
                guardNativeHandle(continuation.handle, target.runner.name, opts) ??
                (await resumeAgent(
                  target.runner,
                  continuation.handle,
                  'Continue this harvest turn. Run ab harvest context again and inspect authoritative artifacts and feedback before continuing.',
                  opts,
                ))
              if (resumed.kind === 'not-resumable')
                await recordFallback(resumed.reason, resumed.message)
              else {
                handle = resumed.session
                result = resumed.result
              }
            }
          }
          if ((!continuation || fallback) && !this.deps.shutdownSignal?.aborted) {
            if (live !== undefined && !continuation) {
              handle = live.handle
              if (nativeHandle) await onNativeSession(nativeHandle)
              if (!this.deps.shutdownSignal?.aborted)
                result = await live.runner.continue(
                  live.handle,
                  `Revise harvest proposals for round ${spec.round}: run ab harvest context, address .ab/findings.json, then submit.`,
                  opts,
                )
            } else {
              const turn = await target.runner.start(opts)
              handle = turn.session
              result = turn.result
            }
          }
        }
      } catch (error) {
        turnError = error
      }
      if (observationFailure instanceof HarvestLeaseLostError) throw observationFailure
      if (observationFailure !== undefined)
        throw new HarvestPersistenceError('Native identity persistence failed', {
          cause: observationFailure,
        })

      try {
        await this.ensureLease()
      } catch (error) {
        if (handle !== undefined && live === undefined) {
          try {
            await target.runner.end(handle)
          } catch {
            // A dead session may have nothing left to close.
          }
        }
        this.closeBracketStream(streamBracket, 'aborted')
        throw error
      }

      const hasTerminal = async () => {
        const event = (await readRepositoryFacts(store, repo)).value.harvestTerminals[session]
        return event !== undefined && event.seq > started.seq && spec.terminal(event, session)
      }
      const terminal = await hasTerminal()
      const owner = live?.runner ?? target.runner
      const close =
        streamBracket !== undefined
          ? { stream: streamBracket, outcome: 'completed' as const }
          : undefined
      if (this.deps.shutdownSignal?.aborted) {
        let content = JSON.stringify({
          session,
          interrupted: true,
          result,
          error: turnError === undefined ? undefined : errorMessage(turnError),
        })
        let usage = result?.usage ?? { inputTokens: 0, outputTokens: 0, turns: 0 }
        if (handle) {
          try {
            const transcript = await owner.end(handle)
            if (transcript.content.trim() !== '') content = transcript.content
            usage = transcript.metadata.usage
          } catch {
            /* Partial evidence remains explicit. */
          }
        }
        if (spec.producer) this.producer = undefined
        // Cleanup can finish a typed deposit already in flight. Its terminal
        // wins even when cancellation initially observed no result.
        const completed = terminal || (await hasTerminal())
        if (completed) {
          await this.depositTranscript(spec, session, content, usage, target.model, close)
          return
        }
        try {
          await streamBracket?.sink.close('aborted')
          await this.ensureLease()
          await store.appendRepoWithArtifacts(
            repo,
            [
              {
                kind: HARVEST_TRANSCRIPT_ARTIFACT,
                content,
                metadata: {
                  run: spec.run,
                  session,
                  step: spec.step,
                  round: spec.round,
                  role: spec.role,
                  usage,
                },
              },
            ],
            (artifacts) => ({
              actor: KERNEL,
              type: 'harvest.session.suspended',
              payload: {
                run: spec.run,
                session,
                cause: this.deps.shutdownCause?.() ?? 'shutdown',
                transcript: artifactRef(artifacts[0]!),
                usage,
              },
            }),
          )
        } catch (error) {
          throw new HarvestPersistenceError('Harvest suspension persistence failed', {
            cause: error,
          })
        }
        throw new HarvestSuspendedSignal()
      }
      if (terminal && (handle === undefined || result === undefined)) {
        await this.depositTranscript(
          spec,
          session,
          JSON.stringify({ session, terminal: true, interrupted: true }),
          result?.usage ?? { inputTokens: 0, outputTokens: 0, turns: 0 },
          target.model,
          close,
        )
        return
      }
      if (terminal && handle !== undefined && result !== undefined) {
        if (spec.producer && index === 0) {
          this.producer = {
            handle,
            runner: owner,
            route: primaryRoute,
            ...(nativeHandle ? { nativeHandle } : {}),
          }
          await this.depositTranscript(
            spec,
            session,
            JSON.stringify(
              {
                session,
                run: spec.run,
                step: spec.step,
                round: spec.round,
                turn: result,
                note: 'producer session kept live for convergence continuation',
              },
              null,
              2,
            ),
            result.usage,
            target.model,
            close,
          )
        } else {
          const transcript = await owner.end(handle)
          await this.depositTranscript(
            spec,
            session,
            transcript.content,
            transcript.metadata.usage,
            transcript.metadata.model ?? target.model,
            close,
          )
          if (spec.producer) this.producer = undefined
        }
        return
      }

      const failure: AgentTurnFailure =
        turnError !== undefined
          ? { message: errorMessage(turnError), permanent: false, cause: 'availability' }
          : result?.kind === 'failed'
            ? result.failure
            : { message: 'no-terminal', permanent: false }
      let content = JSON.stringify({ session, failed: true, error: failure.message, turn: result })
      let usage = result?.usage ?? { inputTokens: 0, outputTokens: 0, turns: 0 }
      let model = target.model
      if (handle !== undefined) {
        try {
          const transcript = await owner.end(handle)
          if (transcript.content.trim() !== '') content = transcript.content
          usage = transcript.metadata.usage
          model = transcript.metadata.model ?? model
        } catch (error) {
          if (error instanceof HarvestLeaseLostError) {
            this.closeBracketStream(streamBracket, 'aborted')
            throw error
          }
          content = JSON.stringify({
            session,
            failed: true,
            error: failure.message,
            turn: result,
            cleanupError: errorMessage(error),
          })
        }
      }
      if (spec.producer) this.producer = undefined
      // A handled provider failure must close its bracket even when startup
      // yielded no handle or cleanup yielded no transcript. Otherwise the next
      // runner mistakes this ordinary retry for an interrupted native turn.
      try {
        await this.depositTranscript(
          spec,
          session,
          content,
          usage,
          model,
          streamBracket !== undefined
            ? { stream: streamBracket, outcome: 'aborted' as const }
            : undefined,
        )
      } catch (error) {
        if (error instanceof HarvestLeaseLostError) throw error
        throw new HarvestPersistenceError('Harvest failed-session transcript persistence failed', {
          cause: error,
        })
      }
      const attempt: HarvestProviderAttempt = {
        index,
        session,
        runner: target.runtime,
        ...(target.account === undefined ? {} : { account: target.account }),
        ...(target.model !== undefined ? { model: target.model } : {}),
        error: failure.message,
        ...(failure.cause !== undefined ? { cause: failure.cause } : {}),
      }
      attempts.push(attempt)
      const eligibleForAlternate =
        turnError !== undefined ||
        (result?.kind === 'failed' && isAlternateEligible(result.failure))
      if (position + 1 < targets.length && eligibleForAlternate) {
        substitution = attempt
        continue
      }

      const attemptNumber = failures + 1
      await this.ensureLease()
      await store.appendRepo(repo, {
        actor: KERNEL,
        type: 'harvest.failed',
        payload: {
          run: spec.run,
          step: spec.step,
          round: spec.round,
          attempt: attemptNumber,
          error: failure.message,
          willRetry: mayRetryPhase(failure) && attemptNumber < this.maxSessionAttempts,
          ...(alternates.length > 0 ? { providerAttempts: attempts } : {}),
        },
      })
      await this.ensureLease()
      await store.appendRepo(repo, {
        actor: KERNEL,
        type: 'harvest.step.completed',
        payload: {
          run: spec.run,
          step: spec.step,
          round: spec.round,
          outcome: 'failed',
          detail: failure.message,
        },
      })
      throw new SessionFailure(`${spec.step}@${spec.round} failed: ${failure.message}`)
    }
  }

  private async depositTranscript(
    spec: {
      run: string
      role: 'harvest' | 'harvest-review'
      step: 'synthesize' | 'review'
      round: number
    },
    session: string,
    content: string,
    usage: { inputTokens: number; outputTokens: number; turns: number },
    model?: string,
    close?: { stream: SessionBracketStream; outcome: StreamOutcome },
  ): Promise<void> {
    if (close !== undefined) {
      // Close must land no later than `harvest.session.ended`; this makes
      // the ordering structural rather than call-site discipline.
      await close.stream.sink.close(close.outcome)
    }
    await this.ensureLease()
    await this.deps.store.appendRepoWithArtifacts(
      this.deps.repo,
      [
        {
          kind: HARVEST_TRANSCRIPT_ARTIFACT,
          content,
          metadata: {
            run: spec.run,
            step: spec.step,
            round: spec.round,
            role: spec.role,
            session,
            ...(model !== undefined ? { model } : {}),
            usage,
          },
        },
      ],
      (deposited) => ({
        actor: KERNEL,
        type: 'harvest.session.ended',
        payload: {
          run: spec.run,
          session,
          transcript: artifactRef(deposited[0]!),
          usage,
        },
      }),
    )
  }

  private async file(run: HarvestRunState, approved: ArtifactRef): Promise<void> {
    const { store, repo, tickets, uuids } = this.deps
    const config = this.currentConfig()
    // Filing is one deterministic side-effecting unit: settle pause before it,
    // then leave reservation/create/adoption bookkeeping uninterrupted.
    await this.controlBoundary(run.run)
    await this.ensureLease()
    const current = await this.refreshRun(run.run)
    if (current.status === 'completed') return
    await this.startStep(run.run, 'file')
    const artifact = await store.getRepoArtifact(repo, approved.kind, approved.rev)
    if (!artifact) {
      throw new Error(`approved proposal artifact ${approved.kind}@${approved.rev} is missing`)
    }
    const set = parseApprovedProposalSet(
      new TextDecoder().decode(artifact.content),
      current.observations,
    )
    const packet = await loadScanPacket(store, repo, current.scan)
    const observations = packet.observations
    // One fresh lookup view per filing attempt, shared only by ledger and joins.
    // Blocker refreshes retain their own authoritative boundary.
    const lookups = new Map<string, ReturnType<typeof tickets.get>>()
    const lookup = (id: string): ReturnType<typeof tickets.get> => {
      let pending = lookups.get(id)
      if (!pending) {
        pending = tickets.get(id).then((ticket) => {
          if (ticket?.ref.source === tickets.name) {
            lookups.set(ticket.ref.id, Promise.resolve(ticket))
          }
          return ticket
        })
        lookups.set(id, pending)
      }
      return pending
    }
    const identity = async (ref: { source: string; id: string }): Promise<string> => {
      const ticket =
        ref.source === tickets.name && tickets.name === 'hosted' ? await lookup(ref.id) : null
      return `${ref.source}:${ticket?.ref.source === ref.source ? ticket.ref.id : ref.id}`
    }
    const knownLedger = new Map<string, (typeof packet.ledger)[number]>()
    for (const entry of packet.ledger) {
      const current = entry.ticket.source === tickets.name ? await lookup(entry.ticket.id) : null
      const ref = current?.ref.source === entry.ticket.source ? current.ref : entry.ticket
      knownLedger.set(`${ref.source}:${ref.id}`, {
        ...entry,
        ticket: ref,
        exists: current !== null,
        resolved: current?.resolved ?? false,
      })
    }
    const alreadyFiled = new Map(current.filed.map((entry) => [entry.proposalKey, entry]))
    const reservations = new Map(current.reservations.map((entry) => [entry.proposalKey, entry.id]))
    const dispositions: HarvestDisposition[] = []
    const report: Array<Record<string, unknown>> = []

    for (const proposal of set.proposals) {
      await this.ensureLease()
      if (proposal.action === 'create') {
        const proposalKey = harvestProposalKey(proposal)
        let filed = alreadyFiled.get(proposalKey)
        if (filed === undefined) {
          // Resolution must precede even the durable reservation: an invalid
          // declared prerequisite cannot leave behind the start of a ready-
          // ticket create path, while origins are refreshed at this boundary.
          const blockers = await resolveHarvestCreateBlockers(proposal, observations, tickets)
          let reservedId = reservations.get(proposalKey)
          if (reservedId === undefined) {
            reservedId = uuids()
            await this.ensureLease()
            await store.appendRepo(repo, {
              actor: KERNEL,
              type: 'harvest.proposal.id-reserved',
              payload: { run: run.run, proposalKey, id: reservedId },
            })
            await this.ensureLease()
            reservations.set(proposalKey, reservedId)
          }
          const body = renderHarvestProposal(proposal, observations)
          const ticket = (
            await tickets.create(
              {
                title: proposal.title,
                body,
                labels: [HARVEST_PROPOSAL_LABEL],
                ...(blockers.blockedBy.length > 0 ? { blockedBy: blockers.blockedBy } : {}),
              },
              {
                state: defaultProposalState(config),
                idempotencyKey: reservedId,
              },
            )
          ).ref
          // If the process stops before create, the replacement reads the
          // reservation. If it stops after create but before this filing fact,
          // it sends the same reserved id and adopts the external ticket.
          await this.ensureLease()
          const filedEvent = await store.appendRepo(repo, {
            actor: KERNEL,
            type: 'harvest.proposal.filed',
            payload: {
              run: run.run,
              proposalKey,
              ticket,
              blockers: blockers.provenance,
            },
          })
          filed = {
            proposalKey,
            ticket,
            blockers: blockers.provenance,
            seq: filedEvent.seq,
          }
          alreadyFiled.set(proposalKey, filed)
        }
        for (const occurrence of proposal.observations) {
          dispositions.push({
            occurrence,
            action: 'filed',
            proposalKey,
            ticket: filed.ticket,
          })
        }
        report.push({
          action: 'filed',
          proposalKey,
          ticket: filed.ticket,
          ...(filed.blockers !== undefined ? { blockers: filed.blockers } : {}),
        })
      } else if (proposal.action === 'join') {
        const known = knownLedger.get(await identity(proposal.ticket))
        if (!known) {
          throw new Error(
            `approved join target ${proposal.ticket.source}:${proposal.ticket.id} is not in the ledger context`,
          )
        }
        if (!known.exists || known.resolved) {
          throw new Error(
            `approved join target ${proposal.ticket.id} is ${
              !known.exists ? 'missing' : 'resolved'
            }; it is a tombstone and must be suppressed, not joined`,
          )
        }
        for (const occurrence of proposal.observations) {
          dispositions.push({
            occurrence,
            action: 'joined',
            proposalKey: known.proposalKey,
            ticket: known.ticket,
            reason: proposal.reason,
          })
        }
        report.push({
          action: 'joined',
          proposalKey: known.proposalKey,
          ticket: known.ticket,
        })
      } else {
        const proposalKey = harvestProposalKey(proposal)
        for (const occurrence of proposal.observations) {
          dispositions.push({
            occurrence,
            action: 'suppressed',
            proposalKey,
            reason: proposal.reason,
          })
        }
        report.push({ action: 'suppressed', proposalKey, reason: proposal.reason })
      }
    }

    const expected = new Set(current.observations.map(occurrenceKey))
    if (
      dispositions.length !== expected.size ||
      dispositions.some((entry) => !expected.has(occurrenceKey(entry.occurrence)))
    ) {
      throw new Error('filing dispositions do not partition the claimed snapshot')
    }
    await this.completeStep(run.run, 'file', undefined, 'completed')
    await this.ensureLease()
    await store.appendRepoWithArtifacts(
      repo,
      [
        {
          kind: HARVEST_REPORT_ARTIFACT,
          content: `${JSON.stringify({ run: run.run, dispositions, proposals: report }, null, 2)}\n`,
          metadata: { run: run.run, observations: dispositions.length },
        },
      ],
      (deposited) => ({
        actor: KERNEL,
        type: 'harvest.completed',
        payload: {
          run: run.run,
          dispositions,
          report: artifactRef(deposited[0]!),
        },
      }),
    )
  }

  private async escalate(
    run: HarvestRunState,
    source: 'agent' | 'stall' | 'policy',
    reason: string,
    round?: number,
  ): Promise<void> {
    await this.controlBoundary(run.run)
    await this.ensureLease()
    const refreshed = await this.refreshRun(run.run)
    if (refreshed.status !== 'running') return
    await this.ensureLease()
    await this.deps.store.appendRepo(this.deps.repo, {
      actor: KERNEL,
      type: 'harvest.escalated',
      payload: {
        run: run.run,
        source,
        reason,
        ...(round !== undefined && round > 0 ? { round } : {}),
        observations: refreshed.observations,
      },
    })
  }

  private async recordWorkflowFailure(
    run: string,
    error: unknown,
    interrupted = false,
  ): Promise<void> {
    await this.ensureLease()
    // Bounded read (AUT-489): reduceHarvest and the harvest.failed filter
    // consume durable types only.
    const events = (await readRepositoryFacts(this.deps.store, this.deps.repo)).value
    const state = events.harvest
    const current = state.runs.find((candidate) => candidate.run === run)
    if (current?.status !== 'running') return
    const open = [...current.steps]
      .reverse()
      .find((occurrence) => occurrence.completedSeq === undefined)
    const step = open?.step ?? 'file'
    const round = open?.round
    const prior = events.harvestFailures[JSON.stringify([run, step, round])]?.count ?? 0
    const attempt = prior + 1
    const willRetry = !interrupted && attempt < this.maxSessionAttempts
    const message = errorMessage(error)
    await this.ensureLease()
    await this.deps.store.appendRepo(this.deps.repo, {
      actor: KERNEL,
      type: 'harvest.failed',
      payload: {
        run,
        step,
        ...(round !== undefined ? { round } : {}),
        attempt,
        error: message,
        willRetry,
      },
    })
    if (open !== undefined) {
      await this.ensureLease()
      await this.deps.store.appendRepo(this.deps.repo, {
        actor: KERNEL,
        type: 'harvest.step.completed',
        payload: {
          run,
          step,
          ...(round !== undefined ? { round } : {}),
          outcome: 'failed',
          detail: message,
        },
      })
    }
  }

  /** If the just-failed execution consumed the final durable reopen, settle
   * give-up before returning. Initial/within-step failures do not spend this
   * outer budget and therefore remain recoverable. */
  private async settleRecoveryExhaustion(run: string): Promise<void> {
    if (this.deps.preparedRun) return
    await this.ensureLease()
    // Bounded read (AUT-489): reduceHarvest consumes durable types only.
    const state = (await readRepositoryFacts(this.deps.store, this.deps.repo)).value.harvest
    const decision = decideHarvestControl(state, this.maxRecoveryAttempts)
    if (decision.kind !== 'exhaust-recovery' || decision.run !== run) return
    await this.finalizeRecoveryExhaustion(decision.run, decision.attempts, decision.limit)
  }

  /** Compute and append the selective-release boundary. The second decision
   * check closes the race with a human pause/resume request that can be written
   * without this process's repository lease. */
  private async finalizeRecoveryExhaustion(
    runId: string,
    attempts: number,
    limit: number,
  ): Promise<boolean> {
    await this.ensureLease()
    let run = await this.refreshRun(runId)
    if (run.recoveryExhaustion !== undefined) return true
    if (run.status !== 'failed' || run.failure === undefined) return false
    const partition = await partitionHarvestExhaustion({
      store: this.deps.store,
      repo: this.deps.repo,
      run,
    })

    await this.ensureLease()
    // Bounded read (AUT-489): reduceHarvest consumes durable types only.
    const state = (await readRepositoryFacts(this.deps.store, this.deps.repo)).value.harvest
    const decision = decideHarvestControl(state, this.maxRecoveryAttempts)
    if (
      decision.kind !== 'exhaust-recovery' ||
      decision.run !== runId ||
      decision.attempts !== attempts ||
      decision.limit !== limit
    ) {
      return false
    }
    run = state.runs.find((candidate) => candidate.run === runId)!
    if (run.failure === undefined) return false
    await this.ensureLease()
    await this.deps.store.appendRepo(this.deps.repo, {
      actor: KERNEL,
      type: 'harvest.recovery-exhausted',
      payload: {
        run: runId,
        step: run.failure.step,
        ...(run.failure.round !== undefined ? { round: run.failure.round } : {}),
        error: run.failure.error,
        attempts,
        limit,
        ...partition,
      },
    })
    return true
  }

  private shutdownBoundary(): void {
    if (this.deps.shutdownSignal?.aborted) throw new HarvestSuspendedSignal()
  }

  /** Settle repository-wide commands and automatic recovery only at a durable
   * workflow boundary. Requests and acknowledgements are separate facts, so a
   * replacement process can finish the same transition without spending a
   * second recovery attempt. */
  private async controlBoundary(run?: string): Promise<void> {
    this.shutdownBoundary()
    while (true) {
      await this.ensureLease()
      // Bounded read (AUT-489): reduceHarvest consumes durable types only.
      const state = (await readRepositoryFacts(this.deps.store, this.deps.repo)).value.harvest
      const decision = decideHarvestControl(state, this.maxRecoveryAttempts)
      if (decision.kind === 'proceed') return
      if (this.deps.preparedRun) throw new HarvestParkedSignal(run)
      if (decision.kind === 'park') {
        throw new HarvestParkedSignal(actionableHarvestRun(state)?.run ?? run)
      }

      if (decision.kind === 'request-recovery') {
        await this.ensureLease()
        await this.deps.store.appendRepo(this.deps.repo, {
          actor: KERNEL,
          type: 'harvest.recovery-requested',
          payload: {
            run: decision.run,
            attempt: decision.attempt,
            limit: decision.limit,
          },
        })
        continue
      }
      if (decision.kind === 'exhaust-recovery') {
        const exhausted = await this.finalizeRecoveryExhaustion(
          decision.run,
          decision.attempts,
          decision.limit,
        )
        if (exhausted) throw new HarvestParkedSignal(decision.run)
        continue
      }

      await this.ensureLease()
      await this.deps.store.appendRepo(this.deps.repo, {
        actor: KERNEL,
        type: decision.command === 'pause' ? 'harvest.paused' : 'harvest.resumed',
        payload: {},
      })
      // Re-reduce after every acknowledgement. An opposing request may have
      // raced the append; the newest durable intent must win before this
      // runner either parks or starts another unit.
    }
  }

  private async refreshRun(run: string): Promise<HarvestRunState> {
    // Bounded read (AUT-489): reduceHarvest consumes durable types only.
    const state = (await readRepositoryFacts(this.deps.store, this.deps.repo)).value.harvest
    const found = state.runs.find((candidate) => candidate.run === run)
    if (!found) throw new Error(`unknown harvest run "${run}"`)
    return found
  }

  private async ensureScanStep(run: HarvestRunState): Promise<void> {
    await this.ensureLease()
    const completed = run.steps.some(
      (occurrence) =>
        occurrence.step === 'scan' &&
        occurrence.completedSeq !== undefined &&
        occurrence.outcome === 'completed',
    )
    if (completed) return
    const open = run.steps.some(
      (occurrence) => occurrence.step === 'scan' && occurrence.completedSeq === undefined,
    )
    if (!open) {
      await this.ensureLease()
      await this.deps.store.appendRepo(this.deps.repo, {
        actor: KERNEL,
        type: 'harvest.step.started',
        payload: { run: run.run, step: 'scan' },
      })
    }
    await this.ensureLease()
    await this.deps.store.appendRepo(this.deps.repo, {
      actor: KERNEL,
      type: 'harvest.step.completed',
      payload: {
        run: run.run,
        step: 'scan',
        outcome: 'completed',
        artifact: run.scan,
      },
    })
  }

  private async startStep(
    run: string,
    step: 'synthesize' | 'review' | 'file',
    round?: number,
  ): Promise<void> {
    await this.ensureLease()
    const refreshed = await this.refreshRun(run)
    const open = refreshed.steps.some(
      (occurrence) =>
        occurrence.step === step &&
        occurrence.round === round &&
        occurrence.completedSeq === undefined,
    )
    if (open) return
    await this.ensureLease()
    await this.deps.store.appendRepo(this.deps.repo, {
      actor: KERNEL,
      type: 'harvest.step.started',
      payload: { run, step, ...(round !== undefined ? { round } : {}) },
    })
  }

  private async completeStep(
    run: string,
    step: 'synthesize' | 'review' | 'file',
    round: number | undefined,
    outcome: 'completed' | 'approve' | 'revise' | 'escalate' | 'failed',
    artifact?: ArtifactRef,
  ): Promise<void> {
    await this.ensureLease()
    await this.deps.store.appendRepo(this.deps.repo, {
      actor: KERNEL,
      type: 'harvest.step.completed',
      payload: {
        run,
        step,
        outcome,
        ...(round !== undefined ? { round } : {}),
        ...(artifact !== undefined ? { artifact } : {}),
      },
    })
  }

  private async ensureStepCompleted(
    run: string,
    step: 'synthesize' | 'review',
    round: number,
    outcome: 'completed' | 'approve' | 'revise' | 'escalate',
    artifact: ArtifactRef,
  ): Promise<void> {
    const refreshed = await this.refreshRun(run)
    const done = refreshed.steps.some(
      (occurrence) =>
        occurrence.step === step &&
        occurrence.round === round &&
        occurrence.completedSeq !== undefined &&
        occurrence.outcome === outcome,
    )
    if (!done) {
      await this.completeStep(run, step, round, outcome, artifact)
    }
  }

  private async sessionEnv(
    run: string,
    step: 'synthesize' | 'review',
    round: number,
    session: string,
  ): Promise<Record<string, string>> {
    const parent = this.deps.sessionEnv
    const token =
      parent?.AB_STORE && /^https?:/i.test(parent.AB_STORE)
        ? await delegateCredential(parent.AB_STORE, parent.AB_TOKEN, {
            kind: 'harvest-phase',
            repo: this.deps.repo,
            id: run,
            session,
          })
        : undefined
    const ticketGrant =
      parent?.AB_TICKET_URL && parent.AB_TICKET_TOKEN
        ? await issueTicketGrant(
            parent.AB_TICKET_URL,
            parent.AB_TICKET_TOKEN,
            this.deps.repo,
            this.deps.instance,
            'phase',
          )
        : undefined
    return {
      AB_ACCOUNT_CREDENTIAL_ENVS: JSON.stringify(
        Object.values(this.currentConfig().accounts).map((account) => account.credentialEnv),
      ),
      AB_STORE: 'local',
      ...this.deps.sessionEnv,
      ...(ticketGrant ? { AB_TICKET_TOKEN: ticketGrant.token } : {}),
      ...(token ? { AB_TOKEN: token } : {}),
      AB_REPO: this.deps.repo,
      AB_HARVEST: run,
      AB_PHASE: `${step}@${round}`,
      AB_SESSION: session,
    }
  }

  // ── Session streams (SPEC §9) ────────────────────────────────────────────

  /**
   * Open one stream for this harvest session bracket through the resolved
   * target's streaming capability: create the store-backed sink, call the
   * capability, and — once it returns an id — emit the bracket's
   * `data-ab-session` part. Returns undefined (and reports once) when
   * streaming is disabled, the runtime declared no capability, or the opener
   * declined/failed; the bracket then proceeds exactly as without streams.
   * Harvest streams are repository-scoped, the harvest analog of the
   * build-runner's build-scoped bracket streams.
   */
  private async openSessionStream(
    target: ResolvedRuntime,
    info: SessionStreamInfo,
  ): Promise<SessionBracketStream | undefined> {
    if (!this.streamSessions) return undefined
    const open = target.openSessionStream
    if (open === undefined) return undefined
    const sink = createSessionStreamSink({
      store: {
        ...this.deps.store,
        createStream: (scope, label) =>
          this.deps.store.createStream(
            scope,
            this.deps.preparedRun
              ? `harvest:${this.deps.preparedRun.run}:${this.deps.instance}:${label}`
              : label,
          ),
        appendStreamParts: (id, parts) => this.deps.store.appendStreamParts(id, parts),
        closeStream: (id, outcome) => this.deps.store.closeStream(id, outcome),
      },
      scope: { kind: 'repo', repo: this.deps.repo },
      onDiagnostic: this.onDiagnostic,
    })
    try {
      const streamId = await open(sink, info)
      if (streamId === undefined) return undefined
      sink.append([sessionPart(info)])
      return { sink, streamId }
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

  /** Re-acquire a lapsed lease only when no replacement won it. Checked at
   * every durable boundary; work already in an agent turn cannot be revoked,
   * but this process performs no subsequent kernel/file action without
   * ownership. */
  private async ensureLease(): Promise<void> {
    if (!this.leaseLost) return
    const { store, repo } = this.deps
    const holder = this.deps.leaseHolder ?? this.deps.instance
    const reclaimed = await store.claimRepoLease(repo, holder, this.leaseTtlMs)
    if (!reclaimed) throw new HarvestLeaseLostError(repo, holder)
    this.leaseLost = false
  }

  private async startHeartbeat(): Promise<void> {
    const { store, repo } = this.deps
    const holder = this.deps.leaseHolder ?? this.deps.instance
    if (!(await store.heartbeatRepo(repo, holder))) this.leaseLost = true
    this.heartbeatTimer = setInterval(() => {
      store.heartbeatRepo(repo, holder).then(
        (alive) => {
          if (!alive) this.leaseLost = true
        },
        () => {
          // Store unreachable: retry on the next beat. A later false result
          // proves expiry/takeover; rejecting timer promises are contained.
        },
      )
    }, this.heartbeatMs)
    this.heartbeatTimer.unref?.()
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
  }
}
