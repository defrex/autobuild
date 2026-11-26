import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, readdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  sourceContent,
  productionLockClosure,
  sourceCommand,
  withSourceExport,
  sourceRepository,
  packedContentFingerprint,
  archivedPackageFingerprint,
  packagedFingerprint,
} from './dispatch-upgrade-source'
import { distributionRoot } from '../distribution'
import { scanDependencies, treeDigest } from './dispatch-runtime-dependencies'
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(parent = tmpdir()) {
  const root = await mkdtemp(join(parent, 'ab-source-test-'))
  roots.push(root)
  await mkdir(join(root, 'src'))
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'source-fixture',
      version: '1.0.0',
      files: ['src', '!src/*.test.ts', 'docs'],
    }),
  )
  await mkdir(join(root, 'docs'))
  await writeFile(join(root, 'docs/guide.md'), 'guide')
  await writeFile(join(root, 'src/main.ts'), 'export const value = 1')
  await writeFile(join(root, 'src/main.test.ts'), 'excluded')
  await writeFile(
    join(root, 'bun.lock'),
    JSON.stringify({ lockfileVersion: 1, workspaces: { '': {} }, packages: {} }),
  )
  return root
}
test('real pack identity excludes tests, archive times and provenance; includes docs, bytes, paths and executable mode', async () => {
  const root = await fixture()
  const key = async () => (await sourceContent(root, '/repository')).key
  const initial = await key()
  await writeFile(join(root, 'bunfig.toml'), '[install]\nexact = true\nlogLevel = "debug"\n')
  expect(await key()).toBe(initial)
  await writeFile(join(root, 'src/main.test.ts'), 'changed test')
  await writeFile(join(root, 'unpackaged'), 'excluded')
  expect(await key()).toBe(initial)
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  manifest.gitHead = 'a'.repeat(40)
  await writeFile(join(root, 'package.json'), JSON.stringify(manifest))
  expect(await key()).toBe(initial)
  await writeFile(join(root, 'docs/guide.md'), 'changed guide')
  expect(await key()).not.toBe(initial)
  await writeFile(join(root, 'docs/guide.md'), 'guide')
  await chmod(join(root, 'src/main.ts'), 0o755)
  expect(await key()).not.toBe(initial)
  await chmod(join(root, 'src/main.ts'), 0o644)
  await rm(join(root, 'src/main.ts'))
  expect(await key()).not.toBe(initial)
})
test('real Bun nested/scoped/peer/optional records agree with installed production graph; unrelated workspace changes are irrelevant', async () => {
  const root = await fixture()
  const manifest = {
    name: 'source-fixture',
    version: '1.0.0',
    workspaces: ['website'],
    files: ['src'],
    dependencies: { debug: '4.3.4', ms: '2.1.3', '@ai-sdk/gateway': '4.0.82', zod: '^4.4.3' },
    optionalDependencies: { 'is-number': '7.0.0' },
  }
  await mkdir(join(root, 'website'))
  await writeFile(
    join(root, 'website/package.json'),
    JSON.stringify({ name: 'website', dependencies: { 'is-odd': '3.0.1' } }),
  )
  await writeFile(join(root, 'package.json'), JSON.stringify(manifest))
  await sourceCommand([process.execPath, 'install', '--ignore-scripts', '--no-progress'], root)
  const lock = Bun.JSONC.parse(await readFile(join(root, 'bun.lock'), 'utf8')) as {
    packages: Record<string, unknown[]>
    workspaces: { website: { dependencies: Record<string, string> } }
  }
  const closure = productionLockClosure(manifest, lock).records as Record<string, unknown[]>
  const graph = await scanDependencies(root)
  expect(new Set(Object.values(closure).map((r) => r[0]))).toEqual(
    new Set(graph.packages.map((p) => `${p.manifest.name}@${p.manifest.version}`)),
  )
  expect(Object.values(closure).some((r) => r[0] === 'ms@2.1.2')).toBe(true)
  expect(Object.values(closure).some((r) => r[0] === 'ms@2.1.3')).toBe(true)
  const initial = (await sourceContent(root, '/repository')).key
  lock.packages['is-odd']![3] = 'changed-unreachable-integrity'
  lock.workspaces.website.dependencies['is-odd'] = '3.0.0'
  await writeFile(join(root, 'bun.lock'), JSON.stringify(lock))
  expect((await sourceContent(root, '/repository')).key).toBe(initial)
  lock.packages.ms![3] = 'changed-reachable-integrity'
  await writeFile(join(root, 'bun.lock'), JSON.stringify(lock))
  expect((await sourceContent(root, '/repository')).key).not.toBe(initial)
}, 120_000)
test('isolated exact export leaves index, working files and refs alone, and cleans on failure/abort', async () => {
  const root = await fixture()
  const git = (...args: string[]) => sourceCommand(['git', ...args], root)
  await git('init', '-b', 'main')
  await git('config', 'user.name', 'Test')
  await git('config', 'user.email', 'test@example.com')
  await git('add', '.')
  await git('commit', '-m', 'initial')
  const sha = (await git('rev-parse', 'HEAD')).trim()
  await writeFile(join(root, 'src/main.ts'), 'dirty')
  const before = await git('status', '--porcelain')
  await withSourceExport({ checkout: root, sha }, async (exported) => {
    expect(await readFile(join(exported, 'src/main.ts'), 'utf8')).toBe('export const value = 1')
    expect(await sourceRepository(root, root)).toBeTruthy()
    expect(await sourceRepository(exported, root)).toBeUndefined()
  })
  expect(await git('status', '--porcelain')).toBe(before)
  await expect(
    withSourceExport({ checkout: root, sha }, async () => {
      throw new Error('failure')
    }),
  ).rejects.toThrow('failure')
  expect(
    (await readdir(join(root, '.autobuild/runtime'))).filter((n) => n.startsWith('.preparing')),
  ).toEqual([])
})

