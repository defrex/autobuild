import { expect, test } from 'bun:test'
import { assertTargetingListing, assertTicketPage } from './contract'
import { FakeTicketSource } from './fake'

test('paging contract rejects a declared capability with an incorrect total or window', async () => {
  const source = Object.assign(new FakeTicketSource(), {
    async listPage() {
      return { tickets: [], diagnostics: [], total: 1 }
    },
  })
  await expect(
    assertTicketPage(source, {}, { limit: 1 }, { tickets: [], diagnostics: [] }),
  ).rejects.toThrow()
  const ticket = await source.create({ title: 'one', body: 'body' })
  source.listPage = async () => ({ tickets: [], diagnostics: [], total: 1 })
  await expect(
    assertTicketPage(source, {}, { limit: 1 }, { tickets: [ticket], diagnostics: [] }),
  ).rejects.toThrow()
})

test('targeted listing contract rejects a declared capability that drops a child', async () => {
  const source = new FakeTicketSource()
  const node = await source.create({ title: 'node', body: 'body', kind: 'node' })
  const child = await source.create({ title: 'child', body: 'body', target: node.ref.id })
  await source.create({ title: 'other child', body: 'body', target: node.ref.id })
  const targeting = Object.assign(source, {
    async listTargeting(nodeId: string) {
      const all = await source.listAll()
      return {
        diagnostics: [],
        tickets: all.tickets.filter(
          (ticket) => ticket.target === nodeId && ticket.ref.id !== child.ref.id,
        ),
      }
    },
  })
  await expect(assertTargetingListing(targeting, node.ref.id)).rejects.toThrow()
})
