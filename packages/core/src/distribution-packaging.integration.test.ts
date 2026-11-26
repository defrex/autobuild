import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { packageDistribution, withDistributionSelection } from './distribution-packaging'

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

test('dry-run selection falls back on failure or a listed symlink, throws staging errors, and always removes staging', async () => {
  const root = await fixture({ name: 'fixture', version: '1.0.0', files: ['src'] })
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src/a'), 'a')
  await symlink('a', join(root, 'src/link'))
  const listed = (path: string) =>
    `bun pack v1.4.5\n\npacked 2B package.json\npacked 1B ${path}\n\nTotal files: 2\n`
  const allocated: string[] = []
  const filesystem = {
    mkdtemp: async (prefix: string) => {
      const path = await mkdtemp(prefix)
      allocated.push(path)
      return path
    },
    rm,
  }
  const select = (dir: string, stdout: string, exitCode = 0) =>
    withDistributionSelection(
      dir,
      async ({ files }) => files,
      async (cmd) => {
        expect(cmd).toEqual(['bun', 'pm', 'pack', '--ignore-scripts', '--dry-run'])
        return { exitCode, stdout, stderr: '' }
      },
      undefined,
      filesystem,
    )
  expect(await select(root, listed('src/a'))).toEqual(['package.json', 'src/a'])
  expect(await select(root, listed('src/a'), 1)).toBeUndefined()
  expect(await select(root, listed('src/link'))).toBeUndefined()
  await expect(
    select(await fixture({ name: 'fixture', files: ['missing'] }), listed('src/a')),
  ).rejects.toThrow()
  expect(allocated.length).toBe(4)
  for (const path of allocated) await absent(path)
})
