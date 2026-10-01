/**
 * `ab ticket attach` / `asset get` / `asset rm` and the ticket-asset note
 * (SPEC §8.8, §13), over the fake ticket source and a real store.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeTicketSource } from '../ports/tickets/fake'
import { FileTicketSource } from '../ports/tickets/file'
import type { Ticket } from '../ports/types'
import { MemoryBuildStore } from '../store/memory'
import {
  TICKET_ASSET_MAX_BYTES,
  type TicketAsset,
  type TicketAssetMeta,
} from '../store/ticket-assets'
import type { BuildStore } from '../store/types'
import { abTicket, abTicketShow } from './ticket'
import { ticketAssetNote, writeAssetTo } from './ticket-assets'

let tmp: string
let source: FakeTicketSource
let store: BuildStore

const TICKET: Ticket = {
  ref: { source: 'fake', id: 'AUT-1' },
  title: 'A ticket',
  body: 'the body',
  state: 'Ready',
  labels: [],
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ab-ticket-assets-'))
  await writeFile(
    join(tmp, 'autobuild.toml'),
    ['[tickets]', 'source = "file"', 'readyState = "ready"', 'dir = "tickets"', ''].join('\n'),
  )
  source = new FakeTicketSource([TICKET])
  store = new MemoryBuildStore()
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

function cli(argv: string[], overrides: { source?: FakeTicketSource; store?: BuildStore } = {}) {
  const out: string[] = []
  const err: string[] = []
  const chosenSource = overrides.source ?? source
  const chosenStore = overrides.store ?? store
  // `ab ticket <argv...>`: the routed tail goes to abTicket with the seams.
  const code = abTicket(argv.slice(1), {
    targetRepo: tmp,
    env: {},
    // A plain checkout with no origin remote: identity is the checkout path.
    exec: async (cmd: string[]) =>
      cmd.includes('remote')
        ? { stdout: '', stderr: '', exitCode: 1 }
        : {
            stdout: `${join(tmp, '.git')}\n${join(tmp, '.git')}\n${tmp}\n`,
            stderr: '',
            exitCode: 0,
          },
    stdout: (line: string) => out.push(line),
    stderr: (line: string) => err.push(line),
    sourceFactory: () => chosenSource,
    openStore: () => chosenStore,
  }).then(() => 0)
  return { code, out, err }
}

const sha = (bytes: Uint8Array | Buffer) => createHash('sha256').update(bytes).digest('hex')

/** A recursive listing: files with content hashes and directories, relative. */
async function listing(root: string, rel = ''): Promise<string[]> {
  const out: string[] = []
  for (const name of (await readdir(join(root, rel))).sort()) {
    const childRel = rel === '' ? name : `${rel}/${name}`
    const info = await stat(join(root, childRel))
    if (info.isDirectory()) {
      out.push(`dir ${childRel}`)
      out.push(...(await listing(root, childRel)))
    } else {
      out.push(`file ${childRel} ${sha(await readFile(join(root, childRel)))}`)
    }
  }
  return out
}

async function makeTree(root: string): Promise<void> {
  await mkdir(join(root, 'img', 'empty'), { recursive: true })
  await mkdir(join(root, 'deep', 'er'), { recursive: true })
  await writeFile(join(root, 'index.html'), '<h1>hi</h1>')
  await writeFile(join(root, 'img', 'a.png'), Uint8Array.from([0, 255, 1, 254]))
  await writeFile(join(root, 'deep', 'er', 'zero.bin'), new Uint8Array(0))
}

describe('ticketAssetNote', () => {
  const meta: TicketAssetMeta = {
    repo: 'r',
    ticketId: 'AUT-1',
    kind: 'design',
    name: 'home',
    revision: 2,
    layout: 'tree',
    size: 2048,
    createdAt: 'now',
    entries: [
      { type: 'file', path: 'a', size: 2048, blobRef: 'x' },
      { type: 'dir', path: 'd' },
    ],
  }

  test('names the asset, revision, size, the download command, and where the bytes live', () => {
    for (const event of ['attached', 'replaced', 'removed'] as const) {
      const note = ticketAssetNote(event, meta)
      expect(note).toContain('`design/home`')
      expect(note).toContain('ab ticket asset get AUT-1 design home <dest>')
      expect(note).toContain('--rev 2')
      expect(note).toContain('Autobuild store, not in this ticket')
      // Plain Markdown: backticks, never bold (Linear breaks bold before a word).
      expect(note).not.toContain('**')
    }
    expect(ticketAssetNote('attached', meta)).toContain('revision 2, 1 file, 2.0 KiB')
    expect(ticketAssetNote('replaced', meta)).toContain('is now revision 2')
    expect(ticketAssetNote('removed', meta)).toContain('no longer one of this ticket')
  })
})

