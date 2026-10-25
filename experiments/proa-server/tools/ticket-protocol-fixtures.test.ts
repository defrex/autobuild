import { expect, test } from 'bun:test'
import { checkTicketProtocolContract, ticketProtocolContract } from './ticket-protocol-fixtures'

test('ticket request oracle is source fresh', async () => {
  await checkTicketProtocolContract()
})

test('every classified operation has a valid seed and rejects unknown envelope fields', () => {
  const contract = ticketProtocolContract()
  for (const operation of contract.operations) {
    const cases = contract.cases.filter((item) => item.operation === operation)
    expect(cases.find((item) => item.name === 'valid')).toHaveProperty('output')
    expect(cases.find((item) => item.name === 'unknown-envelope')).toHaveProperty('issues')
    expect(cases.find((item) => item.name === 'unknown-context')).toHaveProperty('issues')
    expect(cases.find((item) => item.name === 'unknown-input')).toHaveProperty('issues')
  }
})
