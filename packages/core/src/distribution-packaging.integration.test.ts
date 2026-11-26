import { afterEach, expect, test } from 'bun:test'
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { treeDigest } from './cli/dispatch-runtime-dependencies'
import { distributionRoot } from './distribution'
import {
  packageDistribution,
  RUNTIME_ARCHIVE_GZIP_LEVEL,
  SCRATCH_ARCHIVE_GZIP_LEVEL,
  stageDistributionFiles,
} from './distribution-packaging'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function fixture(manifest: unknown = { name: 'fixture', files: [] }) {
  const root = await mkdtemp(join(tmpdir(), 'ab-pack-fixture-'))
  roots.push(root)
  await writeFile(join(root, 'package.json'), JSON.stringify(manifest))
  return root
}
const absent = async (path: string) => expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })

test('pack bytes survive cleanup; manifest stripping and pack arguments remain intact', async () => {
  const root = await fixture({
    name: 'fixture',
    files: [],
    devDependencies: { local: 'workspace:*' },
    patchedDependencies: { local: 'patch' },
  })
  let staging = '',
    destination = ''
  const bytes = await packageDistribution(root, async (cmd, options) => {
    staging = options.cwd
    destination = cmd.at(-1)!
    expect(cmd.slice(0, 5)).toEqual(['bun', 'pm', 'pack', '--ignore-scripts', '--destination'])
    expect(JSON.parse(await readFile(join(staging, 'package.json'), 'utf8'))).toEqual({
      name: 'fixture',
      files: [],
    })
    await writeFile(join(destination, 'fixture.tgz'), 'archive')
    return { exitCode: 0, stdout: '', stderr: '' }
  })
  expect(new TextDecoder().decode(bytes)).toBe('archive')
  await absent(staging)
  await absent(destination)
})

test('failed pack, source copy and manifest parsing remove both roots', async () => {
  for (const manifest of [{ files: [] }, { files: ['missing'] }, { files: 'invalid' }]) {
    const allocated: string[] = []
    await expect(
      packageDistribution(
        await fixture(manifest),
        async () => ({ exitCode: 3, stdout: '', stderr: 'pack failed' }),
        undefined,
        {
          mkdtemp: async (prefix) => {
            const path = await mkdtemp(prefix)
            allocated.push(path)
            return path
          },
          rm,
        },
      ),
    ).rejects.toThrow()
    expect(allocated.length).toBe(2)
    for (const path of allocated) await absent(path)
  }
})

test('second allocation rejection removes the first; cleanup attempts both roots and preserves primary failure', async () => {
  const root = await fixture()
  let first = ''
  await expect(
    packageDistribution(root, undefined, undefined, {
      mkdtemp: async (prefix) => {
        if (first) throw Error('allocation failed')
        first = await mkdtemp(prefix)
        return first
      },
      rm,
    }),
  ).rejects.toThrow('allocation failed')
  await absent(first)
  const removed: string[] = []
  let caught: unknown
  try {
    await packageDistribution(
      root,
      async () => {
        throw Error('primary pack failure')
      },
      undefined,
      {
        mkdtemp: async (prefix) => {
          const path = await mkdtemp(prefix)
          roots.push(path)
          return path
        },
        rm: async (path) => {
          removed.push(String(path))
          if (removed.length === 1) throw Error('cleanup failed')
          await rm(path, { recursive: true, force: true })
        },
      },
    )
  } catch (error) {
    caught = error
  }
  expect(removed.length).toBe(2)
  expect(caught).toBeInstanceOf(AggregateError)
  expect(String((caught as AggregateError).cause)).toContain('primary pack failure')
})

test('gzip level reaches bun before the destination; invalid levels fail before any allocation', async () => {
  const root = await fixture()
  let command: string[] = []
  await packageDistribution(
    root,
    async (cmd) => {
      command = cmd
      await writeFile(join(cmd.at(-1)!, 'fixture.tgz'), 'archive')
      return { exitCode: 0, stdout: '', stderr: '' }
    },
    undefined,
    undefined,
    { gzipLevel: 2 },
  )
  expect(command.slice(0, -1)).toEqual([
    'bun',
    'pm',
    'pack',
    '--ignore-scripts',
    '--gzip-level',
    '2',
    '--destination',
  ])
  for (const gzipLevel of [-1, 10, 1.5, Number.NaN]) {
    let allocated = 0
    await expect(
      packageDistribution(
        root,
        async () => {
          throw Error('pack must not run')
        },
        undefined,
        {
          mkdtemp: async () => {
            allocated++
            throw Error('must not allocate')
          },
          rm,
        },
        { gzipLevel },
      ),
    ).rejects.toThrow('gzip level must be an integer from 0 to 9')
    expect(allocated).toBe(0)
  }
})

