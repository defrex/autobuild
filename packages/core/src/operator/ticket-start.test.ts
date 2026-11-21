import { expect, test } from 'bun:test'
import { FakeTicketSource } from '../ports/tickets/fake'
import type { Ticket, TicketSource } from '../ports/types'
import { MemoryBuildStore } from '../store/memory'
import { readRepositoryFacts } from '../store/reduced-reads'
import { manualClock } from '../testing/fixed'
import { cancelTicketStart, requestTicketStart } from './ticket-start'

const REPO = '/start/repo'

function ticket(id: string, source = 'fake'): Ticket {
  return {
    revision: 'r',
    ref: { source, id },
    title: id,
    body: 'body',
    state: 'Ready',
    resolved: false,
    labels: [],
  }
}

async function world(source: TicketSource = new FakeTicketSource([ticket('T-1')])) {
  const store = new MemoryBuildStore({ clock: manualClock() })
  const control = (id: string) => ({ store, repo: REPO, source, id, user: 'alice' })
  const events = async () => (await store.getRepo(REPO)) && store.getRepoEvents(REPO)
  return { store, control, events }
}

test('a request records the canonical ref once and a repeat writes nothing', async () => {
  const w = await world()
  const first = await requestTicketStart(w.control('T-1'))
  expect(first).toMatchObject({ status: 'pending', existing: false, ticket: { id: 'T-1' } })
  expect(first.event?.actor).toEqual({ kind: 'human', user: 'alice' })
  const second = await requestTicketStart(w.control('T-1'))
  expect(second).toMatchObject({ existing: true, request: first.request })
  expect(second.event).toBeUndefined()
  expect((await w.events())?.map((event) => event.type)).toEqual(['ticket.start-requested'])
  const facts = (await readRepositoryFacts(w.store, REPO)).value
  expect(Object.keys(facts.ticketStarts.pending)).toEqual(['fake:T-1'])
})

test('a missing ticket is refused with no write', async () => {
  const w = await world()
  await expect(requestTicketStart(w.control('T-404'))).rejects.toThrow('no ticket "T-404"')
  expect(await w.events()).toBeFalsy()
})

test('a source that canonicalizes ids records the canonical id', async () => {
  const fake = new FakeTicketSource([ticket('123', 'github')])
  const source = new Proxy(fake, {
    get(target, key) {
      if (key === 'name') return 'github'
      if (key === 'get') return (id: string) => target.get(id.replace(/^#/, ''))
      return Reflect.get(target, key, target)
    },
  }) as unknown as TicketSource
  const w = await world(source)
  const result = await requestTicketStart(w.control('#123'))
  expect(result.ticket).toEqual({ source: 'github', id: '123' })
  expect(await requestTicketStart(w.control('123'))).toMatchObject({ existing: true })
})

test('hosted database refs are keyed in the hosted namespace', async () => {
  const fake = new FakeTicketSource([ticket('AB-1', 'database')])
  const source = new Proxy(fake, {
    get: (target, key) => (key === 'name' ? 'database' : Reflect.get(target, key, target)),
  }) as unknown as TicketSource
  const w = await world(source)
  expect((await requestTicketStart(w.control('AB-1'))).ticket.source).toBe('hosted')
  expect(await cancelTicketStart(w.control('AB-1'))).toMatchObject({ cancelled: true })
})

test('cancel writes only for a pending request', async () => {
  const w = await world()
  expect(await cancelTicketStart(w.control('T-1'))).toEqual({ cancelled: false, id: 'T-1' })
  expect(await w.store.getRepoEvents(REPO)).toEqual([])
  const requested = await requestTicketStart(w.control('T-1'))
  const cancelled = await cancelTicketStart(w.control('T-1'))
  expect(cancelled).toMatchObject({ cancelled: true, request: requested.request })
  expect(await cancelTicketStart(w.control('T-1'))).toMatchObject({ cancelled: false })
  const facts = (await readRepositoryFacts(w.store, REPO)).value
  expect(facts.ticketStarts.pending).toEqual({})
  expect(facts.ticketStarts.recent).toMatchObject([{ outcome: 'cancelled', by: 'alice' }])
})
