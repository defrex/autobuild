import { afterEach, describe, expect, test } from 'bun:test'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parsePluginManifest, PLUGIN_API_VERSION } from '@defrex/autobuild/plugin-sdk'
import {
  restoresInstallIn,
  shipProviderPlugins,
  type ShipProviderPluginsOptions,
} from './ship-provider-plugin'

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const REAL_ROOT = resolve(import.meta.dir, '..', '..', '..')
const TRACE_DIRECTORY = join('.next', 'server', 'app', 'api', 'dispatch')
const PACKAGE_NAME = '@defrex/autobuild-vercel-sandbox'
const TINY = '@fixture/tiny-plugin'

async function temp(prefix: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  temporary.push(path)
  return path
}

async function writeTrace(project: string, files: string[] = ['/absolutely/not/real.js']) {
  await mkdir(join(project, TRACE_DIRECTORY), { recursive: true })
  await writeFile(
    join(project, TRACE_DIRECTORY, 'route.js.nft.json'),
    JSON.stringify({ version: 1, files }),
  )
}

async function traceOf(project: string): Promise<string[]> {
  return JSON.parse(await readFile(join(project, TRACE_DIRECTORY, 'route.js.nft.json'), 'utf8'))
    .files
}

/** Every path under `root`, with symlinks reported (not followed). */
async function tree(root: string): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    result.push(`${relative(root, path)}${entry.isSymbolicLink() ? '@' : ''}`)
    if (entry.isDirectory())
      result.push(...(await tree(path)).map((child) => join(entry.name, child)))
  }
  return result.sort()
}

/** A plugin package directory. The real Vercel Sandbox plugin links its
 * source (so staged bundles inline the genuine plugin-sdk closure); the tiny
 * plugin default-exports a minimal manifest with no imports. */
async function pluginPackage(directory: string, name: string, body?: string) {
  await mkdir(join(directory, 'src'), { recursive: true })
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({
      name,
      version: '0.8.0',
      type: 'module',
      exports: { '.': { types: './src/index.ts', import: './src/index.ts' } },
      peerDependencies: { '@defrex/autobuild': '*' },
    }),
  )
  if (name === PACKAGE_NAME && body === undefined) {
    await symlink(
      join(REAL_ROOT, 'packages', 'vercel-sandbox', 'src', 'index.ts'),
      join(directory, 'src', 'index.ts'),
      'file',
    )
  } else {
    await writeFile(
      join(directory, 'src', 'index.ts'),
      body ?? `export default { name: 'tiny', apiVersion: '${PLUGIN_API_VERSION}' }\n`,
    )
  }
}

/** The source checkout: a workspace root with a `packages/vercel-sandbox`
 * member linked from the root `node_modules` as `bun install` leaves it, and
 * a Next project at `packages/hosted-store-service`. The distribution root is
 * the repository root. */
