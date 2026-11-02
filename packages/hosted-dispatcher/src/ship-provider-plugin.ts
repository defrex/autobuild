/**
 * Ship provider plugin packages into the hosted deployment's `/api/dispatch`
 * function (AUT-517, defrex/autobuild#820).
 *
 * A bare package specifier resolves only through a `node_modules/` path, so
 * appending a plugin's source files to the dispatch route's trace alone cannot
 * make it resolvable inside the deployed function (finding f_0b59ab99). At
 * runtime `loadPlugins` falls back to the installation root,
 * `distributionRoot()` — the installed `@defrex/autobuild` directory — and
 * walks up from it looking for `node_modules/<pkg>`; the first directory it
 * checks is `<distributionRoot>/node_modules/<pkg>`. This step stages a
 * self-contained `bun build` bundle of each plugin exactly there and appends
 * the staged files to the dispatch route's `route.js.nft.json`, relative to
 * the trace file's directory. The bundle inlines the plugin-sdk closure and
 * every dependency; node builtins stay external.
 *
 * In this source checkout `distributionRoot()` is the repository root, so the
 * staging path is the workspace symlink `bun install` left in the root
 * `node_modules`; it is replaced and, on a local run, put back. In an
 * installed deployment the staging path is a nested directory `bun install`
 * never creates, so the consumer's installed package is never touched.
 *
 * Each staged `package.json` carries `"autobuildStagedBundle": true`. The
 * plugin's source is found from the deployment's own installation
 * (`node_modules/<pkg>` walking up from the project). Only the source
 * checkout can resolve onto a staged bundle — a Vercel-cached re-run after
 * staging replaced the workspace symlink (finding f_5b9ade16) — and then the
 * source is located through the root `workspaces` tree instead. Bundles
 * staged before the marker existed are recognized by their two-file shape,
 * but only at the staging path: elsewhere that shape is an ordinary plugin.
 *
 * Every staged bundle is imported once at build time and must evaluate to a
 * valid plugin manifest; a failure at any step fails the build naming the
 * package. A deployment build (`VERCEL` set) keeps the staged bundle — the
 * function needs it. A developer-local run restores the installation as
 * `bun install` had it. Staged files are build artifacts under `node_modules`
 * (gitignored, never committed).
 */
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  rmdir,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Dirent } from 'node:fs'
import { distributionRoot as installedDistributionRoot } from '@defrex/autobuild/distribution'
import { parsePluginManifest } from '@defrex/autobuild/plugin-sdk'
import {
  describeSelectionRule,
  findInstalledPackage,
  type PluginSelectionRule,
} from './deployment-plugins'

export interface ShipProviderPluginsOptions {
  /** The Next project directory. */
  cwd?: string
  /** Next build output directory under the project directory. */
  distDir?: string
  /** Plugin package specifiers to stage. */
  packages: readonly string[]
  /** The rule that selected `packages`, named in shipping errors. */
  rule?: PluginSelectionRule
  /** The installed `@defrex/autobuild` directory; staging goes under its
   * `node_modules`. Defaults to `distributionRoot()` of this process. */
  distributionRoot?: string
  /** The Next output-file-tracing root; staged files must lie under it.
   * Defaults to `AB_SERVICE_BUILD_ROOT`, else the workspace root above the
   * project, else the project. */
  traceRoot?: string
  /** Restore the installation after the trace append. A deployment build
   * must keep the staged bundles; only a developer-local run restores. */
  restoreInstall?: boolean
  log?: (message: string) => void
}

export interface ShipProviderPluginResult {
  packageName: string
  /** Directory the bundle was built from (absolute). */
  source: string
  /** Directory the bundle was staged into (absolute). */
  staging: string
  /** Staged files appended to (or already present in) the trace, relative to
   * the trace file's directory — exactly the strings written into `files`. */
  traceEntries: string[]
  appended: number
  bytes: number
  /** Whether the installation was restored after staging (local runs). */
  restored: boolean
}

/** True when the run is a developer-local build: Vercel sets `VERCEL` in
 * every build environment — including a local `vercel build` — so an absent
 * `VERCEL` identifies exactly the plain local runs the restore is for. */
export function restoresInstallIn(env: Record<string, string | undefined>): boolean {
  return env.VERCEL === undefined
}

