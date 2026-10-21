import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTicketSource } from './file'
import { exportTickets, importTickets, IMPORT_MAP } from './migration'
import { serializeTicketFile } from './file-codec'
import { hostedRequestedIds } from './requested-id'
import { normalizeStateName } from './states'
import { MemoryBuildStore } from '../../store/memory'
import { composeTicketAssets, preparePinnedAssets } from '../../store/ticket-assets'
import { readAssetSnapshot } from '../../store/ticket-asset-snapshots'
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'migration-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
const bytes = new Uint8Array([0, 255, 42])
const bundle = {
  kind: 'design',
  name: 'reference',
  layout: 'tree' as const,
  entries: [
    { type: 'dir' as const, path: 'empty' },
    { type: 'file' as const, path: 'binary', content: bytes },
  ],
}
async function fixture() {
  const source = new FileTicketSource({ dir: join(root, 'source') })
  const a = await source.create(
    { title: 'A', body: 'exact\r\nbody  ', labels: ['☃'] },
    { requestedId: 'AUT-706', state: 'ready', idempotencyKey: 'original-key' },
  )
  const b = await source.create({ title: 'B', body: 'B' }, { requestedId: 'foreign' })
  await source.addBlocker(a.ref.id, b.ref.id)
  await source.addBlocker(b.ref.id, a.ref.id)
  await source.comment(a.ref.id, 'Unicode ☃\r\n\ntrailing  ')
  await source.comment(a.ref.id, 'Unicode ☃\r\n\ntrailing  ')
  await source.assets.putTicketAsset('repo', a.ref.id, bundle)
  await source.addState('icebox')
  return source
}
test('portable export and file import preserve cycles, comments, assets, empty states and stable reruns', async () => {
  const source = await fixture()
  const dir = join(root, 'export')
  await exportTickets({ source, dir, repo: 'repo' })
  const portable = new FileTicketSource({ dir })
  expect((await portable.get('AUT-706'))?.body).toBe('exact\r\nbody  ')
  expect(
    (await portable.assets.getTicketAsset('repo', 'AUT-706', 'design', 'reference'))?.entries,
  ).toEqual(bundle.entries)
  expect((await portable.listStates()).map((s) => s.name)).not.toContain('.ab-assets')
  const target = new FileTicketSource({ dir: join(root, 'target') })
  const lines: string[] = []
  await importTickets({ source: target, dir, repo: 'repo', print: (line) => lines.push(line) })
  const firstAsset = await target.assets.getTicketAsset('repo', 'AUT-706', 'design', 'reference')
  await importTickets({ source: target, dir, repo: 'repo' })
  expect((await target.listReady({})).tickets).toHaveLength(2)
  expect((await target.get('AUT-706'))?.blockedBy).toEqual(['foreign'])
  expect((await target.get('foreign'))?.blockedBy).toEqual(['AUT-706'])
  expect((await target.get('AUT-706'))?.comments?.map((c) => c.body)).toEqual([
    'Unicode ☃\r\n\ntrailing  ',
  ])
  expect(
    (await target.assets.getTicketAsset('repo', 'AUT-706', 'design', 'reference'))?.meta.revision,
  ).toBe(firstAsset?.meta.revision)
  expect((await target.listStates()).some((s) => s.name === 'icebox')).toBe(true)
  expect(JSON.parse(await readFile(join(dir, IMPORT_MAP), 'utf8')).tickets).toEqual({
    'AUT-706': 'AUT-706',
    foreign: 'foreign',
  })
  expect(lines.at(-1)).toBe(`mapping: ${join(dir, IMPORT_MAP)}`)
})
test('all known id clashes fail before even creating missing states; content alone is not adoption', async () => {
  const source = await fixture()
  const dir = join(root, 'export')
  await exportTickets({ source, dir, repo: 'repo' })
  const target = new FileTicketSource({ dir: join(root, 'target') })
  await target.create({ title: 'A', body: 'exact\r\nbody  ' }, { requestedId: 'AUT-706' })
  await target.create({ title: 'B', body: 'B' }, { requestedId: 'foreign' })
  let writes = 0
  target.addState = async () => {
    writes++
    throw new Error('unexpected write')
  }
  target.create = async () => {
    writes++
    throw new Error('unexpected write')
  }
  await expect(importTickets({ source: target, dir, repo: 'repo' })).rejects.toThrow(
    'AUT-706 → AUT-706\nforeign → foreign',
  )
  expect(writes).toBe(0)
})
test('response loss after create resumes by key without duplicating tickets or comments', async () => {
  const source = await fixture()
  const dir = join(root, 'export')
  await exportTickets({ source, dir, repo: 'repo' })
  const target = new FileTicketSource({ dir: join(root, 'target') })
  const create = target.create.bind(target)
  let fail = true
  target.create = async (...args) => {
    const result = await create(...args)
    if (fail) {
      fail = false
      throw new Error('response lost')
    }
    return result
  }
  await expect(importTickets({ source: target, dir, repo: 'repo' })).rejects.toThrow('rerun import')
  const comment = target.comment.bind(target)
  target.comment = async (...args) => {
    await comment(...args)
    throw new Error('comment response lost')
  }
  await expect(importTickets({ source: target, dir, repo: 'repo' })).rejects.toThrow(
    'comment response lost',
  )
  target.comment = comment
  await importTickets({ source: target, dir, repo: 'repo' })
  expect((await target.listReady({})).tickets).toHaveLength(2)
  expect((await target.get('AUT-706'))?.comments).toHaveLength(1)
})
test('legacy ordinary layouts get durable keys and state names normalize without lifecycle remapping', async () => {
  const dir = join(root, 'legacy')
  for (const state of ['In Progress', 'Backlog', 'Done']) {
    await mkdir(join(dir, state), { recursive: true })
    await writeFile(
      join(dir, state, `${state.length}.md`),
      serializeTicketFile({ id: String(state.length), title: state, labels: [] }, state),
    )
  }
  const target = new FileTicketSource({ dir: join(root, 'target') })
  const added: string[] = []
  const add = target.addState.bind(target)
  target.addState = async (...args) => {
    added.push(args[0])
    return add(...args)
  }
  await importTickets({ source: target, dir, repo: 'repo' })
  expect(added.sort()).toEqual(['backlog', 'in-progress'])
  expect((await target.get('11'))?.state).toBe('in-progress')
  expect((await target.get('4'))?.state).toBe('done')
  await importTickets({ source: target, dir, repo: 'repo' })
  expect((await target.listReady({})).tickets).toHaveLength(3)
})
test('export normalization collisions, malformed input and nonempty destinations never publish partial output', async () => {
  const source = await fixture()
  await mkdir(join(root, 'source', 'In Progress'))
  await mkdir(join(root, 'source', 'in-progress'))
  await expect(exportTickets({ source, dir: join(root, 'export'), repo: 'repo' })).rejects.toThrow(
    'state collisions',
  )
  expect(await readdir(root)).not.toContain('export')
  await mkdir(join(root, 'output'))
  await writeFile(join(root, 'output', 'keep'), 'keep')
  await expect(exportTickets({ source, dir: join(root, 'output'), repo: 'repo' })).rejects.toThrow(
    'not empty',
  )
  await writeFile(join(root, 'source', 'ready', 'broken.md'), 'bad')
  const target = new FileTicketSource({ dir: join(root, 'target') })
  await expect(
    importTickets({ source: target, dir: join(root, 'source'), repo: 'repo' }),
  ).rejects.toThrow('incomplete ticket scan')
  expect(await target.listReady({})).toEqual({ tickets: [], diagnostics: [] })
})
test('requested number policy is literal, bigint-safe and allocates above every preserved number', () => {
  const policy = hostedRequestedIds('A.+')
  expect(policy.preserve('A.+-706')).toBe('A.+-706')
  for (const id of ['AUT-706', 'A.+-01', 'A.+-0', 'A.+--1'])
    expect(policy.preserve(id)).toBeUndefined()
  expect(policy.allocate(['A.+-706', 'A.+-9007199254740993'])).toBe('A.+-9007199254740994')
  expect(() => policy.preserve('A.+-9223372036854775808')).toThrow('bigint')
  expect(normalizeStateName(' In  Progress ')).toBe('in-progress')
  for (const state of ['123', '☃', 'a'.repeat(41)])
    expect(() => normalizeStateName(state)).toThrow('invalid state')
})

