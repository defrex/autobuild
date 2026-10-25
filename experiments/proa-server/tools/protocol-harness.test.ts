import { expect, test } from 'bun:test'
import { withProtocolDatabase } from './protocol-harness'

test('protocol database helper refuses non-loopback administrative targets', async () => {
  await expect(
    withProtocolDatabase('postgres://remote.example/postgres', {}, async () => {}),
  ).rejects.toThrow('must be loopback')
})