test.each(['checkout', 'workspace', 'both'])(
  'source fingerprinting does not require writable source parents (%s)',
  async (readonly) => {
    const parent = await mkdtemp(join(tmpdir(), 'ab-source-readonly-'))
    roots.push(parent)
    const root = await fixture(parent)
    const workspaceParent = join(root, 'packages')
    const workspace = join(workspaceParent, 'dependency')
    await mkdir(join(workspace, 'src'), { recursive: true })
    await writeFile(join(workspace, 'src/index.ts'), 'export const dependency = true')
    await writeFile(
      join(workspace, 'package.json'),
      JSON.stringify({
        name: 'workspace-dependency',
        version: '1.0.0',
        files: ['src'],
      }),
    )
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    manifest.dependencies = { 'workspace-dependency': '1.0.0' }
    manifest.workspaces = ['packages/*']
    await writeFile(join(root, 'package.json'), JSON.stringify(manifest))
    await writeFile(
      join(root, 'bun.lock'),
      JSON.stringify({
        lockfileVersion: 1,
        workspaces: {
          '': { dependencies: manifest.dependencies },
          'packages/dependency': { name: 'workspace-dependency', version: '1.0.0' },
        },
        packages: {
          'workspace-dependency': ['workspace-dependency@workspace:packages/dependency'],
        },
      }),
    )
    const before = await treeDigest(root)
    const siblings = await readdir(parent)
    const workspaceSiblings = await readdir(workspaceParent)
    if (readonly !== 'workspace') await chmod(parent, 0o555)
    if (readonly !== 'checkout') await chmod(workspaceParent, 0o555)
    try {
      const initial = await sourceContent(root, '/repository')
      expect((await sourceContent(root, '/repository')).key).toBe(initial.key)
      expect(await treeDigest(root)).toBe(before)
      expect(await readdir(parent)).toEqual(siblings)
      expect(await readdir(workspaceParent)).toEqual(workspaceSiblings)
    } finally {
      await chmod(workspaceParent, 0o755)
      await chmod(parent, 0o755)
    }
  },
)

/** Deterministic root + reachable workspace; every mode is explicit so the
 * golden identity below depends only on content, never on creation defaults. */
