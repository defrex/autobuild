import { randomIds, type IdSource } from '../ids'
/**
 * Settlement of foreign build executions from durable facts plus provider
 * liveness (AUT-301). Today's completion handling hangs off the in-memory
 * `handle.completion` promise of the process that launched the runner; when
 * that process dies, nothing writes `execution.ended`, releases the lease, or
 * settles publication. These helpers let any dispatcher tick re-derive the
 * same decisions from the event log and one bounded provider observation —
 * mirroring the engine, which is already a pure function over the log.
 *
 * Conservatism rule: an observation that cannot be resolved (provider error)
 * is treated as `running`. Supervision decisions reap or settle only on
 * provider proof, never on an unknown.
 */
import { DISPATCHER, KERNEL } from '../events/envelope'
import type { AbEvent, EventWrite } from '../events/catalog'
import type {
  BuildExecution,
  BuildExecutionIdentity,
  ExecutionObservation,
} from '../ports/workspace/build-execution'
import { readBuildFacts } from '../store/reduced-reads'
import { defineReducer } from '../kernel/incremental'
import type { BuildStore } from '../store/types'

export interface OpenExecution {
  instance: string
  workspaceRef: string
  provider: string
  environmentId?: string
  sessionId?: string
  commandId?: string
}

export const OPEN_EXECUTION_REDUCER_VERSION = 1

/** The latest `execution.started` not followed by an instance-matched
 * `execution.ended`, or null when no execution is open. */
export const openExecutionReducer = defineReducer<
  { open: OpenExecution | null },
  AbEvent,
  OpenExecution | null
>({
  version: OPEN_EXECUTION_REDUCER_VERSION,
  initial: () => ({ open: null }),
  fold(acc, events) {
    for (const event of events) {
      if (event.type === 'execution.started') {
        const payload = event.payload
        acc.open = {
          instance: payload.instance,
          workspaceRef: payload.workspaceRef,
          provider: payload.provider,
          ...(payload.environmentId !== undefined ? { environmentId: payload.environmentId } : {}),
          ...(payload.sessionId !== undefined ? { sessionId: payload.sessionId } : {}),
          ...(payload.commandId !== undefined ? { commandId: payload.commandId } : {}),
        }
      } else if (event.type === 'execution.ended' && acc.open !== null) {
        if (event.payload.instance === acc.open.instance) acc.open = null
      }
    }
  },
  finish: (acc) => (acc.open === null ? null : { ...acc.open }),
})

export function openExecution(events: AbEvent[]): OpenExecution | null {
  return openExecutionReducer.reduce(events)
}

export type ExecutionOutcome = 'open' | 'completed' | 'stopped' | 'lost' | 'relaunch' | 'none'

export const LAST_EXECUTION_OUTCOME_REDUCER_VERSION = 2

/** The lifecycle state of the latest recorded execution: `open` (no matching
 * end yet), `completed`/`stopped`/`lost`/`relaunch` (its recorded end), or `none`. */
export const lastExecutionOutcomeReducer = defineReducer<
  { state: ExecutionOutcome; instance: string | null },
  AbEvent,
  ExecutionOutcome
>({
  version: LAST_EXECUTION_OUTCOME_REDUCER_VERSION,
  initial: () => ({ state: 'none', instance: null }),
  fold(acc, events) {
    for (const event of events) {
      if (event.type === 'execution.started') {
        acc.state = 'open'
        acc.instance = event.payload.instance
      } else if (
        event.type === 'execution.ended' &&
        acc.state === 'open' &&
        acc.instance === event.payload.instance
      ) {
        acc.state = event.payload.outcome
      }
    }
  },
  finish: (acc) => acc.state,
})

export function lastExecutionOutcome(events: AbEvent[]): ExecutionOutcome {
  return lastExecutionOutcomeReducer.reduce(events)
}

