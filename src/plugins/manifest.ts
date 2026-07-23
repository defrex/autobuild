import semver from 'semver'
import { z } from 'zod'
import type { Forge, TicketSource, WorkspaceProvider } from '../ports/types'
import type { RuntimeRegistration } from '../ports/runner/runtime'

/** Version of the in-process plugin contract exposed by `autobuild/plugin-sdk`. */
export const PLUGIN_API_VERSION = '1.1.0' as const

/** Context supplied when a registered adapter is selected. Plugin loading is
 * deliberately lazy with respect to factories: this context is not created and
 * no adapter is constructed during manifest registration. */
export interface PluginFactoryContext<Config = Record<string, unknown>> {
  /** Adapter-specific declarative configuration. */
  config: Readonly<Config>
  /** The dispatch process environment; secrets stay out of autobuild.toml. */
  env: Readonly<Record<string, string | undefined>>
  /** Absolute root of the repository that enabled the plugin. */
  repoRoot: string
}

export type PluginFactory<Adapter, Config = Record<string, unknown>> = {
  /** Factory config is plugin-defined. The method-index form intentionally
   * makes this callback bivariant: a manifest can retain a concrete config
   * type while the host stores factories behind the configuration-erased
   * manifest contract until a selector validates and invokes one. */
  invoke(
    context: PluginFactoryContext<Config>,
  ): Adapter | Promise<Adapter>
}['invoke']

export type TicketSourcePluginFactory<Config = Record<string, unknown>> =
  PluginFactory<TicketSource, Config>

/** Optional host-enforced metadata for a ticket source. Bare factories remain
 * valid for plugin API 1.0 compatibility. */
export interface TicketSourcePluginDescriptor<Config = Record<string, unknown>> {
  factory: TicketSourcePluginFactory<Config>
  /** Environment variables that must be nonempty before the factory runs. */
  requiredEnv?: readonly string[]
}

export type TicketSourcePluginRegistration<Config = Record<string, unknown>> =
  | TicketSourcePluginFactory<Config>
  | TicketSourcePluginDescriptor<Config>

export type AgentRuntimePluginFactory<Config = Record<string, unknown>> =
  PluginFactory<RuntimeRegistration, Config>
export type WorkspaceProviderPluginFactory<Config = Record<string, unknown>> =
  PluginFactory<WorkspaceProvider, Config>
export type ForgePluginFactory<Config = Record<string, unknown>> =
  PluginFactory<Forge, Config>

export interface AutobuildPluginManifest {
  /** Diagnostic/ownership identity. It need not equal the npm package name. */
  name: string
  /** Semver range of plugin API versions accepted by this plugin. */
  apiVersion: string
  ticketSources?: Record<string, TicketSourcePluginRegistration>
  agentRuntimes?: Record<string, AgentRuntimePluginFactory>
  workspaceProviders?: Record<string, WorkspaceProviderPluginFactory>
  forges?: Record<string, ForgePluginFactory>
}

const nonblank = z.string().refine(
  (value) => value.trim().length > 0,
  'must be a nonblank string',
)

const factorySchema = z.custom<PluginFactory<unknown>>(
  (value) => typeof value === 'function',
  'must be an adapter factory function',
)

const factoryMapSchema = z.record(nonblank, factorySchema)

const requiredEnvSchema = z
  .array(nonblank)
  .superRefine((names, ctx) => {
    const seen = new Set<string>()
    names.forEach((name, index) => {
      if (seen.has(name)) {
        ctx.addIssue({
          code: 'custom',
          path: [index],
          message: `environment variable "${name}" is declared more than once`,
        })
      }
      seen.add(name)
    })
  })

const ticketSourceDescriptorSchema = z.strictObject({
  factory: factorySchema,
  requiredEnv: requiredEnvSchema.optional(),
})

const ticketSourceMapSchema = z.record(
  nonblank,
  z.union([factorySchema, ticketSourceDescriptorSchema]),
)

/** Strict runtime contract for a plugin module's default export. */
export const pluginManifestSchema = z.strictObject({
  name: nonblank,
  apiVersion: nonblank,
  ticketSources: ticketSourceMapSchema.optional(),
  agentRuntimes: factoryMapSchema.optional(),
  workspaceProviders: factoryMapSchema.optional(),
  forges: factoryMapSchema.optional(),
})

/** Validate shape and API compatibility before any registration is committed. */
export function parsePluginManifest(value: unknown): AutobuildPluginManifest {
  const parsed = pluginManifestSchema.parse(value) as AutobuildPluginManifest
  if (semver.validRange(parsed.apiVersion) === null) {
    throw new Error(
      `plugin "${parsed.name}" declares invalid plugin API range ` +
        `"${parsed.apiVersion}"; host provides ${PLUGIN_API_VERSION}`,
    )
  }
  if (!semver.satisfies(PLUGIN_API_VERSION, parsed.apiVersion)) {
    throw new Error(
      `plugin "${parsed.name}" requires plugin API "${parsed.apiVersion}", ` +
        `but host provides ${PLUGIN_API_VERSION}`,
    )
  }
  return parsed
}
