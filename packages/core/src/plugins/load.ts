import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ZodError } from 'zod'
import { distributionRoot } from '../distribution'
import { expandIssues } from '../zod-issues'
import {
  parsePluginManifest,
  pluginApiCompatibility,
  PluginApiCompatibilityError,
  type AutobuildPluginManifest,
  type PluginApiCompatibility,
} from './manifest'
import { createPluginRegistry, type PluginRegistry, type PluginResolutionKind } from './registry'

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The package directory a bare specifier names: `@scope/name/sub` names
 * `@scope/name`, `name/sub` names `name`. Subpath exports resolve inside the
 * package, so the on-disk gate below must check the package, not the
 * subpath. */
function packageNameOf(specifier: string): string {
  const segments = specifier.split('/')
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : (segments[0] ?? specifier)
}

/** First directory of `root`'s ancestor chain (inclusive) under which
 * `node_modules/<specifier>` exists on disk, or undefined. Pure filesystem
 * syscalls — deliberately no Bun APIs: `Bun.resolveSync` on a bare specifier
 * that no `node_modules` lookup satisfies hands the specifier to Bun's
 * runtime auto-installer, which fetches from the network and writes a cache;
 * on a read-only filesystem (the hosted dispatcher function) that is a
 * fatal, uncatchable process exit (AUT-587). Gating on a disk hit keeps the
 * installer unreachable: per the planner-verified Bun 1.4 behavior, a
 * resolver call whose base chain holds the package on disk resolves from
 * disk and never touches the installer.
 *
 * Termination (AUT-597): `root` is resolved to an absolute path before the
 * walk begins, so a relative candidate root — origin mode passes the
 * non-filesystem token `'<hosted-dispatcher>'` — cannot make `dirname` a
 * fixed point and spin the loop forever. The `parent === current` guard
 * backstops the fixed point (`dirname('/') === '/'`) should the loop's
 * start point ever change. */
function diskNodeModulesDirectory(specifier: string, root: string): string | undefined {
  const pkg = packageNameOf(specifier)
  let current = resolve(root)
  while (true) {
    if (existsSync(join(current, 'node_modules', pkg))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
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
  status: 'loaded' | 'failed' | 'skipped'
  stage: PluginLoadStage | 'loaded'
  pluginName?: string
  api?: PluginApiCompatibility
  error?: string
  cause?: unknown
  /** One-line explanation for a `skipped` report, emitted through the
   * loader's notice channel. Undefined for `loaded` and `failed`. */
  notice?: string
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
  /** Guest context (AUT-517): a package-kind specifier that cannot be
   * resolved from either candidate is skipped with a notice instead of
   * failing the process, because guests never construct workspace providers
   * and may legitimately be handed a provider plugin they need not load.
   * Repo-path specifiers and every post-resolution failure stay fail-closed. */
  guest?: boolean
  /** Notice channel for skipped loads. Defaults to one line on stderr. */
  onNotice?: (line: string) => void
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

/** True when the manifest declares no registrations outside the
 * workspace-provider map. */
function declaresOnlyWorkspaceProviderRegistrations(manifest: AutobuildPluginManifest): boolean {
  const empty = (registrations: Record<string, unknown> | undefined): boolean =>
    registrations === undefined || Object.keys(registrations).length === 0
  return empty(manifest.ticketSources) && empty(manifest.agentRuntimes) && empty(manifest.forges)
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
      // Disk-first gate (AUT-587): only a candidate whose `node_modules`
      // chain holds the package on disk reaches the resolver. Bun's runtime
      // auto-installer fires exactly when disk resolution fails, so a miss
      // here must be recorded without calling `Bun.resolveSync` at all.
      const diskRoot = diskNodeModulesDirectory(moduleSpecifier, candidate.root)
      if (diskRoot === undefined) {
        failures.push(`${candidate.source} "${candidate.root}"`)
        continue
      }
      try {
        found = { path: Bun.resolveSync(moduleSpecifier, diskRoot), source: candidate.source }
        break
      } catch (error) {
        lastError = error
        failures.push(`${candidate.source} "${candidate.root}"`)
      }
    }
    if (found === undefined) {
      if (options.guest === true) {
        return {
          ...initial,
          status: 'skipped',
          stage: 'resolution',
          notice:
            `plugin module "${moduleSpecifier}" could not be resolved from ${failures.join(' or ')}; ` +
            'guests never construct workspace providers, so the provider plugin is skipped here',
        }
      }
      // A disk miss never reached the resolver, so there is no Bun error to
      // quote — say directly what the gate established instead.
      const detail =
        lastError !== undefined
          ? reason(lastError)
          : `no "node_modules/${packageNameOf(moduleSpecifier)}" entry exists on disk under any candidate root`
      return failed(
        initial,
        'resolution',
        `plugin module "${moduleSpecifier}" could not be resolved from ${failures.join(' or ')}: ${detail}`,
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
  // Transitional duplicate-skip (AUT-517): while the builtin hosts the
  // vercel-sandbox implementation, a configured plugin that re-registers the
  // same workspace-provider name must be accepted and skipped, not thrown
  // out of startup. Skip the whole module IFF it declares at least one
  // registration, only workspace-provider registrations, and EVERY declared
  // name collides with a builtin workspace-provider registration. Any other
  // collision (other ports, plugin-vs-plugin, mixed fresh/colliding) throws
  // exactly as before via registry.register below. Keyed on builtin
  // ownership, so the rule retires itself when the builtin is removed.
  const collisions = registry.builtinWorkspaceProviderCollisions(manifest)
  if (
    collisions.length > 0 &&
    declaresOnlyWorkspaceProviderRegistrations(manifest) &&
    collisions.length === Object.keys(manifest.workspaceProviders ?? {}).length
  ) {
    const names = Object.keys(manifest.workspaceProviders ?? {})
      .map((name) => JSON.stringify(name))
      .join(', ')
    return {
      ...identified,
      status: 'skipped',
      stage: 'registration',
      notice:
        `plugin "${manifest.name}" declares only builtin workspace-provider registration(s) ${names}; ` +
        'skipping it — the builtin keeps serving the provider',
    }
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
 * modules leave no registrations; later healthy modules still load. Skipped
 * modules (builtin duplicate-skip, guest tolerance) register nothing and
 * count as healthy. */
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
    healthy: reports.every((report) => report.status !== 'failed'),
  }
}

function defaultPluginNotice(line: string): void {
  console.error(line)
}

/** Dispatch compatibility wrapper: preserve first-failure, fail-closed startup.
 * Skipped modules are announced through the notice channel and load
 * continues. */
export async function loadPlugins(
  modules: readonly string[],
  repoRoot: string,
  options: PluginLoadOptions = {},
  registry: PluginRegistry = createPluginRegistry(),
): Promise<PluginRegistry> {
  const onNotice = options.onNotice ?? defaultPluginNotice
  for (const moduleSpecifier of modules) {
    const report = await attemptPlugin(moduleSpecifier, repoRoot, registry, options)
    if (report.status === 'failed') {
      throw new Error(report.error, { cause: report.cause })
    }
    if (report.status === 'skipped' && report.notice !== undefined) {
      onNotice(report.notice)
    }
  }
  return registry
}