async function goldenFixture() {
  const root = await mkdtemp(join(tmpdir(), 'ab-source-golden-'))
  roots.push(root)
  const write = async (path: string, content: string, mode = 0o644) => {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), content)
    await chmod(join(root, path), mode)
  }
  await write(
    'package.json',
    JSON.stringify({
      version: '2.0.0',
      name: 'golden-fixture',
      bin: { golden: 'bin/golden.ts' },
      files: ['src', '!src/**/*.test.ts', 'docs', 'bin/golden.ts'],
      dependencies: { 'workspace-dependency': '1.0.0' },
      devDependencies: { 'dev-only': 'workspace:*' },
      workspaces: ['packages/*'],
      gitHead: 'b'.repeat(40),
    }),
  )
  await write('bin/golden.ts', '#!/usr/bin/env bun\n', 0o755)
  await write('src/main.ts', 'export const value = 1')
  await write('src/run.sh', 'echo run', 0o755)
  await write('src/nested/deep.ts', 'deep')
  await write('src/nested/deep.test.ts', 'excluded')
  await write('docs/guide.md', 'guide')
  await write('unpackaged.txt', 'excluded')
  await write(
    'packages/dependency/package.json',
    JSON.stringify({ name: 'workspace-dependency', version: '1.0.0', files: ['src'] }),
  )
  await write('packages/dependency/src/index.ts', 'export const dependency = true')
  await write(
    'bun.lock',
    JSON.stringify({
      lockfileVersion: 1,
      workspaces: {
        '': { dependencies: { 'workspace-dependency': '1.0.0' } },
        'packages/dependency': { name: 'workspace-dependency', version: '1.0.0' },
      },
      packages: {
        'workspace-dependency': ['workspace-dependency@workspace:packages/dependency'],
      },
    }),
  )
  return root
}

test('source identity keeps the canonical value captured before archive-free fingerprinting', async () => {
  const root = await goldenFixture()
  expect((await sourceContent(root, '/repository')).key).toBe(
    '4c79b05ee240b1adc25ebe9ddebbc73feb20110d812599ac54213b0f6e535c69',
  )
})

type Entry = string | { content: string; mode: number } | { link: string }
async function tree(entries: Record<string, Entry>) {
  const root = await mkdtemp(join(tmpdir(), 'ab-source-pack-'))
  roots.push(root)
  for (const [path, entry] of Object.entries(entries)) {
    const file = join(root, path)
    await mkdir(join(file, '..'), { recursive: true })
    if (path.endsWith('/')) await mkdir(file, { recursive: true })
    else if (typeof entry === 'object' && 'link' in entry) await symlink(entry.link, file)
    else {
      await writeFile(file, typeof entry === 'string' ? entry : entry.content)
      await chmod(file, typeof entry === 'string' ? 0o644 : entry.mode)
    }
  }
  return root
}
const selectionFixture = () =>
  tree({
    'package.json': JSON.stringify({
      version: '1.0.0',
      name: 'selection-fixture',
      gitHead: 'c'.repeat(40),
      main: 'outside/main.js',
      bin: { tool: 'bin/tool.js', other: 'outside/other.js' },
      files: ['src', '!src/**/*.test.ts', '!src/drop.ts', 'bin/tool.js', 'lib/a/b.js', 'workspace'],
      devDependencies: { local: 'workspace:*' },
      patchedDependencies: { local: 'patches/local.patch' },
    }),
    'bin/tool.js': { content: '#!/usr/bin/env bun', mode: 0o755 },
    'bin/unlisted.js': 'unlisted',
    'lib/a/b.js': 'deep',
    'lib/a/c.js': 'unselected sibling',
    'outside/main.js': 'outside',
    'src/B': 'upper',
    'src/a': 'lower',
    'src/a b.ts': 'space',
    'src/é.md': 'accent',
    'src/drop.ts': 'negated exactly',
    'src/x/y.test.ts': 'negated glob',
    'src/x/keep.ts': 'kept',
    'src/x/.npmignore': 'ignored-by-npmignore\n',
    'src/x/ignored-by-npmignore': 'ignored',
    'src/y/.gitignore': 'ignored-by-gitignore\n',
    'src/y/ignored-by-gitignore': 'ignored',
    'src/y/kept': 'kept',
    'src/node_modules/dep/index.js': 'excluded',
    'src/.DS_Store': 'excluded',
    'src/.npmrc': 'excluded',
    'src/edit.swp': 'excluded',
    'src/bun.lock': '{}',
    'src/.hidden': 'dotfile',
    'src/empty/': '',
    'src/README.md': 'nested readme',
    'src/LICENSE': 'nested license',
    'src/owner.sh': { content: 'owner', mode: 0o700 },
    'src/group.sh': { content: 'group', mode: 0o744 },
    'src/all.sh': { content: 'all', mode: 0o755 },
    'src/file-link': { link: 'a' },
    'src/dir-link': { link: 'x' },
    'workspace/package.json': JSON.stringify({
      name: 'selection-workspace',
      version: '1.0.0',
      files: ['lib', '!lib/*.map'],
    }),
    'workspace/lib/index.js': 'index',
    'workspace/lib/index.js.map': 'excluded',
  })

