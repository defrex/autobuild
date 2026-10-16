import { expect, test } from 'bun:test'
import { MemoryBuildStore } from './memory'
import { prepareAssetSnapshots, readAssetSnapshot } from './ticket-asset-snapshots'
import { preparePinnedAssets, resolvePinnedAsset } from './ticket-assets'
import { DISPATCHER } from '../events/envelope'
import { FakeTicketSource } from '../ports/tickets/fake'

test('hosted snapshots preserve trees, chunks, revision gaps, and conflicting destination rows', async () => {
  const source = new MemoryBuildStore()
  const destination = new MemoryBuildStore()
  const input = {
    kind: 'design',
    name: 'site',
    layout: 'tree' as const,
    entries: [
      { type: 'dir' as const, path: 'empty' },
      { type: 'file' as const, path: 'empty.txt', content: new Uint8Array() },
      { type: 'file' as const, path: 'large.bin', content: new Uint8Array(600_000).fill(71) },
    ],
  }
  await source.putTicketAsset('repo', 'T', input)
  await source.removeTicketAsset('repo', 'T', 'design', 'site')
  await source.putTicketAsset('repo', 'T', input)
  await destination.putTicketAsset('repo', 'T', { ...input, entries: [] })
  const pins = await prepareAssetSnapshots(source, destination, 'repo', 'T')
  expect(pins[0]?.revision).toBe(2)
  const frozen = await source.getTicketAsset('repo', 'T', 'design', 'site', 2)
  await source.removeTicketAsset('repo', 'T', 'design', 'site')
  expect(await readAssetSnapshot(destination, 'repo', 'T', pins[0]!)).toEqual(frozen!)
  // PostgreSQL JSONB can return event payload keys in a different order.
  const reordered = Object.fromEntries(Object.entries(pins[0]!).reverse()) as (typeof pins)[number]
  expect(await readAssetSnapshot(destination, 'repo', 'T', reordered)).toEqual(frozen!)
  expect((await destination.listTicketAssets('repo', 'T'))[0]?.revision).toBe(0)
  expect((await destination.listRepoArtifacts('repo')).length).toBe(4)
  await expect(readAssetSnapshot(destination, 'other', 'T', pins[0]!)).rejects.toThrow()
})

test.each(['file', 'tree'] as const)('snapshots preserve empty %s content', async (layout) => {
  const store = new MemoryBuildStore()
  await store.putTicketAsset('repo', 'T', {
    kind: 'reference',
    name: 'empty',
    layout,
    entries: layout === 'file' ? [{ type: 'file', path: 'empty', content: new Uint8Array() }] : [],
  })
  const [pin] = await prepareAssetSnapshots(store, store, 'repo', 'T')
  expect(await readAssetSnapshot(store, 'repo', 'T', pin!)).toEqual(
    (await store.getTicketAsset('repo', 'T', 'reference', 'empty'))!,
  )
})

test('snapshots reject missing sampled revisions, corrupt chunks, and incompatible identities', async () => {
  const store = new MemoryBuildStore()
  await store.putTicketAsset('repo', 'T', {
    kind: 'design',
    name: 'file',
    layout: 'file',
    entries: [{ type: 'file', path: 'file', content: new Uint8Array([1, 2]) }],
  })
  await expect(
    prepareAssetSnapshots(
      {
        listTicketAssets: store.listTicketAssets.bind(store),
        getTicketAsset: async () => null,
      },
      store,
      'repo',
      'T',
    ),
  ).rejects.toThrow('missing')
  const [pin] = await prepareAssetSnapshots(store, store, 'repo', 'T')
  await expect(
    readAssetSnapshot(
      {
        getRepoArtifact: async (repo, kind, rev) => {
          const artifact = await store.getRepoArtifact(repo, kind, rev)
          return kind === pin!.snapshot!.kind ? artifact : null
        },
      },
      'repo',
      'T',
      pin!,
    ),
  ).rejects.toThrow('chunk')
  await expect(readAssetSnapshot(store, 'repo', 'other', pin!)).rejects.toThrow('metadata')
  await expect(readAssetSnapshot(store, 'repo', 'T', { ...pin!, size: 3 })).rejects.toThrow(
    'metadata',
  )
})

