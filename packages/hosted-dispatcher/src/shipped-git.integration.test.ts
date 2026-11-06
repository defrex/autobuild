import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Exec } from '@defrex/autobuild/git-worktree'
import {
  kernelAtLeast,
  locateShippedGit,
  materializeShippedGit,
  shippedGitExec,
  shippedGitShim,
  type ShippedGitManifest,
} from './shipped-git'

const cleanup: string[] = []
afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true })
})

async function scratch(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  cleanup.push(path)
  return path
}

/** A project with `.autobuild-git/` whose runtime root is a fresh temp path. */
async function project(patch: Partial<ShippedGitManifest> = {}) {
  const root = await scratch('ab-shipped-project-')
  const target = join(await scratch('ab-shipped-runtime-'), 'tree')
  const tree = join(root, '.autobuild-git')
  await mkdir(join(tree, 'bin'), { recursive: true })
  await writeFile(join(tree, 'bin', 'git'), '#!/bin/sh\n', { mode: 0o644 })
  const manifest: ShippedGitManifest = {
    schema: 1,
    platform: 'linux-x64',
    gitVersion: '2.99.0',
    glibcVersion: '2.34',
    minimumKernel: '3.2.0',
    root: target,
    git: 'bin/git',
    execPath: 'libexec/git-core',
    lib: 'lib',
    caBundle: 'ssl/ca-bundle.crt',
    files: ['bin/git'],
    executables: ['bin/git'],
    bytes: 10,
    ...patch,
  }
  const raw = JSON.stringify(manifest)
  await writeFile(join(tree, 'manifest.json'), raw)
  return { root, tree, target, manifest, raw }
}

const linux = { platform: 'linux', arch: 'x64', kernel: '6.1.0-amzn' }

describe('locateShippedGit', () => {
  test('the first root holding a manifest wins and is unpacked executable', async () => {
    const empty = await scratch('ab-shipped-empty-')
    const first = await project()
    const second = await project({ gitVersion: '1.0.0' })
    const result = await locateShippedGit({ roots: [empty, first.root, second.root], ...linux })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.git.root).toBe(first.target)
    expect(result.git.manifest.gitVersion).toBe('2.99.0')
    expect((await stat(join(first.target, 'bin', 'git'))).mode & 0o777).toBe(0o755)
  })

  test('each failure names its cause', async () => {
    const empty = await scratch('ab-shipped-empty-')
    expect(await locateShippedGit({ roots: [empty], ...linux })).toEqual({
      ok: false,
      reason: `no .autobuild-git/manifest.json under ${empty}`,
    })
    const schema = await project({ schema: 2 as 1 })
    expect(await locateShippedGit({ roots: [schema.root], ...linux })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('unsupported manifest schema 2'),
    })
    const shipped = await project()
    expect(
      await locateShippedGit({
        roots: [shipped.root],
        ...linux,
        platform: 'darwin',
        arch: 'arm64',
      }),
    ).toEqual({
      ok: false,
      reason: 'shipped Git targets linux-x64, but this runtime is darwin-arm64',
    })
    expect(await locateShippedGit({ roots: [shipped.root], ...linux, kernel: '3.1.10' })).toEqual({
      ok: false,
      reason: 'shipped Git needs Linux 3.2.0 or newer, but this runtime is 3.1.10',
    })
    // A runtime root whose parent is a file cannot be created.
    const file = join(await scratch('ab-shipped-file-'), 'occupied')
    await writeFile(file, '')
    const unwritable = await project({ root: join(file, 'tree') })
    expect(await locateShippedGit({ roots: [unwritable.root], ...linux })).toMatchObject({
      ok: false,
      reason: expect.stringContaining(`could not unpack shipped Git to ${join(file, 'tree')}`),
    })
  })

  test('kernel versions compare numerically', () => {
    expect(kernelAtLeast('5.10.240-238.959.amzn2.x86_64', '3.2.0')).toBe(true)
    expect(kernelAtLeast('3.2', '3.2.0')).toBe(true)
    expect(kernelAtLeast('3.10.0', '3.2.0')).toBe(true)
    expect(kernelAtLeast('2.6.32', '3.2.0')).toBe(false)
    expect(kernelAtLeast('unknown', '3.2.0')).toBe(false)
  })
})