test('archive-free identity equals the real-pack archive identity across selection behavior', async () => {
  const root = await selectionFixture()
  for (const dir of [root, join(root, 'workspace')]) {
    const fast = await packedContentFingerprint(dir)
    expect(fast).toBeString()
    expect(fast).toBe(await archivedPackageFingerprint(dir))
  }
})

test("the repository's own packed root takes the archive-free path with the archive identity", async () => {
  const root = distributionRoot()
  const fast = await packedContentFingerprint(root)
  expect(fast).toBeString()
  expect(fast).toBe(await archivedPackageFingerprint(root))
}, 60_000)

const binCases: Array<[string, Record<string, unknown>, number, string]> = [
  ['bin string', { bin: 'src/a' }, 0o644, 'src/a'],
  ['bin dot', { bin: { p: './src/a' } }, 0o644, 'src/a'],
  ['bin absolute', { bin: { p: '/src/a' } }, 0o600, 'src/a'],
  ['bin inner parent', { bin: { p: 'src/n/../a' } }, 0o644, 'src/a'],
  ['directories.bin child', { directories: { bin: 'src/b' } }, 0o644, 'src/b/c'],
  ['directories.bin deeper', { directories: { bin: './src/b/' } }, 0o644, 'src/b/d/e'],
  ['bin non-string', { bin: { p: 5 } }, 0o644, 'src/a'],
]
test.each(binCases)(
  'bin targets Bun would re-mode fall back to the archive (%s)',
  async (name, fields, mode, target) => {
    const root = await tree({
      'package.json': JSON.stringify({
        name: 'bin-fixture',
        version: '1.0.0',
        files: ['src'],
        ...fields,
      }),
      'src/a': 'a',
      'src/b/c': { content: 'c', mode: 0o755 },
      'src/b/d/e': { content: 'e', mode: 0o755 },
    })
    await chmod(join(root, target), mode)
    expect(await packedContentFingerprint(root)).toBeUndefined()
    expect(await packagedFingerprint(root)).toBe(await archivedPackageFingerprint(root))
    if (name === 'bin string') {
      await chmod(join(root, target), 0o755)
      const fast = await packedContentFingerprint(root)
      expect(fast).toBeString()
      expect(fast).toBe(await archivedPackageFingerprint(root))
    }
  },
)

test('a creation mask that strips execute bits keeps the exact archive identity', async () => {
  const root = await selectionFixture()
  const module = join(import.meta.dir, 'dispatch-upgrade-source.ts')
  const script = `
    const m = await import(${JSON.stringify(module)})
    const root = ${JSON.stringify(root)}
    console.log(JSON.stringify({
      fast: (await m.packedContentFingerprint(root)) ?? null,
      packaged: await m.packagedFingerprint(root),
      archived: await m.archivedPackageFingerprint(root),
    }))`
  const under = async (mask: string) =>
    JSON.parse(
      await sourceCommand(
        ['sh', '-c', 'umask "$1"; shift; exec "$@"', 'sh', mask, process.execPath, '-e', script],
        root,
      ),
    ) as { fast: string | null; packaged: string; archived: string }
  const normal = await archivedPackageFingerprint(root)
  for (const mask of ['077', '027']) {
    const result = await under(mask)
    expect(result.fast).toBeNull()
    expect(result.packaged).toBe(result.archived)
    if (mask === '077') expect(result.archived).not.toBe(normal)
  }
  const permissive = await under('022')
  expect(permissive.fast).toBeString()
  expect(permissive.fast).toBe(permissive.archived)
}, 60_000)

test.each([
  { dependencies: { x: '1.0.0' }, bundledDependencies: ['x'] },
  { dependencies: { x: 'workspace:*' } },
  { dependencies: { x: 'catalog:' } },
])('manifests Bun would rewrite get no archive-free identity (%o)', async (fields) => {
  const root = await tree({
    'package.json': JSON.stringify({
      name: 'rewrite',
      version: '1.0.0',
      files: ['src'],
      ...fields,
    }),
    'src/a': 'a',
  })
  expect(await packedContentFingerprint(root)).toBeUndefined()
  await expect(packagedFingerprint(root)).rejects.toThrow()
})