test('every boot gzip level extracts the same packaged tree as the default', async () => {
  const root = await fixture({
    name: 'fixture',
    version: '1.0.0',
    files: ['src', 'bin', 'docs', '!src/**/*.test.ts'],
    devDependencies: { local: 'workspace:*' },
    patchedDependencies: { local: 'patch' },
  })
  await mkdir(join(root, 'src/nested'), { recursive: true })
  await mkdir(join(root, 'bin'))
  await mkdir(join(root, 'docs'))
  await writeFile(join(root, 'src/nested/module.ts'), 'export const value = 1\n'.repeat(2000))
  await writeFile(join(root, 'src/nested/module.test.ts'), 'excluded\n')
  await writeFile(join(root, 'bin/tool.ts'), '#!/usr/bin/env bun\n')
  await chmod(join(root, 'bin/tool.ts'), 0o755)
  await writeFile(join(root, 'docs/guide.md'), '# Guide\n')
  const unpack = async (bytes: Uint8Array) => {
    const dir = await mkdtemp(join(tmpdir(), 'ab-pack-extract-'))
    roots.push(dir)
    await writeFile(join(dir, 'archive.tgz'), bytes)
    await mkdir(join(dir, 'tree'))
    await Bun.$`tar -xzf ${join(dir, 'archive.tgz')} --strip-components=1 -C ${join(dir, 'tree')}`.quiet()
    return join(dir, 'tree')
  }
  const defaultBytes = await packageDistribution(root)
  const expected = await unpack(defaultBytes)
  await absent(join(expected, 'src/nested/module.test.ts'))
  expect((await stat(join(expected, 'bin/tool.ts'))).mode & 0o111).not.toBe(0)
  const manifest = JSON.parse(await readFile(join(expected, 'package.json'), 'utf8'))
  expect(manifest.devDependencies).toBeUndefined()
  expect(manifest.patchedDependencies).toBeUndefined()
  for (const gzipLevel of [SCRATCH_ARCHIVE_GZIP_LEVEL, RUNTIME_ARCHIVE_GZIP_LEVEL]) {
    const bytes = await packageDistribution(root, undefined, undefined, undefined, { gzipLevel })
    expect(await treeDigest(await unpack(bytes))).toBe(await treeDigest(expected))
    if (gzipLevel === SCRATCH_ARCHIVE_GZIP_LEVEL)
      expect(bytes.length).toBeGreaterThan(defaultBytes.length)
  }
})

/** The staging loop `stageDistributionFiles` replaced: the behavior it must keep. */
async function serialStage(root: string, staging: string, entries: readonly string[]) {
  for (const entry of entries) {
    const target = join(staging, entry)
    await mkdir(dirname(target), { recursive: true })
    await cp(join(root, entry), target, { recursive: true, errorOnExist: true, force: false })
  }
}

async function listing(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = []
  for (const name of (await readdir(join(dir, rel))).sort()) {
    const path = join(rel, name)
    const status = await lstat(join(dir, path))
    const kind = status.isDirectory() ? 'dir' : status.isFile() ? 'file' : 'link'
    const content =
      kind === 'link'
        ? await readlink(join(dir, path))
        : kind === 'file'
          ? String(Bun.hash(await readFile(join(dir, path))))
          : ''
    out.push(`${path} ${kind} ${(status.mode & 0o7777).toString(8)} ${content}`)
    if (kind === 'dir') out.push(...(await listing(dir, path)))
  }
  return out
}

async function stagedBothWays(root: string, entries: readonly string[]) {
  const [oracle, staged] = await Promise.all([
    mkdtemp(join(tmpdir(), 'ab-stage-oracle-')),
    mkdtemp(join(tmpdir(), 'ab-stage-bounded-')),
  ])
  roots.push(oracle, staged)
  await serialStage(root, oracle, entries)
  await stageDistributionFiles(root, staged, entries)
  const result = [await listing(oracle), await listing(staged)] as const
  // Read-only directories must be writable again for cleanup.
  await Bun.$`chmod -R u+w ${oracle} ${staged}`.quiet()
  return result
}

test('bounded staging reproduces the serial cp tree: modes, links, dotfiles and nested entries', async () => {
  const root = await fixture()
  const write = async (path: string, body: string, mode = 0o644) => {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), body)
    await chmod(join(root, path), mode)
  }
  await write('src/nested/deep/module.ts', 'export {}\n')
  await write('src/.hidden', 'dot\n')
  await write('src/node_modules/pkg/index.js', 'module.exports = 1\n')
  await write('src/tool.ts', '#!/usr/bin/env bun\n', 0o755)
  await write('src/secret.txt', 'secret\n', 0o640)
  await write('src/setuid', 'suid\n', 0o4755)
  await write('src/locked/inner/file.ts', 'locked\n')
  await write('src/private/file.ts', 'private\n')
  await mkdir(join(root, 'src/empty'))
  await symlink('nested/deep/module.ts', join(root, 'src/relative-link'))
  await symlink('/etc/hostname', join(root, 'src/absolute-link'))
  await symlink('nested', join(root, 'src/directory-link'))
  await write('a/b/c', 'nested entry\n')
  await write('LICENSE', 'license\n')
  await chmod(join(root, 'src/private'), 0o750)
  await chmod(join(root, 'src/locked'), 0o555)
  try {
    const [oracle, staged] = await stagedBothWays(root, ['src', 'a/b/c', 'LICENSE'])
    expect(staged).toEqual(oracle)
    expect(oracle.length).toBeGreaterThan(15)
  } finally {
    await chmod(join(root, 'src/locked'), 0o755)
  }
})

test('bounded staging reproduces the serial cp tree for the shipped distribution', async () => {
  const root = distributionRoot()
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const entries = (manifest.files as string[]).filter((entry) => !entry.startsWith('!'))
  const [oracle, staged] = await stagedBothWays(root, entries)
  expect(staged).toEqual(oracle)
})
