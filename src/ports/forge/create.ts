import { resolve } from 'node:path'
import type { PluginFactoryContext } from '../../plugins/manifest'
import type {
  AdapterRegistration,
  PluginRegistry,
} from '../../plugins/registry'
import type { Forge } from '../types'
import { GitHubForge } from './github'

const EMPTY_CONFIG: Readonly<Record<string, unknown>> = Object.freeze({})

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Resolve a forge selector without constructing the adapter. Composition
 * boundaries use this before opening stores or invoking injectable wiring. */
export function resolveForgeRegistration(
  name: string,
  registry: PluginRegistry,
): AdapterRegistration<(context: PluginFactoryContext) => Forge | Promise<Forge>> {
  const registration = registry.forges.get(name)
  if (registration !== undefined) return registration

  const available = [...registry.forges.keys()].sort()
  throw new Error(
    `unknown forge adapter ${JSON.stringify(name)}; available forges: ${available.join(', ')}`,
  )
}

/** Construct the configured Forge lazily from the validated startup catalog.
 * The selected object is returned by identity so optional capabilities such as
 * `prAttachments` remain authoritative. */
export async function createForge(opts: {
  name: string
  registry: PluginRegistry
  env: Readonly<Record<string, string | undefined>>
  repoRoot: string
}): Promise<Forge> {
  const registration = resolveForgeRegistration(opts.name, opts.registry)
  if (registration.owner.kind === 'builtin') {
    // The registry reserves every builtin name. GitHub is the only shipped
    // forge in this release, so reaching another builtin would be host drift.
    if (opts.name === 'github') return new GitHubForge()
    throw new Error(`builtin forge adapter ${JSON.stringify(opts.name)} has no constructor`)
  }

  if (registration.factory === undefined) {
    throw new Error(
      `forge adapter ${JSON.stringify(opts.name)} from plugin ` +
        `${JSON.stringify(registration.owner.name)} has no factory`,
    )
  }

  try {
    return await registration.factory({
      config: EMPTY_CONFIG,
      env: opts.env,
      repoRoot: resolve(opts.repoRoot),
    })
  } catch (error) {
    throw new Error(
      `forge adapter ${JSON.stringify(opts.name)} from plugin ` +
        `${JSON.stringify(registration.owner.name)} failed to initialize: ${reason(error)}`,
      { cause: error },
    )
  }
}
