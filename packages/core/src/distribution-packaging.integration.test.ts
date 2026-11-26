import { afterEach, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { treeDigest } from './cli/dispatch-runtime-dependencies'
import {
  packageDistribution,
  RUNTIME_ARCHIVE_GZIP_LEVEL,
  SCRATCH_ARCHIVE_GZIP_LEVEL,
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

test('an owned snapshot packs in place: no staging copy, no writes inside it, destination removed', async () => {
  const root = await fixture({ name: 'fixture', version: '1.0.0', files: [] })
  const before = await treeDigest(root)
  for (const exitCode of [0, 3]) {
    const allocated: string[] = []
    let cwd = ''
    let command: string[] = []
    const pack = packageDistribution(
      root,
      async (cmd, options) => {
        cwd = options.cwd
        command = cmd
        await writeFile(join(cmd.at(-1)!, 'fixture.tgz'), 'archive')
        return { exitCode, stdout: '', stderr: 'pack failed' }
      },
      undefined,
      {
        mkdtemp: async (prefix) => {
          const path = await mkdtemp(prefix)
          allocated.push(path)
          return path
        },
        rm,
      },
      { gzipLevel: RUNTIME_ARCHIVE_GZIP_LEVEL, ownedSnapshot: true },
    )
    if (exitCode === 0) expect(new TextDecoder().decode(await pack)).toBe('archive')
    else await expect(pack).rejects.toThrow('pack failed')
    expect(cwd).toBe(root)
    expect(allocated.length).toBe(1)
    expect(command).toEqual([
      'bun',
      'pm',
      'pack',
      '--ignore-scripts',
      '--gzip-level',
      String(RUNTIME_ARCHIVE_GZIP_LEVEL),
      '--destination',
      allocated[0]!,
    ])
    await absent(allocated[0]!)
    expect(await treeDigest(root)).toBe(before)
  }
})

test('an owned snapshot with an unnormalized manifest is refused before any allocation, unchanged', async () => {
  for (const [manifest, message] of [
    [{ files: [], devDependencies: { local: 'workspace:*' } }, 'declares devDependencies'],
    [{ files: [], patchedDependencies: { local: 'patch' } }, 'declares patchedDependencies'],
    [{ files: 'invalid' }, 'list its files as an array'],
    [{ files: [1] }, 'list its files as an array'],
  ] as const) {
    const root = await fixture(manifest)
    const bytes = await readFile(join(root, 'package.json'), 'utf8')
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
        { ownedSnapshot: true },
      ),
    ).rejects.toThrow(message)
    expect(allocated).toBe(0)
    expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(bytes)
  }
})

test('an owned snapshot packs the same tree as a staged pack and leaves its root unchanged', async () => {
  const manifest = { name: 'fixture', version: '1.0.0', files: ['src', 'bin', '!src/**/*.test.ts'] }
  const root = await fixture()
  // The runtime snapshot writes its normalized manifest in the packer's form.
  await writeFile(join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await mkdir(join(root, 'src'))
  await mkdir(join(root, 'bin'))
  await mkdir(join(root, 'node_modules/dep'), { recursive: true })
  await writeFile(join(root, 'src/a.ts'), 'export const a = 1\n')
  await writeFile(join(root, 'src/x.test.ts'), 'excluded\n')
  await symlink('a.ts', join(root, 'src/alias.ts'))
  await writeFile(join(root, 'bin/tool.ts'), '#!/usr/bin/env bun\n')
  await chmod(join(root, 'bin/tool.ts'), 0o755)
  await writeFile(join(root, 'node_modules/dep/package.json'), '{"name":"dep"}')
  const before = await treeDigest(root)
  const unpack = async (bytes: Uint8Array) => {
    const dir = await mkdtemp(join(tmpdir(), 'ab-pack-extract-'))
    roots.push(dir)
    await writeFile(join(dir, 'archive.tgz'), bytes)
    await mkdir(join(dir, 'tree'))
    await Bun.$`tar -xzf ${join(dir, 'archive.tgz')} --strip-components=1 -C ${join(dir, 'tree')}`.quiet()
    return join(dir, 'tree')
  }
  const options = { gzipLevel: RUNTIME_ARCHIVE_GZIP_LEVEL }
  const staged = await unpack(
    await packageDistribution(root, undefined, undefined, undefined, options),
  )
  const owned = await unpack(
    await packageDistribution(root, undefined, undefined, undefined, {
      ...options,
      ownedSnapshot: true,
    }),
  )
  expect(await treeDigest(owned)).toBe(await treeDigest(staged))
  await absent(join(owned, 'src/x.test.ts'))
  await absent(join(owned, 'node_modules'))
  expect((await stat(join(owned, 'bin/tool.ts'))).mode & 0o111).not.toBe(0)
  expect(await treeDigest(root)).toBe(before)
})
