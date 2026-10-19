import { expect, test } from 'bun:test'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import semver from 'semver'
import { spawnExec } from '../packages/core/src/ports/workspace/git-worktree'
import { installPackedDistribution } from '../packages/core/src/testing/packed-install'
import { readWorkspaceManifests } from './workspace-manifest-check'

const root = resolve(import.meta.dir, '..')
const packages = [
  '.',
  'packages/vercel-sandbox',
  'packages/postgres-store',
  'packages/hosted-store-service',
  'packages/hosted-dispatcher',
]

test('published Autobuild peers retain stable ranges and admit the beta set', async () => {
  let edges = 0
  for (const { manifest } of await readWorkspaceManifests(root)) {
    if (manifest.private) continue
    for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (!name.startsWith('@defrex/autobuild')) continue
      edges++
      const current = String(range)
      const originalFloors: Record<string, Record<string, string>> = {
        '@defrex/autobuild-vercel-sandbox': { '@defrex/autobuild': '>=0.9.0' },
        '@defrex/autobuild-postgres-store': { '@defrex/autobuild': '>=0.7.0' },
        '@defrex/autobuild-hosted-store-service': { '@defrex/autobuild': '>=0.11.0' },
        '@defrex/autobuild-hosted-dispatcher': {
          '@defrex/autobuild': '>=0.9.0',
          '@defrex/autobuild-hosted-store-service': '>=0.9.0',
          '@defrex/autobuild-postgres-store': '>=0.11.0',
        },
      }
      const previous = originalFloors[String(manifest.name)]![name]!
      expect(current).toBe(`${previous} || >=1.0.0-0 <1.0.0`)
      expect(semver.subset(previous, current)).toBe(true)
      for (const version of [
        '1.0.0-beta.0',
        '1.0.0-beta.1',
        '1.0.0-beta.999',
        '1.0.0',
        '1.0.1',
        '2.0.0',
        semver.minVersion(previous)!.version,
      ]) {
        expect(semver.satisfies(version, current)).toBe(true)
      }
      expect(semver.satisfies('1.1.0-beta.0', current)).toBe(false)
    }
  }
  expect(edges).toBeGreaterThan(0)
})

test('npm and Bun install real beta package tarballs together without peer diagnostics', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'ab-beta-peers-'))
  try {
    const tarballs: string[] = []
    for (const path of packages) {
      const source = join(root, path)
      const target = join(temp, 'distribution', path)
      await mkdir(target, { recursive: true })
      const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
      for (const file of manifest.files as string[]) {
        if (file.startsWith('!')) continue
        await cp(join(source, file), join(target, file), { recursive: true })
      }
      manifest.version = '1.0.0-beta.1'
      if (path === '.') manifest.workspaces = ['packages/*']
      delete manifest.devDependencies
      delete manifest.scripts
      await writeFile(join(target, 'package.json'), JSON.stringify(manifest))
    }
    const locked = await spawnExec(['bun', 'install', '--lockfile-only', '--ignore-scripts'], {
      cwd: join(temp, 'distribution'),
    })
    expect({ code: locked.exitCode, output: locked.stdout + locked.stderr }).toMatchObject({
      code: 0,
    })
    for (const path of packages) {
      const target = join(temp, 'distribution', path)
      const packed = await spawnExec(['bun', 'pm', 'pack', '--ignore-scripts'], { cwd: target })
      expect({ code: packed.exitCode, output: packed.stdout + packed.stderr }).toMatchObject({
        code: 0,
      })
      const archive = (await readdir(target)).find((file) => file.endsWith('.tgz'))!
      tarballs.push(join(target, archive))
    }
    for (const manager of ['npm', 'bun']) {
      const consumer = join(temp, manager)
      await mkdir(consumer)
      await writeFile(join(consumer, 'package.json'), '{"name":"beta-consumer","private":true}')
      const args = ['--ignore-scripts', ...tarballs]
      const installed =
        manager === 'bun'
          ? await installPackedDistribution(args, consumer)
          : await spawnExec(['npm', 'install', '--no-audit', '--no-fund', ...args], {
              cwd: consumer,
            })
      const output = installed.stdout + installed.stderr
      expect({ code: installed.exitCode, output }).toMatchObject({ code: 0 })
      expect(output).not.toMatch(
        /incorrect peer|unmet peer|ERESOLVE|(?:warn|error).*peer|peer.*(?:warn|error)/i,
      )
      for (const path of packages) {
        const { name } = JSON.parse(await readFile(join(root, path, 'package.json'), 'utf8'))
        const installedManifest = JSON.parse(
          await readFile(join(consumer, 'node_modules', name, 'package.json'), 'utf8'),
        )
        expect(installedManifest.version).toBe('1.0.0-beta.1')
      }
    }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}, 480_000)
