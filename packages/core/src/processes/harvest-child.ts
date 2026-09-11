/**
 * Crash-safe repository-scoped harvest workflow: scan -> synthesize <-> review
 * -> file. It reuses `converge` for adversarial review semantics while every
 * durable boundary lives in the repository journal, so a replacement process
 * resumes the claimed snapshot rather than starting a duplicate run.
 */
import { join } from 'node:path'
import { loadConfig } from '../config/load'
import type { HarvestExecutionEnvironment } from '../ports/workspace/harvest-execution'
import type { HarvestRunnerLaunch } from '../ports/workspace/harvest-execution'
import { loadPlugins } from '../plugins/load'
import { materializePluginRuntimes } from '../plugins/runtimes'
import { randomIds, randomUuids } from '../ids'
import { createTicketSource } from '../ports/tickets/create'
import { createProductionRuntimes } from '../ports/runner/production'
import type { BuildStore } from '../store/types'
import { systemClock } from '../store/types'
import { openProductionStore, type StoreOpener } from '../cli/store-opening'
import { DEFAULT_MAX_HARVEST_RECOVERY_ATTEMPTS } from '../kernel/harvest'
import { HarvestRunner } from './harvest-runner'

export type { HarvestExecutionEnvironment }

/** Guest-side composition. The launch envelope supplies identity, lease
 * adoption, and environment provenance only; configuration comes from the
 * guest checkout and the hosted Store/ticket authority from the forwarded
 * environment — the same kernel class a local harvest runs, so filed
 * proposals, creation keys, and idempotency are byte-identical. */
export async function runHarvestChild(
  input: HarvestRunnerLaunch,
  env: Record<string, string | undefined> = process.env,
  openStore: StoreOpener = openProductionStore,
  /** Guest checkout root. The provider launches the runner with this as cwd. */
  workspacePath: string = process.cwd(),
): Promise<void> {
  const fullStore: BuildStore = openStore(input.storeRef, env.AB_TOKEN)
  try {
    const config = await loadConfig(join(workspacePath, 'autobuild.toml'))
    // Full build-child composition parity, in the same order: plugins load
    // first or materializePluginRuntimes silently no-ops and leaves any
    // plugin-provided runtime unrouted in the guest.
    const plugins = await loadPlugins(config.plugins, workspacePath, {
      packageRoot: input.repo,
    })
    const { runtimes: builtins } = createProductionRuntimes()
    const runtimes = await materializePluginRuntimes(builtins, plugins, {
      repoRoot: workspacePath,
      env,
    })
    const tickets = await createTicketSource(config.tickets, env, input.repo, undefined, plugins)

    const runner = new HarvestRunner({
      store: fullStore,
      tickets,
      config,
      runtimes,
      repo: input.repo,
      workspacePath,
      ids: randomIds(),
      uuids: randomUuids(),
      clock: systemClock,
      instance: input.instance,
      // Adopted holder: the guest skips its own claim, heartbeats the owning
      // dispatch loop's repository lease, and never releases it.
      ...(input.leaseHolder !== undefined ? { leaseHolder: input.leaseHolder } : {}),
      ...(input.environment !== undefined ? { environment: input.environment } : {}),
      sessionEnv: {
        AB_STORE: input.storeRef,
        ...(env.AB_TOKEN !== undefined && env.AB_TOKEN !== '' ? { AB_TOKEN: env.AB_TOKEN } : {}),
      },
      opts: {
        maxRecoveryAttempts: DEFAULT_MAX_HARVEST_RECOVERY_ATTEMPTS,
      },
    })
    await runner.run()
  } finally {
    try {
      await fullStore.close()
    } catch {
      // Process teardown cannot change the already-durable runner outcome.
    }
  }
}
