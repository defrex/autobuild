/** Typed agent/operator surface for repository-scoped harvest workflows. Agent
 * stdout is never interpreted: proposal sets and review verdicts land through
 * this module as validated repository events and versioned artifacts. */
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import {
  isHarvestEvent,
  type HarvestEvent,
  type RepositoryEvent,
  type RepositoryEventEnvelope,
} from '../events/repository'
import { agentActor } from '../events/envelope'
import {
  harvestProposalSetSchema,
  type HarvestProposalSet,
  type HarvestScanPacket,
} from '../harvest/schema'
import type { IdSource } from '../ids'
import {
  DEFAULT_MAX_HARVEST_RECOVERY_ATTEMPTS,
  proposalArtifactForRound,
  reduceHarvest,
  type HarvestPendingCommand,
  type HarvestRunState,
} from '../kernel/harvest'
import { findingDraftSchema, type Finding } from '../ontology'
import type { Exec } from '../ports/workspace/git-worktree'
import {
  HARVEST_PROPOSALS_ARTIFACT,
  HARVEST_REVIEW_ARTIFACT,
  loadScanPacket,
  validateProposalCoverage,
} from '../processes/harvest'
import type { BuildStore } from '../store/types'
import { RemoteBuildStore } from '../store/remote/client'
import type { HarvestCliEnv } from './env'
import { resolveRepoState } from './repo-state'
import { resolveStore } from './store-ref'

export interface HarvestCliDeps {
  store: BuildStore
  env: HarvestCliEnv
  workspacePath: string
  ids: IdSource
}

export interface HarvestContextManifest {
  repo: string
  run: string
  phase: 'synthesize' | 'review'
  round: number
  required: string[]
  allowedTerminal: 'submit' | 'verdict'
  materialized: string[]
}

async function wipeAbDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  for (const entry of await readdir(dir)) {
    if (entry === 'server.pid' || entry === 'server.log') continue
    await rm(join(dir, entry), { recursive: true, force: true })
  }
  await writeFile(join(dir, '.gitignore'), '*\n')
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

function runForEnv(
  events: RepositoryEvent[],
  env: HarvestCliEnv,
): HarvestRunState {
  const run = reduceHarvest(events).runs.find((candidate) => candidate.run === env.run)
  if (!run) throw new Error(`unknown harvest run "${env.run}" in repo "${env.repo}"`)
  if (run.status !== 'running') {
    throw new Error(
      `harvest run "${env.run}" is already ${run.status} — its agent session may not deposit another terminal`,
    )
  }
  return run
}

function assertNoSessionTerminal(
  events: RepositoryEvent[],
  env: HarvestCliEnv,
): void {
  for (const event of events) {
    if (
      event.type === 'harvest.proposals.submitted' &&
      env.phase === 'synthesize' &&
      event.payload.run === env.run &&
      event.payload.round === env.round
    ) {
      throw new Error(
        `second harvest terminal rejected: proposals for ${env.run} synthesize@${env.round} already landed at repo seq ${event.seq}`,
      )
    }
    if (
      event.type === 'harvest.review.verdict' &&
      env.phase === 'review' &&
      event.payload.run === env.run &&
      event.payload.round === env.round
    ) {
      throw new Error(
        `second harvest terminal rejected: verdict for ${env.run} review@${env.round} already landed at repo seq ${event.seq}`,
      )
    }
    if (
      event.type === 'harvest.session.ended' &&
      event.payload.session === env.session
    ) {
      throw new Error(
        `harvest terminal rejected: session "${env.session}" already ended at repo seq ${event.seq}`,
      )
    }
  }
}

async function readArtifactJson(
  store: BuildStore,
  repo: string,
  kind: string,
  rev: number,
): Promise<unknown> {
  const artifact = await store.getRepoArtifact(repo, kind, rev)
  if (!artifact) throw new Error(`missing repository artifact ${kind}@${rev}`)
  return JSON.parse(new TextDecoder().decode(artifact.content))
}