function observationIdentity(open: {
  instance: string
  workspaceRef: string
  provider: string
  environmentId?: string
  sessionId?: string
  commandId?: string
}): BuildExecutionIdentity {
  return {
    provider: open.provider,
    workspaceRef: open.workspaceRef,
    ...(open.environmentId !== undefined ? { environmentId: open.environmentId } : {}),
    ...(open.sessionId !== undefined ? { sessionId: open.sessionId } : {}),
    ...(open.commandId !== undefined ? { commandId: open.commandId } : {}),
  }
}

/** Durable settlement outcome for one foreign open execution. `settled` means
 * a recorded completion was written and publication was settled; `lost` means
 * the provider proved the execution gone without an exit code (publication is
 * deliberately left to the existing abandonment flow); `running` means the
 * guest is alive or unknowable. Independent host attention may still be recorded. */
export type ExecutionSettlement = 'running' | 'settled' | 'lost'

export interface ExecutionSettlementDeps {
  store: BuildStore
  ids?: IdSource
  /** The observing provider's executor. Settlement requires the `observe`
   * capability; without it the caller supervises as before. */
  execution: BuildExecution
  /** Trusted publication settlement, invoked only after a recorded completion. */
  settlePublication?: (slug: string) => Promise<void>
}

/** Release the open execution's exact lease, but only while that instance
 * still holds it — a renewed runner lease under a different instance is never
 * touched. */
async function releaseSettledLease(
  store: BuildStore,
  slug: string,
  instance: string,
): Promise<void> {
  const record = await store.getBuild(slug)
  if (record?.lease !== undefined && record.lease.holder === instance) {
    await store.releaseLease(slug, instance)
  }
}

/**
 * Observe one foreign open execution and settle it from the observation.
 * Observation errors are contained and read as `running` (conservative: never
 * reap on an unknown); the next tick retries.
 */
export function settleExecution(
  deps: ExecutionSettlementDeps,
  slug: string,
  events: AbEvent[],
): Promise<ExecutionSettlement> {
  return settleOpenExecution(deps, slug, openExecution(events))
}

/** `settleExecution` over an already-derived open execution, for callers that
 * hold the projection (a reducer snapshot advanced to the log tail) and so
 * never need the event array. A `running` result or an observation error
 * touches no event rows unless the provider also reports actionable attention. */
export async function settleOpenExecution(
  deps: ExecutionSettlementDeps,
  slug: string,
  open: OpenExecution | null,
): Promise<ExecutionSettlement> {
  if (open === null) return 'settled'
  if (open.commandId === undefined || deps.execution.observe === undefined) return 'running'
  let observation: ExecutionObservation
  try {
    observation = await deps.execution.observe(observationIdentity(open))
  } catch {
    return 'running'
  }
  if (observation.attention) {
    const state = (await readBuildFacts(deps.store, slug)).value.state
    if (!state.openEscalations.some((entry) => entry.question === observation.attention))
      await deps.store.append(slug, {
        actor: KERNEL,
        type: 'escalation.raised',
        payload: {
          id: (deps.ids ?? randomIds())('esc'),
          phase: state.phase ?? 'setup',
          ...(state.round > 0 ? { round: state.round } : {}),
          source: 'policy',
          policyCause: 'non-retryable-phase-failure',
          question: observation.attention,
        },
      })
  }
  if (observation.state === 'running') return 'running'

  const request = (await readBuildFacts(deps.store, slug)).value.state.drainingExecutions?.[
    open.instance
  ]?.relaunch
  const ended: EventWrite<'execution.ended'> =
    observation.state === 'ended'
      ? {
          actor: DISPATCHER,
          type: 'execution.ended',
          payload: {
            instance: open.instance,
            workspaceRef: open.workspaceRef,
            outcome: observation.exitCode === 0 && request ? 'relaunch' : 'completed',
            exitCode: observation.exitCode ?? null,
          },
        }
      : {
          actor: DISPATCHER,
          type: 'execution.ended',
          payload: {
            instance: open.instance,
            workspaceRef: open.workspaceRef,
            outcome: 'lost',
          },
        }
  await deps.store.append(slug, ended)
  await releaseSettledLease(deps.store, slug, open.instance)
  if (observation.state === 'ended') {
    await deps.settlePublication?.(slug)
    return 'settled'
  }
  return 'lost'
}
