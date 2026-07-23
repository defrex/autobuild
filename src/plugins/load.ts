import { pathToFileURL } from 'node:url'
import { ZodError } from 'zod'
import { parsePluginManifest } from './manifest'
import { createPluginRegistry, type PluginRegistry } from './registry'

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function withCause(message: string, cause: unknown): Error {
  return new Error(message, { cause })
}

function importUrl(resolved: string): string {
  return resolved.startsWith('file:') ? resolved : pathToFileURL(resolved).href
}

/** Resolve and load configured modules in declaration order. Resolution is
 * rooted at the consuming repository, never Autobuild's installation tree. */
export async function loadPlugins(
  modules: readonly string[],
  repoRoot: string,
  registry: PluginRegistry = createPluginRegistry(),
): Promise<PluginRegistry> {
  for (const moduleSpecifier of modules) {
    let resolved: string
    try {
      resolved = Bun.resolveSync(moduleSpecifier, repoRoot)
    } catch (error) {
      throw withCause(
        `plugin module "${moduleSpecifier}" could not be resolved from ` +
          `repository "${repoRoot}": ${reason(error)}`,
        error,
      )
    }

    let namespace: Record<string, unknown>
    try {
      namespace = (await import(importUrl(resolved))) as Record<string, unknown>
    } catch (error) {
      throw withCause(
        `plugin module "${moduleSpecifier}" failed while evaluating: ${reason(error)}`,
        error,
      )
    }

    if (!Object.hasOwn(namespace, 'default')) {
      throw new Error(
        `plugin module "${moduleSpecifier}" has no default export; ` +
          'default-export an AutobuildPluginManifest',
      )
    }

    let manifest
    try {
      manifest = parsePluginManifest(namespace.default)
    } catch (error) {
      const detail = error instanceof ZodError
        ? error.issues
            .map((issue) => `${issue.path.join('.') || '(manifest)'}: ${issue.message}`)
            .join('; ')
        : reason(error)
      throw withCause(
        `plugin module "${moduleSpecifier}" has an invalid manifest: ${detail}`,
        error,
      )
    }

    try {
      registry.register(manifest)
    } catch (error) {
      throw withCause(
        `plugin module "${moduleSpecifier}" (plugin "${manifest.name}") ` +
          `could not register: ${reason(error)}`,
        error,
      )
    }
  }
  return registry
}