export async function buildHarvestContext(
  deps: HarvestCliDeps,
): Promise<HarvestContextManifest> {
  const { store, env, workspacePath } = deps
  const events = await store.getRepoEvents(env.repo)
  const run = runForEnv(events, env)
  const packet = await loadScanPacket(store, env.repo, run.scan)
  const abDir = join(workspacePath, '.ab')
  await wipeAbDir(abDir)

  const materialized: string[] = []
  const materialize = async (relative: string, value: unknown): Promise<void> => {
    await writeJson(join(abDir, relative), value)
    materialized.push(relative)
  }

  await materialize('observations.json', packet.observations)
  await materialize('ledger.json', packet.ledger)

  const proposal = proposalArtifactForRound(run, env.round)
  if (proposal !== undefined) {
    await materialize(
      'proposals.json',
      await readArtifactJson(store, env.repo, proposal.kind, proposal.rev),
    )
  }

  const priorReviews = run.reviews
    .filter((review) => review.round < env.round)
    .sort((a, b) => a.round - b.round)
  for (const review of priorReviews) {
    if (review.findings.length > 0) {
      await materialize(
        `history/findings-r${review.round}.json`,
        review.findings,
      )
    }
  }
  if (env.phase === 'synthesize' && env.round > 1) {
    const previous = [...run.reviews]
      .reverse()
      .find(
        (review) =>
          review.round === env.round - 1 && review.verdict === 'revise',
      )
    if (previous !== undefined) {
      await materialize('findings.json', previous.findings)
      const previousProposal = proposalArtifactForRound(run, env.round - 1)
      if (previousProposal !== undefined && proposal === undefined) {
        await materialize(
          'proposals.json',
          await readArtifactJson(
            store,
            env.repo,
            previousProposal.kind,
            previousProposal.rev,
          ),
        )
      }
    }
  }

  const manifest: HarvestContextManifest = {
    repo: env.repo,
    run: env.run,
    phase: env.phase,
    round: env.round,
    required:
      env.phase === 'synthesize'
        ? [HARVEST_PROPOSALS_ARTIFACT]
        : [HARVEST_REVIEW_ARTIFACT],
    allowedTerminal: env.phase === 'synthesize' ? 'submit' : 'verdict',
    materialized,
  }
  await writeJson(join(abDir, 'context.json'), manifest)
  return manifest
}

