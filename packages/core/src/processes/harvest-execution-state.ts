/**
 * Durable harvest execution state: the repository-journal projection that
 * hosted-harvest supervision (AUT-305) reads instead of process memory. The
 * launch/close facts (`harvest.execution.started`/`.released`) bracket one
 * disposable environment; the run's own facts decide the outcome. Every
 * helper here is a pure function over the journal, mirroring the build
 * execution settlement, so any dispatcher invocation can settle a run whose
 * supervisor died.
 */
import type { RepositoryEvent } from '../events/repository'
import { defineReducer } from '../kernel/incremental'
import {
  DEFAULT_MAX_HARVEST_RECOVERY_ATTEMPTS,
  actionableHarvestRun,
  decideHarvestControl,
  reduceHarvest,
} from '../kernel/harvest'
import type { HarvestRunnerResult } from './harvest-runner'

export interface OpenHarvestExecution {
  execution: string
  provider: string
  environmentId: string
  sessionId?: string
  commandId?: string
  seq: number
}

export const OPEN_HARVEST_EXECUTIONS_REDUCER_VERSION = 1

/** Open harvest executions: every `harvest.execution.started` not followed by
 * a matching `harvest.execution.released`, in journal order. The accumulator is
 * an ordered array: a re-started execution keeps its original position, as it
 * did in the `Map` this replaces. */
export const openHarvestExecutionsReducer = defineReducer<
  { open: OpenHarvestExecution[] },
  RepositoryEvent,
  OpenHarvestExecution[]
>({
  version: OPEN_HARVEST_EXECUTIONS_REDUCER_VERSION,
  initial: () => ({ open: [] }),
  fold(acc, events) {
    for (const event of events) {
      if (event.type === 'harvest.execution.started') {
        const entry: OpenHarvestExecution = {
          execution: event.payload.execution,
          provider: event.payload.provider,
          environmentId: event.payload.environmentId,
          ...(event.payload.sessionId !== undefined ? { sessionId: event.payload.sessionId } : {}),
          ...(event.payload.commandId !== undefined ? { commandId: event.payload.commandId } : {}),
          seq: event.seq,
        }
        const index = acc.open.findIndex((item) => item.execution === entry.execution)
        if (index === -1) acc.open.push(entry)
        else acc.open[index] = entry
      } else if (event.type === 'harvest.execution.released') {
        const index = acc.open.findIndex((item) => item.execution === event.payload.execution)
        if (index !== -1) acc.open.splice(index, 1)
      }
    }
  },
  finish: (acc) => acc.open.map((item) => ({ ...item })),
})

export function openHarvestExecutions(events: readonly RepositoryEvent[]): OpenHarvestExecution[] {
  return openHarvestExecutionsReducer.reduce(events)
}

export interface HarvestExecutionClassificationInput {
  /** Repo-journal seq of this execution's `harvest.execution.started` fact. */
  executionStartedSeq: number
  /** The repository-lease holder this execution adopted from the dispatch
   * loop. Absent (local runner shape) makes the held check inapplicable. */
  adoptedHolder?: string
  /** The repository lease holder observed after the guest exited. */
  leaseHolder?: string
  maxRecoveryAttempts?: number
}

/** Classify one finished hosted harvest execution from the repository journal
 * alone — the guest's exit code carries no pipeline outcome. The latest run's
 * terminal fact wins (`completed`/`escalated`/unresolved `failed`) — but only
 * when that terminal fact postdates this execution's start: a stale terminal
 * fact was already counted and announced by the execution that produced it,
 * and re-reporting it would double-count. Launch attribution is by whether
 * the run started inside this execution; a run still open under a
 * parked/paused control decision is `parked`; a lease held by someone else is
 * `held`; anything else is `idle`. The result feeds the same counters a
 * locally run harvest reports. */
export function classifyHarvestOutcome(
  events: readonly RepositoryEvent[],
  input: HarvestExecutionClassificationInput,
): HarvestRunnerResult {
  const state = reduceHarvest(events)
  const latestRun = state.runs.at(-1)
  if (latestRun !== undefined) {
    const launch = latestRun.startedSeq > input.executionStartedSeq ? 'started' : 'resumed'
    // Recency gate: a terminal outcome counts only if its fact — the run's
    // terminal fact, or for an unresolved failure the failure fact itself
    // (`failureSeq`), which also covers exhaustion via `terminalSeq` —
    // postdates this execution's `harvest.execution.started`.
    const outcomeSeq = Math.max(latestRun.terminalSeq ?? 0, latestRun.failureSeq ?? 0)
    if (outcomeSeq > input.executionStartedSeq) {
      if (latestRun.status === 'completed') {
        return { outcome: 'completed', launch, run: latestRun.run }
      }
      if (latestRun.status === 'escalated') {
        return { outcome: 'escalated', launch, run: latestRun.run }
      }
      // An unresolved harvest.failed — including recovery exhaustion — is a
      // durable stop, not an idle exit.
      if (latestRun.failure !== undefined) {
        return { outcome: 'failed', launch, run: latestRun.run }
      }
    }
  }
  const decision = decideHarvestControl(
    state,
    input.maxRecoveryAttempts ?? DEFAULT_MAX_HARVEST_RECOVERY_ATTEMPTS,
  )
  if (decision.kind === 'park') {
    const run = actionableHarvestRun(state)?.run
    return run === undefined ? { outcome: 'parked' } : { outcome: 'parked', run }
  }
  if (
    input.adoptedHolder !== undefined &&
    input.leaseHolder !== undefined &&
    input.leaseHolder !== input.adoptedHolder
  ) {
    return { outcome: 'held' }
  }
  return { outcome: 'idle' }
}
