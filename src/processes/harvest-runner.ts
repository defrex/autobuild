/**
 * Crash-safe repository-scoped harvest workflow:
 * scan -> synthesize <-> review -> file. It reuses `converge` for adversarial
 * review semantics while every durable boundary lives in the repository
 * journal, so a replacement process resumes the claimed snapshot rather than
 * starting a duplicate run.
 */
import type { Config } from '../config/schema'
import type { HarvestEvent, HarvestEventWrite } from '../events/harvest'
import { KERNEL } from '../events/envelope'
import type { IdSource } from '../ids'
import {
  occurrenceKey,
  type HarvestDisposition,
} from '../harvest/schema'
import { converge } from '../kernel/converge'
import { stalledChains } from '../kernel/stall'
import {
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
import {
  artifactRef,
  HARVEST_REPORT_ARTIFACT,
  HARVEST_SCAN_ARTIFACT,
  HARVEST_TRANSCRIPT_ARTIFACT,
  harvestProposalKey,
  loadScanPacket,
  makeHarvestScanPacket,
  parseApprovedProposalSet,
  renderHarvestProposal,
  scanUnclaimedObservations,
} from './harvest'
import type { BuildStore, Clock } from '../store/types'

export interface HarvestRunnerOpts {
  leaseTtlMs?: number
  heartbeatMs?: number
  maxSessionAttempts?: number
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
  clock: Clock
  instance: string
  sessionEnv?: Record<string, string>
  opts?: HarvestRunnerOpts
}

export type HarvestRunnerResult =
  | { outcome: 'idle' }
  | { outcome: 'held' }
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function verdictFromEvent(
  event: Extract<HarvestEvent, { type: 'harvest.review.verdict' }>,
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
  private readonly resolver: RuntimeResolver
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private producer: ProducerSession | undefined

  constructor(private readonly deps: HarvestRunnerDeps) {
    this.leaseTtlMs = deps.opts?.leaseTtlMs ?? 60_000
    this.heartbeatMs = deps.opts?.heartbeatMs ?? 15_000
    this.maxSessionAttempts = deps.opts?.maxSessionAttempts ?? 2
    this.resolver = createRuntimeResolver(
      deps.runtimes,
      deps.config.agent,
      deps.defaultRuntime,
      deps.config.roles,
    )
  }

  async run(): Promise<HarvestRunnerResult> {
    const { store, repo, instance } = this.deps
    await store.ensureRepo(repo)
    if (!(await store.claimRepoLease(repo, instance, this.leaseTtlMs))) {
      return { outcome: 'held' }
    }
    this.startHeartbeat()
    let initial: 'started' | 'resumed' = 'resumed'
    let run: HarvestRunState | undefined
    try {
      let events = await store.getRepoEvents(repo)
      run = openHarvestRun(reduceHarvest(events))
      if (!run) {
        const scan = await scanUnclaimedObservations(store, repo)
        if (scan.observations.length < this.deps.config.harvest.threshold) {
          return { outcome: 'idle' }
        }
        initial = 'started'
        const runId = this.deps.ids('harvest')
        const packet = await makeHarvestScanPacket({
          store,
          tickets: this.deps.tickets,
          repo,
          run: runId,
          observations: scan.observations,
          state: scan.state,
        })
        const { event } = await store.appendRepoWithArtifacts(
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
        await store.appendRepo(repo, {
          actor: KERNEL,
          type: 'harvest.step.started',
          payload: { run: runId, step: 'scan' },
        })
        await store.appendRepo(repo, {
          actor: KERNEL,
          type: 'harvest.step.completed',
          payload: {
            run: runId,
            step: 'scan',
            outcome: 'completed',
            artifact: event.payload.scan,
          },
        })
        events = await store.getRepoEvents(repo)
        run = reduceHarvest(events).runs.find((candidate) => candidate.run === runId)
        if (!run) throw new Error(`harvest.started did not reduce run "${runId}"`)
      }

      try {
        await this.ensureScanStep(run)
        const outcome = await this.executeWorkflow(run)
        return { outcome, launch: initial, run: run.run }
      } catch (error) {
        if (error instanceof SessionFailure) {
          return { outcome: 'failed', launch: initial, run: run.run }
        }
        await this.recordWorkflowFailure(run.run, error)
        return { outcome: 'failed', launch: initial, run: run.run }
      }
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
      produce: async (feedback, round) => {
        run = await this.refreshRun(run.run)
        const existing = proposalArtifactForRound(run, round)
        if (existing !== undefined) {
          await this.ensureStepCompleted(
            run.run,
            'synthesize',
            round,
            'completed',
            existing,
          )
          return existing
        }
        return this.synthesize(run, round, feedback)
      },
      review: async (_artifact, round) => {
        run = await this.refreshRun(run.run)
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
              HarvestEvent,
              { type: 'harvest.review.verdict' }
            > =>
              candidate.type === 'harvest.review.verdict' &&
              candidate.payload.run === run.run &&
              candidate.payload.round === round,
          )
          if (!event) throw new Error('review reducer/event mismatch')
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
    feedback: Feedback | null,
  ): Promise<ArtifactRef> {
    await this.startStep(run.run, 'synthesize', round)
    await this.executeSession({
      run: run.run,
      role: 'harvest',
      skill: installedSkillName('harvest'),
      step: 'synthesize',
      round,
      feedback,
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
    return artifact
  }

  private async review(run: HarvestRunState, round: number): Promise<Verdict> {
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
          HarvestEvent,
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
    return verdictFromEvent(verdict)
  }

  private async executeSession(spec: {
    run: string
    role: 'harvest' | 'harvest-review'
    skill: string
    step: 'synthesize' | 'review'
    round: number
    feedback?: Feedback | null
    producer: boolean
    terminal: (event: HarvestEvent, session: string) => boolean
  }): Promise<void> {
    const { store, repo, ids, workspacePath } = this.deps
    const failures = (await store.getRepoEvents(repo)).filter(
      (event) =>
        event.type === 'harvest.failed' &&
        event.payload.run === spec.run &&
        event.payload.step === spec.step &&
        event.payload.round === spec.round,
    ).length
    if (failures >= this.maxSessionAttempts) {
      throw new SessionFailure(`${spec.step}@${spec.round} exhausted retries`)
    }

    const session = ids('hs')
    const resolved = this.resolver.resolve(spec.role)
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
      } catch {
        // A dead agent may have no recoverable transcript.
      }
    }
    if (spec.producer) this.producer = undefined
    const attempt = failures + 1
    const willRetry = attempt < this.maxSessionAttempts
    const failureMessage =
      turnError === undefined ? 'no-terminal' : errorMessage(turnError)
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
      `${spec.step}@${spec.round} failed: ${
        turnError === undefined ? 'no-terminal' : errorMessage(turnError)
      }`,
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
    const { store, repo, tickets, config } = this.deps
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
    const dispositions: HarvestDisposition[] = []
    const report: Array<Record<string, unknown>> = []

    for (const proposal of set.proposals) {
      if (proposal.action === 'create') {
        const proposalKey = harvestProposalKey(proposal)
        let ticket = alreadyFiled.get(proposalKey)
        if (ticket === undefined) {
          const body = renderHarvestProposal(proposal, observations)
          ticket = (
            await tickets.create(
              { title: proposal.title, body },
              {
                state:
                  config.tickets.triageState ??
                  (config.tickets.source === 'linear' ? 'Backlog' : 'Triage'),
                idempotencyKey: proposalKey,
              },
            )
          ).ref
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
    const refreshed = await this.refreshRun(run.run)
    if (refreshed.status !== 'running') return
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

  private async refreshRun(run: string): Promise<HarvestRunState> {
    const state = reduceHarvest(
      await this.deps.store.getRepoEvents(this.deps.repo),
    )
    const found = state.runs.find((candidate) => candidate.run === run)
    if (!found) throw new Error(`unknown harvest run "${run}"`)
    return found
  }

  private async ensureScanStep(run: HarvestRunState): Promise<void> {
    const completed = run.steps.some(
      (occurrence) =>
        occurrence.step === 'scan' && occurrence.completedSeq !== undefined,
    )
    if (completed) return
    const open = run.steps.some(
      (occurrence) =>
        occurrence.step === 'scan' && occurrence.completedSeq === undefined,
    )
    if (!open) {
      await this.deps.store.appendRepo(this.deps.repo, {
        actor: KERNEL,
        type: 'harvest.step.started',
        payload: { run: run.run, step: 'scan' },
      })
    }
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
    const refreshed = await this.refreshRun(run)
    const open = refreshed.steps.some(
      (occurrence) =>
        occurrence.step === step &&
        occurrence.round === round &&
        occurrence.completedSeq === undefined,
    )
    if (open) return
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

  private startHeartbeat(): void {
    void this.deps.store.heartbeatRepo(this.deps.repo, this.deps.instance)
    this.heartbeatTimer = setInterval(() => {
      void this.deps.store.heartbeatRepo(this.deps.repo, this.deps.instance)
    }, this.heartbeatMs)
    this.heartbeatTimer.unref?.()
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
  }
}
