import type { RepositoryEvent, RepositoryEventPayload } from '../events/repository'
import { defineReducer } from './incremental'
export type ForgeDegradation = RepositoryEventPayload<'dispatcher.forge-degraded'>
export const forgeHealthReducer = defineReducer<
  { active?: ForgeDegradation },
  RepositoryEvent,
  ForgeDegradation | undefined
>({
  version: 1,
  initial: () => ({}),
  fold(acc, events) {
    for (const event of events) {
      if (event.type === 'dispatcher.forge-degraded') acc.active = event.payload
      if (event.type === 'dispatcher.forge-recovered' && acc.active?.forge === event.payload.forge)
        delete acc.active
    }
  },
  finish: (acc) => acc.active,
})
