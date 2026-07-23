import type {
  AgentRuntimePluginFactory,
  AutobuildPluginManifest,
  ForgePluginFactory,
  TicketSourcePluginFactory,
  WorkspaceProviderPluginFactory,
} from './manifest'

export type PluginPort =
  | 'ticket source'
  | 'agent runtime'
  | 'workspace provider'
  | 'forge'

export type RegistrationOwner =
  | { kind: 'builtin'; name: 'autobuild' }
  | { kind: 'plugin'; name: string }

export interface AdapterRegistration<Factory> {
  owner: RegistrationOwner
  /** Builtins reserve their names; host construction may remain outside the
   * plugin factory map while selectors consume plugin registrations lazily. */
  factory?: Factory
}

const BUILTIN = { kind: 'builtin', name: 'autobuild' } as const

function reserved<Factory>(names: readonly string[]): Map<string, AdapterRegistration<Factory>> {
  return new Map(names.map((name) => [name, { owner: BUILTIN }]))
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
  target: Map<string, AdapterRegistration<unknown>>
}

/** Owner-aware catalog populated at dispatcher startup. Registration is atomic
 * per plugin: every map and collision is checked before the first write. */
export class PluginRegistry {
  readonly ticketSources = reserved<TicketSourcePluginFactory>(['file', 'linear'])
  readonly agentRuntimes = reserved<AgentRuntimePluginFactory>(['claude', 'pi'])
  readonly workspaceProviders = reserved<WorkspaceProviderPluginFactory>([
    'git-worktree',
  ])
  readonly forges = reserved<ForgePluginFactory>(['github'])

  register(plugin: AutobuildPluginManifest): void {
    const pending: PendingRegistration[] = []
    const collect = <Factory>(
      port: PluginPort,
      factories: Record<string, Factory> | undefined,
      target: Map<string, AdapterRegistration<Factory>>,
    ): void => {
      for (const [name, factory] of Object.entries(factories ?? {})) {
        const existing = target.get(name)
        if (existing !== undefined) {
          throw new Error(
            `${port} adapter "${name}" from plugin "${plugin.name}" collides ` +
              `with ${ownerDescription(existing.owner)}; choose a unique adapter name`,
          )
        }
        pending.push({
          port,
          name,
          factory,
          target: target as Map<string, AdapterRegistration<unknown>>,
        })
      }
    }

    collect('ticket source', plugin.ticketSources, this.ticketSources)
    collect('agent runtime', plugin.agentRuntimes, this.agentRuntimes)
    collect(
      'workspace provider',
      plugin.workspaceProviders,
      this.workspaceProviders,
    )
    collect('forge', plugin.forges, this.forges)

    // A future manifest representation could preserve duplicate keys. Keep the
    // preflight independent of object semantics so atomicity remains explicit.
    const seen = new Set<string>()
    for (const registration of pending) {
      const key = `${registration.port}\0${registration.name}`
      if (seen.has(key)) {
        throw new Error(
          `${registration.port} adapter "${registration.name}" is registered ` +
            `more than once by plugin "${plugin.name}"`,
        )
      }
      seen.add(key)
    }

    for (const registration of pending) {
      registration.target.set(registration.name, {
        owner: { kind: 'plugin', name: plugin.name },
        factory: registration.factory,
      })
    }
  }
}

export function createPluginRegistry(): PluginRegistry {
  return new PluginRegistry()
}
