import { expect, test } from 'bun:test'
import { DISPATCHER } from '../events/envelope'
import type { RepositoryEvent, RepositoryEventWrite } from '../events/repository'
import { handbackIdentity, ticketHandbacksReducer } from './ticket-handbacks'

const ticket = { source: 'fake', id: 'T-1' }
function event(write: RepositoryEventWrite, seq: number): RepositoryEvent {
  return { ...write, seq, repo: 'repo', ts: '2026-11-16T00:00:00.000Z' } as RepositoryEvent
}
function reported(build: string): RepositoryEventWrite {
  return {
    actor: DISPATCHER,
    type: 'ticket.handed-back',
    payload: { ticket, build, cause: 'abort', state: 'Ready', role: 'ready' },
  }
}
function settled(build: string): RepositoryEventWrite {
  return { actor: DISPATCHER, type: 'ticket.handback-settled', payload: { build } }
}

test('a reported build hand-back stays open until settled, and settlement is idempotent', () => {
  const events = [reported('a'), reported('b'), settled('a'), settled('a')].map((write, index) =>
    event(write, index + 1),
  )
  expect(ticketHandbacksReducer.reduce(events.slice(0, 2))).toEqual({
    [handbackIdentity('a')]: { seq: 1, ticket, cause: 'abort' },
    [handbackIdentity('b')]: { seq: 2, ticket, cause: 'abort' },
  })
  expect(ticketHandbacksReducer.reduce(events)).toEqual({
    [handbackIdentity('b')]: { seq: 2, ticket, cause: 'abort' },
  })
})

test('preparation reports are not build identities', () => {
  const write: RepositoryEventWrite = {
    actor: DISPATCHER,
    type: 'ticket.handed-back',
    payload: { ticket, attempt: 'prep', cause: 'spec-bounce', state: 'Triage', role: 'triage' },
  }
  expect(ticketHandbacksReducer.reduce([event(write, 1)])).toEqual({})
})

test('the incremental fold equals the whole fold and stays bounded by open hand-backs', () => {
  const writes: RepositoryEventWrite[] = []
  for (let index = 0; index < 50; index++) writes.push(reported(`b${index}`), settled(`b${index}`))
  writes.push(reported('open'))
  const events = writes.map((write, index) => event(write, index + 1))
  let acc = ticketHandbacksReducer.initial()
  for (let start = 0; start < events.length; start += 7)
    acc = ticketHandbacksReducer.advance(acc, events.slice(start, start + 7))
  const whole = ticketHandbacksReducer.reduce(events)
  expect(ticketHandbacksReducer.finish(acc)).toEqual(whole)
  expect(Object.keys(whole)).toEqual([handbackIdentity('open')])
})
