import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  sourceContent,
  productionLockClosure,
  sourceCommand,
  withSourceExport,
  sourceRepository,
} from './dispatch-upgrade-source'
import { scanDependencies } from './dispatch-runtime-dependencies'
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ab-source-test-'))
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

test('production identity ignores hoist paths while retaining the selected nested version and peer graph', () => {
  const manifest = { dependencies: { parent: '1.0.0' } }
  const parent = ['parent@1.0.0', '', { dependencies: { child: '^1.0.0' } }, 'sha512-parent']
  const child = ['child@1.0.0', '', {}, 'sha512-child']
  const lock = { lockfileVersion: 1, workspaces: { '': manifest }, packages: { parent, child } }
  const nested = {
    ...lock,
    packages: { parent, 'parent/child': child, child: ['child@2.0.0', '', {}, 'sha512-unrelated'] },
  }
  expect(productionLockClosure(manifest, nested).graph).toEqual(
    productionLockClosure(manifest, lock).graph,
  )
  const changed = {
    ...nested,
    packages: { ...nested.packages, 'parent/child': ['child@1.0.1', '', {}, 'sha512-changed'] },
  }
  expect(productionLockClosure(manifest, changed).graph).not.toEqual(
    productionLockClosure(manifest, lock).graph,
  )
})
