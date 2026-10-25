import { expect, test } from 'bun:test'
import { checkTicketHttpContract, ticketHttpContract } from './ticket-http-fixtures'

test('ticket HTTP oracle retains source freshness and exact service responses', async () => {
  await checkTicketHttpContract()
})
test('version refusal happens before TicketSource construction', async () => {
  const corpus = await ticketHttpContract()
  const cases = corpus.cases as { supported: boolean; status: number; sourceCalls: number }[]
  expect(cases.some((item) => item.supported && item.status === 200)).toBe(true)
  const refused = cases.filter((item) => !item.supported)
  expect(refused.length).toBeGreaterThan(0)
  expect(refused.every((item) => item.status === 409 && item.sourceCalls === 0)).toBe(true)
})