describe('writeAssetTo', () => {
  test('refuses stored paths that escape the destination', async () => {
    const asset: TicketAsset = {
      meta: {
        repo: 'r',
        ticketId: 'T',
        kind: 'k',
        name: 'n',
        revision: 0,
        layout: 'tree',
        size: 1,
        createdAt: 'now',
        entries: [],
      },
      entries: [{ type: 'file', path: '../escape.txt', content: new Uint8Array([1]) }],
    }
    await expect(writeAssetTo(asset, join(tmp, 'out'))).rejects.toThrow()
    await expect(stat(join(tmp, 'escape.txt'))).rejects.toThrow()
    const absolute = {
      ...asset,
      entries: [{ ...asset.entries[0]!, path: '/etc/evil' }],
    } as TicketAsset
    await expect(writeAssetTo(absolute, join(tmp, 'out'))).rejects.toThrow()
  })

  const treeWith = (path: string): TicketAsset => ({
    meta: {
      repo: 'r',
      ticketId: 'T',
      kind: 'k',
      name: 'n',
      revision: 0,
      layout: 'tree',
      size: 1,
      createdAt: 'now',
      entries: [],
    },
    entries: [{ type: 'file', path, content: new Uint8Array([1]) }],
  })

  test('refuses to write through an existing directory symlink or a final-file symlink', async () => {
    const out = join(tmp, 'out')
    const outside = join(tmp, 'outside')
    await mkdir(out)
    await mkdir(outside)
    await symlink(outside, join(out, 'nested'))
    await expect(writeAssetTo(treeWith('nested/a.txt'), out)).rejects.toThrow(/symbolic link/)
    await writeFile(join(outside, 'victim.txt'), 'keep')
    await symlink(join(outside, 'victim.txt'), join(out, 'f.txt'))
    await expect(writeAssetTo(treeWith('f.txt'), out)).rejects.toThrow(/symbolic link/)
    expect(await readFile(join(outside, 'victim.txt'), 'utf8')).toBe('keep')
    expect(await readdir(outside)).toEqual(['victim.txt'])

    const fileAsset: TicketAsset = {
      ...treeWith('f.txt'),
      meta: { ...treeWith('f.txt').meta, layout: 'file' },
    }
    await expect(writeAssetTo(fileAsset, join(out, 'f.txt'))).rejects.toThrow(/symbolic link/)
    await expect(writeAssetTo(fileAsset, out)).rejects.toThrow(/symbolic link/)
    expect(await readFile(join(outside, 'victim.txt'), 'utf8')).toBe('keep')
  })
})

