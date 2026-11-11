import { expect, test } from 'bun:test'
import { assertTargetingListing, assertTicketPage } from './contract'
import { FakeTicketSource } from './fake'
import { urgentFirst } from './priority'

test('paging contract rejects a declared capability with an incorrect total or window', async () => {
  const source = Object.assign(new FakeTicketSource(), {
    async listPage() {
      return { tickets: [], diagnostics: [], total: 1 }
    },
  })
  await expect(
    assertTicketPage(source, {}, { limit: 1 }, { tickets: [], diagnostics: [] }, []),
  ).rejects.toThrow()
  const ticket = await source.create({ title: 'one', body: 'body' })
  source.listPage = async () => ({ tickets: [], diagnostics: [], total: 1 })
  await expect(
    assertTicketPage(source, {}, { limit: 1 }, { tickets: [ticket], diagnostics: [] }, [
      ticket.ref.id,
    ]),
  ).rejects.toThrow()
})

test('paging contract orders newest filed first, not reversed dispatch order', async () => {
  const source = new FakeTicketSource()
  const n1 = await source.create({ title: 'n1', body: 'body' })
  const u2 = await source.create({ title: 'u2', body: 'body', priority: 'urgent' })
  const n3 = await source.create({ title: 'n3', body: 'body' })
  const filed = [n1, u2, n3].map((ticket) => ticket.ref.id)
  const full = await source.listReady({})
  const native = (newest: (tickets: typeof full.tickets) => typeof full.tickets) =>
    Object.assign(source, {
      async listPage(_criteria: unknown, page: { limit: number; order?: string }) {
        const tickets = page.order === 'newest' ? newest(full.tickets) : urgentFirst(full.tickets)
        return { tickets: tickets.slice(0, page.limit), diagnostics: [], total: tickets.length }
      },
    })
  const reversedDispatch = native((tickets) => urgentFirst(tickets).reverse())
  await expect(
    assertTicketPage(reversedDispatch, {}, { limit: 3, order: 'newest' }, full, filed),
  ).rejects.toThrow()
  const newestFiled = native((tickets) => [...tickets].reverse())
  await assertTicketPage(newestFiled, {}, { limit: 3, order: 'newest' }, full, filed)
  await assertTicketPage(newestFiled, {}, { limit: 3 }, full, filed)
  const unsorted = Object.assign(source, {
    async listPage(_criteria: unknown, page: { limit: number }) {
      return { tickets: full.tickets.slice(0, page.limit), diagnostics: [], total: 3 }
    },
  })
  await expect(assertTicketPage(unsorted, {}, { limit: 3 }, full, filed)).rejects.toThrow()
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
