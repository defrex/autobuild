import { expect, test } from 'bun:test'
import { DISPATCHER, humanActor } from '../events/envelope'
import type { RepositoryEvent, RepositoryEventWrite } from '../events/repository'
import { TICKET_START_RECENT_LIMIT, ticketStartKey, ticketStartsReducer } from './ticket-starts'

const ticket = { source: 'fake', id: 'T-1' }
function event(write: RepositoryEventWrite, seq: number): RepositoryEvent {
  return {
    ...write,
    seq,
    repo: 'repo',
    ts: `2026-11-21T00:00:${String(seq % 60).padStart(2, '0')}.000Z`,
  } as RepositoryEvent
}
function requested(id = 'T-1'): RepositoryEventWrite {
  return {
    actor: humanActor('alice'),
    type: 'ticket.start-requested',
    payload: { ticket: { source: 'fake', id } },
  }
}
function settled(request: number, id = 'T-1'): RepositoryEventWrite {
  return {
    actor: DISPATCHER,
    type: 'ticket.start-settled',
    payload: { request, ticket: { source: 'fake', id }, outcome: 'blocked', detail: 'T-2' },
  }
}

test('the first request wins and a duplicate is ignored', () => {
  const value = ticketStartsReducer.reduce([event(requested(), 1), event(requested(), 2)])
  expect(value.pending).toEqual({
    [ticketStartKey(ticket)]: { seq: 1, ts: '2026-11-21T00:00:01.000Z', ticket, by: 'alice' },
  })
})

test('a stale settle or cancel never closes a newer request', () => {
  const cancel: RepositoryEventWrite = {
    actor: humanActor('bob'),
    type: 'ticket.start-cancelled',
    payload: { request: 1, ticket },
  }
  const events = [requested(), cancel, requested(), settled(1), cancel].map((write, index) =>
    event(write, index + 1),
  )
  const value = ticketStartsReducer.reduce(events)
  expect(value.pending[ticketStartKey(ticket)]?.seq).toBe(3)
  expect(value.recent).toEqual([
    { request: 1, ticket, outcome: 'cancelled', at: '2026-11-21T00:00:02.000Z', by: 'bob' },
  ])
  const closed = ticketStartsReducer.reduce([...events, event(settled(3), 6)])
  expect(closed.pending).toEqual({})
  expect(closed.recent.at(-1)).toEqual({
    request: 3,
    ticket,
    outcome: 'blocked',
    detail: 'T-2',
    at: '2026-11-21T00:00:06.000Z',
    by: 'alice',
  })
})

test('recent settlements are capped, newest last', () => {
  const writes: RepositoryEventWrite[] = []
  for (let index = 0; index < 20; index++) {
    writes.push(requested(`T-${index}`), settled(writes.length + 1, `T-${index}`))
  }
  const value = ticketStartsReducer.reduce(writes.map((write, index) => event(write, index + 1)))
  expect(value.recent).toHaveLength(TICKET_START_RECENT_LIMIT)
  expect(value.recent.at(-1)?.ticket.id).toBe('T-19')
  expect(value.pending).toEqual({})
})

test('identities are set by records and removed only through released', () => {
  const record = (
    identities: { build: string; recorded: string; canonical: string }[],
    released?: string[],
  ): RepositoryEventWrite => ({
    actor: DISPATCHER,
    type: 'ticket.identity-recorded',
    payload: { identities, ...(released ? { released } : {}) },
  })
  const value = ticketStartsReducer.reduce(
    [
      record([
        { build: 'a', recorded: 'ticket-1', canonical: 'AB-1' },
        { build: 'b', recorded: 'AB-2', canonical: 'AB-2' },
      ]),
      record([{ build: 'c', recorded: 'ticket-3', canonical: 'AB-3' }], ['a']),
    ].map((write, index) => event(write, index + 1)),
  )
  expect(value.identities).toEqual({
    b: { recorded: 'AB-2', canonical: 'AB-2' },
    c: { recorded: 'ticket-3', canonical: 'AB-3' },
  })
})

test('the incremental fold equals the whole fold', () => {
  const writes: RepositoryEventWrite[] = []
  for (let index = 0; index < 30; index++) {
    writes.push(requested(`T-${index}`))
    if (index % 3 !== 0) writes.push(settled(writes.length, `T-${index}`))
  }
  const events = writes.map((write, index) => event(write, index + 1))
  let acc = ticketStartsReducer.initial()
  for (let start = 0; start < events.length; start += 7)
    acc = ticketStartsReducer.advance(acc, events.slice(start, start + 7))
  expect(ticketStartsReducer.finish(acc)).toEqual(ticketStartsReducer.reduce(events))
  expect(Object.keys(ticketStartsReducer.reduce(events).pending)).toHaveLength(10)
})
