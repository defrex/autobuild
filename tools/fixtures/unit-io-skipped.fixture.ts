// Deliberately offending file whose tests are all skipped, so no test hook
// runs: tools/unit-io-guard.integration.test.ts expects the guard to report
// this import-time read at exit and fail the run.
import { describe, test } from 'bun:test'
import { readFileSync } from 'node:fs'

try {
  readFileSync('package.json')
} catch {}

describe('skipped unit IO offender', () => {
  test.skip('never runs', () => undefined)
})
