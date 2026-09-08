#!/usr/bin/env bun
/** Private shipped child used only inside a disposable readiness workspace. */
import { INIT_PROBE_MARKER, runGuestReadinessProbe } from '../packages/core/src/cli/init-validation'

try {
  const report = await runGuestReadinessProbe({ repo: process.cwd(), env: process.env })
  console.log(`${INIT_PROBE_MARKER}${JSON.stringify(report)}`)
  // A complete report is transport success even when one readiness check fails;
  // the host owns the user-facing nonzero status.
  process.exit(0)
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error)
  console.log(
    `${INIT_PROBE_MARKER}${JSON.stringify({ checks: [{ name: 'readiness probe', status: 'fail', detail }] })}`,
  )
  process.exit(1)
}
