import type { RepositoryEvent, DispatchPlacementFact } from '../events/repository'
import { z } from 'zod'
import { dispatchPlacementFactSchema } from '../events/repository'
import { defineReducer } from './incremental'

export const dispatchPlacementSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('known'), placement: dispatchPlacementFactSchema }),
  z.strictObject({
    status: z.literal('unknown'),
    reason: z.enum(['unrecorded', 'unsupported-capability']),
  }),
])
export type DispatchPlacement = z.infer<typeof dispatchPlacementSchema>
export const dispatchPlacementReducer = defineReducer<
  { placement: DispatchPlacementFact | null },
  RepositoryEvent,
  DispatchPlacement
>({
  version: 1,
  initial: () => ({ placement: null }),
  fold: (acc, events) => {
    for (const event of events) {
      if (event.type === 'dispatcher.placement-set') acc.placement = event.payload
    }
  },
  finish: (acc) =>
    acc.placement === null
      ? { status: 'unknown', reason: 'unrecorded' }
      : { status: 'known', placement: structuredClone(acc.placement) },
})
