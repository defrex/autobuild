import { z } from 'zod'
import { forgeRequestCountsSchema } from '../ports/forge-telemetry'
import { EventValidationError } from '../events/catalog'
import {
  dispatcherStatusEventPayloadSchemas,
  validateRepositoryEventWrite,
  type RepositoryEventWrite,
} from '../events/repository'
import type { RepoTickCompletion } from './types'

export const repoTickCompletionSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('completed'),
    counters: dispatcherStatusEventPayloadSchemas['dispatcher.tick-completed'].shape.counters,
  }),
  z.object({
    outcome: z.literal('failed'),
    error: z.string().min(1),
    forgeRequests: forgeRequestCountsSchema.optional(),
  }),
])
export const repoTickObservationSchema = z.object({
  run: z.string().min(1),
  open: z.object({ startedAt: z.iso.datetime() }).optional(),
  finished: z
    .intersection(
      repoTickCompletionSchema,
      z.object({
        run: z.string().min(1),
        startedAt: z.iso.datetime(),
        completedAt: z.iso.datetime(),
      }),
    )
    .optional(),
})

/** Only a matching start and terminal boundary may ride the atomic finish. */
export function validateTickFinish(
  holder: string,
  completion: RepoTickCompletion,
  events: RepositoryEventWrite[],
) {
  const parsed = repoTickCompletionSchema.parse(completion)
  const validated = events.map(validateRepositoryEventWrite)
  if (validated.length === 0 && completion.outcome === 'completed') return validated
  if (validated.length !== 2)
    throw new EventValidationError('tick finish requires start and terminal boundaries')
  const [start, end] = validated
  if (
    start!.type !== 'dispatcher.tick-started' ||
    end!.type !==
      (completion.outcome === 'completed'
        ? 'dispatcher.tick-completed'
        : 'dispatcher.tick-failed') ||
    validated.some(
      (e) => e.actor.kind !== 'dispatcher' || !('run' in e.payload) || e.payload.run !== holder,
    )
  ) {
    throw new EventValidationError('invalid tick finish boundaries')
  }
  if (
    end!.type === 'dispatcher.tick-failed' &&
    completion.outcome === 'failed' &&
    dispatcherStatusEventPayloadSchemas['dispatcher.tick-failed'].parse(end!.payload).error !==
      completion.error
  )
    throw new EventValidationError('tick error mismatch')
  if (
    end!.type === 'dispatcher.tick-completed' &&
    completion.outcome === 'completed' &&
    JSON.stringify(
      dispatcherStatusEventPayloadSchemas['dispatcher.tick-completed'].parse(end!.payload).counters,
    ) !== JSON.stringify(parsed.outcome === 'completed' ? parsed.counters : {})
  )
    throw new EventValidationError('tick counters mismatch')
  return validated
}
