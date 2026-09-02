/**
 * DirBlobStore against the shared BlobStore contract (SPEC §7.1), plus the
 * one adapter-specific fact the contract can't see: the on-disk sharding
 * layout `root/<hash[0:2]>/<hash>`.
 */
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeBlobStoreContract } from '../contract'
import { contentHash, toBytes } from '../types'
import { DirBlobStore } from './blobs'

async function freshRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ab-blobs-'))
}

describeBlobStoreContract('DirBlobStore', async () => {
  const root = await freshRoot()
  return {
    blobs: new DirBlobStore(root),
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
})

describe('DirBlobStore layout', () => {
  test('shards content-addressed files under root/<hash[0:2]>/<hash>', async () => {
    const root = await freshRoot()
    try {
      const blobs = new DirBlobStore(root)
      const bytes = toBytes('sharded content')
      const hash = contentHash(bytes)
      await blobs.put(hash, bytes)
      const file = Bun.file(join(root, hash.slice(0, 2), hash))
      expect(await file.exists()).toBe(true)
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array(bytes))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("concurrent puts never share a temp path: another writer's in-flight partial survives untouched (§7.1)", async () => {
    const root = await freshRoot()
    try {
      const blobs = new DirBlobStore(root)
      const bytes = toBytes('the full blob content')
      const hash = contentHash(bytes)
      // Another process is mid-put (or crashed mid-put) of the same hash:
      // its temp file is on disk. With a single shared `<hash>.partial`
      // temp path, our put would reopen it with O_TRUNC — the other
      // writer's rename would then install truncated bytes under a valid
      // content address, unrepairable through the API (put no-ops once the
      // final path exists).
      const shard = join(root, hash.slice(0, 2))
      await mkdir(shard, { recursive: true })
      const otherWritersPartial = join(shard, `${hash}.partial`)
      await Bun.write(otherWritersPartial, 'trunc')

      await blobs.put(hash, bytes)

      // Our put landed the full bytes under the content address...
      expect(await blobs.get(hash)).toEqual(bytes)
      // ...and never touched the other writer's temp file.
      expect(await Bun.file(otherWritersPartial).exists()).toBe(true)
      expect(await Bun.file(otherWritersPartial).text()).toBe('trunc')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
