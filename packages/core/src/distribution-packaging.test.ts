import { expect, test } from 'bun:test'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { TREE_IO_CONCURRENCY } from './cli/bounded-io'
import { type StagingFilesystem, stageDistributionFiles } from './distribution-packaging'

type Node = { kind: 'dir' | 'file' | 'link'; mode: number }
const cpOptions = { recursive: true, errorOnExist: true, force: false }

/** A map-backed tree whose operations each yield a few microtasks, counting
 * how many are in flight and logging what completed. */
function fakeFilesystem(tree: Record<string, Node>, fail?: (op: string, path: string) => boolean) {
  const nodes = new Map(Object.entries(tree))
  const log: Array<{ op: string; path: string; arg?: unknown }> = []
  const state = { inFlight: 0, peak: 0, failed: false, startedAfterFailure: 0 }
  const op = async <T>(name: string, path: string, run: () => T, arg?: unknown): Promise<T> => {
    // Each staged item begins with lstat, so one after the failure is a new item.
    if (state.failed && name === 'lstat') state.startedAfterFailure++
    state.inFlight++
    state.peak = Math.max(state.peak, state.inFlight)
    try {
      for (let i = 0; i < 3; i++) await Promise.resolve()
      if (fail?.(name, path)) {
        state.failed = true
        throw Object.assign(new Error(`${name} failed: ${path}`), { code: 'EIO' })
      }
      const result = run()
      log.push({ op: name, path, arg })
      return result
    } finally {
      state.inFlight--
    }
  }
  const existing = (path: string) => {
    const node = nodes.get(path)
    if (!node) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    return node
  }
  const fs: StagingFilesystem = {
    lstat: (path) =>
      op('lstat', path, () => {
        const node = existing(path)
        return {
          mode: node.mode,
          isDirectory: () => node.kind === 'dir',
          isFile: () => node.kind === 'file',
        }
      }),
    readdir: (path) =>
      op('readdir', path, () =>
        [...nodes.keys()]
          .filter((key) => dirname(key) === path)
          .map((key) => key.slice(path.length + 1)),
      ),
    mkdir: (path, options) =>
      op('mkdir', path, () => {
        if (!options?.recursive && nodes.has(path)) throw new Error(`EEXIST: ${path}`)
        if (!nodes.has(path)) nodes.set(path, { kind: 'dir', mode: 0o755 })
      }),
    copyFile: (source, target, mode) =>
      op(
        'copyFile',
        target,
        () => {
          if (nodes.has(target)) throw new Error(`EEXIST: ${target}`)
          nodes.set(target, { kind: 'file', mode: existing(source).mode & 0o644 })
        },
        mode,
      ),
    chmod: (path, mode) =>
      op(
        'chmod',
        path,
        () => {
          existing(path).mode = mode
        },
        mode,
      ),
    cp: (source, target, options) =>
      op(
        'cp',
        target,
        () => {
          nodes.set(target, { ...(nodes.get(source) ?? { kind: 'dir', mode: 0o755 }) })
        },
        { source, options },
      ),
  }
  return { fs, nodes, log, state }
}

/** A `src` entry of 600 files across nested directories (one read-only and
 * one holding a symlink), plus top-level and nested file entries. */
function distributionTree(): Record<string, Node> {
  const tree: Record<string, Node> = {
    '/root/src': { kind: 'dir', mode: 0o755 },
    '/root/LICENSE': { kind: 'file', mode: 0o644 },
    '/root/bin': { kind: 'dir', mode: 0o755 },
    '/root/bin/ab.ts': { kind: 'file', mode: 0o4755 },
    '/root/a/b/c': { kind: 'file', mode: 0o640 },
    '/root/src/locked': { kind: 'dir', mode: 0o555 },
    '/root/src/locked/inner': { kind: 'dir', mode: 0o750 },
    '/root/src/locked/inner/file.ts': { kind: 'file', mode: 0o644 },
    '/root/src/locked/inner/link': { kind: 'link', mode: 0o777 },
  }
  for (let d = 0; d < 20; d++) {
    tree[`/root/src/d${d}`] = { kind: 'dir', mode: 0o755 }
    for (let f = 0; f < 30; f++) tree[`/root/src/d${d}/f${f}.ts`] = { kind: 'file', mode: 0o644 }
  }
  return tree
}

