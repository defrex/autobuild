import { expect, test } from 'bun:test'
import { ticketPreparationReducer } from './ticket-preparation'
import type { RepositoryEvent, RepositoryEventWrite } from '../events/repository'
import { DISPATCHER } from '../events/envelope'

const ticket = { source: 'fake', id: 'T-1' }
function event(write: RepositoryEventWrite, seq: number): RepositoryEvent {
  return { ...write, seq, repo: 'repo', ts: '2026-10-28T00:00:00.000Z' } as RepositoryEvent
}
test('intent is not evidence of a claim; incremental recovery retains both failures and prunes terminal work', () => {
  const writes: RepositoryEventWrite[] = [
    {
      actor: DISPATCHER,
      type: 'ticket-preparation.intended',
      payload: { attempt: 'prep', ticket, readyState: 'Ready', claimedState: 'Doing' },
    },
    { actor: DISPATCHER, type: 'ticket-preparation.claimed', payload: { attempt: 'prep', ticket } },
    {
      actor: DISPATCHER,
      type: 'ticket-preparation.creation-selected',
      payload: { attempt: 'prep', ticket, slug: 'build' },
    },
    {
      actor: DISPATCHER,
      type: 'ticket-preparation.failed',
      payload: {
        attempt: 'prep',
        ticket,
        stage: 'create-build',
        claimed: true,
        handback: 'Ready',
        error: 'creation offline',
      },
    },
    {
      actor: DISPATCHER,
      type: 'ticket-preparation.recovery-failed',
      payload: {
        attempt: 'prep',
        ticket,
        error: 'readback offline',
        retryAt: '2026-10-28T00:00:30.000Z',
      },
    },
  ]
  const events = writes.map((write, index) => event(write, index + 1))
  expect(ticketPreparationReducer.reduce(events.slice(0, 1)).prep?.claimed).toBe(false)
  let acc = ticketPreparationReducer.initial()
  for (const fact of events) acc = ticketPreparationReducer.advance(acc, [fact])
  expect(ticketPreparationReducer.finish(acc)).toEqual(ticketPreparationReducer.reduce(events))
  expect(acc.prep).toMatchObject({
    claimed: true,
    slug: 'build',
    error: 'creation offline',
    recoveryError: 'readback offline',
  })
  acc = ticketPreparationReducer.advance(acc, [
    event(
      {
        actor: DISPATCHER,
        type: 'ticket-preparation.resolved',
        payload: { attempt: 'prep', ticket, outcome: 'owned' },
      },
      6,
    ),
  ])
  expect(acc).toEqual({})
  expect(ticketPreparationReducer.advance(acc, [events[4]!])).toEqual({})
})
