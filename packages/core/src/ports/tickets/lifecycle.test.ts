import { expect, test } from 'bun:test'
import { ticketsSchema } from '../../config/schema'
import { ticketLifecycle } from './lifecycle'

test('hosted normalizes ready and defaults all lifecycle roles without rewriting spelling', () => {
  const tickets = ticketsSchema.parse({ source: 'hosted', teamKey: 'ENG' })
  expect(ticketLifecycle(tickets)).toEqual({
    triage: 'triage',
    ready: 'ready',
    doing: 'doing',
    done: 'done',
    create: 'triage',
    proposal: 'triage',
  })
  expect(
    ticketLifecycle({
      ...tickets,
      triageState: 'Inbox',
      claimedState: 'Active',
      doneState: 'Shipped',
    }),
  ).toEqual({
    triage: 'Inbox',
    ready: 'ready',
    doing: 'Active',
    done: 'Shipped',
    create: 'Inbox',
    proposal: 'Inbox',
  })
  expect(ticketLifecycle(tickets, true)).toEqual({
    triage: 'Backlog',
    ready: 'ready',
    doing: 'Doing',
    done: 'Done',
    create: 'Backlog',
    proposal: 'Backlog',
  })
  expect(() => ticketsSchema.parse({ source: 'file' })).toThrow('readyState')
  expect(() => ticketsSchema.parse({ source: 'linear', teamKey: 'ENG' })).toThrow('readyState')
})

test('ticket URL validation is hosted specific and uses the service URL rules', () => {
  expect(ticketsSchema.parse({ source: 'hosted', url: 'https://SERVICE.test/base/' }).url).toBe(
    'https://service.test/base',
  )
  for (const url of [
    'http://service.test',
    'https://user:pass@service.test',
    'https://service.test/?secret=x',
    'https://service.test/#x',
  ])
    expect(() => ticketsSchema.parse({ source: 'hosted', url })).toThrow('tickets.url')
  expect(() =>
    ticketsSchema.parse({ source: 'file', readyState: 'ready', url: 'https://service.test' }),
  ).toThrow('hosted')
})
