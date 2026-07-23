import type {
  AgentRuntimePluginFactory,
  AutobuildPluginManifest,
  ForgePluginFactory,
  PluginAdapterRegistration,
  PluginApiCompatibility,
  PluginContractDescriptor,
  TicketSourcePluginFactory,
  WorkspaceProviderPluginFactory,
} from './manifest'
import { pluginApiCompatibility } from './manifest'
import type { AgentRunnerContractFactory } from '../ports/runner/contract'
import type { TicketSourceContractFactory } from '../ports/tickets/contract'
import type { WorkspaceProviderContractFactory } from '../ports/workspace/contract'
import type { ForgeContractFactory } from '../ports/forge/contract'

export type PluginPort =
  | 'ticket-source'
  | 'agent-runtime'
  | 'workspace-provider'
  | 'forge'

export const PLUGIN_PORTS: readonly PluginPort[] = [
  'ticket-source',
  'agent-runtime',
  'workspace-provider',
  'forge',
]

export type PluginResolutionKind = 'repo-path' | 'package'

export type RegistrationOwner =
  | { kind: 'builtin'; name: 'autobuild' }
  | { kind: 'plugin'; name: string }

export interface ConfiguredPluginSource {
  kind: 'configured'
  module: string
  resolved: string
  resolutionKind: PluginResolutionKind
  pluginName: string
  api: PluginApiCompatibility
}

export type RegistrationSource =
  | { kind: 'builtin' }
  | ConfiguredPluginSource

export interface AdapterRegistration<Factory, ContractFactory = unknown> {
  owner: RegistrationOwner
  /** Builtins remain reservations until their ordinary selector consumes the
   * registry. Plugin registrations always carry a normalized factory. */
  factory?: Factory
  contract?: PluginContractDescriptor<ContractFactory>
  source: RegistrationSource
}

export interface AdapterProjection {
  port: PluginPort
  name: string
  owner: RegistrationOwner
  source: RegistrationSource
  hasContract: boolean
  live: boolean
}

const BUILTIN = { kind: 'builtin', name: 'autobuild' } as const

function reserved<Factory, ContractFactory>(
  names: readonly string[],
): Map<string, AdapterRegistration<Factory, ContractFactory>> {
  return new Map(
    names.map((name) => [name, { owner: BUILTIN, source: { kind: 'builtin' } }]),
  )
}

export function pluginPortLabel(port: PluginPort): string {
  switch (port) {
    case 'ticket-source': return 'ticket source'
    case 'agent-runtime': return 'agent runtime'
    case 'workspace-provider': return 'workspace provider'
    case 'forge': return 'forge'
  }
}

function ownerDescription(owner: RegistrationOwner): string {
  return owner.kind === 'builtin'
    ? 'builtin adapter'
    : `plugin "${owner.name}"`
}

interface PendingRegistration {
  port: PluginPort
  name: string
  factory: unknown
  contract?: PluginContractDescriptor<unknown>
  target: Map<string, AdapterRegistration<unknown, unknown>>
}

function normalize<AdapterFactory, ContractFactory>(
  registration: PluginAdapterRegistration<AdapterFactory, ContractFactory>,
): { factory: AdapterFactory; contract?: PluginContractDescriptor<ContractFactory> } {
  if (typeof registration === 'function') {
    return { factory: registration as AdapterFactory }
  }
  const object = registration as {
    factory: AdapterFactory
    contract?: PluginContractDescriptor<ContractFactory>
  }
  return {
    factory: object.factory,
    ...(object.contract !== undefined ? { contract: object.contract } : {}),
  }
}

/** Owner-aware catalog populated at startup. Registration is atomic per
 * plugin: every map and collision is checked before the first write. */
export class PluginRegistry {
  readonly ticketSources = reserved<TicketSourcePluginFactory, TicketSourceContractFactory>([
    'file',
    'linear',
  ])
  readonly agentRuntimes = reserved<AgentRuntimePluginFactory, AgentRunnerContractFactory>([
    'claude',
    'pi',
  ])
  readonly workspaceProviders = reserved<
    WorkspaceProviderPluginFactory,
    WorkspaceProviderContractFactory
  >(['git-worktree'])
  readonly forges = reserved<ForgePluginFactory, ForgeContractFactory>(['github'])

