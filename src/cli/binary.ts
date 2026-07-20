/**
 * Shared wiring for the `ab` process entry points. Production calls this with
 * argv only; the repo-local hot entry may additionally supply a per-paint
 * dashboard renderer resolver. All command routing and resource cleanup stay
 * identical between the two entries.
 */
import { join } from 'node:path'
import { isSessionlessInvocation, runCli } from './main'
import { createUpgradeAgentResolver } from './upgrade-agent'
import { loadDotEnv } from './dotenv'
import {
  MissingAmbientContextError,
  resolveCliEnv,
  resolveHarvestCliEnv,
} from './env'
import { openProductionStore } from './store-opening'
import { processTerminal, processTerminalInput } from './terminal'
import type { DashboardRendererResolver } from './dashboard/render'
import { GitHubForge } from '../ports/forge/github'
import { spawnExec } from '../ports/workspace/git-worktree'
import { randomIds } from '../ids'
import { systemClock } from '../store/types'

export async function runBinary(
  argv: string[],
  resolveDashboardRenderer?: DashboardRendererResolver,
): Promise<number> {
  // Local .env supplies developer-set secrets (e.g. LINEAR_API_KEY); real
  // environment variables always win over .env values.
  loadDotEnv(join(process.cwd(), '.env'), process.env)

  const command = argv[0]
  const unscopedDeps = {
    workspacePath: process.cwd(),
    processEnv: process.env,
    exec: spawnExec,
    stdout: (line: string) => console.log(line),
    stderr: (line: string) => console.error(line),
  }

  // Sessionless commands resolve their own repository/store and do not require
  // a phase tuple; durable controls also take a target slug and inspect raw
  // AB_SESSION/AB_BUILD only to reject self-control. The flat-name set and
  // mixed nested-command classifier live beside the switch in main.ts.
  if (isSessionlessInvocation(argv)) {
    // The dispatch watch loop runs until SIGINT; abort the signal so it exits
    // cleanly at the next tick boundary (§15.6-C: in-flight leases expire and
    // a future dispatch re-attaches).
    const controller = new AbortController()
    const onSigint = (): void => controller.abort()
    process.once('SIGINT', onSigint)
    try {
      return await runCli(argv, {
        ...unscopedDeps,
        signal: controller.signal,
        // `ab dispatch`'s dashboard seam: interactive iff stdout is a real
        // TTY, so a pipe or redirect silently gets plain output.
        terminal: processTerminal(process.stdout),
        input: processTerminalInput(process.stdin),
        upgradeResolverFactory: createUpgradeAgentResolver,
        ...(resolveDashboardRenderer !== undefined
          ? { resolveDashboardRenderer }
          : {}),
      })
    } finally {
      process.removeListener('SIGINT', onSigint)
    }
  }

  if (command === 'harvest') {
    let harvestEnv
    try {
      harvestEnv = resolveHarvestCliEnv(process.env)
    } catch (error) {
      if (error instanceof MissingAmbientContextError) {
        return runCli(argv, unscopedDeps)
      }
      console.error(error instanceof Error ? error.message : String(error))
      return 1
    }
    const store = openProductionStore(harvestEnv.store, harvestEnv.token)
    try {
      return await runCli(argv, {
        ...unscopedDeps,
        store,
        harvestEnv,
        ids: randomIds(),
        clock: systemClock,
      })
    } finally {
      await store.close()
    }
  }

  let cliEnv
  try {
    cliEnv = resolveCliEnv(process.env)
  } catch (error) {
    if (error instanceof MissingAmbientContextError) {
      return runCli(argv, unscopedDeps)
    }
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }

  const store = openProductionStore(cliEnv.store, cliEnv.token)

  try {
    return await runCli(argv, {
      ...unscopedDeps,
      store,
      env: cliEnv,
      forge: new GitHubForge(),
      ids: randomIds(),
      clock: systemClock,
    })
  } finally {
    await store.close()
  }
}
