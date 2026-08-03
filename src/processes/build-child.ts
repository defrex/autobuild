import { hostname } from 'node:os'
import { createForge } from '../ports/forge/create'
import { createProductionRuntimes } from '../ports/runner/production'
import { spawnExec } from '../ports/workspace/git-worktree'
import { loadPlugins } from '../plugins/load'
import { materializePluginRuntimes } from '../plugins/runtimes'
import { randomIds } from '../ids'
import { systemClock } from '../store/types'
import { openProductionStore } from '../cli/store-opening'
import { BuildRunner, LeaseHeldError, SetupFailureError } from './build-runner'
import {
  BUILD_EFFECTIVE_CONFIG_ARTIFACT,
  diagnosticArtifact,
  parseEffectiveBuildConfig,
  selectOpenWorkspace,
  type BuildRunnerDiagnosticOutcome,
} from './build-execution-state'
import type { BuildExecutionStart } from '../ports/workspace/build-execution'

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Child-side composition. The launch envelope supplies identity only; all
 * execution location/configuration is discovered through the scoped Store. */
export async function runBuildChild(
  input: BuildExecutionStart,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const fullStore = openProductionStore(input.storeRef, env.AB_TOKEN)
  const store = fullStore.scopeBuild(input.slug)
  try {
    const record = await store.getBuild(input.slug)
    if (record === null) throw new Error(`unknown build ${JSON.stringify(input.slug)}`)
    const workspace = selectOpenWorkspace(await store.getEvents(input.slug))
    if (workspace === null) {
      throw new Error(`build ${JSON.stringify(input.slug)} has no open durable workspace`)
    }
    const configArtifact = await store.getArtifact(input.slug, BUILD_EFFECTIVE_CONFIG_ARTIFACT)
    if (configArtifact === null) {
      throw new Error(`build ${JSON.stringify(input.slug)} has no effective config artifact`)
    }
    let currentConfig = parseEffectiveBuildConfig(configArtifact)
    const plugins = await loadPlugins(currentConfig.plugins, workspace.path, {
      packageRoot: record.repo,
    })
    const { runtimes: builtins } = createProductionRuntimes()
    const runtimes = await materializePluginRuntimes(builtins, plugins, {
      repoRoot: workspace.path,
      env,
    })
    const forge = await createForge({
      name: currentConfig.forge,
      registry: plugins,
      env,
      repoRoot: workspace.path,
    })
    const getConfig = async () => {
      const latest = await store.getArtifact(input.slug, BUILD_EFFECTIVE_CONFIG_ARTIFACT)
      if (latest === null) return currentConfig
      try {
        currentConfig = parseEffectiveBuildConfig(latest)
      } catch {
        // The dispatcher publishes only validated snapshots. If storage is
        // externally corrupted, preserve the child's last valid boundary.
      }
      return currentConfig
    }

    const runner = new BuildRunner({
      store,
      config: currentConfig,
      getConfig,
      runtimes,
      workspacePath: workspace.path,
      branch: workspace.branch,
      slug: input.slug,
      exec: spawnExec,
      forge,
      ids: randomIds(),
      clock: systemClock,
      instance: input.instance,
      host: hostname(),
      sessionEnv: {
        AB_STORE: input.storeRef,
        ...(env.AB_TOKEN !== undefined && env.AB_TOKEN !== '' ? { AB_TOKEN: env.AB_TOKEN } : {}),
      },
    })
    await runner.run()
  } catch (error) {
    let outcome: BuildRunnerDiagnosticOutcome = 'failed'
    if (error instanceof LeaseHeldError) outcome = 'lease-held'
    else if (error instanceof SetupFailureError) outcome = 'setup-failed'
    try {
      await store.putArtifact(
        input.slug,
        diagnosticArtifact({ instance: input.instance, outcome, error: message(error) }),
      )
    } catch {
      // Store reachability failures cannot be diagnosed through that Store.
    }
    throw error
  } finally {
    await fullStore.close()
  }
}