test('native and legacy assets compose, tombstones suppress fallback and snapshots outlive source bytes', async () => {
  const source = await fixture()
  const legacy = new MemoryBuildStore()
  await legacy.ensureRepo('repo')
  await legacy.putTicketAsset('repo', 'AUT-706', {
    ...bundle,
    entries: [{ type: 'file', path: 'legacy', content: new Uint8Array([1]) }],
  })
  await legacy.putTicketAsset('repo', 'AUT-706', { ...bundle, name: 'legacy-only' })
  const reader = composeTicketAssets(source, legacy)
  expect(await reader.listTicketAssets('repo', 'AUT-706')).toHaveLength(2)
  expect(
    (await reader.getTicketAsset('repo', 'AUT-706', 'design', 'reference', 0))?.entries[0]?.path,
  ).toBe('legacy')
  const pins = await preparePinnedAssets(source, legacy, 'repo', 'AUT-706')
  expect(pins.every((pin) => pin.snapshot)).toBe(true)
  await reader.removeTicketAsset('repo', 'AUT-706', 'design', 'reference')
  expect(await reader.getTicketAsset('repo', 'AUT-706', 'design', 'reference')).toBeNull()
  expect(await reader.listTicketAssets('repo', 'AUT-706')).toHaveLength(1)
  expect((await readAssetSnapshot(legacy, 'repo', 'AUT-706', pins[0]!)).entries).toEqual(
    bundle.entries,
  )
  const restarted = new FileTicketSource({ dir: join(root, 'source') })
  expect(
    await composeTicketAssets(restarted, legacy).getTicketAsset(
      'repo',
      'AUT-706',
      'design',
      'reference',
    ),
  ).toBeNull()
})

