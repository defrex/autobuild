import { expect, test } from 'bun:test'
import { EVENT_WAIT_POLL_MS } from './wait'

test('EVENT_WAIT_POLL_MS pins the one-second hosted poll interval', () => {
  expect(EVENT_WAIT_POLL_MS).toBe(1000)
})
