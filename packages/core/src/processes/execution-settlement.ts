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
import { DISPATCHER } from '../events/envelope'
import type { AbEvent, EventWrite } from '../events/catalog'
import type {
  BuildExecution,
  BuildExecutionIdentity,
  ExecutionObservation,
} from '../ports/workspace/build-execution'
import type { BuildStore } from '../store/types'

/** The latest `execution.started` not followed by an instance-matched
 * `execution.ended`, or null when no execution is open. */
export function openExecution(events: AbEvent[]): {
  instance: string
  workspaceRef: string
  provider: string
  environmentId?: string
  sessionId?: string
  commandId?: string
} | null {
  let open: {
    instance: string
    workspaceRef: string
    provider: string
    environmentId?: string
    sessionId?: string
    commandId?: string
  } | null = null
  for (const event of events) {
    if (event.type === 'execution.started') {
      const payload = event.payload
      open = {
        instance: payload.instance,
        workspaceRef: payload.workspaceRef,
        provider: payload.provider,
        ...(payload.environmentId !== undefined ? { environmentId: payload.environmentId } : {}),
        ...(payload.sessionId !== undefined ? { sessionId: payload.sessionId } : {}),
        ...(payload.commandId !== undefined ? { commandId: payload.commandId } : {}),
      }
    } else if (event.type === 'execution.ended' && open !== null) {
      if (event.payload.instance === open.instance) open = null
    }
  }
  return open
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
 * guest is alive or unknowable — no writes. */
export type ExecutionSettlement = 'running' | 'settled' | 'lost'

export interface ExecutionSettlementDeps {
  store: BuildStore
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
export async function settleExecution(
  deps: ExecutionSettlementDeps,
  slug: string,
  events: AbEvent[],
): Promise<ExecutionSettlement> {
  const open = openExecution(events)
  if (open === null) return 'settled'
  if (open.commandId === undefined || deps.execution.observe === undefined) return 'running'
  let observation: ExecutionObservation
  try {
    observation = await deps.execution.observe(observationIdentity(open))
  } catch {
    return 'running'
  }
  if (observation.state === 'running') return 'running'

  const ended: EventWrite<'execution.ended'> =
    observation.state === 'ended'
      ? {
          actor: DISPATCHER,
          type: 'execution.ended',
          payload: {
            instance: open.instance,
            workspaceRef: open.workspaceRef,
            outcome: 'completed',
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