describe('ab ticket attach', () => {
  test('attaches a file under the basename, then a new revision on re-attach, with a note each time', async () => {
    await writeFile(join(tmp, 'shot.png'), Uint8Array.from([9, 8, 7]))
    const first = cli(['ticket', 'attach', 'AUT-1', 'design', join(tmp, 'shot.png')])
    expect(await first.code).toBe(0)
    expect(first.out.join('\n')).toContain('design/shot.png revision 0')
    await writeFile(join(tmp, 'shot.png'), Uint8Array.from([9, 8, 7, 6]))
    expect(await cli(['ticket', 'attach', 'AUT-1', 'design', join(tmp, 'shot.png')]).code).toBe(0)

    const assets = await store.listTicketAssets(tmp, 'AUT-1')
    expect(assets.map((a) => [a.kind, a.name, a.revision, a.size])).toEqual([
      ['design', 'shot.png', 1, 4],
    ])
    expect(source.comments.map((c) => c.id)).toEqual(['AUT-1', 'AUT-1'])
    expect(source.comments[0]?.body).toContain('Ticket asset attached')
    expect(source.comments[1]?.body).toContain('Ticket asset replaced')
    expect(source.comments[1]?.body).toContain('revision 1')
  })

  test('--name overrides the default and a folder keeps its relative tree, empty dirs included', async () => {
    const dir = join(tmp, 'site')
    await makeTree(dir)
    expect(await cli(['ticket', 'attach', 'AUT-1', 'design', dir, '--name', 'home']).code).toBe(0)
    const asset = await store.getTicketAsset(tmp, 'AUT-1', 'design', 'home')
    expect(asset?.meta.layout).toBe('tree')
    expect(asset?.meta.entries.map((e) => `${e.type}:${e.path}`).sort()).toEqual([
      'dir:deep',
      'dir:deep/er',
      'dir:img',
      'dir:img/empty',
      'file:deep/er/zero.bin',
      'file:img/a.png',
      'file:index.html',
    ])
    expect(await store.getTicketAsset(tmp, 'AUT-1', 'design', 'site')).toBeNull()
  })

  test('a folder defaults its name to the folder name', async () => {
    const dir = join(tmp, 'mocks')
    await mkdir(dir)
    await writeFile(join(dir, 'a.txt'), 'a')
    expect(await cli(['ticket', 'attach', 'AUT-1', 'design', dir]).code).toBe(0)
    expect((await store.listTicketAssets(tmp, 'AUT-1')).map((a) => a.name)).toEqual(['mocks'])
  })

  test('an unknown ticket id fails and stores nothing, with no note', async () => {
    await writeFile(join(tmp, 'a.txt'), 'a')
    const run = cli(['ticket', 'attach', 'NOPE-9', 'design', join(tmp, 'a.txt')])
    await expect(run.code).rejects.toThrow()
    expect(await store.listTicketAssets(tmp, 'NOPE-9', { revisions: true })).toEqual([])
    expect(source.comments).toEqual([])
  })

  test('refuses an over-limit bundle naming the limit, before reading any bytes', async () => {
    const dir = join(tmp, 'big')
    await mkdir(dir)
    // A sparse file: stat reports the size, reading it would be expensive.
    const file = join(dir, 'huge.bin')
    await writeFile(file, '')
    const { truncate } = await import('node:fs/promises')
    await truncate(file, TICKET_ASSET_MAX_BYTES + 1)
    const run = cli(['ticket', 'attach', 'AUT-1', 'design', dir])
    await expect(run.code).rejects.toThrow('26214400-byte (25 MiB) limit')
    expect(await store.listTicketAssets(tmp, 'AUT-1', { revisions: true })).toEqual([])
    expect(source.comments).toEqual([])
  })

  test('refuses symlinks, missing paths, and invalid kinds without storing anything', async () => {
    await mkdir(join(tmp, 'linked'))
    await writeFile(join(tmp, 'real.txt'), 'x')
    await symlink(join(tmp, 'real.txt'), join(tmp, 'linked', 'link.txt'))
    await expect(
      cli(['ticket', 'attach', 'AUT-1', 'design', join(tmp, 'linked')]).code,
    ).rejects.toThrow(/symbolic links/)
    await symlink(join(tmp, 'real.txt'), join(tmp, 'top-link'))
    await expect(
      cli(['ticket', 'attach', 'AUT-1', 'design', join(tmp, 'top-link')]).code,
    ).rejects.toThrow(/symbolic links/)
    await expect(
      cli(['ticket', 'attach', 'AUT-1', 'design', join(tmp, 'missing')]).code,
    ).rejects.toThrow(/no such file/)
    await expect(
      cli(['ticket', 'attach', 'AUT-1', 'bad kind', join(tmp, 'real.txt')]).code,
    ).rejects.toThrow(/kind/)
    expect(await store.listTicketAssets(tmp, 'AUT-1', { revisions: true })).toEqual([])
    expect(source.comments).toEqual([])
  })

  test('a failing comment after the put names the stored revision', async () => {
    await writeFile(join(tmp, 'a.txt'), 'a')
    const failing = new FakeTicketSource([TICKET])
    failing.comment = async () => {
      throw new Error('boom')
    }
    const run = cli(['ticket', 'attach', 'AUT-1', 'design', join(tmp, 'a.txt')], {
      source: failing,
    })
    await expect(run.code).rejects.toThrow(/stored as revision 0.*boom/)
    // The write is not rolled back.
    expect(await store.listTicketAssets(tmp, 'AUT-1')).toHaveLength(1)
  })

  test('--json prints the stored meta', async () => {
    await writeFile(join(tmp, 'a.txt'), 'abc')
    const run = cli(['ticket', 'attach', 'AUT-1', 'design', join(tmp, 'a.txt'), '--json'])
    expect(await run.code).toBe(0)
    expect(JSON.parse(run.out.join('\n'))).toMatchObject({
      ticketId: 'AUT-1',
      kind: 'design',
      name: 'a.txt',
      revision: 0,
      size: 3,
    })
  })
})

