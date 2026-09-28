import { resolve } from 'node:path'
import { SANDBOX_FORBIDDEN_ENV } from './operator-sandbox'
import type { WorkspaceConfig } from '../../config/schema'
import type { PluginRegistry } from '../../plugins/registry'
import type { WorkspaceProvider } from '../types'
import type { BuildExecution } from './build-execution'
import {
  currentRuntimeReferences,
  runtimeProvisioningMap,
  runtimeProvisioningMissingMessage,
  sandboxForbiddenEnvMessage,
} from './provider-capabilities'
import { LocalBuildExecution } from './local-build-execution'
import type { RuntimeReferencesSource } from './vercel-sandbox'

export interface CreateWorkspaceProviderOptions {
  registry: PluginRegistry
  /** Selected local scratch root. Remote stores pass the repository default. */
  worktreeRoot: string
  /** Absolute repository root supplied to plugin factories. */
  repoRoot: string
  env: Record<string, string | undefined>
  /** Required only by remote builtins. */
  storeRef?: string
  storeToken?: string
  /** Host-derived effective routes; consumed only by the built-in sandbox. */
  runtimeReferences?: RuntimeReferencesSource
  /** Checkout-less seams for the built-in sandbox: the repository's HTTPS
   * origin, and a remote branch-head reader returning `undefined` for an
   * absent branch. Absent seams fall back to host `git` from `repoRoot`. */
  origin?: () => Promise<string>
  remoteBranchHead?: (branch: string) => Promise<string | undefined>
  /** Operator-sandbox options (AUT-340), set once at construction: the raw
   * `[commands].setup` shell string, the local-state-tree sandbox root, and
   * the forwarded non-secret variable names. The service never re-receives
   * setup, root, or variables. */
  sandboxSetupCommand?: string
  sandboxRoot?: string
  sandboxEnvironmentVariables?: readonly string[]
  /** Whether `[orchestrator].enabled` is set at the call site. Gates the
   * construction-site `sandboxForbiddenEnv` check so the parse-time rule is
   * reproduced exactly (the config validation only runs when the orchestrator
   * is enabled). */
  orchestratorSandboxEnabled?: boolean
}

export interface WorkspaceRuntime {
  provider: WorkspaceProvider
  execution: BuildExecution
}

/** Resolve and lazily construct the configured WorkspaceProvider. Builtin
 * construction remains host-owned because its scratch root comes from store
 * selection rather than plugin configuration. */
export async function createWorkspaceProvider(
  config: WorkspaceConfig,
  opts: CreateWorkspaceProviderOptions,
): Promise<WorkspaceProvider> {
  const available = [...opts.registry.workspaceProviders.keys()].sort()
  const registration = opts.registry.workspaceProviders.get(config.provider)
  if (registration === undefined) {
    throw new Error(
      `unknown workspace provider "${config.provider}"; available providers: ${available.join(', ')}`,
    )
  }

  // Uniform capability enforcement (AUT-516): every declaration that needs
  // the registry is honoured here, before the builtin/plugin split, where
  // `registration.capabilities`, `opts.storeRef`, and `opts.storeToken` are
  // already in hand — a plugin declaring any of them is enforced too, never
  // accepted by manifest parsing and silently ignored. Order preserves the
  // builtin failure precedence.
  const capabilities = registration.capabilities
  const hasConfig = Object.keys(config.config).length > 0
  if (capabilities?.configRefusal !== undefined && hasConfig) {
    throw new Error(capabilities.configRefusal)
  }
  let parsed: { data: unknown } | undefined
  if (capabilities?.configSchema !== undefined) {
    const result = capabilities.configSchema.safeParse(config.config)
    if (!result.success) {
      throw new Error(`invalid ${config.provider} config: ${result.error.message}`)
    }
    parsed = result as { data: unknown }
  }
  if (capabilities?.requireRuntimeProvisioning === true && opts.runtimeReferences !== undefined) {
    // `mcp.ts` passes no `runtimeReferences` because it references no runtimes;
    // dispatch and init validation always do.
    const provisioning = runtimeProvisioningMap(parsed !== undefined ? parsed.data : config.config)
    for (const group of currentRuntimeReferences(opts.runtimeReferences)) {
      if (Object.hasOwn(provisioning, group.runtime)) continue
      throw new Error(runtimeProvisioningMissingMessage(group))
    }
  }
  if (opts.orchestratorSandboxEnabled === true && capabilities?.sandboxForbiddenEnv !== undefined) {
    for (const name of opts.sandboxEnvironmentVariables ?? []) {
      if (SANDBOX_FORBIDDEN_ENV.includes(name) || capabilities.sandboxForbiddenEnv.includes(name)) {
        throw new Error(sandboxForbiddenEnvMessage(name))
      }
    }
  }
  if (
    capabilities?.storeRequirements !== undefined &&
    (opts.storeRef === undefined || opts.storeToken === undefined)
  ) {
    throw new Error(capabilities.storeRequirements.constructionMessage)
  }

  if (registration.owner.kind === 'builtin') {
    const builtinFactory = registration.builtinFactory
    if (builtinFactory === undefined) {
      throw new Error(
        `workspace provider "${config.provider}" is registered as a builtin but has no constructor`,
      )
    }
    return builtinFactory(config, opts, parsed !== undefined ? parsed.data : config.config)
  }

  const factory = registration.factory
  if (factory === undefined) {
    throw new Error(
      `workspace provider "${config.provider}" from plugin "${registration.owner.name}" has no factory`,
    )
  }

  try {
    // Conditional spreads keep the existing exactness guarantee: a call site
    // that supplies no seams constructs exactly `{ config, env, repoRoot }`,
    // so plugin factories see no `undefined`-valued additions. With seams,
    // the context widens in place (AUT-560) — the seams the builtin factory
    // receives through `opts` reach the plugin factory through the context.
    return await factory({
      config: config.config,
      env: opts.env,
      repoRoot: resolve(opts.repoRoot),
      ...(opts.storeRef !== undefined ? { storeRef: opts.storeRef } : {}),
      ...(opts.storeToken !== undefined ? { storeToken: opts.storeToken } : {}),
      ...(opts.runtimeReferences !== undefined
        ? { runtimeReferences: opts.runtimeReferences }
        : {}),
      ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
      ...(opts.remoteBranchHead !== undefined ? { remoteBranchHead: opts.remoteBranchHead } : {}),
    })
  } catch (error) {
    throw new Error(
      `workspace provider "${config.provider}" failed to initialize: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    )
  }
}

/** Resolve provisioning and execution as one workspace-owned runtime. Existing
 * providers remain source-compatible: locally reachable implementations that
 * omit execution receive the shipped child-process capability, while a future
 * sandbox provider can replace it without a local proxy process. */
export async function createWorkspaceRuntime(
  config: WorkspaceConfig,
  opts: CreateWorkspaceProviderOptions,
): Promise<WorkspaceRuntime> {
  const provider = await createWorkspaceProvider(config, opts)
  return {
    provider,
    execution: provider.buildExecution ?? new LocalBuildExecution({ env: opts.env }),
  }
}