test('hosted source without asset capability fails explicitly', async () => {
  const source = Object.assign(new FakeTicketSource(), { name: 'hosted' })
  await expect(preparePinnedAssets(source, new MemoryBuildStore(), 'repo', 'T')).rejects.toThrow(
    'capability',
  )
})

test('maximum entry count with long escaped paths fits a bounded manifest artifact', async () => {
  const source = new MemoryBuildStore()
  const destination = new MemoryBuildStore()
  const entries = Array.from({ length: 1000 }, (_, index) => ({
    type: 'file' as const,
    path: `x${index}/${'\u0001'.repeat(120)}/${'\u0002'.repeat(120)}`,
    content: new Uint8Array(),
  }))
  await source.putTicketAsset('repo', 'T', {
    kind: 'design',
    name: 'tree',
    layout: 'tree',
    entries,
  })
  const [pin] = await prepareAssetSnapshots(source, destination, 'repo', 'T')
  const manifest = await destination.getRepoArtifact('repo', pin!.snapshot!.kind)
  expect(manifest!.content.length).toBeLessThan(256 * 1024)
  expect((await readAssetSnapshot(destination, 'repo', 'T', pin!)).entries).toEqual(entries)
})

test('hosted snapshots validate canonical assets for aliases and retain historical build identity', async () => {
  const assets = new MemoryBuildStore()
  const destination = new MemoryBuildStore()
  await assets.putTicketAsset('repo', 'ENG-1', {
    kind: 'reference',
    name: 'proof',
    layout: 'file',
    entries: [{ type: 'file', path: 'proof', content: new Uint8Array([7, 8]) }],
  })
  const source = new FakeTicketSource([])
  Object.defineProperty(source, 'name', { value: 'hosted' })
  source.get = async () => ({
    ref: { source: 'hosted', id: 'ENG-1' },
    revision: '1',
    title: 'Ticket',
    body: 'Body',
    state: 'ready',
    resolved: false,
    labels: [],
  })
  Object.assign(source, {
    assets: {
      listTicketAssets: async () => assets.listTicketAssets('repo', 'ENG-1'),
      getTicketAsset: async (
        _repo: string,
        _id: string,
        kind: string,
        name: string,
        rev?: number,
      ) => assets.getTicketAsset('repo', 'ENG-1', kind, name, rev),
    },
  })
  for (const alias of ['ticket-legacy', 'eng-1']) {
    const [pin] = await preparePinnedAssets(source, destination, 'repo', alias)
    const frozen = await readAssetSnapshot(destination, 'repo', alias, pin!)
    expect(frozen.meta.ticketId).toBe(alias)
    expect(frozen.entries).toEqual([
      { type: 'file', path: 'proof', content: new Uint8Array([7, 8]) },
    ])
    expect(await readAssetSnapshot(destination, 'repo', 'ENG-1', pin!, alias)).toEqual(frozen)
    await destination.createBuild({
      slug: alias,
      repo: 'repo',
      ticket: { source: 'hosted', id: alias },
      created: {
        actor: DISPATCHER,
        type: 'build.created',
        payload: {
          repo: 'repo',
          baseBranch: 'main',
          ticket: { source: 'hosted', id: alias },
          assets: [pin!],
        },
      },
    })
    const record = (await destination.getBuild(alias))!
    expect(
      await resolvePinnedAsset(
        {
          getBuild: async () => ({ ...record, ticket: { source: 'hosted', id: 'ENG-1' } }),
          getEvents: destination.getEvents.bind(destination),
          getTicketAsset: destination.getTicketAsset.bind(destination),
          getRepoArtifact: destination.getRepoArtifact.bind(destination),
        },
        alias,
        'reference',
        'proof',
      ),
    ).toEqual({ ...frozen, meta: { ...frozen.meta, ticketId: 'ENG-1' } })

    await expect(readAssetSnapshot(destination, 'repo', 'FOREIGN-1', pin!)).rejects.toThrow(
      'metadata',
    )
  }
  source.get = async () => ({
    ref: { source: 'hosted', id: 'FOREIGN-1' },
    revision: '1',
    title: 'Wrong ticket',
    body: 'Body',
    state: 'ready',
    resolved: false,
    labels: [],
  })
  await expect(preparePinnedAssets(source, destination, 'repo', 'ticket-legacy')).rejects.toThrow(
    'metadata',
  )
})
