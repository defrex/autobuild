/**
 * Which provider plugins a hosted deployment ships into its `/api/dispatch`
 * function. The first rule that applies decides:
 *
 * 1. `ship-deployment --plugin NAME` flags;
 * 2. the deployment `package.json` field `"autobuild": { "plugins": [...] }`
 *    (an explicit `[]` ships none);
 * 3. every `dependencies` entry whose installed `package.json` declares
 *    `@defrex/autobuild` in `peerDependencies` — the plugin-authoring
 *    convention — except the Autobuild service packages.
 *
 * Selection only names packages; the shipper fails the build when a selected
 * package cannot be resolved, bundled, or evaluated to a plugin manifest.
 */
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

export type PluginSelectionRule = 'flag' | 'manifest' | 'dependencies'

export interface DeploymentPluginSelection {
  packages: string[]
  rule: PluginSelectionRule
}

/** Packages that peer on `@defrex/autobuild` but are Autobuild's own service
 * packages, never provider plugins. */
export const SERVICE_PACKAGES: readonly string[] = [
  '@defrex/autobuild-hosted-store-service',
  '@defrex/autobuild-hosted-dispatcher',
  '@defrex/autobuild-postgres-store',
]

/** Human-readable description of the rule that selected a package, used in
 * shipping errors. */
export function describeSelectionRule(rule: PluginSelectionRule): string {
  switch (rule) {
    case 'flag':
      return 'the --plugin flag'
    case 'manifest':
      return 'package.json autobuild.plugins'
    case 'dependencies':
      return (
        'the default rule (a dependency peering on @defrex/autobuild); ' +
        'list plugins explicitly in package.json autobuild.plugins to override'
      )
  }
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}

/** `node_modules/<name>` found by walking up from `start`, as Node and Bun
 * resolve bare specifiers. */
export async function findInstalledPackage(start: string, name: string): Promise<string | null> {
  let current = resolve(start)
  while (true) {
    const candidate = join(current, 'node_modules', ...name.split('/'))
    try {
      await readFile(join(candidate, 'package.json'))
      return candidate
    } catch {
      // Not installed here: keep walking up.
    }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function explicitList(value: unknown, source: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string' || entry.trim() === '') ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`${source} must be an array of unique, non-blank package names`)
  }
  return value as string[]
}

export async function selectDeploymentPlugins(
  projectRoot: string,
  flags: readonly string[] = [],
): Promise<DeploymentPluginSelection> {
  if (flags.length > 0) return { packages: explicitList([...flags], '--plugin'), rule: 'flag' }
  const manifestPath = join(projectRoot, 'package.json')
  let manifest: Record<string, unknown>
  try {
    manifest = await readJson(manifestPath)
  } catch (error) {
    throw new Error(
      `cannot read the deployment manifest ${manifestPath}: ` +
        (error instanceof Error ? error.message : String(error)),
    )
  }
  const autobuild = manifest.autobuild
  if (autobuild !== undefined) {
    if (typeof autobuild !== 'object' || autobuild === null || Array.isArray(autobuild)) {
      throw new Error(`${manifestPath}: "autobuild" must be an object`)
    }
    const plugins = (autobuild as Record<string, unknown>).plugins
    if (plugins !== undefined) {
      return {
        packages: explicitList(plugins, `${manifestPath}: "autobuild.plugins"`),
        rule: 'manifest',
      }
    }
  }
  const dependencies = manifest.dependencies
  const names =
    typeof dependencies === 'object' && dependencies !== null ? Object.keys(dependencies) : []
  const packages: string[] = []
  for (const name of names.sort()) {
    if (SERVICE_PACKAGES.includes(name)) continue
    const directory = await findInstalledPackage(projectRoot, name)
    // An uninstalled dependency cannot be recognized as a plugin.
    if (directory === null) continue
    const installed = await readJson(join(directory, 'package.json')).catch(() => undefined)
    const peers = installed?.peerDependencies
    if (typeof peers === 'object' && peers !== null && '@defrex/autobuild' in peers) {
      packages.push(name)
    }
  }
  return { packages, rule: 'dependencies' }
}