describe('ab ticket asset get', () => {
  test('round-trips a file, exact bytes, creating parents and honoring an existing directory dest', async () => {
    const bytes = Uint8Array.from([0, 1, 2, 255, 254])
    await writeFile(join(tmp, 'blob.bin'), bytes)
    await cli(['ticket', 'attach', 'AUT-1', 'design', join(tmp, 'blob.bin')]).code
    const dest = join(tmp, 'out', 'nested', 'copy.bin')
    expect(await cli(['ticket', 'asset', 'get', 'AUT-1', 'design', 'blob.bin', dest]).code).toBe(0)
    expect(new Uint8Array(await readFile(dest))).toEqual(bytes)

    await mkdir(join(tmp, 'existing'))
    await cli(['ticket', 'asset', 'get', 'AUT-1', 'design', 'blob.bin', join(tmp, 'existing')]).code
    expect(new Uint8Array(await readFile(join(tmp, 'existing', 'blob.bin')))).toEqual(bytes)
  })

  test('round-trips a nested folder, an empty folder, and empty subdirectories', async () => {
    const nested = join(tmp, 'nested')
    await makeTree(nested)
    const hollow = join(tmp, 'hollow')
    await mkdir(hollow)
    const emptySub = join(tmp, 'with-empty')
    await mkdir(join(emptySub, 'only', 'dirs'), { recursive: true })
    for (const dir of [nested, hollow, emptySub]) {
      await cli(['ticket', 'attach', 'AUT-1', 'design', dir]).code
    }
    for (const [name, original] of [
      ['nested', nested],
      ['hollow', hollow],
      ['with-empty', emptySub],
    ] as const) {
      const dest = join(tmp, 'restored', name)
      expect(await cli(['ticket', 'asset', 'get', 'AUT-1', 'design', name, dest]).code).toBe(0)
      expect(await listing(dest)).toEqual(await listing(original))
    }
    expect(await listing(join(tmp, 'restored', 'hollow'))).toEqual([])
  })

  test('--rev reads an earlier revision; unknown assets and revisions error', async () => {
    const file = join(tmp, 'a.txt')
    await writeFile(file, 'one')
    await cli(['ticket', 'attach', 'AUT-1', 'design', file]).code
    await writeFile(file, 'two')
    await cli(['ticket', 'attach', 'AUT-1', 'design', file]).code
    const dest = join(tmp, 'got.txt')
    await cli(['ticket', 'asset', 'get', 'AUT-1', 'design', 'a.txt', dest, '--rev', '0']).code
    expect(await readFile(dest, 'utf8')).toBe('one')
    await cli(['ticket', 'asset', 'get', 'AUT-1', 'design', 'a.txt', dest]).code
    expect(await readFile(dest, 'utf8')).toBe('two')
    await expect(
      cli(['ticket', 'asset', 'get', 'AUT-1', 'design', 'a.txt', dest, '--rev', '5']).code,
    ).rejects.toThrow('design/a.txt revision 5')
    await expect(
      cli(['ticket', 'asset', 'get', 'AUT-1', 'design', 'ghost', dest]).code,
    ).rejects.toThrow('design/ghost')
    await expect(
      cli(['ticket', 'asset', 'get', 'AUT-1', 'design', 'a.txt', dest, '--rev', 'x']).code,
    ).rejects.toThrow(/--rev/)
  })
})

