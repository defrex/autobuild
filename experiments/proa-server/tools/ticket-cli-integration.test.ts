import { expect, test } from 'bun:test'
import { normalizeTicketCliOutput } from './ticket-cli-integration'

test('CLI parity normalization preserves revisions, errors and body bytes', () => {
  expect(
    normalizeTicketCliOutput(
      {
        revision: '42',
        body: '\nBytes  \n',
        error: 'stale revision',
        createdAt: 'one',
        path: '/tmp/checkout/file',
      },
      [['/tmp/checkout', '<checkout>']],
    ),
  ).toEqual({
    revision: '42',
    body: '\nBytes  \n',
    error: 'stale revision',
    createdAt: '<timestamp>',
    path: '<checkout>/file',
  })
})
