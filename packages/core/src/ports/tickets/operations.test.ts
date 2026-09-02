import { describe, expect, test } from 'bun:test'
import { parseConfig } from '../../config/load'
import { FakeTicketSource } from './fake'
import { changeBlockers, createTicket, ticketListCriteria, updateTicket } from './operations'

const config = parseConfig(`
[tickets]
source = "file"
readyState = "Ready"
readyLabels = ["autobuild", "groomed"]
[verify]
steps = []
[finalize]
steps = []
`)

describe('shared ticket operations', () => {
  test('uses ready criteria only when filters are wholly absent', () => {
    expect(ticketListCriteria(config, {})).toEqual({
      state: 'Ready',
      labels: ['autobuild', 'groomed'],
    })
    expect(ticketListCriteria(config, { labels: [] })).toEqual({ labels: [] })
  })

  test('preflights and deduplicates blockers before create', async () => {
    const source = new FakeTicketSource()
    await expect(
      createTicket(source, { title: 'x', body: 'body', blockedBy: ['missing'] }),
    ).rejects.toThrow('missing')
    expect(await source.listReady({})).toMatchObject({ tickets: [] })
    const blocker = await createTicket(source, { title: 'blocker', body: 'body' })
    const created = await createTicket(source, {
      title: 'target',
      body: 'body',
      blockedBy: [blocker.ref.id, blocker.ref.id],
    })
    expect(created.blockedBy).toEqual([blocker.ref.id])
  })

  test('preserves body bytes and blocker retry semantics', async () => {
    const source = new FakeTicketSource()
    const blocker = await createTicket(source, { title: 'blocker', body: 'body' })
    const target = await createTicket(source, { title: 'target', body: 'old' })
    const body = 'a\r\nb  \nno-newline'
    expect((await updateTicket(source, target.ref.id, { body }))?.body).toBe(body)
    await changeBlockers(source, target.ref.id, [blocker.ref.id, blocker.ref.id], 'block')
    expect((await source.get(target.ref.id))?.blockedBy).toEqual([blocker.ref.id])
  })
})
