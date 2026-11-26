import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { TREE_IO_CONCURRENCY } from './bounded-io'
import {
  copySnapshotTree,
  copyTreeVerbatim,
  inside,
  scanDependencies,
  treeDigest,
} from './dispatch-runtime-dependencies'

const temporary: string[] = []
afterEach(async () => {
  for (const root of temporary.splice(0)) {
    await chmod(root, 0o755).catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})
async function temp() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ab-runtime-tree-')))
  temporary.push(root)
  return root
}
async function file(path: string, bytes: string) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
}

/** The serial digest that defines runtime identity; parallel IO must match it. */
async function serialDigest(root: string, exclude = new Set<string>(), allowedLink?: string) {
  const hash = createHash('sha256')
  async function walk(path: string): Promise<void> {
    const stat = await lstat(path)
    hash.update(JSON.stringify([relative(root, path), stat.mode & 0o111]))
    if (stat.isSymbolicLink()) {
      const actual = await realpath(path)
      if (!inside(root, actual) && actual !== allowedLink) throw new Error('oracle escape')
      hash.update(`link:${relative(dirname(path), actual)}`)
    } else if (stat.isDirectory()) {
      hash.update('directory')
      for (const name of (await readdir(path)).sort())
        if (!exclude.has(name)) await walk(join(path, name))
    } else {
      hash.update('file')
      hash.update(await readFile(path))
    }
  }
  await walk(root)
  return hash.digest('hex')
}

async function listing(root: string): Promise<string[]> {
  const entries: string[] = []
  async function walk(path: string): Promise<void> {
    for (const name of (await readdir(path)).sort()) {
      const child = join(path, name)
      const info = await lstat(child)
      entries.push(`${relative(root, child)} ${info.mode.toString(8)} ${info.size}`)
      if (info.isSymbolicLink()) entries.push(`-> ${await readlink(child)}`)
      else if (info.isDirectory()) await walk(child)
    }
  }
  await walk(root)
  return entries
}

async function wideTree(root: string) {
  for (let index = 0; index < TREE_IO_CONCURRENCY * 3; index++)
    await file(join(root, `d${index % 5}`, `n${index % 3}`, `f${index}.txt`), `bytes ${index}`)
  await file(join(root, 'bin/run'), '#!/bin/sh')
  await chmod(join(root, 'bin/run'), 0o755)
  await symlink('../d0/n0/f0.txt', join(root, 'bin/file-link'))
  await symlink('../d1', join(root, 'bin/dir-link'))
  await file(join(root, 'skip/hidden.txt'), 'excluded')
}

test('parallel digests equal the serial identity and keep every refusal', async () => {
  const root = await temp()
  await wideTree(root)
  const outside = join(await temp(), 'shared')
  await file(join(outside, 'x'), 'x')
  await symlink(outside, join(root, 'allowed'))
  const exclude = new Set(['skip'])
  const digest = await treeDigest(root, exclude, outside)
  expect(digest).toBe(await serialDigest(root, exclude, outside))
  expect(await treeDigest(root, exclude, outside)).toBe(digest)
  await chmod(join(root, 'd2/n2/f2.txt'), 0o755)
  expect(await treeDigest(root, exclude, outside)).not.toBe(digest)
  await expect(treeDigest(root, exclude)).rejects.toThrow('snapshot link escapes runtime')

  const source = await temp()
  await wideTree(source)
  await symlink('..', join(source, 'd3/cycle'))
  await expect(copySnapshotTree(source, join(await temp(), 'out'))).rejects.toThrow(
    'cyclic snapshot asset link',
  )
  await rm(join(source, 'd3/cycle'))
  await symlink(outside, join(source, 'd3/escape'))
  await expect(copySnapshotTree(source, join(await temp(), 'out'))).rejects.toThrow(
    'snapshot link escapes package',
  )
})

test('a failed copy leaves no outstanding writes and read-only directories still copy', async () => {
  const source = await temp()
  for (let index = 0; index < 120; index++)
    await file(join(source, `z${index % 4}`, `f${index}.txt`), `bytes ${index}`.repeat(64))
  await symlink(await temp(), join(source, 'a-escape'))
  const target = join(await temp(), 'out')
  await expect(copySnapshotTree(source, target)).rejects.toThrow('snapshot link escapes package')
  const before = await listing(target)
  await Bun.sleep(0)
  expect(await listing(target)).toEqual(before)

  const readonly = await temp()
  await file(join(readonly, 'locked/inner/a.txt'), 'a')
  await file(join(readonly, 'locked/b.sh'), 'b')
  await chmod(join(readonly, 'locked/b.sh'), 0o755)
  await chmod(join(readonly, 'locked/inner'), 0o555)
  await chmod(join(readonly, 'locked'), 0o555)
  const copied = join(await temp(), 'copy')
  try {
    await copySnapshotTree(readonly, copied)
    expect((await stat(join(copied, 'locked'))).mode & 0o777).toBe(0o555)
    expect((await stat(join(copied, 'locked/inner'))).mode & 0o777).toBe(0o555)
    expect((await stat(join(copied, 'locked/b.sh'))).mode & 0o777).toBe(0o755)
    expect(await readFile(join(copied, 'locked/inner/a.txt'), 'utf8')).toBe('a')
  } finally {
    for (const dir of ['locked', 'locked/inner']) {
      await chmod(join(readonly, dir), 0o755)
      await chmod(join(copied, dir), 0o755).catch(() => {})
    }
  }
})

test('copyTreeVerbatim matches a verbatim fs.cp copy', async () => {
  const source = await temp()
  await wideTree(source)
  await symlink('missing-target', join(source, 'bin/dangling'))
  const base = await temp()
  await cp(source, join(base, 'cp'), { recursive: true, verbatimSymlinks: true })
  await copyTreeVerbatim(source, join(base, 'verbatim'))
  expect(await listing(join(base, 'verbatim'))).toEqual(await listing(join(base, 'cp')))
})

test('dependency ids keep sorted depth-first order and a stable fingerprint', async () => {
  const root = await temp()
  const pkg = (dir: string, name: string, version: string, dependencies = {}) =>
    file(join(dir, 'package.json'), JSON.stringify({ name, version, dependencies }))
  await pkg(root, 'root', '1.0.0', { b: '1', a: '1' })
  await pkg(join(root, 'node_modules/a'), 'a', '1.0.0', { c: '1' })
  await pkg(join(root, 'node_modules/b'), 'b', '1.0.0', { c: '2', a: '1' })
  await pkg(join(root, 'node_modules/c'), 'c', '1.0.0')
  await pkg(join(root, 'node_modules/b/node_modules/c'), 'c', '2.0.0')
  const graph = await scanDependencies(root)
  expect(graph.packages.map((p) => `${p.manifest.name}@${p.manifest.version}`)).toEqual([
    'a@1.0.0',
    'c@1.0.0',
    'b@1.0.0',
    'c@2.0.0',
  ])
  expect(graph.roots).toEqual({ a: 0, b: 2 })
  expect(graph.packages.map((p) => p.edges)).toEqual([{ c: 1 }, {}, { a: 0, c: 3 }, {}])
  expect(graph.packages[3]!.digest).toBe(
    await serialDigest(resolve(root, 'node_modules/b/node_modules/c'), new Set(['node_modules'])),
  )
  expect((await scanDependencies(root)).fingerprint).toBe(graph.fingerprint)
})
