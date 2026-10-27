import { expect, test } from 'bun:test'
import { assertTicketPage } from './contract'
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