  register(
    plugin: AutobuildPluginManifest,
    configuredSource?: Omit<ConfiguredPluginSource, 'kind' | 'pluginName' | 'api'>,
  ): void {
    const source: ConfiguredPluginSource = {
      kind: 'configured',
      module: configuredSource?.module ?? '<direct>',
      resolved: configuredSource?.resolved ?? '<direct>',
      resolutionKind: configuredSource?.resolutionKind ?? 'repo-path',
      pluginName: plugin.name,
      api: pluginApiCompatibility(plugin.apiVersion),
    }
    const pending: PendingRegistration[] = []
    const collect = <AdapterFactory, ContractFactory>(
      port: PluginPort,
      registrations: Record<
        string,
        PluginAdapterRegistration<AdapterFactory, ContractFactory>
      > | undefined,
      target: Map<string, AdapterRegistration<AdapterFactory, ContractFactory>>,
    ): void => {
      for (const [name, registration] of Object.entries(registrations ?? {})) {
        const existing = target.get(name)
        if (existing !== undefined) {
          throw new Error(
            `${pluginPortLabel(port)} adapter "${name}" from plugin "${plugin.name}" collides ` +
              `with ${ownerDescription(existing.owner)}; choose a unique adapter name`,
          )
        }
        const normalized = normalize(registration)
        pending.push({
          port,
          name,
          factory: normalized.factory,
          ...(normalized.contract !== undefined
            ? { contract: normalized.contract as PluginContractDescriptor<unknown> }
            : {}),
          target: target as Map<string, AdapterRegistration<unknown, unknown>>,
        })
      }
    }

    collect('ticket-source', plugin.ticketSources, this.ticketSources)
    collect('agent-runtime', plugin.agentRuntimes, this.agentRuntimes)
    collect('workspace-provider', plugin.workspaceProviders, this.workspaceProviders)
    collect('forge', plugin.forges, this.forges)

    const seen = new Set<string>()
    for (const registration of pending) {
      const key = `${registration.port}\0${registration.name}`
      if (seen.has(key)) {
        throw new Error(
          `${pluginPortLabel(registration.port)} adapter "${registration.name}" is registered ` +
            `more than once by plugin "${plugin.name}"`,
        )
      }
      seen.add(key)
    }

    for (const registration of pending) {
      registration.target.set(registration.name, {
        owner: { kind: 'plugin', name: plugin.name },
        factory: registration.factory,
        ...(registration.contract !== undefined
          ? { contract: registration.contract }
          : {}),
        source,
      })
    }
  }

  adapters(port?: PluginPort): AdapterProjection[] {
    const maps: Array<[
      PluginPort,
      Map<string, AdapterRegistration<unknown, unknown>>,
    ]> = [
      ['ticket-source', this.ticketSources as Map<string, AdapterRegistration<unknown, unknown>>],
      ['agent-runtime', this.agentRuntimes as Map<string, AdapterRegistration<unknown, unknown>>],
      ['workspace-provider', this.workspaceProviders as Map<string, AdapterRegistration<unknown, unknown>>],
      ['forge', this.forges as Map<string, AdapterRegistration<unknown, unknown>>],
    ]
    const result: AdapterProjection[] = []
    for (const [candidate, registrations] of maps) {
      if (port !== undefined && candidate !== port) continue
      for (const [name, registration] of registrations) {
        result.push({
          port: candidate,
          name,
          owner: registration.owner,
          source: registration.source,
          hasContract: registration.contract !== undefined,
          live: registration.contract?.live === true,
        })
      }
    }
    return result
  }

  registration(port: PluginPort, name: string): AdapterRegistration<unknown, unknown> | undefined {
    switch (port) {
      case 'ticket-source': return this.ticketSources.get(name)
      case 'agent-runtime': return this.agentRuntimes.get(name)
      case 'workspace-provider': return this.workspaceProviders.get(name)
      case 'forge': return this.forges.get(name)
    }
  }
}

export function createPluginRegistry(): PluginRegistry {
  return new PluginRegistry()
}
