/**
 * Crash-safe repository-scoped harvest workflow:
 * scan -> synthesize <-> review -> file. It reuses `converge` for adversarial
 * review semantics while every durable boundary lives in the repository
 * journal, so a replacement process resumes the claimed snapshot rather than
 * starting a duplicate run.
 */
import type { Config } from '../config/schema'
import type { RepositoryEvent } from '../events/repository'
import { KERNEL } from '../events/envelope'
import type { IdSource, UuidSource } from '../ids'
import {
  occurrenceKey,
  type HarvestDisposition,
} from '../harvest/schema'
import { converge } from '../kernel/converge'
import { stalledChains } from '../kernel/stall'
import {
  DEFAULT_MAX_HARVEST_RECOVERY_ATTEMPTS,
  actionableHarvestRun,
  decideHarvestControl,
  openHarvestRun,
  proposalArtifactForRound,
  reduceHarvest,
  type HarvestRunState,
} from '../kernel/harvest'
import type { ArtifactRef, Feedback, Verdict } from '../ontology'
import { createRuntimeResolver, type RuntimeResolver } from '../ports/runner/routing'
import type { RuntimeRegistry } from '../ports/runner/runtime'
import type {
  AgentRunner,
  AgentSessionHandle,
  AgentTurnResult,
  TicketSource,
} from '../ports/types'
import { installedSkillName } from '../skills'
import { defaultTriageState } from './dispatcher'
import {
  artifactRef,
  HARVEST_REPORT_ARTIFACT,
  HARVEST_SCAN_ARTIFACT,
  HARVEST_TRANSCRIPT_ARTIFACT,
  harvestProposalKey,
  loadScanPacket,
  makeHarvestScanPacket,
  parseApprovedProposalSet,
  partitionHarvestExhaustion,
  renderHarvestProposal,
  scanUnclaimedObservations,
} from './harvest'
import type { BuildStore, Clock } from '../store/types'

export interface HarvestRunnerOpts {
  leaseTtlMs?: number
  heartbeatMs?: number
  /** Retry budget inside one synthesize/review/file occurrence. */
  maxSessionAttempts?: number
  /** Durable outer reopen budget for a stopped run. */
  maxRecoveryAttempts?: number
}

export interface HarvestRunnerDeps {
  store: BuildStore
  tickets: TicketSource
  config: Config
  runtimes: RuntimeRegistry
  defaultRuntime: string
  repo: string
  workspacePath: string
  ids: IdSource
  uuids: UuidSource
  clock: Clock
  instance: string
  sessionEnv?: Record<string, string>
  opts?: HarvestRunnerOpts
}

export type HarvestRunnerResult =
  | { outcome: 'idle' }
  | { outcome: 'held' }
  | { outcome: 'parked'; run?: string }
  | {
      outcome: 'completed' | 'escalated' | 'failed'
      launch: 'started' | 'resumed'
      run: string
    }

