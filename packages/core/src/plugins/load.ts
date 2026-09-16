import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ZodError } from 'zod'
import { distributionRoot } from '../distribution'
import { expandIssues } from '../zod-issues'
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

/** Which root satisfied a bare package specifier: the consuming repository's
 * installed dependencies, or the Autobuild installation the CLI runs from. */
export type PluginResolutionSource = 'repository' | 'installation'

export interface PluginModuleReport {
  module: string
  resolutionKind: PluginResolutionKind
  resolved?: string
  resolvedFrom?: PluginResolutionSource
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

export interface PluginLoadOptions {
  /** Root whose installed dependencies satisfy bare package specifiers first. */
  packageRoot?: string
  /** Autobuild installation root tried after `packageRoot`, so an extension
   * installed next to the CLI (`bun add -g @defrex/autobuild-<extension>`)
   * loads without being added to the repository. Defaults to the running
   * distribution's root. */
  installationRoot?: string
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
  options: PluginLoadOptions = {},
): Promise<PluginModuleReport> {
  const resolutionKind = pluginResolutionKind(moduleSpecifier)
  const initial = { module: moduleSpecifier, resolutionKind }
  let resolved: string
  let resolvedFrom: PluginResolutionSource | undefined
  if (resolutionKind === 'repo-path') {
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
  } else {
    // A repository copy wins over an installed one: the consuming checkout's
    // dependencies are tried first, then the Autobuild installation itself.
    const candidates: Array<{ source: PluginResolutionSource; root: string }> = [
      { source: 'repository', root: options.packageRoot ?? repoRoot },
    ]
    const installationRoot = options.installationRoot ?? distributionRoot()
    if (installationRoot !== candidates[0]?.root) {
      candidates.push({ source: 'installation', root: installationRoot })
    }
    const failures: string[] = []
    let found: { path: string; source: PluginResolutionSource } | undefined
    let lastError: unknown
    for (const candidate of candidates) {
      try {
        found = { path: Bun.resolveSync(moduleSpecifier, candidate.root), source: candidate.source }
        break
      } catch (error) {
        lastError = error
        failures.push(`${candidate.source} "${candidate.root}"`)
      }
    }
    if (found === undefined) {
      return failed(
        initial,
        'resolution',
        `plugin module "${moduleSpecifier}" could not be resolved from ${failures.join(' or ')}: ${reason(lastError)}`,
        lastError,
      )
    }
    resolved = found.path
    resolvedFrom = found.source
  }

  const located = { ...initial, resolved, ...(resolvedFrom !== undefined ? { resolvedFrom } : {}) }
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
        ? expandIssues(error.issues)
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
  options: PluginLoadOptions = {},
  registry: PluginRegistry = createPluginRegistry(),
): Promise<PluginDiagnosis> {
  const reports: PluginModuleReport[] = []
  for (const moduleSpecifier of modules) {
    reports.push(await attemptPlugin(moduleSpecifier, repoRoot, registry, options))
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
  options: PluginLoadOptions = {},
  registry: PluginRegistry = createPluginRegistry(),
): Promise<PluginRegistry> {
  for (const moduleSpecifier of modules) {
    const report = await attemptPlugin(moduleSpecifier, repoRoot, registry, options)
    if (report.status === 'failed') {
      throw new Error(report.error, { cause: report.cause })
    }
  }
  return registry
}
