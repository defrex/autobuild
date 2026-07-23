import type { PluginFactoryContext } from './manifest'
import type { PluginRegistry } from './registry'
import {
  validateRuntimeRegistration,
  type RuntimeRegistry,
} from '../ports/runner/runtime'

export interface MaterializePluginRuntimesOpts {
  repoRoot: string
  env: Readonly<Record<string, string | undefined>>
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Materialize plugin runtime factories into a fresh registry. Factories run in
 * plugin registration order and receive the same repository-scoped context as
 * the other adapter selectors. The caller's registry is never mutated, and a
 * failure never exposes a partially assembled registry.
 */
export async function materializePluginRuntimes(
  builtins: RuntimeRegistry,
  plugins: PluginRegistry,
  opts: MaterializePluginRuntimesOpts,
): Promise<RuntimeRegistry> {
  const pluginEntries = [...plugins.agentRuntimes.entries()].filter(
    (entry) => entry[1].owner.kind === 'plugin',
  )

  // The normal PluginRegistry reserves shipped names. Keep this independent
  // preflight for injected/test registries and future composition callers.
  for (const [name, registration] of pluginEntries) {
    if (Object.hasOwn(builtins, name)) {
      throw new Error(
        `agent runtime "${name}" from plugin "${registration.owner.name}" ` +
          'collides with an existing runtime registration',
      )
    }
  }

  const merged = Object.assign(
    Object.create(null) as RuntimeRegistry,
    builtins,
  )
  const config = Object.freeze({})
  const env = Object.freeze({ ...opts.env })
  const context: PluginFactoryContext = {
    config,
    env,
    repoRoot: opts.repoRoot,
  }

  for (const [name, adapter] of pluginEntries) {
    const owner = adapter.owner
    if (owner.kind !== 'plugin' || adapter.factory === undefined) continue

    let value: unknown
    try {
      value = await adapter.factory(context)
    } catch (error) {
      throw new Error(
        `agent runtime "${name}" factory from plugin "${owner.name}" failed: ` +
          reason(error),
        { cause: error },
      )
    }

    try {
      merged[name] = validateRuntimeRegistration(value)
    } catch (error) {
      throw new Error(
        `agent runtime "${name}" from plugin "${owner.name}" returned an ` +
          `invalid runtime registration: ${reason(error)}`,
        { cause: error },
      )
    }
  }

  return merged
}
