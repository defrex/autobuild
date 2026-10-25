import type { AbEvent } from '../events/catalog'
import type { Actor } from '../events/envelope'
import type { BuildStore, Clock } from '../store/types'
import { readBuildFacts } from '../store/reduced-reads'
import { isForgeFailure } from '../ports/forge-failure'
import { ForgeRequestDeferred } from '../ports/forge-request-context'

/** A failed retry write must escape phase accounting and destructive release. */
export class PublicationRetryPersistenceError extends Error {
  constructor(cause: unknown) {
    super(
      `publication retry persistence failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
  }
}
async function persistRetry<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (error) {
    throw new PublicationRetryPersistenceError(error)
  }
}

export const PUBLICATION_RETRY_SECONDS = [30, 60, 120, 240, 300, 300] as const
export type PublicationOperation = 'restack' | 'reconcile'
export type PublicationRetryEvent = Extract<
  AbEvent,
  {
    type: 'publication.retry-scheduled' | 'publication.retry-exhausted' | 'escalation.answered'
  }
>
export function publicationEscalationId(
  operation: PublicationOperation,
  id: string,
  anchor: number,
) {
  return `publication:${operation}:${id}:${anchor}`
}
export function publicationRetryState(
  events: readonly PublicationRetryEvent[],
  operation: PublicationOperation,
  rewriteId: string,
) {
  let anchor = 0
  let latest: Exclude<PublicationRetryEvent, { type: 'escalation.answered' }> | undefined
  for (const event of events) {
    if (event.type === 'escalation.answered') {
      if (
        latest?.type === 'publication.retry-exhausted' &&
        event.payload.id === publicationEscalationId(operation, rewriteId, anchor)
      ) {
        anchor = event.seq
        latest = undefined
      }
    } else if (
      event.payload.operation === operation &&
      event.payload.rewriteId === rewriteId &&
      event.payload.anchor === anchor
    )
      latest = event
  }
  return { anchor, latest }
}

export interface PublicationRetryDeps {
  store: BuildStore
  slug: string
  clock: Clock
  actor: Actor
}
/** Retry facts are written outside the provider catch: store failures propagate. */
export async function publicationRetryGate(
  deps: PublicationRetryDeps,
  operation: PublicationOperation,
  id: string,
) {
  const facts = (await readBuildFacts(deps.store, deps.slug)).value
  const state = facts.publication.retry(operation, id)
  if (state.latest?.type === 'publication.retry-exhausted') {
    const payload = state.latest.payload
    const escalationId = publicationEscalationId(operation, id, state.anchor)
    if (!facts.state.openEscalations.some((e) => e.id === escalationId)) {
      const raised = await persistRetry(() =>
        deps.store.appendIfCurrent(deps.slug, facts.state.lastSeq, {
          actor: deps.actor,
          type: 'escalation.raised',
          payload: {
            id: escalationId,
            phase: 'reconcile',
            round: payload.round,
            source: 'policy',
            policyCause: 'publication-retry-limit',
            question: `${operation} publication exhausted after 6 retries; last error: ${payload.error}`,
          },
        }),
      )
      if (!raised) return publicationRetryGate(deps, operation, id)
    }
    throw new ForgeRequestDeferred('publication retry budget exhausted; awaiting answer')
  }
  if (
    state.latest?.type === 'publication.retry-scheduled' &&
    Date.parse(state.latest.payload.retryAt) > deps.clock().getTime()
  )
    throw new ForgeRequestDeferred(
      `publication retry scheduled for ${state.latest.payload.retryAt}`,
    )
}

export async function recordPublicationFailure(
  deps: PublicationRetryDeps,
  operation: PublicationOperation,
  rewriteId: string,
  round: number,
  error: unknown,
): Promise<never> {
  if (error instanceof ForgeRequestDeferred) throw error
  if (isForgeFailure(error) && error.details.kind === 'rate-limited')
    throw new ForgeRequestDeferred(`forge cooldown until ${error.details.resetAt}`)
  if (!isForgeFailure(error) || error.details.kind !== 'transient') throw error
  const state = (await readBuildFacts(deps.store, deps.slug)).value.publication.retry(
    operation,
    rewriteId,
  )
  const failure = (state.latest?.payload.failure ?? 0) + 1
  const payload = { operation, rewriteId, round, anchor: state.anchor, error: error.message }
  if (failure <= PUBLICATION_RETRY_SECONDS.length) {
    await persistRetry(() =>
      deps.store.append(deps.slug, {
        actor: deps.actor,
        type: 'publication.retry-scheduled',
        payload: {
          ...payload,
          failure,
          retryAt: new Date(
            deps.clock().getTime() + PUBLICATION_RETRY_SECONDS[failure - 1]! * 1000,
          ).toISOString(),
        },
      }),
    )
  } else {
    await persistRetry(() =>
      deps.store.append(deps.slug, {
        actor: deps.actor,
        type: 'publication.retry-exhausted',
        payload: { ...payload, failure: 7 },
      }),
    )
    await publicationRetryGate(deps, operation, rewriteId)
  }
  throw new ForgeRequestDeferred('publication retry scheduled')
}

export async function retryPublicationEffect<T>(
  deps: PublicationRetryDeps,
  operation: PublicationOperation,
  id: string,
  round: number,
  effect: () => Promise<T>,
): Promise<T> {
  await publicationRetryGate(deps, operation, id)
  try {
    return await effect()
  } catch (error) {
    return recordPublicationFailure(deps, operation, id, round, error)
  }
}
