import semver from 'semver'
import { z } from 'zod'
import { openMap } from '../open-map'
import { forwardIssues } from '../zod-issues'
import type { Forge, TicketSource, WorkspaceProvider } from '../ports/types'
import type { AgentRunnerContractFactory } from '../ports/runner/contract'
import type { RuntimeRegistration } from '../ports/runner/runtime'
import type { TicketSourceContractFactory } from '../ports/tickets/contract'
import type { ForgeContractFactory } from '../ports/forge/contract'
import type { WorkspaceProviderContractFactory } from '../ports/workspace/contract'
import type { WorkspaceProviderCapabilities } from '../ports/workspace/provider-capabilities'

/** Version of the in-process plugin contract exposed by `@defrex/autobuild/plugin-sdk`. */
export const PLUGIN_API_VERSION = '1.6.0' as const

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
  invoke(context: PluginFactoryContext<Config>): Adapter | Promise<Adapter>
}['invoke']

export type TicketSourcePluginFactory<Config = Record<string, unknown>> = PluginFactory<
  TicketSource,
  Config
>

/** Optional host-enforced metadata for a ticket source. Bare factories remain
 * valid for plugin API 1.0 compatibility. */
export interface TicketSourcePluginDescriptor<Config = Record<string, unknown>> {
  factory: TicketSourcePluginFactory<Config>
  /** Environment variables that must be nonempty before the factory runs. */
  requiredEnv?: readonly string[]
  /** Optional shared-suite certification fixture. */
  contract?: PluginContractDescriptor<TicketSourceContractFactory>
}

export type TicketSourcePluginRegistration<Config = Record<string, unknown>> =
  | TicketSourcePluginFactory<Config>
  | TicketSourcePluginDescriptor<Config>

export type AgentRuntimePluginFactory<Config = Record<string, unknown>> = PluginFactory<
  RuntimeRegistration,
  Config
>
export type WorkspaceProviderPluginFactory<Config = Record<string, unknown>> = PluginFactory<
  WorkspaceProvider,
  Config
>
export type ForgePluginFactory<Config = Record<string, unknown>> = PluginFactory<Forge, Config>

/** Optional host-enforced metadata for a workspace provider. Bare factories
 * remain valid for plugin API 1.0 compatibility. Required environment lives
 * on `capabilities.requiredEnv` — a descriptor-level `requiredEnv` is
 * rejected at manifest parse (see `workspaceProviderRegistrationSchema`). */
export interface WorkspaceProviderPluginDescriptor<Config = Record<string, unknown>> {
  factory: WorkspaceProviderPluginFactory<Config>
  /** Optional shared-suite certification fixture. */
  contract?: PluginContractDescriptor<WorkspaceProviderContractFactory>
  /** Behavior declarations the host enforces without naming the provider
   * (AUT-516): config schema, forges, environment groups, store requirements,
   * origin validation, and remote readiness. */
  capabilities?: WorkspaceProviderCapabilities
}

export type WorkspaceProviderPluginRegistration<Config = Record<string, unknown>> =
  | WorkspaceProviderPluginFactory<Config>
  | WorkspaceProviderPluginDescriptor<Config>

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

export type AgentRuntimePluginRegistration = PluginAdapterRegistration<
  AgentRuntimePluginFactory,
  AgentRunnerContractFactory
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

const nonblank = z.string().refine((value) => value.trim().length > 0, 'must be a nonblank string')

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
  // No prefix: this transform already sits at the value's own path.
  forwardIssues(parsed.error.issues, ctx)
  return z.NEVER
})

/**
 * Adapter maps are keyed by names the PLUGIN AUTHOR chooses, so they go through
 * the same key-preservation contract as autobuild.toml's open maps: a declared
 * name reaches the registry verbatim, `__proto__` included, instead of being
 * lost to `z.record`'s assignment-built result. A dropped registration here is
 * pure misdirection — the operator selecting that adapter is told it is not
 * registered, and the list of available adapters omits the name their manifest
 * plainly declares.
 *
 * Names are `nonblank` rather than merely nonempty: an adapter is addressed from
 * configuration by name, and a name made only of whitespace cannot be.
 */
const ADAPTER_MAP = {
  keys: 'nonblank',
  shape: 'an object of named adapter registrations',
} as const
const registrationMap = (label: string) => openMap(label, registrationSchema, ADAPTER_MAP)

const requiredEnvSchema = z.array(nonblank).superRefine((names, ctx) => {
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
  contract: contractSchema.optional(),
})

