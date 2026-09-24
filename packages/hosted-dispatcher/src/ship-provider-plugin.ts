#!/usr/bin/env bun
/**
 * Ship the provider plugin package into the hosted deployment (AUT-517).
 *
 * A bare package specifier resolves only through a `node_modules/` path, so
 * appending the plugin's source files to the dispatch route's trace alone
 * cannot make `@defrex/autobuild-vercel-sandbox` resolvable inside the
 * deployed `/api/dispatch` function (build extract-the-vercel,
 * finding f_0b59ab99). The runtime resolution root is `distributionRoot()`,
 * which — derived from this repository's own compiled Turbopack output — is
 * the REPOSITORY ROOT, not the Next project directory: the chunk holding
 * `distribution.ts` synthesizes `import.meta.url` from the source path and
 * resolves its absolute root six file-relative ups from the runtime chunk
 * (`<repoRoot>/packages/hosted-store-service/.next/server/chunks/`), which is
 * the repository root. `loadPlugins` therefore resolves bare specifiers
 * against `<repoRoot>/node_modules`.
 *
 * The deployment's repo-root `node_modules` carries no `@defrex/autobuild`
 * either (the trace has zero `@defrex` entries — core is Turbopack-inlined),
 * so this step stages a self-contained `bun build` bundle of the plugin: the
 * bundle inlines the plugin-sdk closure (the shared capability object, its
 * validators, and transitive dependencies including `@vercel/sandbox`) and
 * evaluates with zero external module imports; node builtins stay external.
 *
 * Staging targets `<repoRoot>/node_modules/@defrex/autobuild-vercel-sandbox/`
 * and every staged file is appended to the dispatch route's
 * `route.js.nft.json` computed relative to the trace file's directory — six
 * ups to the repository root, the same depth class as the trace's existing
 * `node_modules/.bun/**` entries. It fails loudly when the package, bundle
 * input, or trace is missing, so a deployment can never silently ship
 * without the plugin. Idempotent: a re-run appends nothing.
 *
 * The npm published package remains the real `src` — only the deployment
 * stages the bundle. Staged files are build-time artifacts under
 * `node_modules` (gitignored, never committed).
 */
import { lstat, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

export interface ShipProviderPluginOptions {
  /** Working directory the repository root is derived from; deploy:build
   * runs in the Next project directory. */
  cwd?: string
  /** Next build output directory under the project directory. */
  distDir?: string
  /** The plugin package specifier to stage. */
  packageName?: string
  log?: (message: string) => void
}

export interface ShipProviderPluginResult {
  repoRoot: string
  /** Directory the bundle was staged into (absolute). */
  staging: string
  /** Staged files appended to (or already present in) the trace, relative to
   * the trace file's directory — exactly the strings written into `files`. */
  traceEntries: string[]
  appended: number
  bytes: number
}

const TRACE_FILE = 'route.js.nft.json'
const ROUTE_DIRECTORY = join('server', 'app', 'api', 'dispatch')

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

/** Directory of the installed plugin package, resolved from the repository
 * root's own installation (the workspace link during deploy builds). */
async function resolvePackageDirectory(repoRoot: string, packageName: string): Promise<string> {
  let entry: string
  try {
    entry = Bun.resolveSync(packageName, repoRoot)
  } catch (error) {
    throw new Error(
      `plugin package "${packageName}" is not resolvable from the repository root ` +
        `${repoRoot} — is the workspace link present (bun install)? ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  let current = dirname(resolve(entry))
  while (true) {
    try {
      const manifest = JSON.parse(await readFile(join(current, 'package.json'), 'utf8')) as {
        name?: unknown
      }
      if (manifest.name === packageName) return current
    } catch {
      // Keep walking up.
    }
    const parent = dirname(current)
    if (parent === current) {
      throw new Error(`resolved entry "${entry}" has no owning package.json named "${packageName}"`)
    }
    current = parent
  }
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
      `missing Next.js trace file ${trace} — run this tool after \`next build\`; ` +
        'if the dispatch route was renamed, update packages/hosted-dispatcher/src/ship-provider-plugin.ts',
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

/** Bundle the provider plugin, stage it into the repository-root
 * `node_modules`, and append the staged files to the dispatch route's trace. */
export async function shipProviderPlugin({
  cwd = process.cwd(),
  distDir = '.next',
  packageName = '@defrex/autobuild-vercel-sandbox',
  log = (message) => console.log(message),
}: ShipProviderPluginOptions = {}): Promise<ShipProviderPluginResult> {
  const repoRoot = await findWorkspaceRoot(cwd)
  const packageDirectory = await resolvePackageDirectory(repoRoot, packageName)
  const packageManifest = JSON.parse(
    await readFile(join(packageDirectory, 'package.json'), 'utf8'),
  ) as { name?: unknown; version?: unknown }
  if (typeof packageManifest.name !== 'string' || typeof packageManifest.version !== 'string') {
    throw new Error(`${join(packageDirectory, 'package.json')} must declare name and version`)
  }

  const bundle = await buildBundle(join(packageDirectory, 'src', 'index.ts'))

  // Stage into the repository-root node_modules. bun install leaves a
  // workspace symlink there for the root devDependency; a real staged
  // directory must replace it (the deployment never runs bun install again,
  // and a later local bun install restores the symlink harmlessly).
  const staging = join(repoRoot, 'node_modules', ...packageName.split('/'))
  const existing = await lstat(staging).catch(() => undefined)
  if (existing?.isSymbolicLink()) {
    await rm(staging)
  }
  await mkdir(join(staging, 'dist'), { recursive: true })
  const stagedManifest = {
    name: packageManifest.name,
    version: packageManifest.version,
    type: 'module',
    exports: { '.': './dist/index.js' },
  }
  const stagedFiles = [
    { name: 'package.json', contents: `${JSON.stringify(stagedManifest, null, 2)}\n` },
    { name: join('dist', 'index.js'), contents: bundle },
  ]
  for (const file of stagedFiles) {
    await writeFile(join(staging, file.name), file.contents)
  }
  const bytes = stagedFiles.reduce((total, file) => total + Buffer.byteLength(file.contents), 0)

  const trace = join(cwd, distDir, ROUTE_DIRECTORY, TRACE_FILE)
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
    `plugin package ${packageName} (${bytes} bytes, ${stagedFiles.length} file(s)) ` +
      `${missing.length > 0 ? `appended ${missing.length} entr${missing.length === 1 ? 'y' : 'ies'} to` : 'already present in'} ${trace}`,
  )
  return { repoRoot, staging, traceEntries: entries, appended: missing.length, bytes }
}

if (import.meta.main) {
  try {
    await shipProviderPlugin()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