test('file requested ids reject unsafe paths and preserve structured metadata through every write', async () => {
  const source = new FileTicketSource({ dir: join(root, 'file') })
  for (const requestedId of ['', '.', '..', 'a/b', 'a\\b', 'a\0b'])
    await expect(source.create({ title: 'x', body: 'y' }, { requestedId })).rejects.toThrow(
      'invalid ticket id',
    )
  await source.create({ title: 'x', body: 'body' }, { requestedId: 'AUT-1', idempotencyKey: 'key' })
  await source.create({ title: 'b', body: 'body' }, { requestedId: 'AUT-2' })
  await source.assets.putTicketAsset('repo', 'AUT-1', bundle)
  await source.comment('AUT-1', '☃\n+++\n"quotes"\r\n')
  const first = (await source.get('AUT-1'))!
  await source.comment('AUT-1', 'another')
  await expect(
    source.mutateIfRevision('AUT-1', first.revision, { kind: 'update', patch: { title: 'stale' } }),
  ).rejects.toThrow('changed')
  await source.update('AUT-1', { title: 'updated' })
  await source.addBlocker('AUT-1', 'AUT-2')
  await source.removeBlocker('AUT-1', 'AUT-2')
  await source.transition('AUT-1', 'done')
  await source.mutateIfRevision('AUT-1', (await source.get('AUT-1'))!.revision, {
    kind: 'update',
    patch: { labels: ['new'] },
  })
  expect((await source.get('AUT-1'))?.comments).toHaveLength(2)
  expect((await source.get('AUT-1'))?.body).toBe('body')
  expect(
    (await source.assets.getTicketAsset('repo', 'AUT-1', 'design', 'reference'))?.entries,
  ).toEqual(bundle.entries)
  expect(
    (
      await source.create(
        { title: 'ignored', body: 'ignored' },
        { requestedId: 'AUT-2', idempotencyKey: 'key' },
      )
    ).ref.id,
  ).toBe('AUT-1')
  await expect(
    source.create({ title: 'clash', body: 'clash' }, { requestedId: 'AUT-1' }),
  ).rejects.toThrow('occupied')
})

test('hosted allocation plans foreign ids above every incoming preserved number independent of scan order', async () => {
  const source = new FileTicketSource({ dir: join(root, 'source') })
  await source.create({ title: 'foreign first', body: 'body' }, { requestedId: 'A-foreign' })
  await source.create({ title: 'preserved', body: 'body' }, { requestedId: 'AUT-706' })
  await exportTickets({ source, dir: join(root, 'export'), repo: 'repo' })
  const target = new FileTicketSource({ dir: join(root, 'target') })
  Object.defineProperty(target, 'requestedIds', { value: hostedRequestedIds('AUT') })
  await importTickets({ source: target, dir: join(root, 'export'), repo: 'repo' })
  expect((await target.get('AUT-706'))?.title).toBe('preserved')
  expect((await target.get('AUT-707'))?.title).toBe('foreign first')
})

