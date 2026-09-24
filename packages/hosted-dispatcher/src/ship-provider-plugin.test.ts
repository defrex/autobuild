import { afterEach, describe, expect, test } from 'bun:test'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parsePluginManifest } from '@defrex/autobuild/plugin-sdk'
import { restoresWorkspaceLinkIn, shipProviderPlugin } from './ship-provider-plugin'

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const REAL_ROOT = resolve(import.meta.dir, '..', '..', '..')
const TRACE_DIRECTORY = join('.next', 'server', 'app', 'api', 'dispatch')
const PACKAGE_NAME = '@defrex/autobuild-vercel-sandbox'

/** A fixture workspace root with a real `packages/vercel-sandbox` workspace
 * member (its `src/index.ts` symlinks to the REAL package source, so staged
 * bundles inline the genuine plugin-sdk closure), plus a Next project
 * directory holding a trace file. Mirrors the deployed layout:
 * `<root>/packages/hosted-store-service/.next/server/app/api/dispatch/
 * route.js.nft.json`, staged files six directory levels below the root. The
 * source member is found through the workspace tree, never node_modules
 * (finding f_5b9ade16) — so no node_modules link is needed here. */
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
  const member = join(root, 'packages', 'vercel-sandbox')
  await mkdir(join(member, 'src'), { recursive: true })
  await writeFile(
    join(member, 'package.json'),
    JSON.stringify({ name: PACKAGE_NAME, version: '0.8.0', type: 'module' }),
  )
  await symlink(
    join(REAL_ROOT, 'packages', 'vercel-sandbox', 'src', 'index.ts'),
    join(member, 'src', 'index.ts'),
    'file',
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
    const imports = [...bundle.matchAll(/^import\s+[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]!)
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
      expect(entry.split('/node_modules')[0]!.split('../').length - 1).toBe(6)
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

  test('stages correctly when node_modules already holds a staged directory instead of the workspace link', async () => {
    // The state a SECOND deploy build sees in a fresh process (finding
    // f_5b9ade16): the first run replaced the workspace symlink with the
    // staged bundle and `bun install` does not relink a pre-existing
    // directory. Bun's in-process module-resolution cache masks this state
    // from same-process re-runs, so the fixture starts here without any
    // symlink — node_modules holds a real staged-looking directory — and
    // the run must still locate the SOURCE through the workspace tree and
    // bundle it, never the staged dist/index.js.
    const { root, project } = await fixture()
    const staged = join(root, 'node_modules', '@defrex', 'autobuild-vercel-sandbox')
    await rm(staged, { recursive: true, force: true })
    await mkdir(join(staged, 'dist'), { recursive: true })
    await writeFile(
      join(staged, 'package.json'),
      JSON.stringify({
        name: PACKAGE_NAME,
        version: '0.0.0-stale',
        type: 'module',
        exports: { '.': './dist/index.js' },
      }),
    )
    await writeFile(join(staged, 'dist', 'index.js'), '// stale staged bundle, not the source')

    const result = await shipProviderPlugin({ cwd: project, log: () => {} })
    expect(result.staging).toBe(staged)
    // Re-staged from the real source: the stale manifest version is gone and
    // the bundle is the real plugin, not the stale placeholder.
    const manifest = JSON.parse(await readFile(join(staged, 'package.json'), 'utf8')) as {
      version?: string
    }
    expect(manifest.version).not.toBe('0.0.0-stale')
    const bundle = await readFile(join(staged, 'dist', 'index.js'), 'utf8')
    expect(bundle).not.toBe('// stale staged bundle, not the source')
    expect(bundle).toContain('autobuild-vercel-sandbox')
    expect(result.appended).toBe(2)
  }, 60_000)

  test('a second run in a FRESH process succeeds after the first consumed the workspace link', async () => {
    // Direct reproduction of the finding: two separate processes against one
    // fixture. Run 1 stages over the symlink; run 2 (new process, no cached
    // module resolution) must not abort with ENOENT on <staging>/src.
    // VERCEL is pinned ON so both runs exercise the DEPLOYMENT branch (the
    // staged bundle persists into the function bundle) — the ambient
    // environment must not decide which branch a test exercises.
    const { project } = await fixture()
    const script = join(import.meta.dir, 'ship-provider-plugin.ts')
    for (let run = 1; run <= 2; run++) {
      const spawn = Bun.spawnSync({
        cmd: ['bun', script],
        cwd: project,
        env: { ...process.env, VERCEL: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(spawn.exitCode).toBe(0)
      const output = `${spawn.stdout.toString()}${spawn.stderr.toString()}`
      expect(output).toContain(run === 1 ? 'appended 2 entries to' : 'already present in')
      expect(output).not.toContain('restored workspace symlink')
    }
  }, 120_000)

  test('a fresh process WITHOUT VERCEL restores the workspace symlink (local run)', async () => {
    // The developer-local path end-to-end: the CLI decides the restore from
    // the environment, so the subprocess env explicitly OMITS VERCEL (a copy
    // of process.env with VERCEL deleted — never the ambient environment,
    // which differs between the sandbox and a developer machine). The run
    // must leave the node_modules path a directory symlink to the workspace
    // member, exactly as `bun install` would have left it.
    const { root, project } = await fixture()
    const staged = join(root, 'node_modules', '@defrex', 'autobuild-vercel-sandbox')
    const script = join(import.meta.dir, 'ship-provider-plugin.ts')
    const { VERCEL: _omit, ...env } = process.env
    expect('VERCEL' in env).toBe(false)
    const spawn = Bun.spawnSync({
      cmd: ['bun', script],
      cwd: project,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const output = `${spawn.stdout.toString()}${spawn.stderr.toString()}`
    expect(spawn.exitCode).toBe(0)
    expect(output).toContain('restored workspace symlink')
    expect((await lstat(staged)).isSymbolicLink()).toBe(true)
    // Assert on the RESOLVED target, not the raw link string: a dangling
    // relative target is the failure class this must catch.
    expect(await realpath(staged)).toBe(join(root, 'packages', 'vercel-sandbox'))
    // The trace still describes the deployment layout (the staged files are
    // appended there whether or not they persist locally).
    const { files } = JSON.parse(
      await readFile(join(project, TRACE_DIRECTORY, 'route.js.nft.json'), 'utf8'),
    )
    expect(files.filter((entry: string) => entry.includes('node_modules'))).toHaveLength(2)
  }, 120_000)

  test('restoreWorkspaceLink restores the workspace symlink after staging', async () => {
    const { root, project } = await fixture()
    const staged = join(root, 'node_modules', '@defrex', 'autobuild-vercel-sandbox')
    const lines: string[] = []
    const result = await shipProviderPlugin({
      cwd: project,
      restoreWorkspaceLink: true,
      log: (m) => lines.push(m),
    })
    expect(result.restoredWorkspaceLink).toBe(true)
    expect((await lstat(staged)).isSymbolicLink()).toBe(true)
    // The resolved target is the fixture's packages/vercel-sandbox member —
    // the assertion that catches a dangling relative target (the link must
    // resolve, not merely exist).
    expect(await realpath(staged)).toBe(join(root, 'packages', 'vercel-sandbox'))
    // The trace file still contains the appended entries — the trace
    // describes the deployment layout; it does not require the staged files
    // to persist locally.
    const { files } = JSON.parse(
      await readFile(join(project, TRACE_DIRECTORY, 'route.js.nft.json'), 'utf8'),
    )
    expect(result.traceEntries.every((entry) => files.includes(entry))).toBe(true)
    expect(lines.join('\n')).toContain('restored workspace symlink')
  }, 60_000)

  test('restoreWorkspaceLink heals a poisoned checkout (staged directory, no symlink)', async () => {
    // The state an already-bitten developer's checkout is in: a previous
    // deploy:build left a real staged directory in node_modules and `bun
    // install` never relinked it. A local run must still end with the
    // workspace symlink restored.
    const { root, project } = await fixture()
    const staged = join(root, 'node_modules', '@defrex', 'autobuild-vercel-sandbox')
    await mkdir(join(staged, 'dist'), { recursive: true })
    await writeFile(
      join(staged, 'package.json'),
      JSON.stringify({ name: PACKAGE_NAME, version: '0.0.0-stale' }),
    )
    const result = await shipProviderPlugin({
      cwd: project,
      restoreWorkspaceLink: true,
      log: () => {},
    })
    expect(result.restoredWorkspaceLink).toBe(true)
    expect((await lstat(staged)).isSymbolicLink()).toBe(true)
    expect(await realpath(staged)).toBe(join(root, 'packages', 'vercel-sandbox'))
  }, 60_000)

  test('restoresWorkspaceLinkIn gates on the VERCEL environment variable', () => {
    // Vercel sets VERCEL in every build environment — including a local
    // `vercel build` — so a deployment build keeps the staged bundle.
    expect(restoresWorkspaceLinkIn({ VERCEL: '1' })).toBe(false)
    expect(restoresWorkspaceLinkIn({ VERCEL: 'production' })).toBe(false)
    // A plain local `bun run deploy:build` has no VERCEL and restores.
    expect(restoresWorkspaceLinkIn({})).toBe(true)
  })

  test('throws loudly when the plugin package is not a workspace member of the root', async () => {
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
      /not found in the workspace tree/,
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

  test('the loader resolves the staged plugin from the traced function layout with the installer disabled (AUT-587)', async () => {
    // The same-layout bound of AUT-587's AC#3, in a `bun --no-install`
    // subprocess: with the installer disabled, ONLY the traced layout can
    // satisfy the bare specifier — the staged package at the six-up
    // repository-root `node_modules` the compiled `distributionRoot()`
    // yields. This is the condition the failed deployment could not meet:
    // loading the plugin from disk inside the function, under a
    // no-install/process-safe loader. Mirrors the deployed call shape
    // (dispatch's `loadPlugins(config.plugins, targetRepo)`): the scratch
    // repository root is the repository candidate (no plugin there), the
    // isolated tree is the installation root the compiled chunk derives.
    const { project } = await fixture()
    const staged = await shipProviderPlugin({ cwd: project, log: () => {} })

    const isolated = await mkdtemp(join(tmpdir(), 'ab-plugin-isolated-'))
    temporary.push(isolated)
    const chunks = join(isolated, 'packages', 'hosted-store-service', '.next', 'server', 'chunks')
    await mkdir(chunks, { recursive: true })
    await writeFile(join(chunks, '[turbopack]_runtime.js'), '// placeholder runtime chunk')
    const stagedDirectory = join(isolated, 'node_modules', '@defrex', 'autobuild-vercel-sandbox')
    await mkdir(join(stagedDirectory, 'dist'), { recursive: true })
    await copyFile(join(staged.staging, 'package.json'), join(stagedDirectory, 'package.json'))
    await copyFile(
      join(staged.staging, 'dist', 'index.js'),
      join(stagedDirectory, 'dist', 'index.js'),
    )

    // The deployment's dispatch call: packageRoot = the (config-only) target
    // repository, installationRoot = distributionRoot() derived from the
    // compiled chunk — the six-up root, here the isolated tree.
    const scratch = await mkdtemp(join(tmpdir(), 'ab-plugin-scratch-'))
    temporary.push(scratch)
    const runner = join(scratch, 'runner.ts')
    await writeFile(
      runner,
      `import { diagnosePlugins } from ${JSON.stringify(join(REAL_ROOT, 'packages', 'core', 'src', 'plugins', 'load.ts'))}
const diagnosis = await diagnosePlugins([${JSON.stringify(PACKAGE_NAME)}], process.argv[2]!, {
  installationRoot: process.env.AB_INSTALLATION_ROOT,
})
console.log(JSON.stringify({ reports: diagnosis.reports, healthy: diagnosis.healthy }))
`,
    )
    const spawn = Bun.spawnSync({
      cmd: ['bun', '--no-install', runner, scratch],
      cwd: isolated,
      env: { ...process.env, AB_INSTALLATION_ROOT: isolated },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const output = `${spawn.stdout.toString()}${spawn.stderr.toString()}`
    expect(spawn.exitCode).toBe(0)
    const { reports, healthy } = JSON.parse(spawn.stdout.toString()) as {
      reports: Array<{
        resolved?: string
        resolvedFrom?: string
        status: string
        stage: string
        notice?: string
      }>
      healthy: boolean
    }
    expect(reports).toHaveLength(1)
    expect(reports[0]?.status).toBe('skipped')
    expect(reports[0]?.stage).toBe('registration')
    expect(reports[0]?.resolved).toBe(join(stagedDirectory, 'dist', 'index.js'))
    expect(reports[0]?.resolvedFrom).toBe('installation')
    expect(reports[0]?.notice).toContain('declares only builtin workspace-provider registration(s)')
    expect(healthy).toBe(true)
    expect(output).not.toContain('unable to write files')
  }, 120_000)
})
