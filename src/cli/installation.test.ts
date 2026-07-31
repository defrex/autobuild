import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  formatInstalledVersion,
  inspectInstallation,
  readDistributionIdentity,
} from './installation'
import { runCli } from './main'

let roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  roots = []
})

async function fixture(options: { git?: 'file' | 'directory'; tag?: string } = {}): Promise<{
  owner: string
  dist: string
  globalBin: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'ab-installation-'))
  roots.push(root)
  const owner = join(root, 'owner')
  const dist = join(owner, 'node_modules', 'autobuild')
  const globalBin = join(root, 'global-bin')
  await mkdir(join(dist, 'bin'), { recursive: true })
  await mkdir(globalBin)
  await writeFile(
    join(dist, 'package.json'),
    JSON.stringify({ name: 'autobuild', version: '2.0.0', bin: { ab: 'bin/ab.ts' } }),
  )
  await writeFile(join(dist, 'bin', 'ab.ts'), '')
  await writeFile(join(dist, '.bun-tag'), options.tag ?? 'fork-owner-repo-name-a1b2c3d')
  await writeFile(
    join(owner, 'package.json'),
    JSON.stringify({ dependencies: { autobuild: 'github:fork-owner/repo-name#main' } }),
  )
  await writeFile(
    join(owner, 'bun.lock'),
    `{
      "workspaces": { "": { "dependencies": { "autobuild": "github:fork-owner/repo-name#main", }, }, },
      "packages": { "autobuild": ["autobuild@github:fork-owner/repo-name#a1b2c3d", {}, "fork-owner-repo-name-a1b2c3d"], },
    }`,
  )
  if (options.git === 'file') await writeFile(join(dist, '.git'), 'gitdir: elsewhere')
  if (options.git === 'directory') await mkdir(join(dist, '.git'))
  return { owner, dist, globalBin }
}

describe('installed distribution identity and Bun provenance', () => {
  test('version rendering uses only package-local version, commit, and plugin API', async () => {
    const { dist } = await fixture()
    const identity = await readDistributionIdentity(dist)
    expect(formatInstalledVersion(identity)).toBe(
      'autobuild 2.0.0 (commit a1b2c3d)\nplugin API 1.3.0',
    )

    const out: string[] = []
    expect(
      await runCli(['--version'], {
        workspacePath: '/not/a/repository',
        distributionRoot: dist,
        stdout: (line) => out.push(line),
        stderr: () => {},
      }),
    ).toBe(0)
    expect(out).toEqual([formatInstalledVersion(identity)])
  })

  test('a .git file or directory always identifies an untouched source checkout', async () => {
    for (const git of ['file', 'directory'] as const) {
      const { dist, globalBin } = await fixture({ git })
      const result = await inspectInstallation({ distRoot: dist, globalBin })
      expect(result.kind).toBe('source')
      if (result.kind === 'source') expect(result.reason).toContain('source checkout')
    }
  })

  test('accepts Bun-resolved lock commits while deriving the fork from the direct dependency', async () => {
    const { owner, dist, globalBin } = await fixture()
    const result = await inspectInstallation({ distRoot: dist, globalBin })
    expect(result.kind).toBe('bun-forge')
    if (result.kind !== 'bun-forge') return
    expect(result.installation).toMatchObject({
      ownerRoot: owner,
      owner: 'fork-owner',
      repository: 'repo-name',
      scope: 'local',
      commit: 'a1b2c3d',
    })
  })

  test('recognizes the active global binary and refuses contradictory tags', async () => {
    const global = await fixture()
    await symlink(join(global.dist, 'bin', 'ab.ts'), join(global.globalBin, 'ab'))
    const globalResult = await inspectInstallation({
      distRoot: global.dist,
      globalBin: global.globalBin,
    })
    expect(globalResult.kind === 'bun-forge' && globalResult.installation.scope).toBe('global')

    const bad = await fixture({ tag: 'someone-else-repository-a1b2c3d' })
    const badResult = await inspectInstallation({ distRoot: bad.dist, globalBin: bad.globalBin })
    expect(badResult.kind).toBe('unknown')
    if (badResult.kind === 'unknown') expect(badResult.reason).toContain('.bun-tag')
  })

  test('rejects malformed package versions and extra --version arguments', async () => {
    const { dist } = await fixture()
    await writeFile(
      join(dist, 'package.json'),
      JSON.stringify({ name: 'autobuild', version: 'main', bin: { ab: 'bin/ab.ts' } }),
    )
    await expect(readDistributionIdentity(dist)).rejects.toThrow('invalid package version')

    const errors: string[] = []
    expect(
      await runCli(['--version', 'extra'], {
        workspacePath: '/',
        distributionRoot: dist,
        stdout: () => {},
        stderr: (line) => errors.push(line),
      }),
    ).toBe(1)
    expect(errors).toEqual(['usage: ab --version'])
  })
})
