import type { AbEvent } from '../events/catalog'
import { DISPATCHER } from '../events/envelope'
import type { EventPayload } from '../events/payloads'
import type { IdSource } from '../ids'
import type { BuildStore } from '../store/types'

export type InfrastructureOperation = EventPayload<'infrastructure.failed'>['operation']
export type InfrastructureCause = EventPayload<'infrastructure.failed'>['cause']

export interface InfrastructureFailureInput {
  slug: string
  events: readonly AbEvent[]
  maxAttempts: number
  provider: string
  workspaceRef: string
  instance: string
  environmentId?: string
  sessionId?: string
  operation: InfrastructureOperation
  error: unknown
  cleanupPending: boolean
}

export interface InfrastructureFailureDependencies {
  store: Pick<BuildStore, 'append'>
  ids: IdSource
}

/** Infrastructure retries are re-armed only by a confirmed execution boundary
 * or a retry answer to this policy's own previously-raised exhaustion escalation. */
export function infrastructureFailureResetSeq(events: readonly AbEvent[]): number {
  const infrastructureEscalations = new Set<string>()
  let resetSeq = 0
  for (const event of events) {
    if (
      event.type === 'escalation.raised' &&
      event.payload.policyCause === 'infrastructure-failure-limit'
    ) {
      infrastructureEscalations.add(event.payload.id)
    } else if (
      event.type === 'execution.ended' ||
      (event.type === 'escalation.answered' &&
        event.payload.resolution === 'retry' &&
        infrastructureEscalations.has(event.payload.id))
    ) {
      resetSeq = event.seq
    }
  }
  return resetSeq
}

export function normalizeInfrastructureError(error: unknown): string {
  return (
    (error instanceof Error ? error.message : String(error)).trim() ||
    'provider operation failed without an error message'
  )
}

/** One deterministic provider-failure taxonomy shared by every dispatch path. */
export function classifyInfrastructureFailure(
  message: string,
  cleanupPending: boolean,
): InfrastructureCause {
  const lower = message.toLowerCase()
  if (/limit|quota|cpu|duration/.test(lower)) return 'provider-limit'
  if (/timeout|abort/.test(lower)) return 'timeout'
  if (/no longer exists|not found|missing/.test(lower)) return 'missing'
  return cleanupPending ? 'unknown-outcome' : 'provider-error'
}

/** Append one durable infrastructure failure and, when its epoch is exhausted,
 * the epoch's single policy escalation. Returned events let snapshot-based
 * callers immediately include these writes in the rest of their tick. */
export async function recordInfrastructureFailure(
  deps: InfrastructureFailureDependencies,
  input: InfrastructureFailureInput,
): Promise<AbEvent[]> {
  const lastReset = infrastructureFailureResetSeq(input.events)
  const attempt =
    input.events.filter((event) => event.type === 'infrastructure.failed' && event.seq > lastReset)
      .length + 1
  const message = normalizeInfrastructureError(input.error)
  const failure = await deps.store.append(input.slug, {
    actor: DISPATCHER,
    type: 'infrastructure.failed',
    payload: {
      provider: input.provider,
      workspaceRef: input.workspaceRef,
      instance: input.instance,
      ...(input.environmentId !== undefined ? { environmentId: input.environmentId } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      operation: input.operation,
      cause: classifyInfrastructureFailure(message, input.cleanupPending),
      attempt,
      retryable: true,
      cleanupPending: input.cleanupPending,
      error: message,
    },
  })
  const appended: AbEvent[] = [failure]

  if (
    attempt >= input.maxAttempts &&
    !input.events.some(
      (event) =>
        event.seq > lastReset &&
        event.type === 'escalation.raised' &&
        event.payload.policyCause === 'infrastructure-failure-limit',
    )
  ) {
    appended.push(
      await deps.store.append(input.slug, {
        actor: DISPATCHER,
        type: 'escalation.raised',
        payload: {
          id: deps.ids('esc'),
          phase: 'setup',
          source: 'policy',
          policyCause: 'infrastructure-failure-limit',
          question: `maxInfrastructureAttempts (${input.maxAttempts}) exhausted during ${input.operation}; provider cleanup/recovery must succeed before retry: ${message}`,
          refs: [input.workspaceRef],
        },
      }),
    )
  }

  return appended
}
