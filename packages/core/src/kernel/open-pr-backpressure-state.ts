import type { RepositoryEvent, RepositoryEventPayload } from '../events/repository'
import { defineReducer } from './incremental'

export type OpenPrBackpressureEngagement =
  RepositoryEventPayload<'dispatcher.open-pr-backpressure-engaged'> & { seq: number; since: string }

/** The durable engagement fact: the latest engaged payload until a cleared
 * event, so a fresh dispatcher process keeps hysteresis without re-recording. */
export const openPrBackpressureReducer = defineReducer<
  { engaged?: OpenPrBackpressureEngagement },
  RepositoryEvent,
  OpenPrBackpressureEngagement | undefined
>({
  identity: 'openPrBackpressure',
  initial: () => ({}),
  fold(acc, events) {
    for (const event of events) {
      if (event.type === 'dispatcher.open-pr-backpressure-engaged')
        acc.engaged = { ...event.payload, seq: event.seq, since: event.ts }
      if (event.type === 'dispatcher.open-pr-backpressure-cleared') delete acc.engaged
    }
  },
  finish: (acc) => (acc.engaged === undefined ? undefined : { ...acc.engaged }),
})
