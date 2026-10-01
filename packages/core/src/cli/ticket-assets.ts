/**
 * Filesystem and note plumbing for `ab ticket attach` / `asset get` /
 * `asset rm` (SPEC §8.8). The store owns the bytes and the validation
 * (store/ticket-assets.ts); this module owns the two edges that touch the
 * local filesystem and the one outward projection: the note left on the
 * ticket in its source (SPEC §13).
 */
import { lstat, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import {
  ticketAssetEntriesError,
  ticketAssetSizeError,
  validateTicketAssetPath,
  validateTicketAssetStructure,
  type TicketAsset,
  type TicketAssetEntryInput,
  type TicketAssetInput,
  type TicketAssetLayout,
  type TicketAssetLimits,
  type TicketAssetMeta,
} from '../store/ticket-assets'

export type TicketAssetNoteEvent = 'attached' | 'replaced' | 'removed'

export function formatAssetSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/**
 * The note left on the ticket in its source. Plain Markdown with backticks
 * (no bold, no source-specific syntax) so every source and plugin renders it.
 * It names the asset and how to fetch it, and states that the contents are in
 * the Autobuild store, not in this ticket.
 */
export function ticketAssetNote(
  event: TicketAssetNoteEvent,
  meta: TicketAssetMeta,
  cli = 'ab',
): string {
  const fileCount = meta.entries.filter((entry) => entry.type === 'file').length
  const label = `\`${meta.kind}/${meta.name}\``
  const get = `${cli} ticket asset get ${meta.ticketId} ${meta.kind} ${meta.name} <dest>`
  const contents = `${plural(fileCount, 'file')}, ${formatAssetSize(meta.size)}`
  switch (event) {
    case 'attached':
      return [
        `Ticket asset attached: ${label} (revision ${meta.revision}, ${contents}).`,
        '',
        'The contents live in the Autobuild store, not in this ticket.',
        `Download the latest revision: \`${get}\``,
        `Download this exact revision: \`${get} --rev ${meta.revision}\``,
      ].join('\n')
    case 'replaced':
      return [
        `Ticket asset replaced: ${label} is now revision ${meta.revision} (${contents}).`,
        '',
        'The contents live in the Autobuild store, not in this ticket. Earlier revisions stay retrievable.',
        `Download the latest revision: \`${get}\``,
        `Download this exact revision: \`${get} --rev ${meta.revision}\``,
      ].join('\n')
    case 'removed':
      return [
        `Ticket asset removed: ${label} is no longer one of this ticket's current assets (last revision ${meta.revision}).`,
        '',
        'The contents live in the Autobuild store, not in this ticket. That revision stays retrievable by number.',
        `Download it: \`${get} --rev ${meta.revision}\``,
      ].join('\n')
  }
}

export interface AssetWalk {
  layout: TicketAssetLayout
  /** Default asset name: the path's basename. */
  basename: string
  files: { path: string; abs: string; size: number }[]
  dirs: string[]
}

/**
 * Walk a file or folder for attachment. Symlinks and non-regular files are
 * refused. The folder root is never an entry — it is represented only by the
 * `tree` layout — so every entry path is relative, with no empty or `.`
 * segment, and an empty folder walks to zero entries.
 */
export async function walkAssetPath(path: string): Promise<AssetWalk> {
  const root = resolve(path)
  const info = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new Error(`${path}: no such file or directory`)
    throw error
  })
  if (info.isSymbolicLink()) {
    throw new Error(`${path}: symbolic links cannot be attached — attach the real file or folder`)
  }
  if (info.isFile()) {
    return {
      layout: 'file',
      basename: basename(root),
      files: [{ path: basename(root), abs: root, size: info.size }],
      dirs: [],
    }
  }
  if (!info.isDirectory()) {
    throw new Error(`${path}: only regular files and folders can be attached`)
  }
  const files: AssetWalk['files'] = []
  const dirs: string[] = []
  const visit = async (abs: string, rel: string): Promise<void> => {
    const names = (await readdir(abs)).sort()
    for (const name of names) {
      const childAbs = join(abs, name)
      const childRel = rel === '' ? name : `${rel}/${name}`
      const child = await lstat(childAbs)
      if (child.isSymbolicLink()) {
        throw new Error(
          `${childAbs}: symbolic links cannot be attached — remove it or attach its target`,
        )
      }
      if (child.isDirectory()) {
        dirs.push(childRel)
        await visit(childAbs, childRel)
      } else if (child.isFile()) {
        files.push({ path: childRel, abs: childAbs, size: child.size })
      } else {
        throw new Error(`${childAbs}: only regular files and folders can be attached`)
      }
    }
  }
  await visit(root, '')
  return { layout: 'tree', basename: basename(root), files, dirs }
}

/**
 * Build the put input from a walk. Everything the stat sizes can refuse —
 * names, paths, structure, entry count, total bytes — is refused here, before
 * any file's bytes are read.
 */
export async function buildAssetInput(
  walk: AssetWalk,
  asset: { kind: string; name: string },
  limits: TicketAssetLimits,
): Promise<TicketAssetInput> {
  const entryCount = walk.files.length + walk.dirs.length
  if (entryCount > limits.maxEntries) throw ticketAssetEntriesError(entryCount, limits.maxEntries)
  const total = walk.files.reduce((sum, file) => sum + file.size, 0)
  if (total > limits.maxBytes) throw ticketAssetSizeError(total, limits.maxBytes)
  validateTicketAssetStructure(
    {
      kind: asset.kind,
      name: asset.name,
      layout: walk.layout,
      entries: [
        ...walk.dirs.map((path) => ({ type: 'dir' as const, path })),
        ...walk.files.map((file) => ({ type: 'file' as const, path: file.path, size: file.size })),
      ],
    },
    limits,
  )
  const entries: TicketAssetEntryInput[] = walk.dirs.map((path) => ({ type: 'dir', path }))
  for (const file of walk.files) {
    entries.push({
      type: 'file',
      path: file.path,
      content: new Uint8Array(await readFile(file.abs)),
    })
  }
  return { kind: asset.kind, name: asset.name, layout: walk.layout, entries }
}

/** Resolve a stored entry path under `root`, refusing anything that would land
 * outside it. Stored paths are never trusted, even though upload validates. */
function guardedTarget(root: string, path: string): string {
  validateTicketAssetPath(path)
  const target = resolve(root, path)
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`ticket asset path "${path}" escapes the destination`)
  }
  return target
}

/**
 * Write a downloaded asset to `dest`. A `file` asset becomes the file `dest`
 * (or `dest/<filename>` when `dest` is an existing directory); a `tree` asset
 * becomes the directory `dest` itself — created even when empty — with every
 * `dir` entry made, then every file written.
 */
export async function writeAssetTo(asset: TicketAsset, dest: string): Promise<string> {
  const root = resolve(dest)
  if (asset.meta.layout === 'file') {
    const file = asset.entries.find((entry) => entry.type === 'file')
    if (file === undefined || file.type !== 'file') {
      throw new Error(`ticket asset ${asset.meta.kind}/${asset.meta.name} holds no file`)
    }
    const isDir = await stat(root)
      .then((info) => info.isDirectory())
      .catch(() => false)
    const target = isDir ? guardedTarget(root, file.path) : root
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.content)
    return target
  }
  await mkdir(root, { recursive: true })
  for (const entry of asset.entries) {
    if (entry.type === 'dir') await mkdir(guardedTarget(root, entry.path), { recursive: true })
  }
  for (const entry of asset.entries) {
    if (entry.type !== 'file') continue
    const target = guardedTarget(root, entry.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, entry.content)
  }
  return root
}
