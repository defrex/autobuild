#!/usr/bin/env bun
/** Repo-local Bun hot entry. This file is not exposed through package.json#bin. */
import { runBinary } from '../src/cli/binary'
import { evaluateDevCli, type DevCliState } from '../src/cli/dev'
import { renderDashboard } from '../src/cli/dashboard/render'

const STATE_KEY = Symbol.for('autobuild.cli.dashboard-dev')
const globals = globalThis as unknown as Record<symbol, DevCliState | undefined>
const state = (globals[STATE_KEY] ??= {})

// Do not top-level-await: Bun must be able to finish evaluating this module and
// evaluate it again when presentation sources change.
evaluateDevCli({
  state,
  renderer: renderDashboard,
  launch: (resolveDashboardRenderer) =>
    runBinary(process.argv.slice(2), resolveDashboardRenderer),
  settle: (run) => {
    void run.then(
      (code) => process.exit(code),
      (error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error))
        process.exit(1)
      },
    )
  },
})
