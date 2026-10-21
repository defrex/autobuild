import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { prepareUpgrade } from './dispatch-upgrade-install'
import { resolveUpgradeTarget } from './dispatch-upgrade-target'
import { spawnExec } from '../ports/workspace/git-worktree'
import type { Forge } from '../ports/types'
import { releasePreparedRuntime } from './dispatch-runtime-use'

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
    'export const DISPATCH_LAUNCH_VERSION = 1\n',
  )
  await writeFile(join(source, 'packages/core/src/cli/dispatch-handoff.ts'), 'export {}')
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
    const runtime = await prepareUpgrade({ checkout: repo, target, signal, env })
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
  } finally {
    await server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