const TRACE_FILE = 'route.js.nft.json'
const ROUTE_DIRECTORY = join('server', 'app', 'api', 'dispatch')
const STAGED_MARKER = 'autobuildStagedBundle'

/** Nearest ancestor directory whose package.json declares `workspaces` — the
 * same root manifest `readWorkspaceManifests` reads. Never a hardcoded
 * up-count. */
export async function findWorkspaceRoot(start: string): Promise<string> {
  let current = resolve(start)
  while (true) {
    try {
      const manifest = JSON.parse(await readFile(join(current, 'package.json'), 'utf8')) as {
        workspaces?: unknown
      }
      if (Array.isArray(manifest.workspaces) && manifest.workspaces.length > 0) return current
    } catch {
      // Not a manifest (or unreadable): keep walking up.
    }
    const parent = dirname(current)
    if (parent === current) {
      throw new Error(
        `no workspace root (a package.json declaring "workspaces") above ${resolve(start)}`,
      )
    }
    current = parent
  }
}

/** Directory of the plugin package's SOURCE, located through the repository
 * root's `workspaces` tree. The fallback for a source checkout whose
 * `node_modules` link was replaced by a staged bundle (finding f_5b9ade16);
 * pattern support mirrors tools/workspace-manifest-check.ts: `directory/*`
 * globs only. */
async function resolvePackageSourceDirectory(
  repoRoot: string,
  packageName: string,
): Promise<string> {
  let rootManifest: { workspaces?: unknown }
  try {
    rootManifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
  } catch (error) {
    throw new Error(
      `cannot read the workspace root manifest ${join(repoRoot, 'package.json')}: ` +
        (error instanceof Error ? error.message : String(error)),
    )
  }
  if (!Array.isArray(rootManifest.workspaces) || rootManifest.workspaces.length === 0) {
    throw new Error(
      `${join(repoRoot, 'package.json')}: workspaces must be a non-empty array — ` +
        `the plugin source is located through the workspace tree`,
    )
  }
  const candidates: string[] = []
  for (const pattern of rootManifest.workspaces) {
    const normalized = typeof pattern === 'string' ? pattern.replaceAll('\\', '/') : ''
    if (!normalized.endsWith('/*') || normalized.slice(0, -2).includes('*')) {
      throw new Error(
        `${join(repoRoot, 'package.json')}: unsupported workspace pattern "${String(pattern)}"; ` +
          'expected a directory/* glob',
      )
    }
    const parent = resolve(repoRoot, normalized.slice(0, -2))
    let entries: Dirent[]
    try {
      entries = await readdir(parent, { withFileTypes: true })
    } catch (error) {
      throw new Error(
        `${join(repoRoot, 'package.json')}: cannot read workspace directory ` +
          `${normalized.slice(0, -2)}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    for (const entry of entries) {
      if (entry.isDirectory()) candidates.push(join(parent, entry.name))
    }
  }
  for (const directory of candidates) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as {
        name?: unknown
      }
      if (manifest.name === packageName) return directory
    } catch {
      // Not a package manifest: keep scanning the workspace tree.
    }
  }
  throw new Error(
    `plugin package "${packageName}" not found in the workspace tree of ${repoRoot} ` +
      '(workspaces patterns: ' +
      rootManifest.workspaces.map((pattern) => String(pattern)).join(', ') +
      ') — is the package a workspace member?',
  )
}

/** Whether `directory` holds a bundle a previous run staged: the marker, or,
 * with `legacyShape`, the exact two-file shape bundles had before the marker
 * existed. Only the staging path itself may be read by shape — an installed
 * plugin elsewhere can legitimately ship exactly those two files. */
async function isStagedBundle(directory: string, legacyShape: boolean): Promise<boolean> {
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  } catch {
    return false
  }
  if (manifest[STAGED_MARKER] === true) return true
  if (!legacyShape) return false
  const exports = manifest.exports as Record<string, unknown> | undefined
  if (exports?.['.'] !== './dist/index.js') return false
  const entries = (await readdir(directory).catch(() => [])).sort()
  const dist = await readdir(join(directory, 'dist')).catch(() => [])
  return entries.join(',') === 'dist,package.json' && dist.join(',') === 'index.js'
}

/** The package's import entry: `exports["."]` (the `import` condition, then
 * `default`), else `module`, else `main`. */
async function entryFile(directory: string, packageName: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as {
    exports?: unknown
    module?: unknown
    main?: unknown
  }
  let target: unknown
  const root =
    typeof manifest.exports === 'object' && manifest.exports !== null
      ? (manifest.exports as Record<string, unknown>)['.']
      : manifest.exports
  if (typeof root === 'string') target = root
  else if (typeof root === 'object' && root !== null) {
    const conditions = root as Record<string, unknown>
    target = conditions.import ?? conditions.default
  }
  target ??= manifest.module ?? manifest.main
  if (typeof target !== 'string' || target === '') {
    throw new Error(`${join(directory, 'package.json')}: ${packageName} declares no import entry`)
  }
  const path = resolve(directory, target)
  if (relative(directory, path).startsWith('..')) {
    throw new Error(`${packageName}'s entry ${target} lies outside the package`)
  }
  try {
    await lstat(path)
  } catch {
    throw new Error(`${packageName}'s entry ${path} does not exist`)
  }
  return path
}

/** Single self-contained ESM bundle of the plugin's entrypoint for the Bun
 * runtime. The plugin-sdk closure inlines; node builtins stay external. */
async function buildBundle(entry: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [entry],
    target: 'bun',
    format: 'esm',
    sourcemap: 'none',
    minify: false,
  })
  if (!result.success) {
    const details = result.logs
      .map((log) => (typeof log === 'string' ? log : `${log.level}: ${log.message}`))
      .join('\n')
    throw new Error(`bundling ${entry} failed:\n${details}`)
  }
  const script = result.outputs.find((artifact) => artifact.path.endsWith('.js'))
  if (script === undefined) {
    throw new Error(`bundling ${entry} produced no JavaScript output`)
  }
  return await script.text()
}