describe('materializeShippedGit', () => {
  test('a complete copy of the same manifest is reused', async () => {
    const shipped = await project()
    await materializeShippedGit(shipped.tree, shipped.manifest, shipped.raw)
    await writeFile(join(shipped.target, 'bin', 'git'), 'kept')
    await materializeShippedGit(shipped.tree, shipped.manifest, shipped.raw)
    expect(await readFile(join(shipped.target, 'bin', 'git'), 'utf8')).toBe('kept')
  })

  test('a stale tree from another manifest is replaced', async () => {
    const shipped = await project()
    await mkdir(join(shipped.target, 'bin'), { recursive: true })
    await writeFile(join(shipped.target, 'bin', 'git'), 'stale')
    await writeFile(join(shipped.target, '.complete'), 'other')
    await materializeShippedGit(shipped.tree, shipped.manifest, shipped.raw)
    expect(await readFile(join(shipped.target, 'bin', 'git'), 'utf8')).toBe('#!/bin/sh\n')
  })

  test('the tree carries an executable git launcher for shells', async () => {
    const shipped = await project()
    await materializeShippedGit(shipped.tree, shipped.manifest, shipped.raw)
    const launcher = join(shipped.target, 'shim', 'git')
    expect(await readFile(launcher, 'utf8')).toBe(
      shippedGitShim({ root: shipped.target, manifest: shipped.manifest }),
    )
    expect((await stat(launcher)).mode & 0o777).toBe(0o755)
  })

  test('a tree an older deployment unpacked without the launcher is replaced', async () => {
    const shipped = await project()
    await mkdir(join(shipped.target, 'bin'), { recursive: true })
    await writeFile(join(shipped.target, 'bin', 'git'), 'stale')
    await writeFile(
      join(shipped.target, '.complete'),
      createHash('sha256').update(shipped.raw).digest('hex'),
    )
    await materializeShippedGit(shipped.tree, shipped.manifest, shipped.raw)
    expect(await readFile(join(shipped.target, 'bin', 'git'), 'utf8')).toBe('#!/bin/sh\n')
    expect((await stat(join(shipped.target, 'shim', 'git'))).isFile()).toBe(true)
  })

  test('concurrent unpackers both end with one valid tree', async () => {
    const shipped = await project()
    await Promise.all(
      Array.from({ length: 4 }, () =>
        materializeShippedGit(shipped.tree, shipped.manifest, shipped.raw),
      ),
    )
    expect(await readFile(join(shipped.target, 'bin', 'git'), 'utf8')).toBe('#!/bin/sh\n')
    expect(await readFile(join(shipped.target, '.complete'), 'utf8')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('shippedGitExec', () => {
  const git = {
    root: '/tmp/abg01234567',
    manifest: {
      git: 'bin/git',
      execPath: 'libexec/git-core',
      lib: 'lib',
      caBundle: 'ssl/ca-bundle.crt',
      templates: 'share/git-core/templates',
    } as ShippedGitManifest,
  }

  function recording() {
    const calls: { cmd: string[]; env?: Record<string, string | undefined> }[] = []
    const base: Exec = async (cmd, opts) => {
      calls.push({ cmd, ...(opts.env ? { env: opts.env } : {}) })
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    return { calls, base }
  }

  test('routes git to the shipped tree with its confining environment', async () => {
    const { calls, base } = recording()
    await shippedGitExec(base, git, { PATH: '/usr/bin' })(['git', 'fetch', 'origin'], {
      cwd: '/repo',
      env: { LD_LIBRARY_PATH: '/host/lib', GIT_CONFIG_COUNT: '1' },
    })
    expect(calls[0]!.cmd).toEqual(['/tmp/abg01234567/bin/git', 'fetch', 'origin'])
    expect(calls[0]!.env).toEqual({
      GIT_EXEC_PATH: '/tmp/abg01234567/libexec/git-core',
      LD_LIBRARY_PATH: '/tmp/abg01234567/lib',
      GIT_SSL_CAINFO: '/tmp/abg01234567/ssl/ca-bundle.crt',
      GIT_TEMPLATE_DIR: '/tmp/abg01234567/share/git-core/templates',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_ALLOW_PROTOCOL: 'https',
      GIT_CONFIG_COUNT: '1',
      PATH: '/tmp/abg01234567/bin:/usr/bin',
    })
  })

  test("keeps the caller's CA bundle, protocol and config overrides", async () => {
    const { calls, base } = recording()
    await shippedGitExec(
      base,
      git,
      {},
    )(['git', 'ls-remote'], {
      env: {
        GIT_SSL_CAINFO: '/custom.pem',
        GIT_ALLOW_PROTOCOL: 'https:http',
        GIT_CONFIG_GLOBAL: '/custom.gitconfig',
        GIT_CONFIG_KEY_0: 'credential.helper',
      },
    })
    expect(calls[0]!.env).toMatchObject({
      GIT_SSL_CAINFO: '/custom.pem',
      GIT_ALLOW_PROTOCOL: 'https:http',
      GIT_CONFIG_GLOBAL: '/custom.gitconfig',
      GIT_CONFIG_KEY_0: 'credential.helper',
      PATH: '/tmp/abg01234567/bin',
    })
  })

  test('non-git commands keep their own libraries and find the launcher', async () => {
    const { calls, base } = recording()
    const exec = shippedGitExec(base, git, { PATH: '/usr/bin' })
    await exec(['gh', 'auth', 'token'], {})
    await exec(['sh', '-c', 'git status'], {
      env: { PATH: '/caller/bin', LD_LIBRARY_PATH: '/host/lib', GIT_CONFIG_COUNT: '1' },
    })
    expect(calls).toEqual([
      { cmd: ['gh', 'auth', 'token'], env: { PATH: '/tmp/abg01234567/shim:/usr/bin' } },
      {
        cmd: ['sh', '-c', 'git status'],
        env: {
          PATH: '/tmp/abg01234567/shim:/caller/bin',
          LD_LIBRARY_PATH: '/host/lib',
          GIT_CONFIG_COUNT: '1',
        },
      },
    ])
  })

  test('the launcher confines only Git and keeps caller overrides', () => {
    expect(shippedGitShim(git)).toBe(
      [
        '#!/bin/sh',
        "export GIT_EXEC_PATH='/tmp/abg01234567/libexec/git-core'",
        "export LD_LIBRARY_PATH='/tmp/abg01234567/lib'",
        `[ -n "\${GIT_SSL_CAINFO+set}" ] || GIT_SSL_CAINFO='/tmp/abg01234567/ssl/ca-bundle.crt'; export GIT_SSL_CAINFO`,
        "export GIT_TEMPLATE_DIR='/tmp/abg01234567/share/git-core/templates'",
        `[ -n "\${GIT_CONFIG_NOSYSTEM+set}" ] || GIT_CONFIG_NOSYSTEM='1'; export GIT_CONFIG_NOSYSTEM`,
        `[ -n "\${GIT_CONFIG_GLOBAL+set}" ] || GIT_CONFIG_GLOBAL='/dev/null'; export GIT_CONFIG_GLOBAL`,
        `[ -n "\${GIT_ALLOW_PROTOCOL+set}" ] || GIT_ALLOW_PROTOCOL='https'; export GIT_ALLOW_PROTOCOL`,
        `exec '/tmp/abg01234567/bin/git' "$@"`,
        '',
      ].join('\n'),
    )
  })
})
