// Deliberately offending unit test. tools/unit-io-guard.integration.test.ts
// runs this file before unit-io-later-file.fixture.ts under the unit IO guard:
// the timer armed here fires while the later file runs, and the guard must
// name this file as the one that armed it. The name keeps it out of both
// suites' collection.
import { expect, test } from 'bun:test'

test('arms a timer and returns before it fires', () => {
  setTimeout(() => {
    ;(globalThis as Record<symbol, unknown>)[Symbol.for('ab.fixture.leakFired')] = true
  }, 100)
  expect(true).toBe(true)
})