/**
 * The ticket-source counterpart of `registrationSchema`. A `z.union` would be
 * the obvious spelling, and the boundary would now carry its branch detail
 * through — `openMap` forwards issues verbatim and the loader expands a union's
 * branches, so nothing is dropped either way. This stays a transform for what it
 * REPORTS, not for what a union would lose: once the value is known not to be a
 * function, committing to the descriptor branch says
 * `ticketSources.acme.factory: must be a factory function`, where a union offers
 * an alternatives list that includes the already-rejected function branch. It
 * also matches its three sibling maps. Do not copy this shape as a workaround —
 * there is nothing left here to work around.
 */
const ticketSourceRegistrationSchema = z.unknown().transform((value, ctx) => {
  if (typeof value === 'function') return value
  const parsed = ticketSourceDescriptorSchema.safeParse(value)
  if (parsed.success) return parsed.data
  forwardIssues(parsed.error.issues, ctx)
  return z.NEVER
})

/** Function-valued capability fields (origin validation, redaction, summary
 * lines, remote readiness). */
const capabilityFunctionSchema = z.custom<(...args: never[]) => unknown>(
  (value) => typeof value === 'function',
  'must be a function',
)

const workspaceProviderCapabilitiesSchema = z.strictObject({
  configSchema: z
    .custom<z.ZodType>(
      (value) =>
        value !== null &&
        typeof value === 'object' &&
        typeof (value as { parse?: unknown }).parse === 'function',
      'must be a Zod schema',
    )
    .optional(),
  configRefusal: z.string().optional(),
  requireRuntimeProvisioning: z.boolean().optional(),
  sandboxForbiddenEnv: z.array(z.string()).optional(),
  supportedForges: z.array(z.string()).optional(),
  forgeDispatchMessage: z.string().optional(),
  forgeValidationMessage: z.string().optional(),
  requiredEnv: z
    .array(
      z.strictObject({
        alternatives: z.array(z.array(z.string().min(1)).min(1)).min(1),
        dispatchMessage: z.string().optional(),
        validationMessage: z.string().optional(),
      }),
    )
    .optional(),
  processEnvOnly: z
    .array(z.strictObject({ name: z.string().min(1), message: z.string() }))
    .optional(),
  storeRequirements: z
    .strictObject({
      constructionMessage: z.string(),
      storeRefMessage: z.string(),
      storeTokenMessage: z.string(),
    })
    .optional(),
  validateOrigin: capabilityFunctionSchema.optional(),
  originReadFailureMessage: z.string().optional(),
  guestEnvNames: capabilityFunctionSchema.optional(),
  describeEnvironment: capabilityFunctionSchema.optional(),
  validateReadiness: capabilityFunctionSchema.optional(),
})

const workspaceProviderDescriptorSchema = z.strictObject({
  factory: factorySchema,
  contract: contractSchema.optional(),
  capabilities: workspaceProviderCapabilitiesSchema.optional(),
})

/**
 * The workspace-provider counterpart of `ticketSourceRegistrationSchema`, with
 * one deliberate tightening (AUT-516): a top-level `requiredEnv` key is
 * rejected with a bespoke remediation message instead of the generic
 * unrecognized-key complaint. The generic registration schema accepts the key
 * today, but its only consumer is ticket-source construction — routing
 * workspace-provider env requirements there would leave the declaration
 * parsed and never checked, exactly the ignored-declaration failure mode this
 * port's capabilities exist to eliminate. Required environment belongs on
 * `capabilities.requiredEnv`, which carries the per-site messages a bare name
 * list cannot.
 */
const workspaceProviderRegistrationSchema = z.unknown().transform((value, ctx) => {
  if (typeof value === 'function') return value
  if (value !== null && typeof value === 'object' && 'requiredEnv' in value) {
    ctx.addIssue({
      code: 'custom',
      message:
        'workspaceProviders.<name>.requiredEnv is not supported; declare required environment as workspaceProviders.<name>.capabilities.requiredEnv',
    })
    return z.NEVER
  }
  const parsed = workspaceProviderDescriptorSchema.safeParse(value)
  if (parsed.success) return parsed.data
  forwardIssues(parsed.error.issues, ctx)
  return z.NEVER
})

/** Strict runtime contract for a plugin module's default export.
 *
 * `.optional()` stays outermost, so an undeclared port remains `undefined`
 * rather than becoming `openMap`'s prefaulted `{}`. */
export const pluginManifestSchema = z.strictObject({
  name: nonblank,
  apiVersion: nonblank,
  ticketSources: openMap('ticketSources', ticketSourceRegistrationSchema, ADAPTER_MAP).optional(),
  agentRuntimes: registrationMap('agentRuntimes').optional(),
  workspaceProviders: openMap(
    'workspaceProviders',
    workspaceProviderRegistrationSchema,
    ADAPTER_MAP,
  ).optional(),
  forges: registrationMap('forges').optional(),
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