async function readJsonFile(path: string): Promise<unknown> {
  const file = Bun.file(path)
  if (!(await file.exists())) throw new Error(`file not found: ${path}`)
  try {
    return JSON.parse(await file.text())
  } catch (error) {
    throw new Error(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function validateJoinTargets(
  set: HarvestProposalSet,
  packet: HarvestScanPacket,
): void {
  const allowed = new Set(
    packet.ledger.map((entry) => `${entry.ticket.source}:${entry.ticket.id}`),
  )
  for (const proposal of set.proposals) {
    if (proposal.action !== 'join') continue
    const key = `${proposal.ticket.source}:${proposal.ticket.id}`
    if (!allowed.has(key)) {
      throw new Error(
        `join target ${key} was not supplied in the harvest ledger context — agents may only join a known prior proposal`,
      )
    }
  }
}

export async function submitHarvestProposals(
  deps: HarvestCliDeps,
  file: string,
): Promise<RepositoryEventEnvelope<'harvest.proposals.submitted'>> {
  const { store, env } = deps
  if (env.phase !== 'synthesize') {
    throw new Error(
      `'ab harvest submit' is only valid in synthesize@<round>; current phase is ${env.phase}@${env.round}`,
    )
  }
  const events = await store.getRepoEvents(env.repo)
  const run = runForEnv(events, env)
  assertNoSessionTerminal(events, env)

  const parsed = harvestProposalSetSchema.safeParse(await readJsonFile(file))
  if (!parsed.success) {
    throw new Error(
      `${file} does not match the harvest proposal schema: ${parsed.error.message}`,
    )
  }
  const coverage = validateProposalCoverage(parsed.data, run.observations)
  if (!coverage.ok) {
    throw new Error(
      `harvest proposals must cover every claimed observation exactly once: ${coverage.errors.join('; ')}`,
    )
  }
  const packet = await loadScanPacket(store, env.repo, run.scan)
  validateJoinTargets(parsed.data, packet)

  const { event } = await store.appendRepoWithArtifacts(
    env.repo,
    [
      {
        kind: HARVEST_PROPOSALS_ARTIFACT,
        content: `${JSON.stringify(parsed.data, null, 2)}\n`,
        metadata: { run: env.run, round: env.round },
      },
    ],
    (deposited) => ({
      actor: agentActor('harvest', env.session),
      type: 'harvest.proposals.submitted',
      payload: {
        run: env.run,
        round: env.round,
        artifact: {
          kind: deposited[0]!.kind,
          rev: deposited[0]!.revision,
        },
      },
    }),
  )
  return event
}

const FINDINGS_SHAPE = z.array(findingDraftSchema)

async function parseHarvestFindings(
  deps: HarvestCliDeps,
  file: string,
  run: HarvestRunState,
): Promise<Finding[]> {
  const parsed = FINDINGS_SHAPE.safeParse(await readJsonFile(file))
  if (!parsed.success) {
    throw new Error(`${file} does not match the finding schema: ${parsed.error.message}`)
  }
  const known = new Set(
    run.reviews
      .filter((review) => review.round < deps.env.round)
      .flatMap((review) => review.findings.map((finding) => finding.id)),
  )
  for (const finding of parsed.data) {
    for (const id of finding.persists) {
      if (!known.has(id)) {
        throw new Error(
          `persists id "${id}" is not a finding from an earlier harvest review round`,
        )
      }
    }
  }
  return parsed.data.map((finding) => ({ ...finding, id: deps.ids('hf') }))
}

export interface HarvestVerdictOpts {
  verdict: string
  notes: string
  findings?: string
  reason?: string
}

export async function submitHarvestVerdict(
  deps: HarvestCliDeps,
  opts: HarvestVerdictOpts,
): Promise<RepositoryEventEnvelope<'harvest.review.verdict'>> {
  const { store, env } = deps
  if (env.phase !== 'review') {
    throw new Error(
      `'ab harvest verdict' is only valid in review@<round>; current phase is ${env.phase}@${env.round}`,
    )
  }
  if (!['approve', 'revise', 'escalate'].includes(opts.verdict)) {
    throw new Error(
      `harvest verdict "${opts.verdict}" is invalid — expected approve | revise | escalate`,
    )
  }
  const events = await store.getRepoEvents(env.repo)
  const run = runForEnv(events, env)
  assertNoSessionTerminal(events, env)
  if (proposalArtifactForRound(run, env.round) === undefined) {
    throw new Error(
      `review@${env.round} has no proposal artifact to review — synthesize must submit first`,
    )
  }

  const notesFile = Bun.file(opts.notes)
  if (!(await notesFile.exists())) throw new Error(`--notes file not found: ${opts.notes}`)
  const notes = await notesFile.text()
  let findings: Finding[] = []
  if (opts.verdict === 'revise') {
    if (opts.findings === undefined) {
      throw new Error(`'ab harvest verdict revise' requires --findings <json>`)
    }
    findings = await parseHarvestFindings(deps, opts.findings, run)
    if (findings.length === 0) {
      throw new Error(`'ab harvest verdict revise' requires at least one finding`)
    }
  } else if (opts.findings !== undefined) {
    throw new Error(`--findings is only valid with the revise verdict`)
  }
  const reason = opts.reason?.trim()
  if (opts.verdict === 'escalate' && !reason) {
    throw new Error(`'ab harvest verdict escalate' requires --reason <text>`)
  }

  const { event } = await store.appendRepoWithArtifacts(
    env.repo,
    [
      {
        kind: HARVEST_REVIEW_ARTIFACT,
        content: notes,
        metadata: {
          run: env.run,
          round: env.round,
          verdict: opts.verdict,
        },
      },
    ],
    (deposited) => ({
      actor: agentActor('harvest-review', env.session),
      type: 'harvest.review.verdict',
      payload: {
        run: env.run,
        round: env.round,
        verdict: opts.verdict as 'approve' | 'revise' | 'escalate',
        findings,
        artifact: {
          kind: deposited[0]!.kind,
          rev: deposited[0]!.revision,
        },
        ...(reason ? { reason } : {}),
      },
    }),
  )
  return event
}

export interface HarvestRecoveryStatus {
  /** True only for an ordinary infrastructure stop the dispatcher may reopen. */
  recoverable: boolean
  /** Completed, escalated, and recovery-exhausted runs are genuinely terminal. */
  finished: boolean
  automatic: {
    attempts: number
    limit: number
    exhausted: boolean
  }
  stopped?: {
    step: NonNullable<HarvestRunState['failure']>['step']
    round?: number
  }
  attention: {
    required: boolean
    acknowledged: boolean
  }
  pending: {
    observations: Array<{ build: string; seq: number }>
    proposalKeys: string[]
  }
}

export interface HarvestStatusView {
  repo: string
  run?: string
  /** Repository control takes display precedence while paused; runStatus keeps
   * the underlying run lifecycle queryable without making pause terminal. */
  status: 'idle' | 'paused' | HarvestRunState['status']
  runStatus?: HarvestRunState['status']
  paused: boolean
  pausedSeq?: number
  pausedAt?: string
  pendingCommands: HarvestPendingCommand[]
  observations: number
  steps: HarvestRunState['steps']
  rounds: number
  filed: Array<{ proposalKey: string; ticket: { source: string; id: string } }>
  escalation?: HarvestRunState['escalation']
  failure?: HarvestRunState['failure']
  recovery: HarvestRecoveryStatus
  events?: HarvestEvent[]
}

function projectRecovery(
  run: HarvestRunState | undefined,
): HarvestRecoveryStatus {
  const exhaustion = run?.recoveryExhaustion
  const attempts = run?.recoveryRequests.length ?? 0
  const limit =
    exhaustion?.limit ??
    run?.recoveryRequests.at(-1)?.limit ??
    DEFAULT_MAX_HARVEST_RECOVERY_ATTEMPTS
  const stopped = run?.failure
  return {
    recoverable:
      run?.status === 'failed' && exhaustion === undefined,
    finished:
      run?.status === 'completed' ||
      run?.status === 'escalated' ||
      exhaustion !== undefined,
    automatic: {
      attempts,
      limit,
      exhausted: exhaustion !== undefined,
    },
    ...(stopped !== undefined
      ? {
          stopped: {
            step: stopped.step,
            ...(stopped.round !== undefined
              ? { round: stopped.round }
              : {}),
          },
        }
      : {}),
    attention: {
      required:
        exhaustion !== undefined &&
        exhaustion.attentionAcknowledgedSeq === undefined,
      acknowledged:
        exhaustion?.attentionAcknowledgedSeq !== undefined,
    },
    pending: {
      observations: structuredClone(
        exhaustion?.releasedObservations ?? [],
      ),
      proposalKeys:
        exhaustion?.pendingProposals.map(
          (proposal) => proposal.proposalKey,
        ) ?? [],
    },
  }
}

export function projectHarvestStatus(
  repo: string,
  events: RepositoryEvent[],
  newestEvents?: number,
): HarvestStatusView {
  const state = reduceHarvest(events)
  const history =
    newestEvents === undefined
      ? undefined
      : events.filter(isHarvestEvent).slice(-newestEvents)
  const latest = state.latest
  if (!latest) {
    return {
      repo,
      status: state.paused ? 'paused' : 'idle',
      paused: state.paused,
      ...(state.pausedSeq !== undefined ? { pausedSeq: state.pausedSeq } : {}),
      ...(state.pausedAt !== undefined ? { pausedAt: state.pausedAt } : {}),
      pendingCommands: state.pendingCommands,
      observations: 0,
      steps: [],
      rounds: 0,
      filed: [],
      recovery: projectRecovery(undefined),
      ...(history !== undefined ? { events: history } : {}),
    }
  }
  return {
    repo,
    run: latest.run,
    status: state.paused ? 'paused' : latest.status,
    runStatus: latest.status,
    paused: state.paused,
    ...(state.pausedSeq !== undefined ? { pausedSeq: state.pausedSeq } : {}),
    ...(state.pausedAt !== undefined ? { pausedAt: state.pausedAt } : {}),
    pendingCommands: state.pendingCommands,
    observations: latest.observations.length,
    steps: latest.steps,
    rounds: Math.max(0, ...latest.reviews.map((review) => review.round)),
    filed: latest.filed.map((entry) => ({
      proposalKey: entry.proposalKey,
      ticket: { source: entry.ticket.source, id: entry.ticket.id },
    })),
    ...(latest.escalation !== undefined
      ? { escalation: latest.escalation }
      : {}),
    ...(latest.failure !== undefined ? { failure: latest.failure } : {}),
    recovery: projectRecovery(latest),
    ...(history !== undefined ? { events: history } : {}),
  }
}

export function renderHarvestStatus(view: HarvestStatusView): string[] {
  const noRun = view.run === undefined
  const lines = noRun
    ? [
        `harvest ${view.repo}: ${
          view.status === 'paused' ? 'paused' : 'idle'
        } (no runs)`,
      ]
    : [
        `harvest ${view.run} — ${view.status}${
          view.status === 'paused' && view.runStatus !== undefined
            ? ` (run ${view.runStatus})`
            : ''
        }`,
        `observations: ${view.observations}`,
        `review rounds: ${view.rounds}`,
        'steps:',
      ]
  if (view.pendingCommands.length > 0) {
    lines.splice(
      1,
      0,
      `control pending: ${view.pendingCommands.map((command) => command.command).join(', ')}`,
    )
  }
  for (const step of view.steps) {
    lines.push(
      `  ${step.step}${step.round !== undefined ? ` r${step.round}` : ''}: ` +
        `${step.outcome ?? (step.completedSeq === undefined ? 'running' : 'done')}`,
    )
  }
  if (view.recovery.stopped !== undefined) {
    lines.push(
      `stopped at: ${view.recovery.stopped.step}${
        view.recovery.stopped.round !== undefined
          ? ` r${view.recovery.stopped.round}`
          : ''
      }`,
    )
  }
  if (
    view.recovery.recoverable ||
    view.recovery.automatic.attempts > 0 ||
    view.recovery.automatic.exhausted
  ) {
    lines.push(
      `automatic recovery: ${view.recovery.automatic.attempts}/${view.recovery.automatic.limit}${
        view.recovery.automatic.exhausted
          ? ' exhausted'
          : view.recovery.recoverable
            ? ' available'
            : ' resumed'
      }`,
    )
  }
  if (view.recovery.automatic.exhausted) {
    const observations = view.recovery.pending.observations.map(
      (occurrence) => `${occurrence.build}:${occurrence.seq}`,
    )
    const proposals = view.recovery.pending.proposalKeys
    lines.push(
      `pending: ${observations.length} observation${observations.length === 1 ? '' : 's'}` +
        `${observations.length > 0 ? ` (${observations.join(', ')})` : ''}` +
        `${proposals.length > 0 ? `; proposals ${proposals.join(', ')}` : ''}`,
    )
    lines.push(
      view.recovery.attention.required
        ? 'attention: human acknowledgement required'
        : 'attention: acknowledged',
    )
  }
  if (view.escalation) lines.push(`escalation: ${view.escalation.reason}`)
  if (view.failure) lines.push(`failure: ${view.failure.error}`)
  if (view.filed.length > 0) {
    lines.push('filed:')
    for (const entry of view.filed) {
      lines.push(`  ${entry.proposalKey} -> ${entry.ticket.source}:${entry.ticket.id}`)
    }
  }
  if (view.events !== undefined) {
    lines.push('events:')
    for (const event of view.events) {
      lines.push(`  ${event.seq} ${event.ts} ${event.type}`)
    }
  }
  return lines
}

export interface HarvestStatusOpts {
  /** Current directory; normalized to the main checkout before journal reads. */
  repo: string
  env: Record<string, string | undefined>
  exec: Exec
  stdout: (line: string) => void
  storeRef?: string
  json?: boolean
  events?: number
  /** Injectable store seam for command tests. */
  openStore?: (ref: string, token?: string) => BuildStore
}

export async function abHarvestStatus(opts: HarvestStatusOpts): Promise<void> {
  const state = await resolveRepoState({
    targetRepo: opts.repo,
    exec: opts.exec,
    ...(opts.storeRef !== undefined ? { storeRef: opts.storeRef } : {}),
    ...(opts.env['AB_STORE'] !== undefined ? { envStore: opts.env['AB_STORE'] } : {}),
  })
  const token = opts.env['AB_TOKEN']
  const open =
    opts.openStore ??
    ((ref: string, scoped?: string) =>
      resolveStore(ref, {
        ...(scoped !== undefined && scoped !== '' ? { token: scoped } : {}),
        remoteFactory: (url, remoteToken) =>
          new RemoteBuildStore({ url, token: remoteToken }),
      }))
  const store = open(
    state.storeRef,
    token !== undefined && token !== '' ? token : undefined,
  )
  try {
    const record = await store.getRepo(state.repo)
    const events = record === null ? [] : await store.getRepoEvents(state.repo)
    const view = projectHarvestStatus(state.repo, events, opts.events)
    if (opts.json === true) opts.stdout(JSON.stringify(view, null, 2))
    else for (const line of renderHarvestStatus(view)) opts.stdout(line)
  } finally {
    await store.close()
  }
}
