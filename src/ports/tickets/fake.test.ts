import { describe, expect, test } from 'bun:test'
import type { Ticket } from '../types'
import { FakeTicketSource } from './fake'

function ticket(id: string, over: Partial<Omit<Ticket, 'ref'>> = {}): Ticket {
  return {
    ref: { source: 'fake', id },
    title: over.title ?? `Ticket ${id}`,
    body: over.body ?? `Body of ${id}`,
    state: over.state ?? 'Ready',
    labels: over.labels ?? [],
  }
}

describe('FakeTicketSource', () => {
  test('claim returns true exactly once per ticket (§12 claim-before-launch)', async () => {
    const source = new FakeTicketSource([ticket('t-1'), ticket('t-2')])

    expect(await source.claim('t-1')).toBe(true)
    expect(await source.claim('t-1')).toBe(false)
    expect(await source.claim('t-2')).toBe(true)
  })

  test('claim returns false for unknown ids', async () => {
    const source = new FakeTicketSource([ticket('t-1')])
    expect(await source.claim('nope')).toBe(false)
  })

  test('listReady requires every requested label to be present', async () => {
    const source = new FakeTicketSource([
      ticket('t-1', { labels: ['autobuild', 'bug'] }),
      ticket('t-2', { labels: ['autobuild'] }),
      ticket('t-3', { labels: ['bug'] }),
    ])

    const ready = await source.listReady({ labels: ['autobuild', 'bug'] })
    expect(ready.map((t) => t.ref.id)).toEqual(['t-1'])
  })

  test('listReady filters by state', async () => {
    const source = new FakeTicketSource([
      ticket('t-1', { state: 'Ready' }),
      ticket('t-2', { state: 'Triage' }),
    ])

    const ready = await source.listReady({ state: 'Ready' })
    expect(ready.map((t) => t.ref.id)).toEqual(['t-1'])
  })

  test('listReady combines label and state criteria; empty criteria match all', async () => {
    const source = new FakeTicketSource([
      ticket('t-1', { state: 'Ready', labels: ['autobuild'] }),
      ticket('t-2', { state: 'Triage', labels: ['autobuild'] }),
      ticket('t-3', { state: 'Ready', labels: [] }),
    ])

    const ready = await source.listReady({ state: 'Ready', labels: ['autobuild'] })
    expect(ready.map((t) => t.ref.id)).toEqual(['t-1'])
    expect((await source.listReady({})).length).toBe(3)
  })

  test('journals record every comment and transition, in order', async () => {
    const source = new FakeTicketSource([ticket('t-1'), ticket('t-2')])

    await source.comment('t-1', 'spec imported')
    await source.transition('t-1', 'In Progress')
    await source.comment('t-2', 'bounced: spec below standard')
    await source.transition('t-2', 'Triage')

    expect(source.comments).toEqual([
      { id: 't-1', body: 'spec imported' },
      { id: 't-2', body: 'bounced: spec below standard' },
    ])
    expect(source.transitions).toEqual([
      { id: 't-1', state: 'In Progress' },
      { id: 't-2', state: 'Triage' },
    ])
  })

  test('transition updates the state that get and listReady see', async () => {
    const source = new FakeTicketSource([ticket('t-1', { state: 'Triage' })])

    await source.transition('t-1', 'Ready')

    expect((await source.get('t-1'))?.state).toBe('Ready')
    expect(await source.listReady({ state: 'Ready' })).toHaveLength(1)
  })

  test('comment and transition throw on unknown tickets', async () => {
    const source = new FakeTicketSource()
    await expect(source.comment('nope', 'hi')).rejects.toThrow('nope')
    await expect(source.transition('nope', 'Ready')).rejects.toThrow('nope')
  })

  test('create assigns ids fake-1, fake-2, … and stores the ticket', async () => {
    const source = new FakeTicketSource()

    const first = await source.create({ title: 'A', body: 'a-body' })
    const second = await source.create({ title: 'B', body: 'b-body', labels: ['autobuild'] })

    expect(first.ref).toEqual({ source: 'fake', id: 'fake-1', title: 'A' })
    expect(second.ref.id).toBe('fake-2')
    expect(second.labels).toEqual(['autobuild'])
    expect((await source.get('fake-1'))?.body).toBe('a-body')
  })

  test('created tickets land in Triage by default (§12: humans groom to Ready)', async () => {
    const source = new FakeTicketSource()
    const created = await source.create({ title: 'A', body: 'b' })

    expect(created.state).toBe('Triage')
    expect(await source.listReady({ state: 'Ready' })).toHaveLength(0)
  })

  test('get returns a copy — mutating the result does not corrupt the source', async () => {
    const source = new FakeTicketSource([ticket('t-1', { labels: ['a'] })])

    const got = await source.get('t-1')
    got?.labels.push('b')

    expect((await source.get('t-1'))?.labels).toEqual(['a'])
  })

  test('get returns null for unknown ids', async () => {
    const source = new FakeTicketSource()
    expect(await source.get('nope')).toBeNull()
  })
})
