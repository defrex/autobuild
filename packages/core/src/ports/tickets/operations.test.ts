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

test('guarded blockers are one adapter call and legacy plugins cannot silently drop checks', async () => {
  const source = new FakeTicketSource()
  const target = await source.create({ title: 'Target', body: 'Body' })
  const one = await source.create({ title: 'One', body: 'Body' })
  const two = await source.create({ title: 'Two', body: 'Body' })
  const original = source.mutateIfRevision.bind(source)
  const calls: unknown[] = []
  source.mutateIfRevision = async (...args) => {
    calls.push(args)
    await original(...args)
  }
  await changeBlockers(source, target.ref.id, [one.ref.id, two.ref.id], 'block', target.revision)
  expect(calls).toHaveLength(1)
  expect(source.blockerAdds).toHaveLength(0)
  Object.defineProperty(source, 'mutateIfRevision', { value: undefined })
  const before = await source.get(target.ref.id)
  await expect(
    changeBlockers(source, target.ref.id, [one.ref.id], 'unblock', before!.revision),
  ).rejects.toThrow('does not support')
  await expect(
    updateTicket(source, target.ref.id, { title: 'Lost' }, false, before!.revision),
  ).rejects.toThrow('does not support')
  expect(await source.get(target.ref.id)).toEqual(before)
})