interface ProducerSession {
  handle: AgentSessionHandle
  runner: AgentRunner
}

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
    super(
      `harvest lease for ${repo} is held by another runner ` +
        `(former holder ${instance})`,
    )
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
  private readonly resolver: RuntimeResolver
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  /** Set only when the store positively reports a lapsed/stolen lease. A
   * rejected heartbeat is an outage; later beats retry until one can decide. */
  private leaseLost = false
  private producer: ProducerSession | undefined

  constructor(private readonly deps: HarvestRunnerDeps) {
    this.leaseTtlMs = deps.opts?.leaseTtlMs ?? 60_000
    this.heartbeatMs = deps.opts?.heartbeatMs ?? 15_000
    this.maxSessionAttempts = deps.opts?.maxSessionAttempts ?? 2
    this.maxRecoveryAttempts =
      deps.opts?.maxRecoveryAttempts ??
      DEFAULT_MAX_HARVEST_RECOVERY_ATTEMPTS
    if (
      !Number.isInteger(this.maxRecoveryAttempts) ||
      this.maxRecoveryAttempts <= 0
    ) {
      throw new Error('maxRecoveryAttempts must be a positive integer')
    }
    this.resolver = createRuntimeResolver(
      deps.runtimes,
      deps.config.roles,
      deps.defaultRuntime,
    )
  }

  async run(): Promise<HarvestRunnerResult> {
    const { store, repo, instance } = this.deps
    await store.ensureRepo(repo)
    if (!(await store.claimRepoLease(repo, instance, this.leaseTtlMs))) {
      return { outcome: 'held' }
    }
    let initial: 'started' | 'resumed' = 'resumed'
    let run: HarvestRunState | undefined
    try {
      await this.startHeartbeat()
      await this.ensureLease()
      let events = await store.getRepoEvents(repo)
      let state = reduceHarvest(events)
      run = actionableHarvestRun(state)

      // Settle durable operator control before scanning or resuming work. The
      // selected run comes from the full journal, so a shadowed failure or
      // exhaustion barrier is recovered/reported before any later open run.
      await this.controlBoundary(run?.run)
      events = await store.getRepoEvents(repo)
      state = reduceHarvest(events)
      run = openHarvestRun(state)

      if (!run) {
        await this.controlBoundary()
        const scan = await scanUnclaimedObservations(store, repo)
        // Scanning may span many build streams. Treat its completion as a
        // boundary even when the threshold is not met, so a request arriving
        // during the read is acknowledged before this runner returns idle.
        await this.controlBoundary()
        if (scan.observations.length < this.deps.config.harvest.threshold) {
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
            },
          }),
        )
        events = await store.getRepoEvents(repo)
        run = reduceHarvest(events).runs.find((candidate) => candidate.run === runId)
        if (!run) throw new Error(`harvest.started did not reduce run "${runId}"`)
        // A request racing the claim parks this exact run; its snapshot stays
        // open and is resumed rather than scanned again.
        await this.controlBoundary(run.run)
      }

      try {
        await this.ensureScanStep(run)
        await this.controlBoundary(run.run)
        const outcome = await this.executeWorkflow(run)
        return { outcome, launch: initial, run: run.run }
      } catch (error) {
        if (
          error instanceof HarvestLeaseLostError ||
          error instanceof HarvestParkedSignal
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
      await store.releaseRepoLease(repo, instance)
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
      this.deps.config.policy.stallRounds,
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
      policy: {
        maxRounds: this.deps.config.policy.maxReviewRounds,
        stallRounds: this.deps.config.policy.stallRounds,
      },
      produce: async (_feedback, round) => {
        run = await this.refreshRun(run.run)
        await this.controlBoundary(run.run)
        const existing = proposalArtifactForRound(run, round)
        if (existing !== undefined) {
          await this.ensureStepCompleted(
            run.run,
            'synthesize',
            round,
            'completed',
            existing,
          )
          await this.controlBoundary(run.run)
          return existing
        }
        return this.synthesize(run, round)
      },
      review: async (_artifact, round) => {
        run = await this.refreshRun(run.run)
        await this.controlBoundary(run.run)
        const existing = [...run.reviews]
          .reverse()
          .find((review) => review.round === round)
        if (existing !== undefined) {
          await this.ensureStepCompleted(
            run.run,
            'review',
            round,
            existing.verdict,
            existing.artifact,
          )
          const event = (await this.deps.store.getRepoEvents(this.deps.repo)).find(
            (candidate): candidate is Extract<
              RepositoryEvent,
              { type: 'harvest.review.verdict' }
            > =>
              candidate.type === 'harvest.review.verdict' &&
              candidate.payload.run === run.run &&
              candidate.payload.round === round,
          )
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

  private async synthesize(
    run: HarvestRunState,
    round: number,
  ): Promise<ArtifactRef> {
    await this.controlBoundary(run.run)
    await this.startStep(run.run, 'synthesize', round)
    await this.executeSession({
      run: run.run,
      role: 'harvest',
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
    await this.completeStep(
      run.run,
      'synthesize',
      round,
      'completed',
      artifact,
    )
    await this.controlBoundary(run.run)
    return artifact
  }

  private async review(run: HarvestRunState, round: number): Promise<Verdict> {
    await this.controlBoundary(run.run)
    await this.startStep(run.run, 'review', round)
    await this.executeSession({
      run: run.run,
      role: 'harvest-review',
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
    const events = await this.deps.store.getRepoEvents(this.deps.repo)
    const verdict = [...events]
      .reverse()
      .find(
        (event): event is Extract<
          RepositoryEvent,
          { type: 'harvest.review.verdict' }
        > =>
          event.type === 'harvest.review.verdict' &&
          event.payload.run === run.run &&
          event.payload.round === round,
      )
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
    const { store, repo, ids, workspacePath } = this.deps
    await this.ensureLease()
    const events = await store.getRepoEvents(repo)
    const matchingFailures = events.filter(
      (event): event is Extract<RepositoryEvent, { type: 'harvest.failed' }> =>
        event.type === 'harvest.failed' &&
        event.payload.run === spec.run &&
        event.payload.step === spec.step &&
        event.payload.round === spec.round,
    )
    const failures = matchingFailures.length
    const latestFailure = matchingFailures.at(-1)
    const current = reduceHarvest(events).runs.find(
      (candidate) => candidate.run === spec.run,
    )
    // A stopping failure may already have consumed the ordinary retry budget.
    // harvest.resumed deliberately clears that reduced stop and grants one real
    // re-entry without deleting history or resetting attempt numbers. The next
    // failure fact restores the guard (and parks the run again).
    const resumedAfterTerminalFailure =
      latestFailure?.payload.willRetry === false &&
      current?.status === 'running' &&
      current.failure === undefined &&
      events.some(
        (event) =>
          event.type === 'harvest.resumed' && event.seq > latestFailure.seq,
      )
    if (failures >= this.maxSessionAttempts && !resumedAfterTerminalFailure) {
      throw new SessionFailure(`${spec.step}@${spec.round} exhausted retries`)
    }

    const session = ids('hs')
    const resolved = this.resolver.resolve(spec.role)
    await this.ensureLease()
    const started = await store.appendRepo(repo, {
      actor: KERNEL,
      type: 'harvest.session.started',
      payload: {
        run: spec.run,
        session,
        role: spec.role,
        runner: resolved.runtime,
        ...(resolved.model !== undefined ? { model: resolved.model } : {}),
        step: spec.step,
        round: spec.round,
      },
    })

    let handle: AgentSessionHandle | undefined
    let result: AgentTurnResult | undefined
    let turnError: unknown
    const live = spec.producer ? this.producer : undefined
    try {
      if (live !== undefined) {
        handle = live.handle
        result = await live.runner.continue(
          live.handle,
          `Revise harvest proposals for round ${spec.round}: run ab harvest context, address .ab/findings.json, then submit.`,
          { env: this.sessionEnv(spec.run, spec.step, spec.round, session) },
        )
      } else {
        const turn = await resolved.runner.start({
          skill: spec.skill,
          invocation: spec.run,
          workspacePath,
          ...(resolved.model !== undefined ? { model: resolved.model } : {}),
          ...(resolved.extensions !== undefined
            ? { extensions: resolved.extensions }
            : {}),
          env: this.sessionEnv(spec.run, spec.step, spec.round, session),
        })
        handle = turn.session
        result = turn.result
      }
    } catch (error) {
      turnError = error
    }

    try {
      await this.ensureLease()
    } catch (error) {
      // The turn may have crossed the lease-expiry boundary. Close adapter
      // resources, but deposit no transcript/result after a replacement has
      // taken ownership. Continued producers are closed by run()'s finally.
      if (handle !== undefined && live === undefined) {
        try {
          await resolved.runner.end(handle)
        } catch {
          // A dead session may have nothing left to close.
        }
      }
      throw error
    }

    const since = await store.getRepoEvents(repo, started.seq)
    const terminal =
      turnError === undefined &&
      since.some((event) => spec.terminal(event, session))

    if (terminal && handle !== undefined && result !== undefined) {
      if (spec.producer) {
        this.producer = {
          handle,
          runner: live?.runner ?? resolved.runner,
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
          resolved.model,
        )
      } else {
        const transcript = await resolved.runner.end(handle)
        await this.depositTranscript(
          spec,
          session,
          transcript.content,
          transcript.metadata.usage,
          transcript.metadata.model ?? resolved.model,
        )
      }
      return
    }

    if (handle !== undefined) {
      try {
        const owner = live?.runner ?? resolved.runner
        const transcript = await owner.end(handle)
        await this.depositTranscript(
          spec,
          session,
          transcript.content,
          transcript.metadata.usage,
          transcript.metadata.model ?? resolved.model,
        )
      } catch (error) {
        if (error instanceof HarvestLeaseLostError) throw error
        // A dead agent may have no recoverable transcript.
      }
    }
    if (spec.producer) this.producer = undefined
    const attempt = failures + 1
    const structuredFailure =
      turnError === undefined && result?.kind === 'failed'
        ? result.failure
        : undefined
    const failureMessage =
      turnError !== undefined
        ? errorMessage(turnError)
        : structuredFailure?.message ?? 'no-terminal'
    const willRetry =
      structuredFailure?.permanent !== true && attempt < this.maxSessionAttempts
    await this.ensureLease()
    await store.appendRepo(repo, {
      actor: KERNEL,
      type: 'harvest.failed',
      payload: {
        run: spec.run,
        step: spec.step,
        round: spec.round,
        attempt,
        error: failureMessage,
        willRetry,
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
        detail: failureMessage,
      },
    })
    throw new SessionFailure(
      `${spec.step}@${spec.round} failed: ${failureMessage}`,
    )
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
  ): Promise<void> {
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
    const { store, repo, tickets, config, uuids } = this.deps
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
    const knownLedger = new Map(
      packet.ledger.map((entry) => [
        `${entry.ticket.source}:${entry.ticket.id}`,
        entry,
      ]),
    )
    const alreadyFiled = new Map(
      current.filed.map((entry) => [entry.proposalKey, entry.ticket]),
    )
    const reservations = new Map(
      current.reservations.map((entry) => [entry.proposalKey, entry.id]),
    )
    const dispositions: HarvestDisposition[] = []
    const report: Array<Record<string, unknown>> = []

    for (const proposal of set.proposals) {
      await this.ensureLease()
      if (proposal.action === 'create') {
        const proposalKey = harvestProposalKey(proposal)
        let ticket = alreadyFiled.get(proposalKey)
        if (ticket === undefined) {
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
          ticket = (
            await tickets.create(
              { title: proposal.title, body },
              {
                state: defaultTriageState(config),
                idempotencyKey: reservedId,
              },
            )
          ).ref
          // If the process stops before create, the replacement reads the
          // reservation. If it stops after create but before this filing fact,
          // it sends the same reserved id and adopts the external ticket.
          await this.ensureLease()
          await store.appendRepo(repo, {
            actor: KERNEL,
            type: 'harvest.proposal.filed',
            payload: { run: run.run, proposalKey, ticket },
          })
          alreadyFiled.set(proposalKey, ticket)
        }
        for (const occurrence of proposal.observations) {
          dispositions.push({
            occurrence,
            action: 'filed',
            proposalKey,
            ticket,
          })
        }
        report.push({ action: 'filed', proposalKey, ticket })
      } else if (proposal.action === 'join') {
        const known = knownLedger.get(
          `${proposal.ticket.source}:${proposal.ticket.id}`,
        )
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
  ): Promise<void> {
    await this.ensureLease()
    const events = await this.deps.store.getRepoEvents(this.deps.repo)
    const state = reduceHarvest(events)
    const current = state.runs.find((candidate) => candidate.run === run)
    if (!current || current.status !== 'running') return
    const open = [...current.steps]
      .reverse()
      .find((occurrence) => occurrence.completedSeq === undefined)
    const step = open?.step ?? 'file'
    const round = open?.round
    const prior = events.filter(
      (event) =>
        event.type === 'harvest.failed' &&
        event.payload.run === run &&
        event.payload.step === step &&
        event.payload.round === round,
    ).length
    const attempt = prior + 1
    const willRetry = attempt < this.maxSessionAttempts
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
    await this.ensureLease()
    const state = reduceHarvest(
      await this.deps.store.getRepoEvents(this.deps.repo),
    )
    const decision = decideHarvestControl(state, this.maxRecoveryAttempts)
    if (decision.kind !== 'exhaust-recovery' || decision.run !== run) return
    await this.finalizeRecoveryExhaustion(
      decision.run,
      decision.attempts,
      decision.limit,
    )
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
    const state = reduceHarvest(
      await this.deps.store.getRepoEvents(this.deps.repo),
    )
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
        ...(run.failure.round !== undefined
          ? { round: run.failure.round }
          : {}),
        error: run.failure.error,
        attempts,
        limit,
        ...partition,
      },
    })
    return true
  }

  /** Settle repository-wide commands and automatic recovery only at a durable
   * workflow boundary. Requests and acknowledgements are separate facts, so a
   * replacement process can finish the same transition without spending a
   * second recovery attempt. */
  private async controlBoundary(run?: string): Promise<void> {
    while (true) {
      await this.ensureLease()
      const state = reduceHarvest(
        await this.deps.store.getRepoEvents(this.deps.repo),
      )
      const decision = decideHarvestControl(state, this.maxRecoveryAttempts)
      if (decision.kind === 'proceed') return
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
        type:
          decision.command === 'pause'
            ? 'harvest.paused'
            : 'harvest.resumed',
        payload: {},
      })
      // Re-reduce after every acknowledgement. An opposing request may have
      // raced the append; the newest durable intent must win before this
      // runner either parks or starts another unit.
    }
  }

  private async refreshRun(run: string): Promise<HarvestRunState> {
    const state = reduceHarvest(
      await this.deps.store.getRepoEvents(this.deps.repo),
    )
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
      (occurrence) =>
        occurrence.step === 'scan' && occurrence.completedSeq === undefined,
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

  private sessionEnv(
    run: string,
    step: 'synthesize' | 'review',
    round: number,
    session: string,
  ): Record<string, string> {
    return {
      AB_STORE: 'local',
      ...this.deps.sessionEnv,
      AB_REPO: this.deps.repo,
      AB_HARVEST: run,
      AB_PHASE: `${step}@${round}`,
      AB_SESSION: session,
    }
  }

  /** Re-acquire a lapsed lease only when no replacement won it. Checked at
   * every durable boundary; work already in an agent turn cannot be revoked,
   * but this process performs no subsequent kernel/file action without
   * ownership. */
  private async ensureLease(): Promise<void> {
    if (!this.leaseLost) return
    const { store, repo, instance } = this.deps
    const reclaimed = await store.claimRepoLease(repo, instance, this.leaseTtlMs)
    if (!reclaimed) throw new HarvestLeaseLostError(repo, instance)
    this.leaseLost = false
  }

  private async startHeartbeat(): Promise<void> {
    const { store, repo, instance } = this.deps
    if (!(await store.heartbeatRepo(repo, instance))) this.leaseLost = true
    this.heartbeatTimer = setInterval(() => {
      store.heartbeatRepo(repo, instance).then(
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