describe('ab ticket asset rm', () => {
  test('removes from the current assets, notes it, and keeps the pinned revision retrievable', async () => {
    const file = join(tmp, 'a.txt')
    await writeFile(file, 'one')
    await cli(['ticket', 'attach', 'AUT-1', 'design', file]).code
    expect(await cli(['ticket', 'asset', 'rm', 'AUT-1', 'design', 'a.txt']).code).toBe(0)
    expect(source.comments.at(-1)?.body).toContain('Ticket asset removed')
    expect(await store.listTicketAssets(tmp, 'AUT-1')).toEqual([])

    const dest = join(tmp, 'got.txt')
    await expect(
      cli(['ticket', 'asset', 'get', 'AUT-1', 'design', 'a.txt', dest]).code,
    ).rejects.toThrow('design/a.txt')
    expect(
      await cli(['ticket', 'asset', 'get', 'AUT-1', 'design', 'a.txt', dest, '--rev', '0']).code,
    ).toBe(0)
    expect(await readFile(dest, 'utf8')).toBe('one')
  })

  test('an unknown asset errors and leaves no note', async () => {
    const before = source.comments.length
    await expect(cli(['ticket', 'asset', 'rm', 'AUT-1', 'design', 'ghost']).code).rejects.toThrow(
      'design/ghost',
    )
    expect(source.comments).toHaveLength(before)
  })
})

describe('ab ticket show with assets', () => {
  test('lists current assets in human and JSON output', async () => {
    const file = join(tmp, 'a.txt')
    await writeFile(file, 'abcd')
    await cli(['ticket', 'attach', 'AUT-1', 'design', file]).code
    await cli(['ticket', 'attach', 'AUT-1', 'design', file]).code

    const human = cli(['ticket', 'show', 'AUT-1'])
    expect(await human.code).toBe(0)
    const text = human.out.join('\n')
    expect(text).toContain('  assets:')
    expect(text).toContain('    design/a.txt  rev 1  4 B')
    expect(text.indexOf('  assets:')).toBeLessThan(text.indexOf('  body:'))

    const json = cli(['ticket', 'show', 'AUT-1', '--json'])
    expect(await json.code).toBe(0)
    const parsed = JSON.parse(json.out.join('\n'))
    expect(parsed).toMatchObject({ ref: TICKET.ref, title: TICKET.title })
    expect(parsed.assets).toEqual([
      { kind: 'design', name: 'a.txt', revision: 1, size: 4, layout: 'file', fileCount: 1 },
    ])
  })

  test('a ticket without assets prints no assets block', async () => {
    const human = cli(['ticket', 'show', 'AUT-1'])
    expect(await human.code).toBe(0)
    expect(human.out.join('\n')).not.toContain('assets:')
  })

  test('an asset-listing failure fails the command', async () => {
    const broken = new MemoryBuildStore()
    broken.listTicketAssets = async () => {
      throw new Error('store down')
    }
    await expect(
      abTicketShow({
        targetRepo: tmp,
        id: 'AUT-1',
        env: {},
        stdout: () => {},
        sourceFactory: () => source,
        openStore: () => broken,
      }),
    ).rejects.toThrow('store down')
  })
})

describe('the file ticket source', () => {
  test('the note lands in the ticket file below the body, which is left byte-exact', async () => {
    const dir = join(tmp, 'tickets')
    await mkdir(join(dir, 'ready'), { recursive: true })
    const original = ['+++', 'id = "file-1"', 'title = "On disk"', '+++', '', 'the spec', ''].join(
      '\n',
    )
    await writeFile(join(dir, 'ready', 'file-1.md'), original)
    const fileSource = new FileTicketSource({ dir })
    await writeFile(join(tmp, 'mock.txt'), 'x')
    const run = abTicket(['attach', 'file-1', 'design', join(tmp, 'mock.txt')], {
      targetRepo: tmp,
      env: {},
      exec: async (cmd: string[]) =>
        cmd.includes('remote')
          ? { stdout: '', stderr: '', exitCode: 1 }
          : {
              stdout: `${join(tmp, '.git')}\n${join(tmp, '.git')}\n${tmp}\n`,
              stderr: '',
              exitCode: 0,
            },
      stdout: () => {},
      stderr: () => {},
      sourceFactory: () => fileSource,
      openStore: () => store,
    })
    await run
    const written = await readFile(join(dir, 'ready', 'file-1.md'), 'utf8')
    expect(written.startsWith(original)).toBe(true)
    expect(written).toContain('Ticket asset attached: `design/mock.txt`')
    expect(written).toContain('ab ticket asset get file-1 design mock.txt <dest>')
    expect((await fileSource.get('file-1'))?.body).toContain('the spec')
  })
})
