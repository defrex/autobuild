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

async function fixture(
  options: {
    git?: 'file' | 'directory'
    tag?: string
    /** npm registry provenance instead of the default github: forge records. */
    npm?: { dependency: string; lockRecord?: unknown[] }
    /** Manifest section declaring the package (default `dependencies`). */
    section?: 'dependencies' | 'devDependencies' | 'optionalDependencies'
    /** Also declare it, with this value, in the other of the two sections. */
    both?: string
    /** Section of the lock workspace block; defaults to `section`. */
    lockSection?: string
  } = {},
): Promise<{
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
    JSON.stringify({
      name: 'autobuild',
      version: '2.0.0',
      bin: { ab: 'bin/ab.ts' },
    }),
  )
  await writeFile(join(dist, 'bin', 'ab.ts'), '')
  const section = options.section ?? 'dependencies'
  const lockSection = options.lockSection ?? section
  let dependency: string
  let packages: string
  if (options.npm === undefined) {
    await writeFile(join(dist, '.bun-tag'), options.tag ?? 'fork-owner-repo-name-a1b2c3d')
    dependency = 'github:fork-owner/repo-name#main'
    packages = `["autobuild@github:fork-owner/repo-name#a1b2c3d", {}, "fork-owner-repo-name-a1b2c3d"]`
  } else {
    dependency = options.npm.dependency
    packages = JSON.stringify(
      options.npm.lockRecord ?? ['autobuild@2.0.0', '', {}, 'sha512-fixture'],
    )
  }
  const manifest: Record<string, unknown> = {
    [section]: { autobuild: dependency },
  }
  if (options.both !== undefined) {
    const other = section === 'devDependencies' ? 'dependencies' : 'devDependencies'
    manifest[other] = { autobuild: options.both }
  }
  await writeFile(join(owner, 'package.json'), JSON.stringify(manifest))
  await writeFile(
    join(owner, 'bun.lock'),
    `{
      "workspaces": { "": { ${JSON.stringify(lockSection)}: { "autobuild": ${JSON.stringify(dependency)}, }, }, },
      "packages": { "autobuild": ${packages}, },
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
      'autobuild 2.0.0 (commit a1b2c3d)\nplugin API 1.7.0',
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
    const badResult = await inspectInstallation({
      distRoot: bad.dist,
      globalBin: bad.globalBin,
    })
    expect(badResult.kind).toBe('unknown')
    if (badResult.kind === 'unknown') expect(badResult.reason).toContain('.bun-tag')
  })

  test('recognizes an npm registry install from a satisfied range and a registry lock record', async () => {
    for (const dependency of ['2.0.0', '^2.0.0', '>=1.5.0 <3']) {
      const { owner, dist, globalBin } = await fixture({ npm: { dependency } })
      const result = await inspectInstallation({ distRoot: dist, globalBin })
      expect(result.kind).toBe('npm-registry')
      if (result.kind !== 'npm-registry') return
      expect(result.installation).toMatchObject({
        channel: 'npm',
        ownerRoot: owner,
        dependency,
        scope: 'local',
        version: '2.0.0',
      })
      expect(result.installation.commit).toBeUndefined()
    }
    const global = await fixture({ npm: { dependency: '2.0.0' } })
    await symlink(join(global.dist, 'bin', 'ab.ts'), join(global.globalBin, 'ab'))
    const globalResult = await inspectInstallation({
      distRoot: global.dist,
      globalBin: global.globalBin,
    })
    expect(globalResult.kind === 'npm-registry' && globalResult.installation.scope).toBe('global')
  })

  test('refuses registry provenance that the range, lock version, or origin contradict', async () => {
    const unsatisfied = await fixture({ npm: { dependency: '^3.0.0' } })
    const unsatisfiedResult = await inspectInstallation({
      distRoot: unsatisfied.dist,
      globalBin: unsatisfied.globalBin,
    })
    expect(unsatisfiedResult.kind).toBe('unknown')
    if (unsatisfiedResult.kind === 'unknown') {
      expect(unsatisfiedResult.reason).toContain('npm registry version range')
    }

    const staleLock = await fixture({
      npm: {
        dependency: '^2.0.0',
        lockRecord: ['autobuild@2.0.1', '', {}, 'sha512-other'],
      },
    })
    const staleResult = await inspectInstallation({
      distRoot: staleLock.dist,
      globalBin: staleLock.globalBin,
    })
    expect(staleResult.kind).toBe('unknown')
    if (staleResult.kind === 'unknown')
      expect(staleResult.reason).toContain('registry version 2.0.0')

    const tarball = await fixture({
      npm: {
        dependency: '2.0.0',
        lockRecord: ['autobuild@2.0.0', 'https://example.test/a.tgz', {}],
      },
    })
    const tarballResult = await inspectInstallation({
      distRoot: tarball.dist,
      globalBin: tarball.globalBin,
    })
    expect(tarballResult.kind).toBe('unknown')
  })

  test('rejects malformed package versions and extra --version arguments', async () => {
    const { dist } = await fixture()
    await writeFile(
      join(dist, 'package.json'),
      JSON.stringify({
        name: 'autobuild',
        version: 'main',
        bin: { ab: 'bin/ab.ts' },
      }),
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

  const sections = ['dependencies', 'devDependencies'] as const
  const channels = [
    { name: 'npm', kind: 'npm-registry', npm: { dependency: '^2.0.0' } },
    { name: 'github', kind: 'bun-forge', npm: undefined },
  ] as const
  const scopes = ['local', 'global'] as const

  for (const section of sections) {
    for (const channel of channels) {
      for (const scope of scopes) {
        test(`recognizes a ${scope} ${channel.name} install declared under ${section}`, async () => {
          const f = await fixture({
            section,
            ...(channel.npm === undefined ? {} : { npm: channel.npm }),
          })
          if (scope === 'global') {
            await symlink(join(f.dist, 'bin', 'ab.ts'), join(f.globalBin, 'ab'))
          }
          const result = await inspectInstallation({
            distRoot: f.dist,
            globalBin: f.globalBin,
          })
          expect(result.kind).toBe(channel.kind)
          if (result.kind !== 'npm-registry' && result.kind !== 'bun-forge') return
          expect(result.installation).toMatchObject({
            section,
            scope,
            dual: false,
          })
        })
      }
    }
  }

  test('a package in both sections resolves to dependencies and follows its lock block', async () => {
    const f = await fixture({ npm: { dependency: '^2.0.0' }, both: '2.0.0' })
    const result = await inspectInstallation({
      distRoot: f.dist,
      globalBin: f.globalBin,
    })
    expect(result.kind).toBe('npm-registry')
    if (result.kind !== 'npm-registry') return
    expect(result.installation).toMatchObject({
      section: 'dependencies',
      dependency: '^2.0.0',
      dual: true,
    })

    const devOnlyLock = await fixture({
      npm: { dependency: '^2.0.0' },
      both: '2.0.0',
      lockSection: 'devDependencies',
    })
    const refused = await inspectInstallation({
      distRoot: devOnlyLock.dist,
      globalBin: devOnlyLock.globalBin,
    })
    expect(refused.kind).toBe('unknown')
    if (refused.kind === 'unknown') expect(refused.reason).toContain('does not agree')
  })

  test('refuses a lock that records the dependency in the other section', async () => {
    for (const [section, lockSection] of [
      ['devDependencies', 'dependencies'],
      ['dependencies', 'devDependencies'],
    ] as const) {
      const f = await fixture({
        section,
        lockSection,
        npm: { dependency: '^2.0.0' },
      })
      const result = await inspectInstallation({
        distRoot: f.dist,
        globalBin: f.globalBin,
      })
      expect(result.kind).toBe('unknown')
      if (result.kind === 'unknown') expect(result.reason).toContain(`${section} entry`)
    }
  })

  test('names the searched sections when nothing is declared there, or the range is unsatisfied', async () => {
    const optional = await fixture({
      section: 'optionalDependencies',
      npm: { dependency: '^2.0.0' },
    })
    const result = await inspectInstallation({
      distRoot: optional.dist,
      globalBin: optional.globalBin,
    })
    expect(result.kind).toBe('unknown')
    if (result.kind === 'unknown') {
      expect(result.reason).toContain('under dependencies or devDependencies')
    }

    const unsatisfied = await fixture({
      section: 'devDependencies',
      npm: { dependency: '^3.0.0' },
    })
    const second = await inspectInstallation({
      distRoot: unsatisfied.dist,
      globalBin: unsatisfied.globalBin,
    })
    expect(second.kind).toBe('unknown')
    if (second.kind === 'unknown') expect(second.reason).toContain('under devDependencies')
  })
})