async function sourceFixture(): Promise<{ root: string; project: string; link: string }> {
  const root = await temp('ab-ship-plugin-')
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', workspaces: ['packages/*'] }),
  )
  const project = join(root, 'packages', 'hosted-store-service')
  await writeTrace(project)
  await pluginPackage(join(root, 'packages', 'vercel-sandbox'), PACKAGE_NAME)
  const link = join(root, 'node_modules', '@defrex', 'autobuild-vercel-sandbox')
  await mkdir(dirname(link), { recursive: true })
  await symlink(join('..', '..', 'packages', 'vercel-sandbox'), link, 'dir')
  return { root, project, link }
}

/** Bun's isolated-linker install: `node_modules/<pkg>` links into
 * `node_modules/.bun/<pkg>@v/node_modules/<pkg>`, and the installed
 * `@defrex/autobuild` lives under `.bun` too. `installRoot` holds
 * `node_modules`; `project` is the Next project folder. */
async function installedFixture(
  installRoot: string,
  project: string,
  name = TINY,
  body?: string,
): Promise<{ distributionRoot: string; link: string }> {
  const modules = join(installRoot, 'node_modules')
  const store = join(modules, '.bun', `${name.replace('/', '+')}@0.8.0`, 'node_modules', name)
  await pluginPackage(store, name, body)
  const link = join(modules, ...name.split('/'))
  await mkdir(dirname(link), { recursive: true })
  await symlink(relative(dirname(link), store), link, 'dir')
  const distributionRoot = join(
    modules,
    '.bun',
    '@defrex+autobuild@1.0.0',
    'node_modules',
    '@defrex',
    'autobuild',
  )
  await mkdir(distributionRoot, { recursive: true })
  await writeFile(
    join(distributionRoot, 'package.json'),
    JSON.stringify({ name: '@defrex/autobuild', version: '1.0.0' }),
  )
  await writeTrace(project)
  return { distributionRoot, link }
}

const ship = (options: Omit<ShipProviderPluginsOptions, 'log'>) =>
  shipProviderPlugins({ log: () => {}, ...options })

describe('ship-provider-plugin: source checkout', () => {
  test('stages a self-contained bundle over the workspace link at the repository-root depth', async () => {
    const { root, project, link } = await sourceFixture()
    const lines: string[] = []
    const [result] = await shipProviderPlugins({
      cwd: project,
      packages: [PACKAGE_NAME],
      distributionRoot: root,
      log: (m) => lines.push(m),
    })
    expect(result!.staging).toBe(link)
    expect(result!.source).toBe(join(root, 'packages', 'vercel-sandbox'))

    // The staged module must be self-contained: zero external module imports
    // (node builtins excepted) — the deployment's node_modules carries
    // nothing else the closure needs.
    const bundle = await readFile(join(link, 'dist', 'index.js'), 'utf8')
    const imports = [...bundle.matchAll(/^import\s+[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]!)
    const external = imports.filter(
      (specifier) => !specifier.startsWith('node:') && !builtinModules.includes(specifier),
    )
    expect(external).toEqual([])
    expect(bundle).toContain('autobuild-vercel-sandbox')

    // Staged package.json is minimal, carries the marker and points at the bundle.
    const stagedManifest = JSON.parse(await readFile(join(link, 'package.json'), 'utf8'))
    expect(stagedManifest.name).toBe(PACKAGE_NAME)
    expect(stagedManifest.exports?.['.']).toBe('./dist/index.js')
    expect(stagedManifest.autobuildStagedBundle).toBe(true)

    // Trace entries are relative to the trace file's directory: seven '..'
    // components from …/.next/server/app/api/dispatch to the repository root.
    const files = await traceOf(project)
    const tracePath = join(project, TRACE_DIRECTORY, 'route.js.nft.json')
    expect(result!.traceEntries).toHaveLength(2)
    for (const entry of result!.traceEntries) {
      expect(files).toContain(entry)
      expect(entry.split('/').filter((segment) => segment === '..')).toHaveLength(7)
      expect(resolve(dirname(tracePath), entry).startsWith(`${link}/`)).toBe(true)
    }
    expect(result!.appended).toBe(2)
    expect(result!.bytes).toBeGreaterThan(0)
    expect(lines.join('\n')).toContain('appended 2 entries to')
  }, 60_000)

  test('a re-run appends nothing and stages byte-identical files', async () => {
    const { root, project, link } = await sourceFixture()
    await ship({ cwd: project, packages: [PACKAGE_NAME], distributionRoot: root })
    const trace = await traceOf(project)
    const bundle = await readFile(join(link, 'dist', 'index.js'))
    const [result] = await ship({ cwd: project, packages: [PACKAGE_NAME], distributionRoot: root })
    expect(result!.appended).toBe(0)
    expect(await traceOf(project)).toEqual(trace)
    expect(await readFile(join(link, 'dist', 'index.js'))).toEqual(bundle)
  }, 60_000)

  test('a staged bundle in place of the workspace link falls back to the workspace tree', async () => {
    // The state a SECOND deploy build sees in a fresh process (finding
    // f_5b9ade16): the first run replaced the workspace symlink and `bun
    // install` does not relink a pre-existing directory. The bundle was staged
    // before the marker existed, so it is recognized by its two-file shape.
    const { root, project, link } = await sourceFixture()
    await rm(link)
    await mkdir(join(link, 'dist'), { recursive: true })
    await writeFile(
      join(link, 'package.json'),
      JSON.stringify({
        name: PACKAGE_NAME,
        version: '0.0.0-stale',
        type: 'module',
        exports: { '.': './dist/index.js' },
      }),
    )
    await writeFile(join(link, 'dist', 'index.js'), '// stale staged bundle, not the source')

    const [result] = await ship({ cwd: project, packages: [PACKAGE_NAME], distributionRoot: root })
    expect(result!.source).toBe(join(root, 'packages', 'vercel-sandbox'))
    const manifest = JSON.parse(await readFile(join(link, 'package.json'), 'utf8'))
    expect(manifest.version).toBe('0.8.0')
    const bundle = await readFile(join(link, 'dist', 'index.js'), 'utf8')
    expect(bundle).toContain('autobuild-vercel-sandbox')
    expect(result!.appended).toBe(2)
  }, 60_000)

  async function runner(project: string, root: string): Promise<string> {
    const script = join(project, 'ship-runner.ts')
    await writeFile(
      script,
      `import { restoresInstallIn, shipProviderPlugins } from ${JSON.stringify(join(import.meta.dir, 'ship-provider-plugin.ts'))}
await shipProviderPlugins({
  packages: [${JSON.stringify(PACKAGE_NAME)}],
  distributionRoot: ${JSON.stringify(root)},
  restoreInstall: restoresInstallIn(process.env),
})
`,
    )
    return script
  }

  test('a second run in a FRESH process succeeds after the first consumed the workspace link', async () => {
    // Two separate processes against one fixture; VERCEL is pinned ON so
    // both runs keep the staged bundle, as a deployment build does.
    const { root, project } = await sourceFixture()
    const script = await runner(project, root)
    for (let run = 1; run <= 2; run++) {
      const spawn = Bun.spawnSync({
        cmd: ['bun', script],
        cwd: project,
        env: { ...process.env, VERCEL: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const output = `${spawn.stdout.toString()}${spawn.stderr.toString()}`
      expect(spawn.exitCode).toBe(0)
      expect(output).toContain(run === 1 ? 'appended 2 entries to' : 'already present in')
      expect(output).not.toContain('restored workspace symlink')
    }
  }, 120_000)

  test('a fresh process WITHOUT VERCEL restores the workspace symlink (local run)', async () => {
    const { root, project, link } = await sourceFixture()
    const script = await runner(project, root)
    const { VERCEL: _omit, ...env } = process.env
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
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(await realpath(link)).toBe(join(root, 'packages', 'vercel-sandbox'))
    // The trace still describes the deployment layout.
    expect((await traceOf(project)).filter((entry) => entry.includes('node_modules'))).toHaveLength(
      2,
    )
  }, 120_000)

  test('restoreInstall heals a poisoned checkout (staged directory, no symlink)', async () => {
    const { root, project, link } = await sourceFixture()
    await ship({ cwd: project, packages: [PACKAGE_NAME], distributionRoot: root })
    expect((await lstat(link)).isDirectory()).toBe(true)
    const [result] = await ship({
      cwd: project,
      packages: [PACKAGE_NAME],
      distributionRoot: root,
      restoreInstall: true,
    })
    expect(result!.restored).toBe(true)
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(await realpath(link)).toBe(join(root, 'packages', 'vercel-sandbox'))
  }, 60_000)

  test('restoresInstallIn gates on the VERCEL environment variable', () => {
    expect(restoresInstallIn({ VERCEL: '1' })).toBe(false)
    expect(restoresInstallIn({ VERCEL: 'production' })).toBe(false)
    expect(restoresInstallIn({})).toBe(true)
  })
})

describe('ship-provider-plugin: installed deployments', () => {
  test('stages under the installed distribution, leaving the installed package untouched', async () => {
    const project = await temp('ab-ship-installed-')
    await writeFile(join(project, 'package.json'), '{"name":"deployment"}')
    const { distributionRoot, link } = await installedFixture(project, project)
    const linkTarget = await realpath(link)
    const [result] = await ship({
      cwd: project,
      packages: [TINY],
      distributionRoot,
      traceRoot: project,
    })
    const staging = join(distributionRoot, 'node_modules', '@fixture', 'tiny-plugin')
    expect(result!.staging).toBe(staging)
    expect(result!.source).toBe(linkTarget)
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(await realpath(link)).toBe(linkTarget)
    const files = await traceOf(project)
    const traceDirectory = join(project, TRACE_DIRECTORY)
    expect(
      result!.traceEntries.map((entry) => relative(staging, resolve(traceDirectory, entry))).sort(),
    ).toEqual(['dist/index.js', 'package.json'])
    expect(result!.traceEntries.every((entry) => files.includes(entry))).toBe(true)
    // The runtime resolves the bare specifier from the distribution root.
    expect(Bun.resolveSync(TINY, distributionRoot)).toBe(join(staging, 'dist', 'index.js'))
  }, 60_000)

  test('a workspace member ships under the workspace tracing root and re-runs identically', async () => {
    const root = await temp('ab-ship-member-')
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ private: true, workspaces: ['apps/*'] }),
    )
    const project = join(root, 'apps', 'autobuild')
    await mkdir(project, { recursive: true })
    await writeFile(join(project, 'package.json'), '{"name":"autobuild-deployment"}')
    const { distributionRoot } = await installedFixture(root, project)
    const first = await ship({ cwd: project, packages: [TINY], distributionRoot, traceRoot: root })
    const trace = await traceOf(project)
    const staged = await readFile(join(first[0]!.staging, 'dist', 'index.js'))
    const second = await ship({ cwd: project, packages: [TINY], distributionRoot, traceRoot: root })
    expect(second[0]!.staging).toBe(first[0]!.staging)
    expect(second[0]!.appended).toBe(0)
    expect(await traceOf(project)).toEqual(trace)
    expect(await readFile(join(second[0]!.staging, 'dist', 'index.js'))).toEqual(staged)
    // Workspace-root node_modules lies outside the project folder.
    for (const entry of first[0]!.traceEntries)
      expect(entry.startsWith('../../../../../../../')).toBe(true)
  }, 60_000)

  test('a local run restores the installation tree exactly', async () => {
    const project = await temp('ab-ship-restore-')
    await writeFile(join(project, 'package.json'), '{"name":"deployment"}')
    const { distributionRoot } = await installedFixture(project, project)
    const before = await tree(join(project, 'node_modules'))
    const [result] = await ship({
      cwd: project,
      packages: [TINY],
      distributionRoot,
      traceRoot: project,
      restoreInstall: true,
    })
    expect(result!.restored).toBe(true)
    expect(await tree(join(project, 'node_modules'))).toEqual(before)
    expect((await traceOf(project)).filter((entry) => entry.includes('tiny-plugin'))).toHaveLength(
      2,
    )
  }, 60_000)

  test('refuses to replace a real installed package at the staging path', async () => {
    const project = await temp('ab-ship-refuse-')
    await writeFile(join(project, 'package.json'), '{"name":"deployment"}')
    const { distributionRoot } = await installedFixture(project, project)
    const occupied = join(distributionRoot, 'node_modules', '@fixture', 'tiny-plugin')
    await pluginPackage(occupied, TINY)
    await expect(
      ship({ cwd: project, packages: [TINY], distributionRoot, traceRoot: project }),
    ).rejects.toThrow(/refusing to replace installed package at/)
    expect(await readFile(join(occupied, 'src', 'index.ts'), 'utf8')).toContain('tiny')
  }, 60_000)

  test('a staging directory outside the tracing root is an error naming both paths', async () => {
    const project = await temp('ab-ship-outside-')
    await writeFile(join(project, 'package.json'), '{"name":"deployment"}')
    const { distributionRoot } = await installedFixture(project, project)
    const elsewhere = await temp('ab-ship-elsewhere-')
    await expect(
      ship({ cwd: project, packages: [TINY], distributionRoot, traceRoot: elsewhere }),
    ).rejects.toThrow(new RegExp(`lies outside the output-file-tracing root ${elsewhere}`))
  })

  test('an uninstalled plugin names the package and the rule that selected it', async () => {
    const project = await temp('ab-ship-missing-')
    await writeFile(join(project, 'package.json'), '{"name":"deployment"}')
    const { distributionRoot } = await installedFixture(project, project)
    await expect(
      ship({
        cwd: project,
        packages: ['@fixture/absent'],
        rule: 'manifest',
        distributionRoot,
        traceRoot: project,
      }),
    ).rejects.toThrow(
      'provider plugin @fixture/absent is not installed in the deployment (selected by package.json autobuild.plugins)',
    )
  })

  test('a package that does not evaluate to a plugin manifest fails the build', async () => {
    const project = await temp('ab-ship-not-plugin-')
    await writeFile(join(project, 'package.json'), '{"name":"deployment"}')
    const { distributionRoot } = await installedFixture(
      project,
      project,
      '@fixture/not-plugin',
      'export default { hello: 1 }\n',
    )
    await expect(
      ship({
        cwd: project,
        packages: ['@fixture/not-plugin'],
        rule: 'dependencies',
        distributionRoot,
        traceRoot: project,
      }),
    ).rejects.toThrow(
      /@fixture\/not-plugin is not an Autobuild plugin \(selected by the default rule.*autobuild\.plugins/,
    )
  }, 60_000)

  test('a missing trace fails before anything is staged', async () => {
    const project = await temp('ab-ship-no-trace-')
    await writeFile(join(project, 'package.json'), '{"name":"deployment"}')
    const { distributionRoot } = await installedFixture(project, project)
    await rm(join(project, TRACE_DIRECTORY), { recursive: true })
    await expect(
      ship({ cwd: project, packages: [TINY], distributionRoot, traceRoot: project }),
    ).rejects.toThrow(/missing Next\.js trace file/)
    await expect(lstat(join(distributionRoot, 'node_modules'))).rejects.toThrow()
  })
})

describe('ship-provider-plugin: function-bundle evaluation', () => {
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
    const { root, project } = await sourceFixture()
    const [staged] = await ship({ cwd: project, packages: [PACKAGE_NAME], distributionRoot: root })

    const isolated = await mkdtemp(join(tmpdir(), 'ab-plugin-isolated-'))
    temporary.push(isolated)
    const chunks = join(isolated, 'packages', 'hosted-store-service', '.next', 'server', 'chunks')
    await mkdir(chunks, { recursive: true })
    const chunkFile = join(chunks, '[turbopack]_runtime.js')
    await writeFile(chunkFile, '// placeholder for the compiled runtime chunk')
    const stagedDirectory = join(isolated, 'node_modules', '@defrex', 'autobuild-vercel-sandbox')
    await mkdir(join(stagedDirectory, 'dist'), { recursive: true })
    await copyFile(join(staged!.staging, 'package.json'), join(stagedDirectory, 'package.json'))
    await copyFile(
      join(staged!.staging, 'dist', 'index.js'),
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
    const { root, project } = await sourceFixture()
    const [staged] = await ship({ cwd: project, packages: [PACKAGE_NAME], distributionRoot: root })

    const isolated = await mkdtemp(join(tmpdir(), 'ab-plugin-isolated-'))
    temporary.push(isolated)
    const chunks = join(isolated, 'packages', 'hosted-store-service', '.next', 'server', 'chunks')
    await mkdir(chunks, { recursive: true })
    await writeFile(join(chunks, '[turbopack]_runtime.js'), '// placeholder runtime chunk')
    const stagedDirectory = join(isolated, 'node_modules', '@defrex', 'autobuild-vercel-sandbox')
    await mkdir(join(stagedDirectory, 'dist'), { recursive: true })
    await copyFile(join(staged!.staging, 'package.json'), join(stagedDirectory, 'package.json'))
    await copyFile(
      join(staged!.staging, 'dist', 'index.js'),
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
