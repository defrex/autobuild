import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ZodError } from 'zod'
import {
  parsePluginManifest,
  pluginApiCompatibility,
  PluginApiCompatibilityError,
  type PluginApiCompatibility,
} from './manifest'
import { createPluginRegistry, type PluginRegistry, type PluginResolutionKind } from './registry'

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function importUrl(resolved: string): string {
  return resolved.startsWith('file:') ? resolved : pathToFileURL(resolved).href
}

export type PluginLoadStage = 'resolution' | 'evaluation' | 'manifest' | 'registration'

export interface PluginModuleReport {
  module: string
  resolutionKind: PluginResolutionKind
  resolved?: string
  status: 'loaded' | 'failed'
  stage: PluginLoadStage | 'loaded'
  pluginName?: string
  api?: PluginApiCompatibility
  error?: string
  cause?: unknown
}

export interface PluginDiagnosis {
  registry: PluginRegistry
  reports: PluginModuleReport[]
  healthy: boolean
}

export function pluginResolutionKind(moduleSpecifier: string): PluginResolutionKind {
  return moduleSpecifier.startsWith('./') ||
    moduleSpecifier.startsWith('../') ||
    moduleSpecifier.startsWith('file:') ||
    isAbsolute(moduleSpecifier) ||
    /^[A-Za-z]:[\\/]/.test(moduleSpecifier)
    ? 'repo-path'
    : 'package'
}

function failed(
  base: Omit<PluginModuleReport, 'status' | 'stage' | 'error'>,
  stage: PluginLoadStage,
  message: string,
  cause?: unknown,
): PluginModuleReport {
  return {
    ...base,
    status: 'failed',
    stage,
    error: message,
    ...(cause !== undefined ? { cause } : {}),
  }
}

function manifestIdentity(value: unknown): {
  pluginName?: string
  api?: PluginApiCompatibility
} {
  if (typeof value !== 'object' || value === null) return {}
  const record = value as Record<string, unknown>
  return {
    ...(typeof record.name === 'string' ? { pluginName: record.name } : {}),
    ...(typeof record.apiVersion === 'string'
      ? { api: pluginApiCompatibility(record.apiVersion) }
      : {}),
  }
}

/** One structured, atomic module attempt shared by fail-fast dispatch loading
 * and exhaustive operator diagnostics. */
export async function attemptPlugin(
  moduleSpecifier: string,
  repoRoot: string,
  registry: PluginRegistry,
): Promise<PluginModuleReport> {
  const resolutionKind = pluginResolutionKind(moduleSpecifier)
  const initial = { module: moduleSpecifier, resolutionKind }
  let resolved: string
  try {
    resolved = Bun.resolveSync(moduleSpecifier, repoRoot)
  } catch (error) {
    return failed(
      initial,
      'resolution',
      `plugin module "${moduleSpecifier}" could not be resolved from repository "${repoRoot}": ${reason(error)}`,
      error,
    )
  }

  const located = { ...initial, resolved }
  let namespace: Record<string, unknown>
  try {
    namespace = (await import(importUrl(resolved))) as Record<string, unknown>
  } catch (error) {
    return failed(
      located,
      'evaluation',
      `plugin module "${moduleSpecifier}" failed while evaluating: ${reason(error)}`,
      error,
    )
  }

  if (!Object.hasOwn(namespace, 'default')) {
    return failed(
      located,
      'manifest',
      `plugin module "${moduleSpecifier}" has no default export; default-export an AutobuildPluginManifest`,
    )
  }

  const identity = manifestIdentity(namespace.default)
  let manifest: ReturnType<typeof parsePluginManifest>
  try {
    manifest = parsePluginManifest(namespace.default)
  } catch (error) {
    const detail =
      error instanceof ZodError
        ? error.issues
            .map((issue) => `${issue.path.join('.') || '(manifest)'}: ${issue.message}`)
            .join('; ')
        : reason(error)
    const api = error instanceof PluginApiCompatibilityError ? error.compatibility : identity.api
    return failed(
      {
        ...located,
        ...(identity.pluginName !== undefined ? { pluginName: identity.pluginName } : {}),
        ...(api !== undefined ? { api } : {}),
      },
      'manifest',
      `plugin module "${moduleSpecifier}" has an invalid manifest: ${detail}`,
      error,
    )
  }

  const api = pluginApiCompatibility(manifest.apiVersion)
  const identified = {
    ...located,
    pluginName: manifest.name,
    api,
  }
  try {
    registry.register(manifest, {
      module: moduleSpecifier,
      resolved,
      resolutionKind,
    })
  } catch (error) {
    return failed(
      identified,
      'registration',
      `plugin module "${moduleSpecifier}" (plugin "${manifest.name}") could not register: ${reason(error)}`,
      error,
    )
  }

  return {
    ...identified,
    status: 'loaded',
    stage: 'loaded',
  }
}

/** Exhaustively attempt configured modules in declaration order. Failed
 * modules leave no registrations; later healthy modules still load. */
export async function diagnosePlugins(
  modules: readonly string[],
  repoRoot: string,
  registry: PluginRegistry = createPluginRegistry(),
): Promise<PluginDiagnosis> {
  const reports: PluginModuleReport[] = []
  for (const moduleSpecifier of modules) {
    reports.push(await attemptPlugin(moduleSpecifier, repoRoot, registry))
  }
  return {
    registry,
    reports,
    healthy: reports.every((report) => report.status === 'loaded'),
  }
}

/** Dispatch compatibility wrapper: preserve first-failure, fail-closed startup. */
export async function loadPlugins(
  modules: readonly string[],
  repoRoot: string,
  registry: PluginRegistry = createPluginRegistry(),
): Promise<PluginRegistry> {
  for (const moduleSpecifier of modules) {
    const report = await attemptPlugin(moduleSpecifier, repoRoot, registry)
    if (report.status === 'failed') {
      throw new Error(report.error, { cause: report.cause })
    }
  }
  return registry
}
