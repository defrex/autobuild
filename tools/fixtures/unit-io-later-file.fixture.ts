// Deliberately blamed unit test. tools/unit-io-guard.integration.test.ts runs
// this file after unit-io-armed-leak.fixture.ts under the unit IO guard; the
// earlier file's leaked timer fires during this test, which the guard fails
// while naming the earlier file. The name keeps it out of both suites'
// collection.
import { test } from 'bun:test'

test('runs while an earlier file leaks a timer', async () => {
  const deadline = Date.now() + 5_000
  while (!(globalThis as Record<symbol, unknown>)[Symbol.for('ab.fixture.leakFired')]) {
    if (Date.now() > deadline) throw new Error('the leaked timer never fired')
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
})