async function traceFiles(trace: string): Promise<string[]> {
  let raw: string
  try {
    raw = await readFile(trace, 'utf8')
  } catch {
    throw new Error(
      `missing Next.js trace file ${trace} — run this step after \`next build\`; ` +
        'if the dispatch route was renamed, update ship-provider-plugin.ts in @defrex/autobuild-hosted-dispatcher',
    )
  }
  const parsed: unknown = JSON.parse(raw)
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as { files?: unknown }).files)
  ) {
    throw new Error(`unexpected trace file layout in ${trace}: "files" array not found`)
  }
  return (parsed as { files: string[] }).files
}

/** The default tracing root: `AB_SERVICE_BUILD_ROOT` (what the published
 * build passes Next), else the workspace root above the project, else the
 * project itself. */
export async function defaultTraceRoot(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const explicit = env.AB_SERVICE_BUILD_ROOT?.trim()
  if (explicit) return resolve(explicit)
  return findWorkspaceRoot(cwd).catch(() => resolve(cwd))
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  )
}

/** Bundle each plugin, stage it under the installed distribution's
 * `node_modules`, validate it, and append the staged files to the dispatch
 * route's trace. */
export async function shipProviderPlugins({
  cwd = process.cwd(),
  distDir = '.next',
  packages,
  rule = 'flag',
  distributionRoot = installedDistributionRoot(),
  traceRoot,
  restoreInstall = false,
  log = (message) => console.log(message),
}: ShipProviderPluginsOptions): Promise<ShipProviderPluginResult[]> {
  const project = await realpath(cwd)
  const tracing = await realpath(traceRoot ?? (await defaultTraceRoot(project)))
  const installation = await realpath(distributionRoot)
  const trace = join(project, distDir, ROUTE_DIRECTORY, TRACE_FILE)
  // Fail on a missing trace before touching node_modules.
  await traceFiles(trace)
  const results: ShipProviderPluginResult[] = []
  for (const packageName of packages) {
    const selected = `selected by ${describeSelectionRule(rule)}`
    const staging = join(installation, 'node_modules', ...packageName.split('/'))
    if (relative(tracing, staging).startsWith('..')) {
      throw new Error(
        `cannot ship ${packageName}: its staging directory ${staging} lies outside the ` +
          `output-file-tracing root ${tracing}`,
      )
    }

    // Source: the deployment's own installation, unless that resolves onto a
    // staged bundle (a source checkout re-run).
    const installed = await findInstalledPackage(project, packageName)
    if (installed === null) {
      throw new Error(
        `provider plugin ${packageName} is not installed in the deployment (${selected})`,
      )
    }
    let source = await realpath(installed)
    const installedAtStaging = resolve(installed) === staging
    let healLink = false
    if (await isStagedBundle(source, installedAtStaging)) {
      source = await resolvePackageSourceDirectory(await findWorkspaceRoot(project), packageName)
      healLink = installedAtStaging
    }
    const sourceManifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as {
      name?: unknown
      version?: unknown
    }
    if (typeof sourceManifest.name !== 'string' || typeof sourceManifest.version !== 'string') {
      throw new Error(`${join(source, 'package.json')} must declare name and version`)
    }
    const bundle = await buildBundle(await entryFile(source, packageName))

    // What may already sit at the staging path: nothing, a staged bundle, or
    // the source checkout's workspace symlink. Never an installed package.
    const existing = await lstat(staging).catch(() => undefined)
    let linkTarget: string | undefined
    if (existing?.isSymbolicLink()) {
      linkTarget = await readlink(staging)
    } else if (existing !== undefined && !(await isStagedBundle(staging, true))) {
      throw new Error(`refusing to replace installed package at ${staging} (${packageName})`)
    }
    const created = [join(installation, 'node_modules'), dirname(staging)].filter(
      (path, index, all) => all.indexOf(path) === index && path !== staging,
    )
    const createdHere: string[] = []
    for (const path of created) if (!(await exists(path))) createdHere.push(path)
    if (existing !== undefined) await rm(staging, { recursive: true, force: true })

    const stagedManifest = {
      name: sourceManifest.name,
      version: sourceManifest.version,
      type: 'module',
      exports: { '.': './dist/index.js' },
      [STAGED_MARKER]: true,
    }
    const stagedFiles = [
      { name: 'package.json', contents: `${JSON.stringify(stagedManifest, null, 2)}\n` },
      { name: join('dist', 'index.js'), contents: bundle },
    ]
    try {
      await mkdir(join(staging, 'dist'), { recursive: true })
      for (const file of stagedFiles) await writeFile(join(staging, file.name), file.contents)
      const bytes = stagedFiles.reduce((total, file) => total + Buffer.byteLength(file.contents), 0)

      let namespace: { default?: unknown }
      try {
        namespace = await import(pathToFileURL(join(staging, 'dist', 'index.js')).href)
        parsePluginManifest(namespace.default)
      } catch (error) {
        throw new Error(
          `${packageName} is not an Autobuild plugin (${selected}): ` +
            (error instanceof Error ? error.message : String(error)),
        )
      }

      const files = await traceFiles(trace)
      const entries = stagedFiles.map((file) => relative(dirname(trace), join(staging, file.name)))
      const missing = entries.filter((entry) => !files.includes(entry))
      if (missing.length > 0) {
        const parsed = JSON.parse(await readFile(trace, 'utf8'))
        await writeFile(
          trace,
          `${JSON.stringify({ ...parsed, files: [...files, ...missing] }, null, 2)}\n`,
        )
      }
      log(
        `plugin package ${packageName} (${bytes} bytes, ${stagedFiles.length} file(s)) staged at ${staging}; ` +
          `${missing.length > 0 ? `appended ${missing.length} entr${missing.length === 1 ? 'y' : 'ies'} to` : 'already present in'} ${trace}`,
      )
      results.push({
        packageName,
        source,
        staging,
        traceEntries: entries,
        appended: missing.length,
        bytes,
        restored: false,
      })
    } finally {
      if (restoreInstall) {
        // A local run leaves the installation as `bun install` had it: the
        // workspace symlink back in place, or no trace of the staging.
        await rm(staging, { recursive: true, force: true })
        if (linkTarget !== undefined || healLink) {
          const target = linkTarget ?? relative(dirname(staging), source)
          await symlink(target, staging, 'dir')
          log(
            `restored workspace symlink ${staging} -> ${target} (local run, no VERCEL environment)`,
          )
        } else {
          for (const path of createdHere.reverse()) await rmdir(path).catch(() => {})
          log(`removed staged ${staging} (local run, no VERCEL environment)`)
        }
        const last = results.at(-1)
        if (last?.packageName === packageName) last.restored = true
      }
    }
  }
  return results
}