test.each(['blockers', 'assets'])(
  'reruns recover response loss during %s without duplicate revisions',
  async (stage) => {
    const source = await fixture()
    const dir = join(root, 'export')
    await exportTickets({ source, dir, repo: 'repo' })
    const target = new FileTicketSource({ dir: join(root, 'target') })
    const blocker = target.addBlocker.bind(target)
    const put = target.assets.putTicketAsset.bind(target.assets)
    let fail = true
    if (stage === 'blockers')
      target.addBlocker = async (...args) => {
        await blocker(...args)
        if (fail) {
          fail = false
          throw new Error('lost blocker response')
        }
      }
    else
      target.assets.putTicketAsset = async (...args) => {
        const result = await put(...args)
        if (fail) {
          fail = false
          throw new Error('lost asset response')
        }
        return result
      }
    await expect(importTickets({ source: target, dir, repo: 'repo' })).rejects.toThrow(
      'rerun import',
    )
    await importTickets({ source: target, dir, repo: 'repo' })
    expect((await target.get('AUT-706'))?.blockedBy).toEqual(['foreign'])
    expect((await target.get('AUT-706'))?.comments).toHaveLength(1)
    expect(
      (await target.assets.getTicketAsset('repo', 'AUT-706', 'design', 'reference'))?.meta.revision,
    ).toBe(1_000_000_000)
  },
)

test.each(['keys', 'blocker', 'states', 'target-diagnostics'])(
  'preflight rejects %s before target mutations',
  async (kind) => {
    const dir = join(root, 'input')
    await mkdir(join(dir, 'In Progress'), { recursive: true })
    await mkdir(join(dir, 'in-progress'), { recursive: true })
    await writeFile(
      join(dir, 'In Progress', 'one.md'),
      serializeTicketFile(
        {
          id: 'one',
          title: 'One',
          labels: [],
          ...(kind === 'keys' ? { idempotencyKey: 'same' } : {}),
          ...(kind === 'blocker' ? { blockedBy: ['missing'] } : {}),
        },
        'body',
      ),
    )
    await writeFile(
      join(dir, 'in-progress', 'two.md'),
      serializeTicketFile(
        {
          id: 'two',
          title: 'Two',
          labels: [],
          ...(kind === 'keys' ? { idempotencyKey: 'same' } : {}),
        },
        'body',
      ),
    )
    const target = new FileTicketSource({ dir: join(root, 'target') })
    let writes = 0
    target.addState = async () => {
      writes++
      throw new Error('write')
    }
    target.create = async () => {
      writes++
      throw new Error('write')
    }
    if (kind === 'target-diagnostics')
      target.listReady = async () => ({ tickets: [], diagnostics: ['bad target'] })
    await expect(importTickets({ source: target, dir, repo: 'repo' })).rejects.toThrow(
      kind === 'keys'
        ? 'duplicate creation key'
        : kind === 'blocker'
          ? 'invalid blocker'
          : kind === 'states'
            ? 'state collisions'
            : 'bad target',
    )
    expect(writes).toBe(0)
  },
)

test('state creation response loss adopts a rediscovered unique case-insensitive match', async () => {
  const dir = join(root, 'input')
  await mkdir(join(dir, 'In Progress'), { recursive: true })
  await writeFile(
    join(dir, 'In Progress', 'one.md'),
    serializeTicketFile({ id: 'one', title: 'One', labels: [] }, 'body'),
  )
  const target = new FileTicketSource({ dir: join(root, 'target') })
  target.addState = async () => {
    await mkdir(join(root, 'target', 'In-Progress'), { recursive: true })
    throw new Error('response lost')
  }
  await importTickets({ source: target, dir, repo: 'repo' })
  expect((await target.get('one'))?.state).toBe('In-Progress')
  expect(JSON.parse(await readFile(join(dir, IMPORT_MAP), 'utf8')).states).toEqual({
    'In Progress': 'In-Progress',
  })
})

test('tree import establishes identities before edges and resumes adopted nested nodes', async () => {
  const source = new FileTicketSource({ dir: join(root, 'tree-source') })
  await source.create({ title: 'Root', body: 'Body', kind: 'node' }, { requestedId: 'z-root' })
  await source.create(
    { title: 'Nested', body: 'Body', kind: 'node', target: 'z-root' },
    { requestedId: 'm-node' },
  )
  await source.create(
    { title: 'Child', body: 'Body', target: 'm-node' },
    { requestedId: 'a-child' },
  )
  const dir = join(root, 'tree-export')
  await exportTickets({ source, dir, repo: 'repo' })
  const target = new FileTicketSource({ dir: join(root, 'tree-target') })
  await importTickets({ source: target, dir, repo: 'repo' })
  await target.update('a-child', { target: null })
  await importTickets({ source: target, dir, repo: 'repo' })
  expect((await target.get('a-child'))?.target).toBe('m-node')
  expect(await target.get('m-node')).toMatchObject({ kind: 'node', target: 'z-root' })
  expect((await target.listAll()).tickets).toHaveLength(3)
})