const entries = ['src', 'LICENSE', 'bin', 'a/b/c']

test('disjoint entries copy through a bounded pool that reaches inside large entries', async () => {
  for (const limit of [TREE_IO_CONCURRENCY, 3]) {
    const tree = distributionTree()
    const { fs, nodes, log, state } = fakeFilesystem(tree)
    await stageDistributionFiles('/root', '/staging', entries, fs, limit)
    expect(state.peak).toBeLessThanOrEqual(limit)
    expect(state.peak).toBeGreaterThan(1)
    expect(state.inFlight).toBe(0)

    // Every source node exists in staging with its kind and mode & 0o7777.
    for (const [path, node] of Object.entries(tree))
      expect(nodes.get(path.replace('/root', '/staging'))).toEqual(node)
    const copies = log.filter((entry) => entry.op === 'copyFile')
    const files = Object.entries(tree).filter(([, node]) => node.kind === 'file')
    expect(copies.length).toBe(files.length)
    expect(new Set(copies.map((entry) => entry.path)).size).toBe(files.length)
    expect(copies.every((entry) => entry.arg === constants.COPYFILE_EXCL)).toBe(true)

    // Non-regular, non-directory entries are handed to cp and never walked.
    const delegated = log.filter((entry) => entry.op === 'cp')
    expect(delegated).toEqual([
      {
        op: 'cp',
        path: '/staging/src/locked/inner/link',
        arg: { source: '/root/src/locked/inner/link', options: cpOptions },
      },
    ])
    expect(log.filter((entry) => entry.path.endsWith('/link')).map((entry) => entry.op)).toEqual([
      'lstat',
      'cp',
    ])

    // A directory's mode lands after every write beneath it.
    log.forEach((entry, index) => {
      if (entry.op !== 'chmod' || !nodes.get(entry.path) || nodes.get(entry.path)?.kind !== 'dir')
        return
      const later = log.slice(index + 1)
      expect(later.some((next) => next.path.startsWith(`${entry.path}/`))).toBe(false)
    })
  }
})

test('overlapping, duplicate, root and escaping entries keep the serial cp loop', async () => {
  for (const list of [
    ['src', 'src/d0/f0.ts'],
    ['src/d0', 'src'],
    ['LICENSE', 'LICENSE'],
    ['.', 'LICENSE'],
    ['../outside', 'LICENSE'],
  ]) {
    const { fs, log, state } = fakeFilesystem(distributionTree())
    await stageDistributionFiles('/root', '/staging', list, fs)
    expect(state.peak).toBe(1)
    const copies = log.filter((entry) => entry.op === 'cp')
    expect(copies.map((entry) => entry.arg)).toEqual(
      list.map((entry) => ({ source: join('/root', entry), options: cpOptions })),
    )
    expect(log.every((entry) => entry.op === 'cp' || entry.op === 'mkdir')).toBe(true)
  }
})

test('a failed copy settles every in-flight operation, starts no more and restricts no directory', async () => {
  const { fs, log, state } = fakeFilesystem(
    distributionTree(),
    (op, path) => op === 'copyFile' && path === '/staging/src/d10/f10.ts',
  )
  let settledInFlight = -1
  await expect(
    stageDistributionFiles('/root', '/staging', entries, fs).finally(() => {
      settledInFlight = state.inFlight
    }),
  ).rejects.toMatchObject({ code: 'EIO' })
  expect(settledInFlight).toBe(0)
  expect(state.startedAfterFailure).toBe(0)
  expect(log.filter((entry) => entry.op === 'chmod' && entry.arg === 0o555)).toEqual([])
})
