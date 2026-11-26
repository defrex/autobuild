import { temporaryDirectories as ownTempDirectories } from '../testing/temp-directories'
import { afterEach, expect, test } from 'bun:test'
import { cp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { installSourceDependencies, prepareUpgrade } from './dispatch-upgrade-install'
import { inside, scanDependencies } from './dispatch-runtime-dependencies'
import { resolveUpgradeTarget } from './dispatch-upgrade-target'
import { spawnExec } from '../ports/workspace/git-worktree'
import type { Forge } from '../ports/types'
import { releasePreparedRuntime } from './dispatch-runtime-use'

const mkdtemp = ownTempDirectories(afterEach)

test('real Bun lock and isolated install validate exact registry integrity, then reuse cache offline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ab-upgrade-install-'))
  const source = join(root, 'package'),
    repo = join(root, 'repo')
  await mkdir(join(source, 'bin/agent'), { recursive: true })
  await mkdir(join(source, 'packages/core/src/cli'), { recursive: true })
  await mkdir(repo)
  await writeFile(
    join(source, 'package.json'),
    JSON.stringify({
      name: '@defrex/autobuild',
      version: '2.0.0',
      bin: 'bin/ab.ts',
      files: ['bin', 'packages'],
    }),
  )
  await writeFile(join(source, 'bin/ab.ts'), 'console.log("autobuild 2.0.0")')
  await writeFile(join(source, 'bin/agent/ab'), '#!/bin/sh\n')
  for (const entry of [
    'ab-dispatch-generation.ts',
    'ab-dispatch-kernel.ts',
    'ab-build-runner.ts',
    'ab-harvest-runner.ts',
    'ab-process-group-reaper.ts',
  ])
    await writeFile(join(source, 'bin', entry), 'export {}')
  await writeFile(
    join(source, 'packages/core/src/cli/dispatch-launch-contract.ts'),
    'export const DISPATCH_LAUNCH_VERSION = 1\nexport const DISPATCH_OVERLAP_VERSION = 1\n',
  )
  await writeFile(join(source, 'packages/core/src/cli/dispatch-handoff.ts'), 'export {}')
  await writeFile(
    join(source, 'bin/ab-dispatch-generation.ts'),
    `if (process.argv[2] === '--read-handoff') console.log(JSON.stringify({version:1,handoff:null})); export {}`,
  )
  const tarball = join(root, 'package.tgz')
  await Bun.$`tar czf ${tarball} -C ${root} package`.quiet()
  const bytes = await readFile(tarball)
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
  let requests = 0
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0,
    fetch(request): Response {
      requests++
      if (new URL(request.url).pathname.endsWith('.tgz')) return new Response(bytes)
      const version = {
        name: '@defrex/autobuild',
        version: '2.0.0',
        bin: 'bin/ab.ts',
        dist: { tarball: `http://localhost:${server.port}/package.tgz`, integrity },
      }
      return Response.json({
        name: '@defrex/autobuild',
        'dist-tags': { latest: '2.0.0' },
        versions: { '2.0.0': version },
      })
    },
  })
  const env = {
    ...process.env,
    BUN_CONFIG_REGISTRY: `http://localhost:${server.port}`,
    BUN_INSTALL_CACHE_DIR: join(root, 'cache'),
  }
  const signal = new AbortController().signal
  try {
    await writeFile(
      join(repo, 'package.json'),
      '{"devDependencies":{"@defrex/autobuild":"2.0.0"},"dependencies":{"@defrex/autobuild":"^2.0.0"}}',
    )
    const install = await spawnExec([process.execPath, 'install', '--ignore-scripts'], {
      cwd: repo,
      env,
    })
    if (install.exitCode) throw new Error(install.stderr)
    for (const args of [
      ['init', '-b', 'main'],
      ['config', 'user.name', 'Test'],
      ['config', 'user.email', 'test@example.com'],
      ['add', 'package.json', 'bun.lock'],
      ['commit', '-m', 'pin'],
    ]) {
      const r = await spawnExec(['git', ...args], { cwd: repo })
      if (r.exitCode) throw new Error(r.stderr)
    }
    const target = await resolveUpgradeTarget({
      checkout: repo,
      base: 'main',
      originalInstall: '/unused',
      exec: spawnExec,
      forge: {
        snapshotBase: async () =>
          (await spawnExec(['git', 'rev-parse', 'main'], { cwd: repo })).stdout.trim(),
      } as unknown as Forge,
    })
    expect(target.version).toBe('2.0.0')
    const runtime = await prepareUpgrade({
      checkout: repo,
      target,
      signal,
      env,
    })
    expect(JSON.parse(await readFile(join(runtime.root, 'package.json'), 'utf8')).version).toBe(
      '2.0.0',
    )
    releasePreparedRuntime(runtime.root)
    const before = requests
    const cached = await prepareUpgrade({
      checkout: repo,
      target,
      signal,
      env: { ...env, BUN_CONFIG_REGISTRY: 'http://localhost:1' },
    })
    expect(cached.id).toBe(runtime.id)
    expect(requests).toBe(before)
    releasePreparedRuntime(cached.root)
    await expect(
      prepareUpgrade({
        checkout: repo,
        target: {
          ...target,
          key: 'bad-integrity',
          record: [...target.record!.slice(0, -1), 'sha512-incorrect'],
        },
        signal,
        env,
      }),
    ).rejects.toThrow('integrity')
    await writeFile(
      join(source, 'bin/ab-dispatch-generation.ts'),
      'throw new Error("broken generation entry")',
    )
    await expect(
      prepareUpgrade({
        checkout: repo,
        target: {
          mode: 'installed',
          key: 'broken-entry',
          version: '2.0.0',
          source,
          installRoot: source,
        },
        signal,
        env,
      }),
    ).rejects.toThrow('handoff reader validation failed')
  } finally {
    await server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('source installation publishes exact provenance atomically, reuses a validated cache and rejects corruption and abort', async () => {
  const { sourceCommand, sourceContent } = await import('./dispatch-upgrade-source')
  const { captureRuntimeIdentity } = await import('../runtime-identity')
  const root = await mkdtemp(join(tmpdir(), 'ab-source-install-'))
  const repo = join(root, 'repo')
  await mkdir(join(repo, 'bin/agent'), { recursive: true })
  await mkdir(join(repo, 'packages/core/src/cli'), { recursive: true })
  await writeFile(
    join(repo, 'package.json'),
    JSON.stringify({
      name: '@defrex/autobuild',
      version: '1.0.0',
      files: ['bin', 'packages'],
      bin: 'bin/ab.ts',
      scripts: { prepare: 'touch MUST-NOT-RUN' },
      dependencies: { semver: '7.7.4' },
    }),
  )
  await writeFile(join(repo, 'bin/ab.ts'), 'console.log("autobuild 1.0.0")')
  await writeFile(join(repo, 'bin/agent/ab'), '#!/bin/sh\n')
  for (const name of [
    'ab-dispatch-generation.ts',
    'ab-dispatch-kernel.ts',
    'ab-build-runner.ts',
    'ab-harvest-runner.ts',
    'ab-process-group-reaper.ts',
  ])
    await writeFile(
      join(repo, 'bin', name),
      name === 'ab-dispatch-generation.ts'
        ? 'console.log(JSON.stringify({version:1,handoff:null}))'
        : 'export {}',
    )
  await writeFile(
    join(repo, 'packages/core/src/cli/dispatch-launch-contract.ts'),
    'export const DISPATCH_LAUNCH_VERSION = 1\nexport const DISPATCH_OVERLAP_VERSION = 1\n',
  )
  await writeFile(join(repo, 'packages/core/src/cli/dispatch-handoff.ts'), 'export {}')
  await sourceCommand([process.execPath, 'install', '--ignore-scripts'], repo)
  const git = (...args: string[]) => sourceCommand(['git', ...args], repo)
  await git('init', '-b', 'main')
  await git('config', 'user.name', 'Test')
  await git('config', 'user.email', 'test@example.com')
  await git('add', 'bin', 'packages', 'package.json', 'bun.lock')
  await git('commit', '-m', 'source')
  const sha = (await git('rev-parse', 'HEAD')).trim()
  const content = await sourceContent(repo, '/source-repository')
  const target = {
    mode: 'source' as const,
    source: '/source-repository',
    base: 'main',
    sha,
    ...content,
  }
  const input = { target, checkout: repo, signal: new AbortController().signal, env: process.env }
  let runtime: Awaited<ReturnType<typeof prepareUpgrade>> | undefined
  try {
    runtime = await prepareUpgrade(input)
    expect(captureRuntimeIdentity(runtime.root).commit).toBe(sha)
    expect(await Bun.file(join(repo, 'MUST-NOT-RUN')).exists()).toBe(false)
    const before = await readFile(join(runtime.root, 'package.json'), 'utf8')
    releasePreparedRuntime(runtime.root)
    const again = await prepareUpgrade(input)
    expect(again.root).toBe(runtime.root)
    expect(await readFile(join(runtime.root, 'package.json'), 'utf8')).toBe(before)
    releasePreparedRuntime(again.root)
    await expect(prepareUpgrade({ ...input, signal: AbortSignal.abort() })).rejects.toThrow()
    await writeFile(join(runtime.root, 'bin/ab.ts'), 'corrupt')
    await expect(prepareUpgrade(input)).rejects.toThrow('corrupt completed runtime')
  } finally {
    if (runtime) releasePreparedRuntime(runtime.root)
    await rm(root, { recursive: true, force: true })
  }
})

for (const linker of ['isolated', 'hoisted'] as const)
  test(`production-only ${linker} source install keeps the full production graph and still refuses contradictions`, async () => {
    const { sourceCommand } = await import('./dispatch-upgrade-source')
    const root = await mkdtemp(join(tmpdir(), 'ab-source-production-'))
    const fixture = join(root, 'fixture')
    const json = (path: string, value: unknown) => writeFile(path, JSON.stringify(value))
    await mkdir(join(fixture, 'packages/lib'), { recursive: true })
    await mkdir(join(fixture, 'packages/devtool'), { recursive: true })
    await writeFile(join(fixture, 'bunfig.toml'), `[install]\nlinker = "${linker}"\n`)
    await json(join(fixture, 'package.json'), {
      name: 'fixture-root',
      private: true,
      workspaces: ['packages/*'],
      // debug nests ms@2.1.2 beside the root's ms@2.1.3; gateway peers on zod.
      dependencies: {
        debug: '4.3.4',
        ms: '2.1.3',
        '@ai-sdk/gateway': '4.0.82',
        zod: '^4.4.3',
        '@fx/lib': 'workspace:*',
      },
      optionalDependencies: { 'is-number': '7.0.0' },
      // A development version that conflicts with the library's production one.
      devDependencies: { semver: '7.7.4', jose: '6.2.3', '@fx/devtool': 'workspace:*' },
    })
    await json(join(fixture, 'packages/lib/package.json'), {
      name: '@fx/lib',
      version: '1.0.0',
      main: 'index.js',
      dependencies: { 'is-odd': '3.0.1', jose: '6.2.13' },
      devDependencies: { 'left-pad': '1.3.0' },
    })
    await writeFile(join(fixture, 'packages/lib/index.js'), 'module.exports = require("is-odd")')
    await json(join(fixture, 'packages/devtool/package.json'), {
      name: '@fx/devtool',
      version: '1.0.0',
      dependencies: { 'left-pad': '1.3.0' },
    })
    await sourceCommand([process.execPath, 'install', '--ignore-scripts', '--no-progress'], fixture)
    const copy = async (name: string) => {
      const target = join(root, name)
      await cp(fixture, target, {
        recursive: true,
        filter: (path) => !path.split('/').includes('node_modules'),
      })
      return realpath(target)
    }
    const signal = new AbortController().signal
    const full = await copy('full')
    await sourceCommand(
      [process.execPath, 'install', '--frozen-lockfile', '--ignore-scripts', '--no-progress'],
      full,
    )
    const prod = await copy('prod')
    await installSourceDependencies(prod, process.env, signal)

    const [expected, actual] = await Promise.all([scanDependencies(full), scanDependencies(prod)])
    expect(actual.fingerprint).toBe(expected.fingerprint)
    expect(actual.roots).toEqual(expected.roots)
    for (const entry of actual.packages) expect(inside(prod, entry.source)).toBe(true)
    expect(
      actual.packages
        .filter((entry) => entry.manifest.name === 'jose')
        .map((e) => e.manifest.version),
    ).toEqual(['6.2.13'])
    for (const path of [
      'node_modules/semver',
      'node_modules/@fx/devtool',
      'node_modules/left-pad',
      'packages/devtool/node_modules',
      'packages/lib/node_modules/left-pad',
    ])
      expect(existsSync(join(prod, path))).toBe(false)
    await sourceCommand(
      [
        process.execPath,
        '-e',
        'for (const name of ["debug", "@ai-sdk/gateway", "zod", "is-number", "@fx/lib"]) await import(name)',
      ],
      prod,
    )

    // The frozen lock still covers dev-only workspaces and the root manifest.
    for (const manifest of ['packages/devtool/package.json', 'package.json']) {
      const contradicted = await copy(`contradicted-${manifest.split('/').length}`)
      const path = join(contradicted, manifest)
      const value = JSON.parse(await readFile(path, 'utf8'))
      value.dependencies['is-even'] = '1.0.0'
      await json(path, value)
      await expect(installSourceDependencies(contradicted, process.env, signal)).rejects.toThrow(
        'source dependency installation failed',
      )
    }
    const unlocked = await copy('unlocked')
    await rm(join(unlocked, 'bun.lock'))
    await expect(installSourceDependencies(unlocked, process.env, signal)).rejects.toThrow('ENOENT')
  }, 120_000)