test('invalid target graphs fail before destination changes', async () => {
  const dir = join(root, 'bad-tree', 'ready')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'child.md'),
    serializeTicketFile({ id: 'child', title: 'Child', target: 'missing', labels: [] }, 'Body'),
  )
  const target = new FileTicketSource({ dir: join(root, 'bad-target') })
  await expect(
    importTickets({ source: target, dir: join(root, 'bad-tree'), repo: 'repo' }),
  ).rejects.toThrow('orphan')
  expect((await target.listAll()).tickets).toHaveLength(0)
})

test('Linear export waits without publication and preserves portable content and legacy assets', async () => {
  const { LinearTicketSource } = await import('./linear')
  const connection = <T>(nodes: T[], hasNextPage = false) => ({
    nodes,
    pageInfo: { hasNextPage, endCursor: hasNextPage ? 'next' : null },
  })
  const issue = {
    id: 'uuid-1',
    identifier: 'ENG-1',
    title: 'Export',
    description: 'Body',
    url: 'https://example.test',
    team: { key: 'ENG' },
    state: { name: 'Ready', type: 'unstarted' },
    labels: connection([{ name: 'node' }]),
    parent: {
      id: 'uuid-parent',
      identifier: 'ENG-0',
      team: { key: 'ENG' },
      labels: connection([{ name: 'node' }]),
    },
    inverseRelations: connection([{ type: 'blocks', issue: { identifier: 'ENG-2' } }]),
    comments: connection([{ body: 'Comment', createdAt: '2026-01-01', user: null }], true),
  }
  const store = new MemoryBuildStore()
  await store.putTicketAsset('repo', 'ENG-1', bundle)
  const dir = join(root, 'linear-export')
  await mkdir(dir)
  let now = 1000
  let requests = 0
  const lines: string[] = []
  const source = new LinearTicketSource({
    apiKey: 'key',
    teamKey: 'ENG',
    now: () => now,
    sleep: async (ms) => {
      expect(await readdir(dir)).toEqual([])
      now += ms
    },
    fetchFn: async () => {
      requests++
      const data =
        requests === 1
          ? { issues: connection([issue]), inventory: connection([{ id: issue.id }]) }
          : { issue: { comments: connection([]) } }
      return {
        ok: true,
        status: 200,
        headers: new Headers(requests === 2 ? { 'x-ratelimit-requests-reset': '2000' } : {}),
        json: async () =>
          requests === 2
            ? { errors: [{ message: 'limit', extensions: { code: 'RATELIMITED' } }] }
            : { data },
      }
    },
  })
  await exportTickets({
    source,
    dir,
    repo: 'repo',
    assets: store,
    print: (line) => lines.push(line),
  })
  expect(requests).toBe(3)
  expect(lines).toContain('read 0/1 tickets; waiting until 1970-01-01T00:00:02.000Z')
  const portable = new FileTicketSource({ dir })
  const ticket = await portable.get('ENG-1')
  expect(ticket).toMatchObject({
    kind: 'node',
    target: 'ENG-0',
    body: 'Body',
    labels: ['node'],
    blockedBy: ['ENG-2'],
    creationKey: 'uuid-1',
    comments: [{ body: 'Comment', createdAt: '2026-01-01' }],
  })
  expect(
    (await portable.assets.getTicketAsset('repo', 'ENG-1', 'design', 'reference'))?.entries,
  ).toEqual(bundle.entries)
})

for (const boundary of ['already', 'snapshot', 'assets', 'staging'] as const) {
  test(`cancellation at ${boundary} prevents export publication`, async () => {
    const source = await fixture()
    const controller = new AbortController()
    const dir = join(root, 'cancelled')
    await mkdir(dir)
    const abort = () => controller.abort(new Error('cancelled'))
    if (boundary === 'already') abort()
    if (boundary === 'snapshot') {
      source.listReady = async () => {
        abort()
        return { tickets: [], diagnostics: [] }
      }
    }
    if (boundary === 'assets') {
      const getAsset = source.assets.getTicketAsset.bind(source.assets)
      source.assets.getTicketAsset = async (...args) => {
        const asset = await getAsset(...args)
        abort()
        return asset
      }
    }
    if (boundary === 'staging') {
      const check = controller.signal.throwIfAborted.bind(controller.signal)
      controller.signal.throwIfAborted = () => {
        if (readdirSync(root).some((name) => name.endsWith('.tmp'))) abort()
        check()
      }
    }
    const lines: string[] = []
    await expect(
      exportTickets({
        source,
        dir,
        repo: 'repo',
        signal: controller.signal,
        print: (line) => lines.push(line),
      }),
    ).rejects.toThrow('cancelled')
    expect(await readdir(dir)).toEqual([])
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(lines.some((line) => line.startsWith('exported'))).toBe(false)
  })
}
