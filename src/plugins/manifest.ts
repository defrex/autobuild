import semver from 'semver'
import { z } from 'zod'
import type { Forge, TicketSource, WorkspaceProvider } from '../ports/types'
import type { AgentRunnerContractFactory } from '../ports/runner/contract'
import type { RuntimeRegistration } from '../ports/runner/runtime'
import type { TicketSourceContractFactory } from '../ports/tickets/contract'
import type { ForgeContractFactory } from '../ports/forge/contract'
import type { WorkspaceProviderContractFactory } from '../ports/workspace/contract'

/** Version of the in-process plugin contract exposed by `autobuild/plugin-sdk`. */
export const PLUGIN_API_VERSION = '1.1.0' as const

/** Context supplied when a registered adapter or contract fixture is selected. */
export interface PluginFactoryContext<Config = Record<string, unknown>> {
  /** Adapter-specific declarative configuration. */
  config: Readonly<Config>
  /** The dispatch process environment; secrets stay out of autobuild.toml. */
  env: Readonly<Record<string, string | undefined>>
  /** Absolute root of the repository that enabled the plugin. */
  repoRoot: string
}

export type PluginFactory<Adapter, Config = Record<string, unknown>> = {
  /** The method-index form intentionally makes this callback bivariant, so a
   * plugin can retain its concrete config type across the erased manifest. */
  invoke(
    context: PluginFactoryContext<Config>,
  ): Adapter | Promise<Adapter>
}['invoke']

export type TicketSourcePluginFactory<Config = Record<string, unknown>> =
  PluginFactory<TicketSource, Config>
export type AgentRuntimePluginFactory<Config = Record<string, unknown>> =
  PluginFactory<RuntimeRegistration, Config>
export type WorkspaceProviderPluginFactory<Config = Record<string, unknown>> =
  PluginFactory<WorkspaceProvider, Config>
export type ForgePluginFactory<Config = Record<string, unknown>> =
  PluginFactory<Forge, Config>

export interface PluginContractDescriptor<ContractFactory, Config = Record<string, unknown>> {
  /** Creates the unchanged shared-suite harness factory when the test verb runs. */
  factory: PluginFactory<ContractFactory, Config>
  /** True when creating/running the fixture touches a live external system. */
  live?: boolean
}

export type PluginAdapterRegistration<AdapterFactory, ContractFactory> =
  | AdapterFactory
  | {
      factory: AdapterFactory
      contract?: PluginContractDescriptor<ContractFactory>
    }

export type TicketSourcePluginRegistration = PluginAdapterRegistration<
  TicketSourcePluginFactory,
  TicketSourceContractFactory
>
export type AgentRuntimePluginRegistration = PluginAdapterRegistration<
  AgentRuntimePluginFactory,
  AgentRunnerContractFactory
>
export type WorkspaceProviderPluginRegistration = PluginAdapterRegistration<
  WorkspaceProviderPluginFactory,
  WorkspaceProviderContractFactory
>
export type ForgePluginRegistration = PluginAdapterRegistration<
  ForgePluginFactory,
  ForgeContractFactory
>

export interface AutobuildPluginManifest {
  /** Diagnostic/ownership identity. It need not equal the npm package name. */
  name: string
  /** Semver range of plugin API versions accepted by this plugin. */
  apiVersion: string
  ticketSources?: Record<string, TicketSourcePluginRegistration>
  agentRuntimes?: Record<string, AgentRuntimePluginRegistration>
  workspaceProviders?: Record<string, WorkspaceProviderPluginRegistration>
  forges?: Record<string, ForgePluginRegistration>
}

export interface PluginApiCompatibility {
  declaredRange: string
  hostVersion: typeof PLUGIN_API_VERSION
  status: 'compatible' | 'incompatible' | 'invalid'
}

export class PluginApiCompatibilityError extends Error {
  constructor(
    readonly pluginName: string,
    readonly compatibility: PluginApiCompatibility,
  ) {
    const { declaredRange, hostVersion, status } = compatibility
    super(
      status === 'invalid'
        ? `plugin "${pluginName}" declares invalid plugin API range "${declaredRange}"; host provides ${hostVersion}`
        : `plugin "${pluginName}" requires plugin API "${declaredRange}", but host provides ${hostVersion}`,
    )
    this.name = 'PluginApiCompatibilityError'
  }
}

export function pluginApiCompatibility(declaredRange: string): PluginApiCompatibility {
  const valid = semver.validRange(declaredRange)
  return {
    declaredRange,
    hostVersion: PLUGIN_API_VERSION,
    status:
      valid === null
        ? 'invalid'
        : semver.satisfies(PLUGIN_API_VERSION, valid)
          ? 'compatible'
          : 'incompatible',
  }
}

const nonblank = z.string().refine(
  (value) => value.trim().length > 0,
  'must be a nonblank string',
)

const factorySchema = z.custom<PluginFactory<unknown>>(
  (value) => typeof value === 'function',
  'must be a factory function',
)

const contractSchema = z.strictObject({
  factory: factorySchema,
  live: z.boolean().optional(),
})
const registrationObjectSchema = z.strictObject({
  factory: factorySchema,
  contract: contractSchema.optional(),
})
const registrationSchema = z.unknown().transform((value, ctx) => {
  if (typeof value === 'function') return value
  const parsed = registrationObjectSchema.safeParse(value)
  if (parsed.success) return parsed.data
  for (const issue of parsed.error.issues) {
    ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message })
  }
  return z.NEVER
})
const registrationMapSchema = z.record(nonblank, registrationSchema)

/** Strict runtime contract for a plugin module's default export. */
export const pluginManifestSchema = z.strictObject({
  name: nonblank,
  apiVersion: nonblank,
  ticketSources: registrationMapSchema.optional(),
  agentRuntimes: registrationMapSchema.optional(),
  workspaceProviders: registrationMapSchema.optional(),
  forges: registrationMapSchema.optional(),
})

/** Validate shape and API compatibility before any registration is committed. */
export function parsePluginManifest(value: unknown): AutobuildPluginManifest {
  const parsed = pluginManifestSchema.parse(value) as AutobuildPluginManifest
  const compatibility = pluginApiCompatibility(parsed.apiVersion)
  if (compatibility.status !== 'compatible') {
    throw new PluginApiCompatibilityError(parsed.name, compatibility)
  }
  return parsed
}
