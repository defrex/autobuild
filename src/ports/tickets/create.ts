/**
 * TicketSource factory (SPEC §3.2, §13): construct the builtin or plugin source
 * named by [tickets]. Plugin credentials, like LINEAR_API_KEY, come only from
 * the environment. This remains the single boundary for file-directory
 * defaulting and for registry-aware source selection.
 */
import { resolve } from 'node:path'
import type { TicketsConfig } from '../../config/schema'
import {
  createPluginRegistry,
  type PluginRegistry,
} from '../../plugins/registry'
import type { PluginFactoryContext } from '../../plugins/manifest'
import type { TicketSource } from '../types'
import { DEFAULT_TICKETS_DIR, FileTicketSource } from './file'
import { LinearTicketSource } from './linear'

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function createTicketSource(
  config: TicketsConfig,
  env: Record<string, string | undefined>,
  /** A relative [tickets].dir is relative to the repo, not this process's cwd. */
  targetRepo: string,
  /** Selected local state root. Remote stores pass the repo-local default. */
  localStateRoot?: string,
  /** Registry loaded from this repository's configured plugins. */
  plugins: PluginRegistry = createPluginRegistry(),
): Promise<TicketSource> {
  if (config.source === 'linear') {
    const apiKey = env['LINEAR_API_KEY']
    if (apiKey === undefined || apiKey === '') {
      throw new Error(
        'LINEAR_API_KEY is not set — expected a Linear personal API key; ' +
          'required when [tickets].source = "linear". Set it in the ' +
          'environment or a local .env file.',
      )
    }
    // teamKey presence is cross-validated at config parse; re-checked here
    // because plugin configurations can carry the same optional field.
    if (config.teamKey === undefined) {
      throw new Error(
        '[tickets].source = "linear" requires teamKey — the Linear team key (e.g. "ENG")',
      )
    }
    return new LinearTicketSource({
      apiKey,
      teamKey: config.teamKey,
      ...(config.claimedState !== undefined
        ? { claimedState: config.claimedState }
        : {}),
      ...(config.createState !== undefined
        ? { createState: config.createState }
        : {}),
    })
  }

  if (config.source === 'file') {
    return new FileTicketSource({
      dir:
        config.dir === undefined && localStateRoot !== undefined
          ? resolve(localStateRoot, 'tickets')
          : resolve(targetRepo, config.dir ?? DEFAULT_TICKETS_DIR),
      // Only the DEFAULTED backlog hides itself from git. An explicit dir is
      // user-owned and may intentionally be tracked.
      selfIgnore: config.dir === undefined,
      ...(config.createState !== undefined
        ? { createState: config.createState }
        : {}),
    })
  }

  const registration = plugins.ticketSources.get(config.source)
  if (registration === undefined || registration.factory === undefined) {
    const available = [...plugins.ticketSources.keys()].sort().join(', ')
    throw new Error(
      `unknown ticket source "${config.source}"; available ticket sources: ${available}`,
    )
  }

  const missing = (registration.requiredEnv ?? []).filter((name) => {
    const value = env[name]
    return value === undefined || value === ''
  })
  if (missing.length > 0) {
    throw new Error(
      `ticket source "${config.source}" from plugin "${registration.owner.name}" ` +
        `requires environment ${missing.map((name) => `variable "${name}"`).join(', ')}; ` +
        'set the missing credentials in the environment or a local .env file',
    )
  }

  const context: PluginFactoryContext = {
    config: config as unknown as Record<string, unknown>,
    env,
    repoRoot: resolve(targetRepo),
  }
  try {
    return await registration.factory(context)
  } catch (error) {
    throw new Error(
      `ticket source "${config.source}" from plugin "${registration.owner.name}" ` +
        `failed during construction: ${reason(error)}`,
      { cause: error },
    )
  }
}
