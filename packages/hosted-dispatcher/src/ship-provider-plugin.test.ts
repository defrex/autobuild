import { afterEach, describe, expect, test } from 'bun:test'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parsePluginManifest } from '@defrex/autobuild/plugin-sdk'
import { shipProviderPlugin } from './ship-provider-plugin'

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const REAL_ROOT = resolve(import.meta.dir, '..', '..', '..')
const TRACE_DIRECTORY = join('.next', 'server', 'app', 'api', 'dispatch')
const PACKAGE_NAME = '@defrex/autobuild-vercel-sandbox'

/** A fixture workspace root whose node_modules links the real plugin package,
 * plus a Next project directory holding a trace file. Mirrors the deployed
 * layout: `<root>/packages/hosted-store-service/.next/server/app/api/dispatch/
 * route.js.nft.json`, staged files six directory levels below the root. */
async function fixture(traceFiles?: string[]): Promise<{ root: string; project: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ab-ship-plugin-'))
  temporary.push(root)
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', workspaces: ['packages/*'] }),
  )
  const project = join(root, 'packages', 'hosted-store-service')
  await mkdir(join(project, TRACE_DIRECTORY), { recursive: true })
  await writeFile(
    join(project, TRACE_DIRECTORY, 'route.js.nft.json'),
    JSON.stringify({ version: 1, files: traceFiles ?? ['/absolutely/not/real.js'] }),
  )
  await mkdir(join(root, 'node_modules', '@defrex'), { recursive: true })
  await symlink(
    join(REAL_ROOT, 'packages', 'vercel-sandbox'),
    join(root, 'node_modules', '@defrex', 'autobuild-vercel-sandbox'),
    'dir',
  )
  return { root, project }
}

describe('ship-provider-plugin', () => {
  test('stages a self-contained bundle and appends it at the repository-root depth', async () => {
    const { root, project } = await fixture()
    const lines: string[] = []
    const result = await shipProviderPlugin({ cwd: project, log: (m) => lines.push(m) })
    expect(result.repoRoot).toBe(root)

    // The staged module must be self-contained: zero external module imports
    // (node builtins excepted) — the deployment's repo-root node_modules
    // carries no @defrex/autobuild and nothing else the closure needs.
    const bundle = await readFile(join(result.staging, 'dist', 'index.js'), 'utf8')
    const imports = [...bundle.matchAll(/^import\s+[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
    const external = imports.filter(
      (specifier) => !specifier.startsWith('node:') && !builtinModules.includes(specifier),
    )
    expect(external).toEqual([])
    expect(bundle).toContain('autobuild-vercel-sandbox')

    // Staged package.json is minimal and points at the bundle.
    const stagedManifest = JSON.parse(
      await readFile(join(result.staging, 'package.json'), 'utf8'),
    ) as { name?: string; exports?: Record<string, string> }
    expect(stagedManifest.name).toBe(PACKAGE_NAME)
    expect(stagedManifest.exports?.['.']).toBe('./dist/index.js')

    // Trace entries are relative to the trace file's directory and reach the
    // repository root in exactly six ups — the same depth class as the
    // trace's existing node_modules/.bun/** entries, and the root the
    // compiled distributionRoot() resolves.
    const tracePath = join(project, TRACE_DIRECTORY, 'route.js.nft.json')
    const { files } = JSON.parse(await readFile(tracePath, 'utf8'))
    const stagedPaths = new Set(['package.json', join('dist', 'index.js')])
    expect(result.traceEntries).toHaveLength(2)
    for (const entry of result.traceEntries) {
      expect(files).toContain(entry)
      // Six ups to the repository root: the same depth class as the trace's
      // existing node_modules/.bun/** entries, and the root the compiled
      // distributionRoot() resolves.
      expect(entry.split('/node_modules')[0].split('../').length - 1).toBe(6)
      const resolvedEntry = resolve(join(tracePath, '..'), entry)
      expect(resolvedEntry.startsWith(result.staging)).toBe(true)
      expect(stagedPaths.has(resolvedEntry.slice(result.staging.length + 1))).toBe(true)
    }
    expect(result.appended).toBe(2)
    expect(result.bytes).toBeGreaterThan(0)
    expect(lines.join('\n')).toContain('appended 2 entries to')
  }, 60_000)

  test('is idempotent: a re-run appends nothing and leaves the trace unchanged', async () => {
    const { project } = await fixture()
    await shipProviderPlugin({ cwd: project, log: () => {} })
    const tracePath = join(project, TRACE_DIRECTORY, 'route.js.nft.json')
    const before = await readFile(tracePath, 'utf8')
    const result = await shipProviderPlugin({ cwd: project, log: () => {} })
    expect(result.appended).toBe(0)
    expect(await readFile(tracePath, 'utf8')).toBe(before)
  }, 60_000)

  test('throws loudly when the plugin package is not resolvable from the root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ab-ship-plugin-'))
    temporary.push(root)
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', workspaces: ['packages/*'] }),
    )
    const project = join(root, 'packages', 'hosted-store-service')
    await mkdir(join(project, TRACE_DIRECTORY), { recursive: true })
    await writeFile(join(project, TRACE_DIRECTORY, 'route.js.nft.json'), '{"version":1,"files":[]}')
    await expect(shipProviderPlugin({ cwd: project, log: () => {} })).rejects.toThrow(
      /not resolvable from the repository root/,
    )
  })

  test('throws loudly when the trace file is missing', async () => {
    const { root, project } = await fixture()
    await rm(join(project, TRACE_DIRECTORY), { recursive: true })
    await expect(shipProviderPlugin({ cwd: project, log: () => {} })).rejects.toThrow(
      /missing Next\.js trace file/,
    )
    expect(root).toBeDefined()
  }, 60_000)

  test('the staged bundle evaluates in isolation at the compiled resolution root', async () => {
    // Reproduces the deployed condition in isolation: a temp directory T laid
    // out as the compiled function bundle is, with the staged plugin in
    // T/node_modules and NO @defrex/autobuild package anywhere on the
    // resolution path. The resolution root is the one the compiled runtime
    // yields: six file-relative ups from the runtime chunk
    // (<repoRoot>/packages/hosted-store-service/.next/server/chunks/
    // [turbopack]_runtime.js — RUNTIME_PUBLIC_PATH three ups plus
    // RELATIVE_ROOT_PATH three ups; import.meta.url is synthesized from the
    // source path), which is T itself.
    const { project } = await fixture()
    const staged = await shipProviderPlugin({ cwd: project, log: () => {} })

    const isolated = await mkdtemp(join(tmpdir(), 'ab-plugin-isolated-'))
    temporary.push(isolated)
    const chunks = join(isolated, 'packages', 'hosted-store-service', '.next', 'server', 'chunks')
    await mkdir(chunks, { recursive: true })
    const chunkFile = join(chunks, '[turbopack]_runtime.js')
    await writeFile(chunkFile, '// placeholder for the compiled runtime chunk')
    const stagedDirectory = join(isolated, 'node_modules', '@defrex', 'autobuild-vercel-sandbox')
    await mkdir(join(stagedDirectory, 'dist'), { recursive: true })
    await copyFile(join(staged.staging, 'package.json'), join(stagedDirectory, 'package.json'))
    await copyFile(
      join(staged.staging, 'dist', 'index.js'),
      join(stagedDirectory, 'dist', 'index.js'),
    )

    const resolutionRoot = resolve(chunkFile, '..', '..', '..', '..', '..', '..')
    expect(resolutionRoot).toBe(isolated)
    const resolved = Bun.resolveSync(PACKAGE_NAME, resolutionRoot)
    expect(resolved).toBe(join(stagedDirectory, 'dist', 'index.js'))
    // The test runs the staged bundle — never the in-repo source — so
    // workspace self-reference cannot mask a missing runtime import.
    const namespace = (await import(pathToFileURL(resolved).href)) as { default: unknown }
    const parsed = parsePluginManifest(namespace.default)
    expect(parsed.name).toBe('autobuild-vercel-sandbox')
    expect(Object.keys(parsed.workspaceProviders ?? {})).toEqual(['vercel-sandbox'])
  }, 60_000)
})
