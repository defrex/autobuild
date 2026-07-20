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
import { resolveCliEnv, resolveHarvestCliEnv } from './env'
import { resolveStore } from './store-ref'
import { processTerminal, processTerminalInput } from './terminal'
import type { DashboardRendererResolver } from './dashboard/render'
import { RemoteBuildStore } from '../store/remote/client'
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
        workspacePath: process.cwd(),
        exec: spawnExec,
        processEnv: process.env,
        signal: controller.signal,
        // `ab dispatch`'s dashboard seam: interactive iff stdout is a real
        // TTY, so a pipe or redirect silently gets plain output.
        terminal: processTerminal(process.stdout),
        input: processTerminalInput(process.stdin),
        upgradeResolverFactory: createUpgradeAgentResolver,
        ...(resolveDashboardRenderer !== undefined
          ? { resolveDashboardRenderer }
          : {}),
        stdout: (line) => console.log(line),
        stderr: (line) => console.error(line),
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
      console.error(error instanceof Error ? error.message : String(error))
      return 1
    }
    const store = resolveStore(harvestEnv.store, {
      token: harvestEnv.token,
      remoteFactory: (url, token) => new RemoteBuildStore({ url, token }),
    })
    try {
      return await runCli(argv, {
        store,
        harvestEnv,
        workspacePath: process.cwd(),
        exec: spawnExec,
        ids: randomIds(),
        clock: systemClock,
        stdout: (line) => console.log(line),
        stderr: (line) => console.error(line),
      })
    } finally {
      await store.close()
    }
  }

  let cliEnv
  try {
    cliEnv = resolveCliEnv(process.env)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }

  const store = resolveStore(cliEnv.store, {
    token: cliEnv.token,
    remoteFactory: (url, token) => new RemoteBuildStore({ url, token }),
  })

  try {
    return await runCli(argv, {
      store,
      env: cliEnv,
      workspacePath: process.cwd(),
      forge: new GitHubForge(),
      exec: spawnExec,
      ids: randomIds(),
      clock: systemClock,
      stdout: (line) => console.log(line),
      stderr: (line) => console.error(line),
    })
  } finally {
    await store.close()
  }
}
